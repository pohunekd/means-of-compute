// Session brief builder: the exact prompt text a started session receives.
// Pure: the driver (a later slice) supplies the branch inputs and the limit.
import type { AuditFinding, WorkItem } from "../../contracts/v1/types.js";
import type { RoundOutcome } from "./types.js";

export interface BriefFindings {
  readonly headSha: string;
  readonly list: readonly AuditFinding[];
}

export interface BriefPrevious {
  readonly outcome: RoundOutcome;
  readonly failingChecks: readonly string[];
  readonly findings: BriefFindings | null;
}

export interface BriefInput {
  readonly item: WorkItem;
  readonly branch: string;
  readonly baseBranch: string;
  readonly previous: BriefPrevious | null;
}

export type BriefResult =
  | { readonly kind: "ok"; readonly brief: string; readonly omittedFindings: number }
  | { readonly kind: "too-large"; readonly bytes: number };

export function briefBranchOf(itemBranch: string | null, branchPrefix: string, id: string): string {
  return itemBranch ?? `${branchPrefix}${id}`;
}

function headLines(input: BriefInput): string[] {
  const { item, branch, baseBranch } = input;
  return [
    `Work item ${item.id}: ${item.title}`,
    `Repository ${item.repo}. Branch ${branch} from ${baseBranch}.`,
    "",
    "Goal:",
    item.goal,
    "",
    "Definition of done:",
    ...item.dod.map((entry) => `- [ ] ${entry.id}: ${entry.text}`),
    "",
    `Rules: Commit on ${branch} and push it to origin. Do not open a pull request. Do not push to ${baseBranch}.`,
  ];
}

function findingLine(finding: AuditFinding): string {
  return `- [${finding.severity}] ${finding.location}: ${finding.defect} Fix: ${finding.fixDirection}`;
}

// The previous-round section with the first kept findings and the omission
// line when findings were dropped.
function previousLines(previous: BriefPrevious, kept: number, omitted: number): string[] {
  const lines = ["", `Previous round: ${previous.outcome}.`];
  if (previous.failingChecks.length > 0) {
    lines.push(`Failing checks: ${previous.failingChecks.join(", ")}.`);
  }
  if (previous.findings !== null && previous.findings.list.length > 0) {
    lines.push(`Audit findings at ${previous.findings.headSha.slice(0, 12)}:`);
    for (const finding of previous.findings.list.slice(0, kept)) {
      lines.push(findingLine(finding));
    }
    if (omitted > 0) {
      lines.push(`(${String(omitted)} more findings omitted)`);
    }
  }
  return lines;
}

function render(input: BriefInput, kept: number, omitted: number): string {
  const lines =
    input.previous === null
      ? headLines(input)
      : [...headLines(input), ...previousLines(input.previous, kept, omitted)];
  return `${lines.join("\n")}\n`;
}

function findingCount(input: BriefInput): number {
  return input.previous?.findings?.list.length ?? 0;
}

export function buildBrief(input: BriefInput, maxBriefBytes: number): BriefResult {
  const total = findingCount(input);
  if (total === 0) {
    const brief = render(input, 0, 0);
    const bytes = Buffer.byteLength(brief, "utf8");
    return bytes <= maxBriefBytes
      ? { kind: "ok", brief, omittedFindings: 0 }
      : { kind: "too-large", bytes };
  }
  for (let kept = total; kept >= 0; kept -= 1) {
    const omitted = total - kept;
    const brief = render(input, kept, omitted);
    if (Buffer.byteLength(brief, "utf8") <= maxBriefBytes) {
      return { kind: "ok", brief, omittedFindings: omitted };
    }
  }
  return { kind: "too-large", bytes: Buffer.byteLength(render(input, 0, total), "utf8") };
}
