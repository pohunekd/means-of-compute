// Run report: fold coordinator call-ends and snapshots into report data.
// Counts, dedupe keys and strand analysis feed the markdown renderer.
import type { CoordCallEnd } from "./calls.js";
import type { SessionOutcome } from "./session.js";
import type { WorkItemStatus } from "../../contracts/v1/types.js";

export const COORD_TOOLS = [
  "fleet_status",
  "list_work",
  "audit_results",
  "submit_work",
  "approve",
  "pause_fleet",
] as const;
export type CoordTool = (typeof COORD_TOOLS)[number];

export interface ListRow {
  readonly id: string;
  readonly status: WorkItemStatus;
  readonly statusReason: string | null;
  readonly pullNumber: number | null;
  readonly dependencies: readonly string[];
  readonly dod: { readonly done: number; readonly total: number };
  readonly retryCount: number;
}

export interface ListSnapshot {
  readonly revision: number;
  readonly items: readonly ListRow[];
}

export type FinalSnapshot =
  | { readonly ok: true; readonly snapshot: ListSnapshot }
  | { readonly ok: false; readonly code: string };

export interface ReportGate {
  readonly k: number;
  readonly admit: boolean;
  readonly reason: string | null;
}

export interface ReportSession {
  readonly k: number;
  readonly kind: "plan" | "react";
  readonly sessionId: string;
  readonly outcome: SessionOutcome;
  readonly durationMs: number;
  readonly exportOk: boolean;
  readonly attentionKeys: readonly string[];
}

export interface ReportInput {
  readonly runId: string;
  readonly goalId: string;
  readonly idPrefix: string;
  readonly repo: string;
  readonly phase: "plan" | "watch" | "full";
  readonly stop: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly configPath: string;
  readonly configSha256: string;
  readonly gates: readonly ReportGate[];
  readonly sessions: readonly ReportSession[];
  readonly calls: readonly CoordCallEnd[];
  readonly consumed: readonly string[];
  readonly finalSnapshot: FinalSnapshot;
}

export interface ReportItem {
  readonly id: string;
  readonly status: WorkItemStatus;
  readonly statusReason: string | null;
  readonly dod: { readonly done: number; readonly total: number };
  readonly pullNumber: number | null;
  readonly retryCount: number;
  readonly stranded: boolean;
}

interface ReportCalls {
  readonly ok: number;
  readonly refused: number;
  readonly error: number;
}

interface ReportSubmission {
  readonly submissionId: string;
  readonly itemIds: readonly string[];
  readonly replayed: boolean;
}

interface ReportRefusal {
  readonly tool: string;
  readonly code: string;
}

interface ReportRequest {
  readonly requestId: string;
  readonly outcome: string;
}

interface ReportSnapshotRef {
  readonly ok: true;
  readonly revision: number;
}

type ReportSnapshot = ReportSnapshotRef | { readonly ok: false; readonly code: string };

export interface Report {
  readonly schemaVersion: "v1";
  readonly runId: string;
  readonly goalId: string;
  readonly repo: string;
  readonly phase: "plan" | "watch" | "full";
  readonly stop: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly configPath: string;
  readonly configSha256: string;
  readonly gates: readonly ReportGate[];
  readonly sessions: readonly ReportSession[];
  readonly calls: Record<CoordTool, ReportCalls>;
  readonly submissions: readonly ReportSubmission[];
  readonly refusals: readonly ReportRefusal[];
  readonly requests: readonly ReportRequest[];
  readonly items: readonly ReportItem[] | null;
  readonly followups: readonly string[];
  readonly unresolved: readonly string[] | null;
  readonly outOfScope: readonly string[];
  readonly finalSnapshot: ReportSnapshot;
}

export class ReportDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReportDataError";
  }
}

const STATUSES: readonly WorkItemStatus[] = [
  "queued",
  "running",
  "review",
  "parked",
  "blocked",
  "done",
];

