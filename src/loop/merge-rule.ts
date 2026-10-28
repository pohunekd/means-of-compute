import { parseMarkerLine, recount, type MarkerFields } from "../auditor/verdict.js";
import type { AuditVerdict, MergeMode } from "../../contracts/v1/types.js";
import type { CheckRun, CommentFirstLine, PullRow, PullView } from "./github.js";

export type CiStatus = "pending" | "green" | "red";

export function ciStatus(runs: readonly CheckRun[], requiredChecks: readonly string[]): CiStatus {
  if (runs.length === 0) {
    return "pending";
  }
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const current = latest.get(run.name);
    if (current === undefined || run.id > current.id) {
      latest.set(run.name, run);
    }
  }
  for (const name of requiredChecks) {
    if (latest.get(name) === undefined) {
      return "pending";
    }
  }
  for (const run of latest.values()) {
    if (run.status !== "completed") {
      return "pending";
    }
  }
  const required = new Set(requiredChecks);
  for (const [name, run] of latest) {
    if (required.has(name)) {
      if (run.conclusion !== "success") {
        return "red";
      }
    } else if (
      run.conclusion !== "success" &&
      run.conclusion !== "neutral" &&
      run.conclusion !== "skipped"
    ) {
      return "red";
    }
  }
  return "green";
}

export type PullDecision =
  | { readonly kind: "adopt"; readonly pull: PullRow }
  | { readonly kind: "none" }
  | { readonly kind: "duplicate" };

export function pullDecision(rows: readonly PullRow[], factoryLogin: string): PullDecision {
  const open = rows.filter(
    (row) => row.authorLogin === factoryLogin && !row.isCrossRepository && row.state === "OPEN",
  );
  if (open.length === 0) {
    return { kind: "none" };
  }
  if (open.length > 1) {
    return { kind: "duplicate" };
  }
  const pull = open[0] as PullRow;
  return { kind: "adopt", pull };
}

export function factoryMarkers(
  comments: readonly CommentFirstLine[],
  factoryLogin: string,
): readonly MarkerFields[] {
  const markers: MarkerFields[] = [];
  for (const comment of comments) {
    if (comment.login !== factoryLogin) {
      continue;
    }
    const marker = parseMarkerLine(comment.first);
    if (marker !== null) {
      markers.push(marker);
    }
  }
  return markers;
}

export type VerdictCheck =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "findings"; readonly verdict: AuditVerdict }
  | { readonly kind: "clean"; readonly verdict: AuditVerdict };

export function verdictCheck(
  verdicts: readonly AuditVerdict[],
  pull: number,
  headSha: string,
  currentAuthors: readonly string[],
): VerdictCheck {
  const verdict = verdicts.find((entry) => entry.headSha === headSha);
  if (verdict === undefined) {
    return { kind: "missing" };
  }
  if (verdict.pullNumber !== pull) {
    return { kind: "invalid" };
  }
  const counts = recount(verdict.findings);
  if (
    counts.high !== verdict.counts.high ||
    counts.medium !== verdict.counts.medium ||
    counts.low !== verdict.counts.low
  ) {
    return { kind: "invalid" };
  }
  if (currentAuthors.includes(verdict.auditorModel)) {
    return { kind: "invalid" };
  }
  if (verdict.counts.high > 0 || verdict.counts.medium > 0) {
    return { kind: "findings", verdict };
  }
  return { kind: "clean", verdict };
}

export function markerMatches(
  markers: readonly MarkerFields[],
  repo: string,
  pull: number,
  headSha: string,
  verdict: AuditVerdict,
): boolean {
  return markers.some(
    (marker) =>
      marker.repo === repo &&
      marker.number === pull &&
      marker.headSha === headSha &&
      marker.auditor === verdict.auditorModel &&
      marker.high === verdict.counts.high &&
      marker.medium === verdict.counts.medium &&
      marker.low === verdict.counts.low,
  );
}

export type M1Result =
  | { readonly kind: "pass" }
  | { readonly kind: "draft" }
  | { readonly kind: "head-moved"; readonly headSha: string }
  | { readonly kind: "merged" }
  | {
      readonly kind: "operator";
      readonly code: "base-mismatch" | "merged-elsewhere" | "pull-closed";
    };

export function m1(view: PullView, headSha: string, baseBranch: string): M1Result {
  if (view.state === "OPEN") {
    if (view.headRefOid === headSha && view.baseRefName === baseBranch && !view.isDraft) {
      return { kind: "pass" };
    }
    if (view.baseRefName !== baseBranch) {
      return { kind: "operator", code: "base-mismatch" };
    }
    if (view.isDraft) {
      return { kind: "draft" };
    }
    return { kind: "head-moved", headSha: view.headRefOid };
  }
  if (view.state === "MERGED") {
    if (view.headRefOid === headSha && view.baseRefName === baseBranch) {
      return { kind: "merged" };
    }
    return { kind: "operator", code: "merged-elsewhere" };
  }
  return { kind: "operator", code: "pull-closed" };
}

export interface MergeInput {
  readonly view: PullView;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly ci: CiStatus;
  readonly verdict: VerdictCheck;
  readonly markerOk: boolean;
  readonly mergeMode: MergeMode;
  readonly approved: boolean;
}

export type MergeStep =
  | { readonly kind: "draft" }
  | { readonly kind: "head-moved"; readonly headSha: string }
  | { readonly kind: "merged" }
  | {
      readonly kind: "operator";
      readonly code: "base-mismatch" | "merged-elsewhere" | "pull-closed";
    }
  | { readonly kind: "ci"; readonly status: "pending" | "red" }
  | { readonly kind: "audit-missing" }
  | { readonly kind: "verdict-invalid" }
  | { readonly kind: "findings" }
  | { readonly kind: "marker-missing" }
  | { readonly kind: "awaiting-approval" }
  | { readonly kind: "ready" };

export function mergeStep(input: MergeInput): MergeStep {
  const first = m1(input.view, input.headSha, input.baseBranch);
  if (first.kind === "draft") {
    return { kind: "draft" };
  }
  if (first.kind === "head-moved") {
    return { kind: "head-moved", headSha: first.headSha };
  }
  if (first.kind === "merged") {
    return { kind: "merged" };
  }
  if (first.kind === "operator") {
    return { kind: "operator", code: first.code };
  }
  if (input.ci !== "green") {
    return { kind: "ci", status: input.ci };
  }
  if (input.verdict.kind === "missing") {
    return { kind: "audit-missing" };
  }
  if (input.verdict.kind === "invalid") {
    return { kind: "verdict-invalid" };
  }
  if (input.verdict.kind === "findings") {
    return { kind: "findings" };
  }
  if (!input.markerOk) {
    return { kind: "marker-missing" };
  }
  if (input.mergeMode === "by-rule") {
    return { kind: "ready" };
  }
  if (input.approved) {
    return { kind: "ready" };
  }
  return { kind: "awaiting-approval" };
}

export function baseCheck(parents: readonly string[], base: string, head: string): "ok" | "race" {
  if (parents.length === 2 && parents[0] === base && parents[1] === head) {
    return "ok";
  }
  return "race";
}
