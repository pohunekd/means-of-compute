// Watch core: pure parsing and attention rules for the watch loop.
import type { MergeMode } from "../../contracts/v1/types.js";
import type { AttentionEntry } from "./prompt.js";
import { parseListSnapshot, strandedIds, type ListRow } from "./report.js";

export interface WatchRow extends ListRow {
  readonly repo: string;
  readonly issue: number | null;
  readonly fallbackUsed: boolean;
}

export interface Verdict {
  readonly headSha: string;
  readonly pullNumber: number | null;
  readonly auditorModel: string;
  readonly counts: { readonly high: number; readonly medium: number; readonly low: number };
}

export interface FleetState {
  readonly paused: boolean;
  readonly pendingTools: readonly string[];
}

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

export interface WatchSnapshot {
  readonly rows: readonly WatchRow[];
  readonly verdicts: ReadonlyMap<string, readonly Verdict[]>;
  readonly fleet: FleetState;
}

export interface WatchContext {
  readonly goalId: string;
  readonly idPrefix: string;
  readonly mergeModes: ReadonlyMap<string, MergeMode>;
  readonly maxFollowupsPerRun: number;
  readonly pauseRequestBlockedItems: number;
  readonly followupsFiled: number;
  readonly consumed: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isCount(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function errorCode(payload: Record<string, unknown>, fallback: string): Parsed<never> {
  const error: unknown = payload["error"];
  if (isRecord(error) && typeof error["code"] === "string") {
    return { ok: false, code: error["code"] };
  }
  return { ok: false, code: fallback };
}

function parseVerdictEntry(entry: unknown): Verdict | null {
  if (!isRecord(entry)) {
    return null;
  }
  const headSha: unknown = entry["headSha"];
  const pullNumber: unknown = entry["pullNumber"];
  const auditorModel: unknown = entry["auditorModel"];
  const counts: unknown = entry["counts"];
  if (typeof headSha !== "string") {
    return null;
  }
  if (pullNumber !== null && !isInteger(pullNumber)) {
    return null;
  }
  if (typeof auditorModel !== "string") {
    return null;
  }
  if (
    !isRecord(counts) ||
    !isCount(counts["high"]) ||
    !isCount(counts["medium"]) ||
    !isCount(counts["low"])
  ) {
    return null;
  }
  return {
    headSha,
    pullNumber,
    auditorModel,
    counts: { high: counts["high"], medium: counts["medium"], low: counts["low"] },
  };
}

export function parseVerdicts(payload: unknown): Parsed<readonly Verdict[]> {
  if (!isRecord(payload)) {
    return { ok: false, code: "invalid-audit-results" };
  }
  if (payload["ok"] !== true) {
    return errorCode(payload, "invalid-audit-results");
  }
  const verdicts: unknown = payload["verdicts"];
  if (!Array.isArray(verdicts)) {
    return { ok: false, code: "invalid-audit-results" };
  }
  const parsed: Verdict[] = [];
  for (const entry of verdicts as readonly unknown[]) {
    const verdict = parseVerdictEntry(entry);
    if (verdict === null) {
      return { ok: false, code: "invalid-audit-results" };
    }
    parsed.push(verdict);
  }
  return { ok: true, value: parsed };
}

export function parseFleet(payload: unknown): Parsed<FleetState> {
  if (!isRecord(payload)) {
    return { ok: false, code: "invalid-fleet-status" };
  }
  if (payload["ok"] !== true) {
    return errorCode(payload, "invalid-fleet-status");
  }
  const fleet: unknown = payload["fleet"];
  if (!isRecord(fleet)) {
    return { ok: false, code: "invalid-fleet-status" };
  }
  const paused: unknown = fleet["paused"];
  const pending: unknown = fleet["pendingRequests"];
  if (typeof paused !== "boolean" || !Array.isArray(pending)) {
    return { ok: false, code: "invalid-fleet-status" };
  }
  const pendingTools: string[] = [];
  for (const entry of pending as readonly unknown[]) {
    if (!isRecord(entry) || typeof entry["tool"] !== "string") {
      return { ok: false, code: "invalid-fleet-status" };
    }
    pendingTools.push(entry["tool"]);
  }
  return { ok: true, value: { paused, pendingTools } };
}

export function parseWatchRows(
  payload: unknown,
): Parsed<{ readonly revision: number; readonly rows: readonly WatchRow[] }> {
  const snapshot = parseListSnapshot(payload);
  if (!snapshot.ok) {
    return snapshot;
  }
  if (!isRecord(payload) || !Array.isArray(payload["items"])) {
    return { ok: false, code: "invalid-list-work" };
  }
  const rawItems = payload["items"] as readonly unknown[];
  const parsed = snapshot.snapshot.items;
  const rows: WatchRow[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const base = parsed[index];
    const raw = rawItems[index];
    if (base === undefined || !isRecord(raw)) {
      return { ok: false, code: "invalid-list-work" };
    }
    const repo: unknown = raw["repo"];
    const issue: unknown = raw["issue"];
    const routing: unknown = raw["modelRouting"];
    if (typeof repo !== "string") {
      return { ok: false, code: "invalid-list-work" };
    }
    if (issue !== null && !isInteger(issue)) {
      return { ok: false, code: "invalid-list-work" };
    }
    if (!isRecord(routing) || typeof routing["fallbackUsed"] !== "boolean") {
      return { ok: false, code: "invalid-list-work" };
    }
    rows.push({ ...base, repo, issue, fallbackUsed: routing["fallbackUsed"] });
  }
  return { ok: true, value: { revision: snapshot.snapshot.revision, rows } };
}

export function scopeRows(rows: readonly WatchRow[], idPrefix: string): readonly WatchRow[] {
  return rows.filter((row) => row.id.startsWith(`${idPrefix}-`));
}

function hasFollowupId(rows: readonly WatchRow[], id: string): boolean {
  return rows.some((row) => row.id === `${id}-fu`);
}

export function auditTargets(rows: readonly WatchRow[], ctx: WatchContext): readonly string[] {
  const targets: string[] = [];
  for (const row of scopeRows(rows, ctx.idPrefix)) {
    if (row.status === "blocked" && !row.id.endsWith("-fu") && !hasFollowupId(rows, row.id)) {
      targets.push(row.id);
    } else if (row.status === "review" && ctx.mergeModes.get(row.repo) === "human-approval") {
      targets.push(row.id);
    }
  }
  return targets;
}

export function attentionOf(snapshot: WatchSnapshot, ctx: WatchContext): readonly AttentionEntry[] {
  const scope = scopeRows(snapshot.rows, ctx.idPrefix);
  const byId = new Map<string, WatchRow>();
  for (const row of snapshot.rows) {
    byId.set(row.id, row);
  }
  const followups: Extract<AttentionEntry, { readonly kind: "followup" }>[] = [];
  for (const row of scope) {
    if (row.status !== "blocked" || row.id.endsWith("-fu") || row.id.length > 45) {
      continue;
    }
    if (byId.has(`${row.id}-fu`)) {
      continue;
    }
    if (row.pullNumber === null) {
      continue;
    }
    const verdicts = snapshot.verdicts.get(row.id) ?? [];
    const flagged = verdicts.some(
      (verdict) =>
        verdict.pullNumber === row.pullNumber && verdict.counts.high + verdict.counts.medium > 0,
    );
    if (!flagged) {
      continue;
    }
    const key = `followup:${row.id}`;
    if (ctx.consumed.has(key)) {
      continue;
    }
    followups.push({
      kind: "followup",
      key,
      workItemId: row.id,
      pullNumber: row.pullNumber,
      issue: row.issue,
      fallbackUsed: row.fallbackUsed,
    });
  }
  followups.sort((left, right) =>
    left.workItemId < right.workItemId ? -1 : left.workItemId > right.workItemId ? 1 : 0,
  );
  const allowed = Math.max(0, ctx.maxFollowupsPerRun - ctx.followupsFiled);
  const kept = followups.slice(0, allowed);

  const approves: Extract<AttentionEntry, { readonly kind: "approve" }>[] = [];
  for (const row of scope) {
    if (row.status !== "review" || ctx.mergeModes.get(row.repo) !== "human-approval") {
      continue;
    }
    if (row.pullNumber === null) {
      continue;
    }
    const verdicts = snapshot.verdicts.get(row.id) ?? [];
    for (const verdict of verdicts) {
      if (verdict.pullNumber !== row.pullNumber) {
        continue;
      }
      if (verdict.counts.high !== 0 || verdict.counts.medium !== 0) {
        continue;
      }
      const key = `approve:${row.id}:${row.pullNumber}:${verdict.headSha}`;
      if (ctx.consumed.has(key)) {
        continue;
      }
      approves.push({
        kind: "approve",
        key,
        workItemId: row.id,
        pullNumber: row.pullNumber,
        headSha: verdict.headSha,
        auditorModel: verdict.auditorModel,
      });
    }
  }
  approves.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

  const entries: AttentionEntry[] = [...kept, ...approves];
  const blocked = scope.filter((row) => row.status === "blocked").length;
  const pauseKey = `pause:${ctx.goalId}`;
  if (
    blocked >= ctx.pauseRequestBlockedItems &&
    !snapshot.fleet.paused &&
    !snapshot.fleet.pendingTools.includes("pause_fleet") &&
    !ctx.consumed.has(pauseKey)
  ) {
    entries.push({ kind: "pause", key: pauseKey, goalId: ctx.goalId, blocked });
  }
  return entries;
}

export function isGoalTerminal(rows: readonly WatchRow[], idPrefix: string): boolean {
  const scope = scopeRows(rows, idPrefix);
  if (scope.length === 0) {
    return false;
  }
  const stranded = strandedIds(rows);
  return scope.every((row) => {
    if (row.status === "done" || row.status === "blocked" || stranded.has(row.id)) {
      return true;
    }
    return (
      row.status === "parked" &&
      row.statusReason !== null &&
      row.statusReason.startsWith("operator: ")
    );
  });
}
