import { resolve } from "node:path";
import type { AuditDeps } from "../auditor/audit-types.js";
import { AuditModelError } from "../auditor/reply.js";
import { runAudit } from "../auditor/audit.js";
import { createReadOnlyGit } from "../auditor/git.js";
import { readVerdicts } from "../auditor/store.js";
import { renderComment } from "../auditor/verdict.js";
import type { AuditVerdict, WorkItem } from "../../contracts/v1/types.js";
import { BudgetGateError } from "../budget/gate.js";
import { InputPathError } from "../fs/input.js";
import { authorModelsOf, readLedger } from "../ledger/read.js";
import type { LoopRepoConfig } from "./config.js";
import { fetchRefs, GitError, type GitDeps, remoteBranchSha, revParse } from "./git.js";
import {
  ciStatus,
  factoryMarkers,
  markerMatches,
  pullDecision,
  verdictCheck,
} from "./merge-rule.js";
import { GitHubError, utf8Prefix, type CheckRun, type GitHubPort } from "./github.js";
import type { BriefPrevious } from "./brief.js";
import { parkOperator, parkStall, type ParkContext } from "./park.js";
import { reconcile } from "./project.js";
import { closeRound, type RoundClose } from "./rounds.js";
import { updateLoopState, LoopStateDataError } from "./state.js";
import type { LoopItem, RoundAttempt, RoundOutcome } from "./types.js";
import type { StartContext } from "./start.js";

export interface ReviewContext extends StartContext {
  readonly repos: readonly LoopRepoConfig[];
  readonly git: GitDeps;
  readonly requiredChecks: readonly string[];
  readonly ciTimeoutMs: number;
  readonly auditRetries: number;
  readonly auditor: Pick<AuditDeps, "config" | "budget" | "call">;
}

export type ReviewStep = "ci" | "auditing" | "audited" | "idle" | "parked" | "pending";

export function failingChecksOf(
  runs: readonly CheckRun[],
  requiredChecks: readonly string[],
): readonly string[] {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const current = latest.get(run.name);
    if (current === undefined || run.id > current.id) {
      latest.set(run.name, run);
    }
  }
  const required = new Set(requiredChecks);
  const failing: string[] = [];
  for (const [name, run] of latest) {
    if (run.status !== "completed") {
      continue;
    }
    const conclusion = run.conclusion;
    if (conclusion === "success" || conclusion === "neutral") {
      continue;
    }
    if (conclusion === "skipped") {
      if (required.has(name)) {
        failing.push(name);
      }
      continue;
    }
    failing.push(name);
  }
  failing.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return failing;
}

export function previousRoundOf(
  li: LoopItem,
  verdicts: readonly AuditVerdict[],
): BriefPrevious | null {
  let last: (typeof li.rounds)[number] | null = null;
  for (const record of li.rounds) {
    if (record.outcome === "start-rejected" || record.outcome === "lost") {
      continue;
    }
    last = record;
  }
  if (last === null) {
    return null;
  }
  let audited: { readonly headSha: string; readonly verdict: AuditVerdict } | null = null;
  for (const record of li.rounds) {
    if (record.verdict === null) {
      continue;
    }
    const verdict = verdicts.find((entry) => entry.headSha === record.headSha);
    if (verdict !== undefined && record.headSha !== null) {
      audited = { headSha: record.headSha, verdict };
    }
  }
  return {
    outcome: last.outcome,
    failingChecks: [...last.failingChecks],
    findings:
      audited === null ? null : { headSha: audited.headSha, list: audited.verdict.findings },
  };
}

interface ReviewHeads {
  readonly li: LoopItem;
  readonly checkoutDir: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly pull: { readonly number: number; readonly headSha: string };
}

async function readReviewItem(ctx: ReviewContext, id: string): Promise<LoopItem> {
  return updateLoopState(ctx.statePath, (state) => {
    const found = state.items[id] as unknown as LoopItem | undefined;
    if (found === undefined) {
      throw new LoopStateDataError(`loop state ${ctx.statePath}: unknown item "${id}"`);
    }
    return Promise.resolve({ next: null, value: found });
  });
}