function isWorkItemStatus(value: string): value is WorkItemStatus {
  return STATUSES.some((status) => status === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function parseListRow(row: unknown): ListRow | null {
  if (!isRecord(row)) {
    return null;
  }
  const id: unknown = row["id"];
  const status: unknown = row["status"];
  const statusReason: unknown = row["statusReason"];
  const pullNumber: unknown = row["pullNumber"];
  const dependencies: unknown = row["dependencies"];
  const dod: unknown = row["dod"];
  const retryCount: unknown = row["retryCount"];
  if (typeof id !== "string") {
    return null;
  }
  if (typeof status !== "string" || !isWorkItemStatus(status)) {
    return null;
  }
  if (typeof statusReason !== "string" && statusReason !== null) {
    return null;
  }
  if (pullNumber !== null && !isInteger(pullNumber)) {
    return null;
  }
  if (!Array.isArray(dependencies)) {
    return null;
  }
  const deps: readonly string[] = dependencies.filter(
    (entry: unknown): entry is string => typeof entry === "string",
  );
  if (deps.length !== dependencies.length) {
    return null;
  }
  if (!isRecord(dod)) {
    return null;
  }
  const done: unknown = dod["done"];
  const total: unknown = dod["total"];
  if (!isInteger(done) || !isInteger(total)) {
    return null;
  }
  if (!isInteger(retryCount) || retryCount < 0) {
    return null;
  }
  return {
    id,
    status,
    statusReason,
    pullNumber,
    dependencies: deps,
    dod: { done, total },
    retryCount,
  };
}

export function parseListSnapshot(payload: unknown): FinalSnapshot {
  if (!isRecord(payload)) {
    return { ok: false, code: "invalid-list-work" };
  }
  const ok = payload["ok"];
  if (ok === true) {
    const revision: unknown = payload["revision"];
    const items: unknown = payload["items"];
    if (!isInteger(revision) || revision < 0 || !Array.isArray(items)) {
      return { ok: false, code: "invalid-list-work" };
    }
    const rows: ListRow[] = [];
    for (const entry of items as readonly unknown[]) {
      const row = parseListRow(entry);
      if (row === null) {
        return { ok: false, code: "invalid-list-work" };
      }
      rows.push(row);
    }
    return { ok: true, snapshot: { revision, items: rows } };
  }
  if (ok === false) {
    const error: unknown = payload["error"];
    if (isRecord(error)) {
      const code: unknown = error["code"];
      if (typeof code === "string") {
        return { ok: false, code };
      }
    }
  }
  return { ok: false, code: "invalid-list-work" };
}

export function strandedIds(rows: readonly ListRow[]): ReadonlySet<string> {
  const byId = new Map<string, ListRow>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  const stranded = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.status !== "queued" || stranded.has(row.id)) {
        continue;
      }
      for (const dep of row.dependencies) {
        const target = byId.get(dep);
        if (target === undefined) {
          continue;
        }
        const blocked =
          target.status === "blocked" ||
          (target.status === "parked" &&
            target.statusReason !== null &&
            target.statusReason.startsWith("operator: ")) ||
          stranded.has(target.id);
        if (blocked) {
          stranded.add(row.id);
          changed = true;
          break;
        }
      }
    }
  }
  return stranded;
}

interface CallCounts {
  ok: number;
  refused: number;
  error: number;
}

function emptyCalls(): Record<CoordTool, CallCounts> {
  const empty: CallCounts = { ok: 0, refused: 0, error: 0 };
  return {
    fleet_status: { ...empty },
    list_work: { ...empty },
    audit_results: { ...empty },
    submit_work: { ...empty },
    approve: { ...empty },
    pause_fleet: { ...empty },
  };
}

function asTool(tool: string): CoordTool | null {
  return (COORD_TOOLS as readonly string[]).includes(tool) ? (tool as CoordTool) : null;
}

function parseSubmitSummary(call: CoordCallEnd): {
  readonly submissionId: string;
  readonly itemIds: readonly string[];
  readonly replayed: boolean;
} {
  const summary: unknown = call.summary;
  if (!isRecord(summary)) {
    throw new ReportDataError(
      `Report: call ${call.run}/${String(call.callId)} has an invalid submit_work summary`,
    );
  }
  const submissionId: unknown = summary["submissionId"];
  const itemIds: unknown = summary["itemIds"];
  const replayed: unknown = summary["replayed"];
  if (
    typeof submissionId !== "string" ||
    !Array.isArray(itemIds) ||
    typeof replayed !== "boolean"
  ) {
    throw new ReportDataError(
      `Report: call ${call.run}/${String(call.callId)} has an invalid submit_work summary`,
    );
  }
  const ids: readonly string[] = itemIds.filter(
    (entry: unknown): entry is string => typeof entry === "string",
  );
  if (ids.length !== itemIds.length) {
    throw new ReportDataError(
      `Report: call ${call.run}/${String(call.callId)} has an invalid submit_work summary`,
    );
  }
  return {
    submissionId,
    itemIds: ids,
    replayed,
  };
}

