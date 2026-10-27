// Verdict build, comment render, and marker parse. Counts are always
// recomputed from the findings; a count reported by the model is never
// read. Findings sort by severity rank, then by location.
import type {
  AuditCounts,
  AuditFinding,
  AuditVerdict,
} from "../../contracts/v1/types.js";
import type { AuditInput } from "./audit-types.js";

const SEVERITY_RANK: Record<AuditFinding["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function recount(findings: readonly AuditFinding[]): AuditCounts {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const finding of findings) {
    if (finding.severity === "high") {
      high += 1;
    } else if (finding.severity === "medium") {
      medium += 1;
    } else {
      low += 1;
    }
  }
  return { high, medium, low };
}

function sortedFindings(findings: readonly AuditFinding[]): AuditFinding[] {
  return [...findings].sort((a, b) => {
    const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rank !== 0) {
      return rank;
    }
    return a.location < b.location ? -1 : a.location > b.location ? 1 : 0;
  });
}

export function buildVerdict(
  input: AuditInput,
  headSha: string,
  auditorModel: string,
  findings: readonly AuditFinding[],
): AuditVerdict {
  return {
    schemaVersion: "v1",
    repo: input.item.repo,
    workItemId: input.item.id,
    pullNumber: input.pullNumber,
    headSha,
    authorModels: [...input.authorModels].sort(),
    auditorModel,
    counts: recount(findings),
    findings: sortedFindings(findings),
  };
}

// Neutralize one table cell: model text cannot start an HTML comment,
// start a new line, or break the table.
function neutralize(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|");
}

export function renderComment(verdict: AuditVerdict): string | null {
  if (verdict.pullNumber === null) {
    return null;
  }
  const head =
    `<!-- audit:v1:${verdict.repo}#${String(verdict.pullNumber)}@${verdict.headSha}` +
    `:auditor=${verdict.auditorModel}:high=${String(verdict.counts.high)}` +
    `:medium=${String(verdict.counts.medium)}:low=${String(verdict.counts.low)} -->`;
  if (verdict.findings.length === 0) {
    return `${head}\n\nNo findings.`;
  }
  const rows = verdict.findings.map(
    (finding) =>
      `| ${finding.severity} | ${neutralize(finding.location)} | ${neutralize(finding.defect)} | ${neutralize(finding.scenario)} | ${neutralize(finding.fixDirection)} |`,
  );
  return [
    head,
    "",
    "| Severity | Location | Defect | Failure scenario | Fix direction |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

export const MARKER_LINE =
  /^<!-- audit:v1:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)@([0-9a-f]{40}):auditor=([A-Za-z0-9][A-Za-z0-9._/-]*):high=(0|[1-9][0-9]*):medium=(0|[1-9][0-9]*):low=(0|[1-9][0-9]*) -->$/;

export interface MarkerFields {
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  readonly auditor: string;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

export function parseMarkerLine(line: string): MarkerFields | null {
  const match = MARKER_LINE.exec(line);
  if (match === null) {
    return null;
  }
  const [, repo, numberText, sha, auditor, highText, mediumText, lowText] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const number = Number(numberText);
  const high = Number(highText);
  const medium = Number(mediumText);
  const low = Number(lowText);
  for (const value of [number, high, medium, low]) {
    if (!Number.isSafeInteger(value)) {
      return null;
    }
  }
  return { repo, number, headSha: sha, auditor, high, medium, low };
}