async function writeReviewItem(ctx: ReviewContext, id: string, next: LoopItem): Promise<LoopItem> {
  return updateLoopState(ctx.statePath, (state) => {
    const current = state.items[id] as unknown as LoopItem | undefined;
    if (current === undefined) {
      throw new LoopStateDataError(`loop state ${ctx.statePath}: unknown item "${id}"`);
    }
    const stored: Record<string, unknown> = { ...(next as unknown as Record<string, unknown>) };
    return Promise.resolve({
      next: { ...state, items: { ...state.items, [id]: stored } },
      value: next,
    });
  });
}

function checkoutDirOf(ctx: ReviewContext, item: WorkItem): string {
  const entry = ctx.repos.find((candidate) => candidate.repo === item.repo);
  if (entry === undefined) {
    throw new Error(`review: no checkout for ${item.repo}`);
  }
  return resolve(entry.checkoutDir);
}

async function requireHeads(
  ctx: ReviewContext,
  item: WorkItem,
  phase: "publishing" | "ci" | "auditing",
): Promise<ReviewHeads> {
  const li = await readReviewItem(ctx, item.id);
  if (li.phase !== phase) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" is "${li.phase}", not "${phase}"`,
    );
  }
  const pull = li.pull;
  if (pull === null) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" has no pull in "${phase}"`,
    );
  }
  if (phase === "ci" && li.ciSince === null) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" has no ciSince in "ci"`,
    );
  }
  const checkoutDir = checkoutDirOf(ctx, item);
  const branch = `${ctx.branchPrefix}${item.id}`;
  const baseBranch = ctx.dispatcherConfig.baseBranch;
  return { li, checkoutDir, branch, baseBranch, pull };
}

function logGithubError(ctx: ReviewContext, item: WorkItem, error: GitHubError | GitError): void {
  ctx.log.log({
    event: "github-error",
    workItemId: item.id,
    code: error.kind,
    detail: error.step,
  });
}

async function reviewAttemptOf(
  ctx: ReviewContext,
  requestId: string | null,
): Promise<RoundAttempt> {
  if (requestId === null) {
    throw new LoopStateDataError(`loop state ${ctx.statePath}: item has no request to replay`);
  }
  const outcome = await ctx.dispatcher.watch(requestId);
  if (outcome.attempt === "lost") {
    throw new LoopStateDataError(`loop state ${ctx.statePath}: replayed a lost session`);
  }
  return outcome.attempt;
}

interface AddedOutcome {
  readonly requestId: string | null;
}

async function closeReviewRound(
  ctx: ReviewContext,
  item: WorkItem,
  added: AddedOutcome,
  outcome: RoundOutcome,
  headSha: string | null,
  failingChecks: readonly string[],
): Promise<ReviewStep> {
  void added;
  const fresh = await readReviewItem(ctx, item.id);
  if (fresh.session === null) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" has no session for a red close`,
    );
  }
  const session = fresh.session;
  const close: RoundClose = {
    outcome,
    attempt: await reviewAttemptOf(ctx, fresh.requestId),
    requestId: fresh.requestId,
    model: session.model,
    providerId: session.providerId,
    hostAlias: session.hostAlias,
    headSha,
    failingChecks,
    verdict: null,
    baseRace: false,
  };
  const decision = await closeRound(ctx, item, close);
  if (decision.kind === "park") {
    await parkStall(ctx, item, decision);
    return "parked";
  }
  const stored = await readReviewItem(ctx, item.id);
  await reconcile(ctx.storePath, item.id, stored, ctx);
  return "idle";
}

