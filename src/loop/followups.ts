// Follow-up issues: one issue per low finding of the merged verdict filed
// before the item turns final, and one blocked issue when an item is
// blocked. Each issue carries a key marker, the key is recorded before the
// create, and an existing factory issue with the marker is adopted, so a
// replay files nothing twice.
import type { AuditFinding, AuditVerdict, WorkItem } from "../../contracts/v1/types.js";
import { readVerdicts } from "../auditor/store.js";
import { canonicalJson, sha256Hex } from "../work/canonical.js";
import { GitHubError } from "./github.js";
import type { ParkContext, ParkProgress } from "./park.js";
import { LoopStateDataError, readLoopItem, updateLoopState, writeLoopItem } from "./state.js";
import type { Followup, LoopItem } from "./types.js";

// The marker line every follow-up body starts with.
export function followupMarker(key: string): string {
  return `<!-- moc:followup:${key} -->`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return longest;
}

// A fence one backtick longer than the longest run inside, at least three,
// so finding text cannot render mentions, links or HTML.
export function fenced(text: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}\n${text}\n${fence}`;
}

// Titles are cut to 200 code points.
function cutTitle(title: string): string {
  return Array.from(title).slice(0, 200).join("");
}

// An inline code span: newlines become spaces, wrapped in one more backtick
// than the longest run inside, padded when the text touches the fence.
export function codeSpan(text: string): string {
  const flat = text.replace(/\n/g, " ");
  const fence = "`".repeat(longestBacktickRun(flat) + 1);
  const padded = `${flat.startsWith("`") ? " " : ""}${flat}${flat.endsWith("`") ? " " : ""}`;
  return `${fence}${padded}${fence}`;
}

export function findingFollowup(
  item: WorkItem,
  verdict: AuditVerdict,
  finding: AuditFinding,
): { key: string; kind: "finding"; title: string; body: string } {
  const key = sha256Hex(
    canonicalJson({
      repo: item.repo,
      headSha: verdict.headSha,
      location: finding.location,
      defect: finding.defect,
    }),
  ).slice(0, 16);
  const title = cutTitle(`Follow-up (${item.id}): ${finding.location}`);
  const lines = [
    followupMarker(key),
    `From the audit of ${item.repo}#${String(verdict.pullNumber)} at ${verdict.headSha} by ${verdict.auditorModel}, severity ${finding.severity}.`,
    "",
    "Location:",
    fenced(finding.location),
    "",
    "Defect:",
    fenced(finding.defect),
    "",
    "Failure scenario:",
    fenced(finding.scenario),
    "",
    "Fix direction:",
    fenced(finding.fixDirection),
  ];
  if (item.issue !== null) {
    lines.push("", `Refs #${String(item.issue)}`);
  }
  return { key, kind: "finding", title, body: `${lines.join("\n")}\n` };
}

export function blockedFollowup(
  item: WorkItem,
  li: LoopItem,
  verdict: AuditVerdict | null,
): { key: string; kind: "blocked"; title: string; body: string } {
  const key = sha256Hex(`${item.id}:blocked`).slice(0, 16);
  const title = cutTitle(`Blocked: ${item.id}`);
  const lines = [
    followupMarker(key),
    `Work item ${item.id} is blocked.`,
    "",
    "| Round | Retry | Model | Outcome | Head |",
    "|---|---|---|---|---|",
    ...li.rounds.map(
      (record) =>
        `| ${String(record.round)} | ${String(record.retry)} | ${record.model} | ${record.outcome} | ${record.headSha === null ? "-" : record.headSha.slice(0, 12)} |`,
    ),
  ];
  if (li.pull !== null) {
    lines.push("", `Pull request: #${String(li.pull.number)}`);
  }
  lines.push("", "Last audit findings:");
  if (verdict === null || verdict.findings.length === 0) {
    lines.push("- none");
  } else {
    for (const finding of verdict.findings) {
      lines.push(`- ${finding.severity} ${codeSpan(finding.location)}`);
    }
  }
  if (item.issue !== null) {
    lines.push("", `Refs #${String(item.issue)}`);
  }
  return { key, kind: "blocked", title, body: `${lines.join("\n")}\n` };
}