function parseRequestSummary(call: CoordCallEnd): {
  readonly requestId: string;
  readonly outcome: string;
} {
  const summary: unknown = call.summary;
  if (!isRecord(summary)) {
    throw new ReportDataError(
      `Report: call ${call.run}/${String(call.callId)} has an invalid ${call.tool} summary`,
    );
  }
  const requestId: unknown = summary["requestId"];
  const outcome: unknown = summary["outcome"];
  if (typeof requestId !== "string" || typeof outcome !== "string") {
    throw new ReportDataError(
      `Report: call ${call.run}/${String(call.callId)} has an invalid ${call.tool} summary`,
    );
  }
  return { requestId, outcome };
}

export function buildReport(input: ReportInput): Report {
  const calls = emptyCalls();
  const submissions: ReportSubmission[] = [];
  const refusals: ReportRefusal[] = [];
  const requests: ReportRequest[] = [];
  const seenFollowups = new Set<string>();
  const followups: string[] = [];
  const outOfScope: string[] = [];
  const seenOutOfScope = new Set<string>();
  for (const call of input.calls) {
    const tool = asTool(call.tool);
    if (tool === null) {
      throw new ReportDataError(
        `Report: call ${call.run}/${String(call.callId)} names unknown tool ${call.tool}`,
      );
    }
    const counts = calls[tool];
    if (call.outcome === "ok") {
      counts.ok += 1;
    } else if (call.outcome === "refused") {
      counts.refused += 1;
    } else {
      counts.error += 1;
    }
    if (call.tool === "submit_work" && call.outcome === "ok") {
      const parsed = parseSubmitSummary(call);
      submissions.push(parsed);
      for (const id of parsed.itemIds) {
        if (id.endsWith("-fu") && !seenFollowups.has(id)) {
          seenFollowups.add(id);
          followups.push(id);
        }
        if (!id.startsWith(`${input.idPrefix}-`) && !seenOutOfScope.has(id)) {
          seenOutOfScope.add(id);
          outOfScope.push(id);
        }
      }
    }
    if ((call.tool === "approve" || call.tool === "pause_fleet") && call.outcome === "ok") {
      requests.push(parseRequestSummary(call));
    }
    if (call.outcome === "refused" || call.outcome === "error") {
      if (call.code === null) {
        throw new ReportDataError(
          `Report: call ${call.run}/${String(call.callId)} has a ${call.outcome} ${call.tool} line without a code`,
        );
      }
      refusals.push({ tool: call.tool, code: call.code });
    }
  }
  const okSnapshot = input.finalSnapshot.ok ? input.finalSnapshot.snapshot : null;
  const items: readonly ReportItem[] | null =
    okSnapshot === null ? null : scopeItems(okSnapshot, input.idPrefix);
  const unresolved: readonly string[] | null =
    okSnapshot === null ? null : openFollowups(input.consumed, okSnapshot);
  const finalSnapshot: ReportSnapshot = input.finalSnapshot.ok
    ? { ok: true, revision: input.finalSnapshot.snapshot.revision }
    : { ok: false, code: input.finalSnapshot.code };
  return {
    schemaVersion: "v1",
    runId: input.runId,
    goalId: input.goalId,
    repo: input.repo,
    phase: input.phase,
    stop: input.stop,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    configPath: input.configPath,
    configSha256: input.configSha256,
    gates: [...input.gates],
    sessions: [...input.sessions],
    calls,
    submissions,
    refusals,
    requests,
    items,
    followups,
    unresolved,
    outOfScope,
    finalSnapshot,
  };
}

function scopeItems(snapshot: ListSnapshot, idPrefix: string): ReportItem[] {
  const stranded = strandedIds(snapshot.items);
  const items: ReportItem[] = [];
  for (const row of snapshot.items) {
    if (!row.id.startsWith(`${idPrefix}-`)) {
      continue;
    }
    items.push({
      id: row.id,
      status: row.status,
      statusReason: row.statusReason,
      dod: { done: row.dod.done, total: row.dod.total },
      pullNumber: row.pullNumber,
      retryCount: row.retryCount,
      stranded: stranded.has(row.id),
    });
  }
  return items;
}

function openFollowups(consumed: readonly string[], snapshot: ListSnapshot): string[] {
  const byId = new Set<string>();
  for (const row of snapshot.items) {
    byId.add(row.id);
  }
  const unresolved: string[] = [];
  for (const key of consumed) {
    if (!key.startsWith("followup:")) {
      continue;
    }
    const base = key.slice("followup:".length);
    if (!byId.has(`${base}-fu`)) {
      unresolved.push(key);
    }
  }
  return unresolved;
}