function pullBodyOf(item: WorkItem): string {
  const lines = [`<!-- moc:work-item:${item.id} -->`];
  if (item.issue !== null) {
    lines.push(`Refs #${String(item.issue)}`);
  }
  lines.push("", "Definition of done:");
  for (const entry of item.dod) {
    lines.push(`- [ ] ${entry.id}: ${entry.text}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function publishStep(ctx: ReviewContext, item: WorkItem): Promise<ReviewStep> {
  const li = await readReviewItem(ctx, item.id);
  if (li.phase !== "publishing") {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" is "${li.phase}", not "publishing"`,
    );
  }
  const checkoutDir = checkoutDirOf(ctx, item);
  const branch = `${ctx.branchPrefix}${item.id}`;
  const baseBranch = ctx.dispatcherConfig.baseBranch;
  const attempt = await reviewAttemptOf(ctx, li.requestId);
  let decision: ReturnType<typeof pullDecision>;
  let head: string | null;
  try {
    decision = pullDecision(await ctx.github.pullsForBranch(item.repo, branch), ctx.factoryLogin);
    if (decision.kind === "duplicate") {
      await parkOperator(ctx, item, "duplicate-pulls");
      return "parked";
    }
    if (decision.kind === "adopt") {
      head = decision.pull.headRefOid;
    } else {
      head = await remoteBranchSha(checkoutDir, ctx.git, branch);
    }
  } catch (error: unknown) {
    if (error instanceof GitHubError || error instanceof GitError) {
      logGithubError(ctx, item, error);
      return "pending";
    }
    throw error;
  }
  if (head === null) {
    const outcome = attempt === "success" ? "no-push" : "session-failed";
    return closeReviewRound(ctx, item, { requestId: li.requestId }, outcome, null, []);
  }
  if (li.pull !== null && head === li.pull.headSha) {
    const outcome = attempt === "success" ? "no-new-commit" : "session-failed";
    return closeReviewRound(ctx, item, { requestId: li.requestId }, outcome, head, []);
  }
  let number: number;
  let code: string;
  if (decision.kind === "adopt") {
    number = decision.pull.number;
    code = "adopted";
  } else {
    try {
      number = await ctx.github.createPull(
        item.repo,
        branch,
        baseBranch,
        item.title,
        pullBodyOf(item),
      );
    } catch (error: unknown) {
      if (error instanceof GitHubError || error instanceof GitError) {
        logGithubError(ctx, item, error);
        return "pending";
      }
      throw error;
    }
    code = "created";
  }
  const now = ctx.now().toISOString();
  const round = (await readReviewItem(ctx, item.id)).round;
  const stored = await writeReviewItem(ctx, item.id, {
    ...(await readReviewItem(ctx, item.id)),
    pull: { number, headSha: head },
    ciSince: now,
    phase: "ci",
  });
  ctx.log.log({ event: "pull", workItemId: item.id, round, sha: head, code });
  await reconcile(ctx.storePath, item.id, stored, ctx);
  return "ci";
}

export async function ciStep(ctx: ReviewContext, item: WorkItem): Promise<ReviewStep> {
  const heads = await requireHeads(ctx, item, "ci");
  const { li, pull } = heads;
  try {
    const view = await ctx.github.viewPull(item.repo, pull.number);
    if (view.state === "OPEN" && view.headRefOid !== pull.headSha) {
      const now = ctx.now().toISOString();
      await writeReviewItem(ctx, item.id, {
        ...(await readReviewItem(ctx, item.id)),
        pull: { number: pull.number, headSha: view.headRefOid },
        ciSince: now,
      });
      ctx.log.log({
        event: "pull",
        workItemId: item.id,
        round: li.round,
        sha: view.headRefOid,
        code: "moved",
      });
      return "ci";
    }
  } catch (error: unknown) {
    if (error instanceof GitHubError || error instanceof GitError) {
      logGithubError(ctx, item, error);
      return "pending";
    }
    throw error;
  }
  let runs: readonly CheckRun[];
  try {
    runs = await ctx.github.checkRuns(item.repo, pull.headSha);
  } catch (error: unknown) {
    if (error instanceof GitHubError || error instanceof GitError) {
      logGithubError(ctx, item, error);
      return "pending";
    }
    throw error;
  }
  const status = ciStatus(runs, ctx.requiredChecks);
  if (status === "green") {
    await writeReviewItem(ctx, item.id, {
      ...(await readReviewItem(ctx, item.id)),
      phase: "auditing",
    });
    ctx.log.log({
      event: "ci",
      workItemId: item.id,
      round: li.round,
      sha: pull.headSha,
      code: "green",
    });
    return "auditing";
  }
  if (status === "red") {
    ctx.log.log({
      event: "ci",
      workItemId: item.id,
      round: li.round,
      sha: pull.headSha,
      code: "red",
    });
    return closeReviewRound(
      ctx,
      item,
      { requestId: li.requestId },
      "red-ci",
      pull.headSha,
      failingChecksOf(runs, ctx.requiredChecks),
    );
  }
  const since = li.ciSince;
  if (since !== null && ctx.now().getTime() - Date.parse(since) >= ctx.ciTimeoutMs) {
    ctx.log.log({
      event: "ci",
      workItemId: item.id,
      round: li.round,
      sha: pull.headSha,
      code: "timeout",
    });
    return closeReviewRound(ctx, item, { requestId: li.requestId }, "ci-timeout", pull.headSha, []);
  }
  return "ci";
}