// The stored verdict with headSha and pull number of the loop item pull.
// A human merge with no audit at that head yields none.
export async function mergedVerdict(
  ctx: Pick<ParkContext, "verdictDir">,
  item: WorkItem,
  li: LoopItem,
): Promise<AuditVerdict | null> {
  if (li.pull === null) {
    return null;
  }
  const verdicts = await readVerdicts(ctx.verdictDir, item.id);
  const pull = li.pull;
  const found = verdicts.find(
    (verdict) => verdict.headSha === pull.headSha && verdict.pullNumber === pull.number,
  );
  return found ?? null;
}

// The verdict at the head of the last round record with a verdict.
async function lastVerdict(
  ctx: ParkContext,
  item: WorkItem,
  li: LoopItem,
): Promise<AuditVerdict | null> {
  const record = [...li.rounds].reverse().find((entry) => entry.verdict !== null);
  if (record === undefined || record.headSha === null) {
    return null;
  }
  const verdicts = await readVerdicts(ctx.verdictDir, item.id);
  return verdicts.find((verdict) => verdict.headSha === record.headSha) ?? null;
}

// One follow-up per key, in O7 order: record the key, adopt the factory
// issue with the marker, otherwise create, then record the post.
async function fileOne(
  ctx: ParkContext,
  item: WorkItem,
  draft: { key: string; kind: Followup["kind"]; title: string; body: string },
): Promise<ParkProgress> {
  const lookedUp = await updateLoopState(ctx.statePath, (state) => {
    const current = state.items[item.id] as unknown as LoopItem | undefined;
    if (current === undefined) {
      throw new LoopStateDataError(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    const held = current.followups.find((entry) => entry.key === draft.key);
    if (held !== undefined && held.posted !== null) {
      return Promise.resolve({ next: null, value: null });
    }
    if (held !== undefined) {
      return Promise.resolve({
        next: null,
        value: { marker: followupMarker(draft.key) },
      });
    }
    const entry: Followup = { key: draft.key, kind: draft.kind, posted: null };
    return Promise.resolve({
      next: {
        ...state,
        items: {
          ...state.items,
          [item.id]: { ...current, followups: [...current.followups, entry] },
        },
      },
      value: { marker: followupMarker(draft.key) },
    });
  });
  if (lookedUp === null) {
    return "done";
  }
  let posted: number;
  try {
    const label = ctx.followupLabels[0];
    if (label === undefined) {
      throw new Error("follow-ups: followupLabels is empty; the first label is the lookup label");
    }
    const rows = await ctx.github.factoryIssues(item.repo, label);
    const found = rows.find((row) => row.first === lookedUp.marker);
    posted =
      found === undefined
        ? await ctx.github.createIssue(item.repo, draft.title, draft.body, ctx.followupLabels)
        : found.number;
  } catch (error: unknown) {
    if (error instanceof GitHubError) {
      ctx.log.log({
        event: "github-error",
        workItemId: item.id,
        code: error.kind,
        detail: error.step,
      });
      return "pending";
    }
    throw error;
  }
  const filed = await readLoopItem(ctx.statePath, item.id);
  const followups = filed.followups.map((entry) =>
    entry.key === draft.key ? { ...entry, posted } : entry,
  );
  await writeLoopItem(ctx.statePath, item.id, { ...filed, followups });
  ctx.log.log({ event: "followup", workItemId: item.id, code: draft.kind, detail: draft.key });
  return "done";
}

// Files the low findings of the merged verdict in verdict order; the
// first pending filing stops the run so the next tick retries it.
export async function fileFindingFollowups(
  ctx: ParkContext,
  item: WorkItem,
): Promise<ParkProgress> {
  const li = await readLoopItem(ctx.statePath, item.id);
  const verdict = await mergedVerdict(ctx, item, li);
  if (verdict === null) {
    return "done";
  }
  for (const finding of verdict.findings) {
    if (finding.severity !== "low") {
      continue;
    }
    const filed = await fileOne(ctx, item, findingFollowup(item, verdict, finding));
    if (filed === "pending") {
      return "pending";
    }
  }
  return "done";
}

// Files the single blocked follow-up listing the last verdict findings.
export async function fileBlockedFollowup(ctx: ParkContext, item: WorkItem): Promise<ParkProgress> {
  const li = await readLoopItem(ctx.statePath, item.id);
  if (li.followups.some((entry) => entry.kind === "blocked" && entry.posted !== null)) {
    return "done";
  }
  const verdict = await lastVerdict(ctx, item, li);
  return fileOne(ctx, item, blockedFollowup(item, li, verdict));
}