function cellText(value: string): string {
  return value.replaceAll("|", "\\|");
}

function cell(value: string | null): string {
  if (value === null) {
    return "-";
  }
  return cellText(value);
}

function outcomeText(outcome: SessionOutcome): string {
  switch (outcome.kind) {
    case "exited":
      return `exited ${String(outcome.rc)}`;
    case "timeout":
      return "timeout";
    case "aborted":
      return "aborted";
    case "spawn-failed":
      return `spawn-failed ${outcome.stage} ${outcome.code}`;
  }
}

function table(header: string, rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) {
    return ["None."];
  }
  const pipes = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  const divider = `|${header
    .split("|")
    .slice(1, -1)
    .map(() => "---")
    .join("|")}|`;
  return [header, divider, ...rows.map((row) => pipes(row))];
}

export function renderReportMd(report: Report): string {
  const lines: string[] = [
    `# Coordinator run ${report.runId}`,
    "",
    `Goal \`${report.goalId}\` (${report.repo}), phase ${report.phase}, stop **${report.stop}**, ${report.startedAt} to ${report.endedAt} (UTC).`,
    "",
    "## Sessions",
    "",
    ...table(
      "| # | Kind | Session | Outcome | Duration (s) | Export |",
      report.sessions.map((session) => [
        cellText(String(session.k)),
        cellText(session.kind),
        cellText(session.sessionId),
        cellText(outcomeText(session.outcome)),
        cellText((session.durationMs / 1000).toFixed(1)),
        cellText(session.exportOk ? "yes" : "no"),
      ]),
    ),
    "",
    "## Submissions",
    "",
    ...table(
      "| Submission | Items | Replayed |",
      report.submissions.map((entry) => [
        cellText(entry.submissionId),
        cellText(entry.itemIds.join(", ")),
        cellText(entry.replayed ? "yes" : "no"),
      ]),
    ),
    "",
    "## Refusals",
    "",
    ...refusalLines(report),
    "",
    "## Requests",
    "",
    ...table(
      "| Request | Outcome |",
      report.requests.map((entry) => [cellText(entry.requestId), cellText(entry.outcome)]),
    ),
    "",
    "## Items",
    "",
    ...itemsLines(report),
    "",
    "## Unresolved",
    "",
    ...unresolvedLines(report),
  ];
  return `${lines.join("\n")}\n`;
}

function refusalLines(report: Report): string[] {
  if (report.refusals.length === 0) {
    return ["None."];
  }
  const counts = new Map<string, { readonly tool: string; readonly code: string; count: number }>();
  for (const refusal of report.refusals) {
    const key = `${refusal.tool} ${refusal.code}`;
    const found = counts.get(key);
    if (found === undefined) {
      counts.set(key, { tool: refusal.tool, code: refusal.code, count: 1 });
    } else {
      // The grouped count mutates while the key order stays first-seen.
      found.count += 1;
    }
  }
  return table(
    "| Tool | Code | Count |",
    [...counts.values()].map((entry) => [
      cellText(entry.tool),
      cellText(entry.code),
      cellText(String(entry.count)),
    ]),
  );
}

function itemsLines(report: Report): string[] {
  if (report.items === null) {
    if (report.finalSnapshot.ok) {
      throw new ReportDataError("Report: items are null with an ok snapshot");
    }
    return [`Items: unavailable (${report.finalSnapshot.code})`];
  }
  return table(
    "| Item | Status | Reason | DoD | Pull | Retries | Stranded |",
    report.items.map((item) => [
      cellText(item.id),
      cellText(item.status),
      cell(item.statusReason),
      cellText(`${String(item.dod.done)}/${String(item.dod.total)}`),
      cell(item.pullNumber === null ? null : String(item.pullNumber)),
      cellText(String(item.retryCount)),
      cellText(item.stranded ? "yes" : "no"),
    ]),
  );
}

function unresolvedLines(report: Report): string[] {
  if (report.unresolved === null) {
    if (report.finalSnapshot.ok) {
      throw new ReportDataError("Report: unresolved is null with an ok snapshot");
    }
    return [`Unresolved: unavailable (${report.finalSnapshot.code})`];
  }
  if (report.unresolved.length === 0) {
    return ["None."];
  }
  return report.unresolved.map((key) => `- ${key}`);
}