async function postVerdict(
  ctx: ReviewContext,
  item: WorkItem,
  v: AuditVerdict,
  h: string,
  round: number,
): Promise<ReviewStep> {
  const heads = await requireHeads(ctx, item, "auditing");
  const authors = authorModelsOf(await readLedger("Loop ledger", ctx.ledgerPath), item.id);
  const check = verdictCheck([v], heads.pull.number, h, authors);
  if (check.kind === "invalid") {
    return "audited";
  }
  let markers: ReturnType<typeof factoryMarkers>;
  try {
    markers = factoryMarkers(
      await ctx.github.commentFirstLines(item.repo, heads.pull.number),
      ctx.factoryLogin,
    );
  } catch (error: unknown) {
    if (error instanceof GitHubError || error instanceof GitError) {
      logGithubError(ctx, item, error);
      return "pending";
    }
    throw error;
  }
  if (markerMatches(markers, item.repo, heads.pull.number, h, v)) {
    return "audited";
  }
  try {
    const body = renderComment(v);
    if (body !== null) {
      await ctx.github.postComment(item.repo, heads.pull.number, body);
    }
  } catch (error: unknown) {
    if (error instanceof GitHubError || error instanceof GitError) {
      logGithubError(ctx, item, error);
      return "pending";
    }
    throw error;
  }
  ctx.log.log({ event: "verdict", workItemId: item.id, round, sha: h, code: check.kind });
  return "audited";
}

async function auditRefusedStep(
  ctx: ReviewContext,
  item: WorkItem,
  li: LoopItem,
  h: string,
  reason: string,
): Promise<ReviewStep> {
  if (reason.startsWith("verdict exists for ")) {
    try {
      const stored = await readVerdicts(ctx.auditor.config.verdictDir, item.id);
      const atHead = stored.find((entry) => entry.headSha === h);
      if (atHead !== undefined) {
        return postVerdict(ctx, item, atHead, h, li.round);
      }
    } catch (error: unknown) {
      return auditErrorStep(ctx, item, li, h, error);
    }
    return auditErrorStep(ctx, item, li, h, new Error(reason));
  }
  if (reason.startsWith("nothing to audit at ")) {
    return closeReviewRound(ctx, item, { requestId: li.requestId }, "empty-diff", h, []);
  }
  if (reason.startsWith("diff too large for one audit ")) {
    return closeReviewRound(ctx, item, { requestId: li.requestId }, "diff-too-large", h, []);
  }
  if (reason.startsWith("no eligible auditor")) {
    await parkOperator(ctx, item, "no-eligible-auditor");
    return "parked";
  }
  if (reason.startsWith("no author models recorded for ")) {
    await parkOperator(ctx, item, "no-authors");
    return "parked";
  }
  if (reason.startsWith("budget: ")) {
    const fresh = await readReviewItem(ctx, item.id);
    const prior = fresh.auditAttempts ?? li.auditAttempts;
    await writeReviewItem(ctx, item.id, {
      ...(await readReviewItem(ctx, item.id)),
      backoffUntil: new Date(ctx.now().getTime() + ctx.budgetBackoffMs).toISOString(),
      auditAttempts: prior,
    });
    ctx.log.log({
      event: "budget-refused",
      workItemId: item.id,
      code: "refused",
      detail: reason.slice("budget: ".length),
    });
    return "pending";
  }
  return auditErrorStep(ctx, item, li, h, new Error(reason), utf8Prefix(reason, 300));
}

function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

async function auditErrorStep(
  ctx: ReviewContext,
  item: WorkItem,
  li: LoopItem,
  h: string,
  error: unknown,
  refusedDetail?: string,
): Promise<ReviewStep> {
  const cause = causeOf(error);
  if (error instanceof InputPathError || cause instanceof InputPathError) {
    throw error;
  }
  if (cause instanceof BudgetGateError) {
    const fresh = await readReviewItem(ctx, item.id);
    const prior = fresh.auditAttempts ?? li.auditAttempts;
    await writeReviewItem(ctx, item.id, {
      ...(await readReviewItem(ctx, item.id)),
      backoffUntil: new Date(ctx.now().getTime() + ctx.budgetBackoffMs).toISOString(),
      auditAttempts: prior,
    });
    ctx.log.log({
      event: "budget-refused",
      workItemId: item.id,
      code: "budget-gate-error",
      detail: error instanceof Error ? error.message : String(error),
    });
    return "pending";
  }
  if (error instanceof AuditModelError) {
    ctx.log.log({
      event: "audit-error",
      workItemId: item.id,
      round: li.round,
      sha: h,
      code: "audit-model-error",
    });
    return "pending";
  }
  const detail =
    refusedDetail ?? utf8Prefix(error instanceof Error ? error.message : String(error), 300);
  ctx.log.log({
    event: "audit-error",
    workItemId: item.id,
    round: li.round,
    sha: h,
    code: "audit-error",
    detail,
  });
  await parkOperator(ctx, item, "audit-error");
  return "parked";
}

export async function auditStep(ctx: ReviewContext, item: WorkItem): Promise<ReviewStep> {
  const heads = await requireHeads(ctx, item, "auditing");
  const { li, checkoutDir, branch, baseBranch, pull } = heads;
  if (li.backoffUntil !== null && ctx.now().getTime() < Date.parse(li.backoffUntil)) {
    return "pending";
  }
  let h: string;
  try {
    await fetchRefs(checkoutDir, ctx.git, [
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    h = await revParse(checkoutDir, ctx.git, `refs/remotes/origin/${branch}`);
  } catch (error: unknown) {
    if (error instanceof GitHubError || error instanceof GitError) {
      logGithubError(ctx, item, error);
      return "pending";
    }
    throw error;
  }
  if (h !== pull.headSha) {
    const now = ctx.now().toISOString();
    await writeReviewItem(ctx, item.id, {
      ...(await readReviewItem(ctx, item.id)),
      pull: { number: pull.number, headSha: h },
      ciSince: now,
      phase: "ci",
    });
    ctx.log.log({ event: "pull", workItemId: item.id, round: li.round, sha: h, code: "moved" });
    return "ci";
  }
  let stored: readonly AuditVerdict[];
  try {
    stored = await readVerdicts(ctx.auditor.config.verdictDir, item.id);
  } catch (error: unknown) {
    return auditErrorStep(ctx, item, li, h, error);
  }
  const atHead = stored.find((entry) => entry.headSha === h);
  if (atHead !== undefined) {
    return postVerdict(ctx, item, atHead, h, li.round);
  }
  const prior = li.auditAttempts;
  if (prior?.headSha === h && prior.count >= 1 + ctx.auditRetries) {
    await parkOperator(ctx, item, "audit-failed");
    return "parked";
  }
  await writeReviewItem(ctx, item.id, {
    ...(await readReviewItem(ctx, item.id)),
    auditAttempts: { headSha: h, count: prior?.headSha === h ? prior.count + 1 : 1 },
    backoffUntil: null,
  });
  let authors: readonly string[];
  let outcome: Awaited<ReturnType<typeof runAudit>>;
  try {
    authors = authorModelsOf(await readLedger("Loop ledger", ctx.ledgerPath), item.id);
    outcome = await runAudit(
      {
        item,
        repoDir: checkoutDir,
        ref: h,
        baseRef: `origin/${baseBranch}`,
        pullNumber: pull.number,
        phaseCritical: false,
        authorModels: authors,
      },
      {
        ...ctx.auditor,
        git: createReadOnlyGit(checkoutDir),
        ledgerPath: ctx.ledgerPath,
        now: ctx.now,
      },
    );
  } catch (error: unknown) {
    return auditErrorStep(ctx, item, li, h, error);
  }
  if (outcome.kind === "verdict") {
    return postVerdict(ctx, item, outcome.verdict, h, li.round);
  }
  return auditRefusedStep(ctx, item, li, h, outcome.reason);
}
