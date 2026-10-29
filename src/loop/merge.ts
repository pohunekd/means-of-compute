// Driver merge: take an audited item to merged under one mutex, then
// finalize the usage record. Trial and base reads use real git; the
// merge outcome closes the round through review.ts.
import { resolve } from "node:path";
import type { AuditVerdict, FactorySpec, WorkItem } from "../../contracts/v1/types.js";
import { m1, type M1Result } from "./merge-rule.js";
import { readVerdicts } from "../auditor/store.js";
import { authorModelsOf, readLedger } from "../ledger/read.js";
import { fetchRefs, isAncestor, trialMerge, GitError } from "./git.js";
import { GitHubError } from "./github.js";
import {
  baseCheck,
  ciStatus,
  factoryMarkers,
  markerMatches,
  mergeStep,
  verdictCheck,
} from "./merge-rule.js";
import { escalate, finalizeItem, parkOperator } from "./park.js";
import { readLoopState, updateLoopState, LoopStateDataError } from "./state.js";
import type { LoopItem } from "./types.js";
import {
  checkoutDirOf,
  closeReviewRound,
  logGithubError,
  readReviewItem,
  registryBranchOf,
  writeReviewItem,
  type ReviewContext,
} from "./review.js";
import { reconcile } from "./project.js";
import type { ApprovalsView } from "./approvals-view.js";
import type { LoopTrialMergeConfig } from "./config.js";

export interface MergeMutex {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createMergeMutex(): MergeMutex {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = tail.then(() => fn());
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

export interface MergeContext extends ReviewContext {
  readonly specs: readonly FactorySpec[];
  readonly approvals: ApprovalsView;
  readonly mergeRetries: number;
  readonly trialMerge: LoopTrialMergeConfig;
  readonly home: string;
  readonly mergeMutex: MergeMutex;
}

type DecideInput =
  | {
      readonly kind: "early";
      early: Exclude<M1Result["kind"], "pass">;
      detail: M1Result;
      mergeCommit: string | null;
    }
  | {
      readonly kind: "full";
      step: ReturnType<typeof mergeStep>;
      verdict: ReturnType<typeof verdictCheck>;
    };

async function decideMerge(
  ctx: MergeContext,
  item: WorkItem,
  input: DecideInput,
  h: string,
  mergeCommit: string | null,
  pullNumber: number,
): Promise<MergeOutcome> {
  const tag = input.kind === "early" ? input.early : input.step.kind;
  if (tag === "draft") {
    return "pending";
  }
  if (tag === "head-moved") {
    let moved = h;
    if (input.kind === "early" && input.detail.kind === "head-moved") {
      moved = input.detail.headSha;
    } else if (input.kind === "full" && input.step.kind === "head-moved") {
      moved = input.step.headSha;
    }
    const fresh = await readReviewItem(ctx, item.id);
    await writeReviewItem(ctx, item.id, {
      ...(await readReviewItem(ctx, item.id)),
      pull: { number: pullNumber, headSha: moved },
      ciSince: ctx.now().toISOString(),
      phase: "ci",
    });
    ctx.log.log({
      event: "pull",
      workItemId: item.id,
      round: fresh.round,
      sha: moved,
      code: "moved",
    });
    return "ci";
  }
  if (tag === "merged") {
    const done = await mergedPathInternal(ctx, item, h, mergeCommit, pullNumber);
    if (done !== null) {
      return done;
    }
    throw new LoopStateDataError(`loop state ${ctx.statePath}: MERGED view without a handler`);
  }
  if (tag === "operator") {
    if (input.kind === "early") {
      if (input.detail.kind !== "operator") {
        throw new LoopStateDataError(`loop state ${ctx.statePath}: unexpected early merge result`);
      }
      await parkOperator(ctx, item, input.detail.code);
      return "parked";
    }
    if (input.step.kind !== "operator") {
      throw new LoopStateDataError(`loop state ${ctx.statePath}: unexpected merge result`);
    }
    await parkOperator(ctx, item, input.step.code);
    return "parked";
  }
  if (input.kind === "early") {
    throw new LoopStateDataError(`loop state ${ctx.statePath}: unexpected early merge result`);
  }
  const step = input.step;
  if (step.kind === "ci") {
    const fresh = await readReviewItem(ctx, item.id);
    if (fresh.phase === "ci") {
      return "ci";
    }
    await writeReviewItem(ctx, item.id, {
      ...(await readReviewItem(ctx, item.id)),
      phase: "ci",
      ciSince: ctx.now().toISOString(),
    });
    return "ci";
  }
  if (step.kind === "audit-missing") {
    const fresh = await readReviewItem(ctx, item.id);
    await writeReviewItem(ctx, item.id, { ...fresh, phase: "auditing" });
    return "auditing";
  }
  if (step.kind === "verdict-invalid") {
    await parkOperator(ctx, item, "verdict-invalid");
    return "parked";
  }
  if (step.kind === "findings") {
    const found = input.verdict.kind === "findings" ? input.verdict.verdict : null;
    await closeReviewRound(ctx, item, {
      outcome: "findings",
      headSha: h,
      failingChecks: [],
      verdict: countsOf(found),
      baseRace: false,
    });
    return "idle";
  }
  if (step.kind === "marker-missing") {
    const fresh = await readReviewItem(ctx, item.id);
    if (fresh.phase !== "auditing") {
      await writeReviewItem(ctx, item.id, {
        ...(await readReviewItem(ctx, item.id)),
        phase: "auditing",
      });
      return "auditing";
    }
    await parkOperator(ctx, item, "marker-missing");
    return "parked";
  }
  if (step.kind === "awaiting-approval") {
    const fresh = await readReviewItem(ctx, item.id);
    if (fresh.phase !== "awaiting-approval") {
      await writeReviewItem(ctx, item.id, {
        ...(await readReviewItem(ctx, item.id)),
        phase: "awaiting-approval",
      });
    }
    return "awaiting-approval";
  }
  return ctx.mergeMutex.run(() => readyMerge(ctx, item, h));
}

export type MergeOutcome =
  "ci" | "auditing" | "awaiting-approval" | "done" | "idle" | "parked" | "pending";

async function readyMerge(ctx: MergeContext, item: WorkItem, h: string): Promise<MergeOutcome> {
  const state = await readLoopState(ctx.statePath);
  if (state.mergeHold !== null) {
    return "pending";
  }
  const heads = await mergeHeads(ctx, item);
  const { checkoutDir, branch, baseBranch, pull } = heads;
  if (pull.headSha !== h) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" moved under a ready merge`,
    );
  }
  const view = await ctx.github.viewPull(item.repo, pull.number);
  const first = m1(view, h, baseBranch);
  if (first.kind !== "pass") {
    return decideMerge(
      ctx,
      item,
      { kind: "early", early: first.kind, detail: first, mergeCommit: view.mergeCommit },
      h,
      view.mergeCommit,
      pull.number,
    );
  }
  let base: string;
  try {
    base = await ctx.github.baseSha(item.repo, baseBranch);
    await fetchRefs(checkoutDir, ctx.git, [
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
  } catch (error: unknown) {
    const failure = githubErrorOf(error);
    if (failure !== null) {
      logGithubError(ctx, item, failure);
      return "pending";
    }
    throw error;
  }
  let ancestor: boolean;
  try {
    ancestor = await isAncestor(checkoutDir, ctx.git, base, h);
  } catch (error: unknown) {
    const failure = githubErrorOf(error);
    if (failure !== null) {
      logGithubError(ctx, item, failure);
      return "pending";
    }
    throw error;
  }
  const fresh = await readReviewItem(ctx, item.id);
  const trial = fresh.trial;
  const trialFresh =
    trial !== null && trial.baseSha === base && trial.headSha === h && trial.passed;
  if (!ancestor && !trialFresh) {
    if (trial !== null && trial.baseSha === base && trial.headSha === h && !trial.passed) {
      await closeReviewRound(ctx, item, {
        outcome: "trial-failed",
        headSha: h,
        failingChecks: [],
        verdict: null,
        baseRace: false,
      });
      return "idle";
    }
    let passed: boolean;
    try {
      const result = await trialMerge({
        dir: checkoutDir,
        scratchDir: resolve(ctx.trialMerge.scratchDir),
        id: item.id,
        baseSha: base,
        headSha: h,
        steps: ctx.trialMerge.steps,
        timeoutMs: ctx.trialMerge.timeoutMs,
        PATH: ctx.git.PATH,
        HOME: ctx.home,
      });
      passed = result.passed;
    } catch (error: unknown) {
      const failure = githubErrorOf(error);
      if (failure !== null) {
        logGithubError(ctx, item, failure);
        return "pending";
      }
      throw error;
    }
    const beforeTrial = await readReviewItem(ctx, item.id);
    const failedMerging = !passed && beforeTrial.phase === "merging";
    await writeReviewItem(ctx, item.id, {
      ...beforeTrial,
      phase: failedMerging ? "auditing" : beforeTrial.phase,
      trial: { baseSha: base, headSha: h, passed },
    });
    if (!passed) {
      await closeReviewRound(ctx, item, {
        outcome: "trial-failed",
        headSha: h,
        failingChecks: [],
        verdict: null,
        baseRace: false,
      });
      return "idle";
    }
  }
  await writeReviewItem(ctx, item.id, {
    ...(await readReviewItem(ctx, item.id)),
    phase: "merging",
    trial: { baseSha: base, headSha: h, passed: true },
  });
  let moved: string;
  try {
    moved = await ctx.github.baseSha(item.repo, baseBranch);
  } catch (error: unknown) {
    const failure = githubErrorOf(error);
    if (failure !== null) {
      logGithubError(ctx, item, failure);
      return "pending";
    }
    throw error;
  }
  if (moved !== base) {
    return "pending";
  }
  const prior = (await readReviewItem(ctx, item.id)).mergeAttempts;
  if (prior?.headSha === h && prior.count >= 1 + ctx.mergeRetries) {
    await parkOperator(ctx, item, "merge-failed");
    return "parked";
  }
  await writeReviewItem(ctx, item.id, {
    ...(await readReviewItem(ctx, item.id)),
    mergeAttempts: { headSha: h, count: prior?.headSha === h ? prior.count + 1 : 1 },
  });
  try {
    await ctx.github.mergePull(item.repo, pull.number, h);
  } catch (error: unknown) {
    const failure = githubErrorOf(error);
    if (failure !== null) {
      logGithubError(ctx, item, failure);
      return "pending";
    }
    throw error;
  }
  const after = await ctx.github.viewPull(item.repo, pull.number);
  if (m1(after, h, baseBranch).kind === "merged") {
    const done = await mergedPathInternal(ctx, item, h, after.mergeCommit, pull.number);
    if (done !== null) {
      return done;
    }
  }
  return "pending";
}

export async function finishMerge(ctx: MergeContext, item: WorkItem): Promise<"done" | "pending"> {
  const li = await readReviewItem(ctx, item.id);
  if (li.phase === "final") {
    return "done";
  }
  if (li.phase !== "finalizing") {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" is "${li.phase}", not "finalizing"`,
    );
  }
  const progress = await finalizeItem(ctx, item);
  if (progress === "pending") {
    return "pending";
  }
  const fresh = await readReviewItem(ctx, item.id);
  const written = await writeReviewItem(ctx, item.id, { ...fresh, phase: "final" });
  await reconcile(ctx.storePath, item.id, written, ctx);
  return "done";
}

export async function mergeCheck(ctx: MergeContext, item: WorkItem): Promise<MergeOutcome> {
  const heads = await mergeHeads(ctx, item);
  const { li, baseBranch, pull, spec: readySpec } = heads;
  const h = pull.headSha;
  try {
    return await decideOnView(ctx, item, li, h, baseBranch, pull.number, readySpec);
  } catch (error: unknown) {
    const failure = githubErrorOf(error);
    if (failure !== null) {
      logGithubError(ctx, item, failure);
      return "pending";
    }
    throw error;
  }
}

function githubErrorOf(error: unknown): GitHubError | GitError | null {
  if (error instanceof GitHubError || error instanceof GitError) {
    return error;
  }
  return null;
}

async function mergeHeads(
  ctx: MergeContext,
  item: WorkItem,
): Promise<{
  readonly li: LoopItem;
  readonly checkoutDir: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly pull: { readonly number: number; readonly headSha: string };
  readonly spec: FactorySpec;
}> {
  const li = await readReviewItem(ctx, item.id);
  if (li.phase !== "auditing" && li.phase !== "awaiting-approval" && li.phase !== "merging") {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" is "${li.phase}", not a merge phase`,
    );
  }
  const spec = ctx.specs.find((entry) => entry.repo === item.repo);
  if (spec === undefined) {
    throw new Error(`merge: no factory spec for ${item.repo}`);
  }
  if (
    li.phase === "merging" &&
    (li.trial === null || li.trial.headSha !== li.pull?.headSha || !li.trial.passed)
  ) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" is merging without a passed trial`,
    );
  }
  const pull = li.pull;
  if (pull === null) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" has no pull to merge`,
    );
  }
  const checkoutDir = checkoutDirOf(ctx, item);
  const branch = await registryBranchOf(ctx, item, li);
  return { li, checkoutDir, branch, baseBranch: ctx.dispatcherConfig.baseBranch, pull, spec };
}

type VerdictCounts = {
  readonly auditorModel: string;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
} | null;

async function storedVerdictAt(
  ctx: MergeContext,
  item: WorkItem,
  pull: number,
  headSha: string,
): Promise<AuditVerdict | null> {
  const stored = await readVerdicts(ctx.auditor.config.verdictDir, item.id);
  return stored.find((entry) => entry.pullNumber === pull && entry.headSha === headSha) ?? null;
}

function countsOf(verdict: AuditVerdict | null): VerdictCounts {
  if (verdict === null) {
    return null;
  }
  return {
    auditorModel: verdict.auditorModel,
    high: verdict.counts.high,
    medium: verdict.counts.medium,
    low: verdict.counts.low,
  };
}

async function setMergeHold(
  ctx: MergeContext,
  hold: {
    readonly mergeSha: string;
    readonly workItemId: string;
    readonly expectedBase: string;
    readonly parents: readonly string[];
    readonly since: string;
  },
): Promise<boolean> {
  return updateLoopState(ctx.statePath, (state) => {
    if (state.mergeHold !== null) {
      return Promise.resolve({ next: null, value: false });
    }
    return Promise.resolve({ next: { ...state, mergeHold: hold }, value: true });
  });
}

async function closeMerged(
  ctx: MergeContext,
  item: WorkItem,
  h: string,
  mergeCommit: string,
  race: boolean,
  humanMerge: boolean,
  pullNumber: number,
): Promise<MergeOutcome> {
  const li = await readReviewItem(ctx, item.id);
  const round = li.round;
  const requestId: string | null = li.requestId;
  await closeReviewRound(ctx, item, {
    outcome: "merged",
    headSha: h,
    failingChecks: [],
    verdict: countsOf(await storedVerdictAt(ctx, item, pullNumber, h)),
    baseRace: race,
    finalize: { humanMerge },
  });
  ctx.log.log(
    requestId === null
      ? { event: "merged", workItemId: item.id, round, sha: mergeCommit }
      : { event: "merged", workItemId: item.id, round, requestId, sha: mergeCommit },
  );
  return finishMerge(ctx, item);
}

async function mergedPathInternal(
  ctx: MergeContext,
  item: WorkItem,
  h: string,
  mergeCommit: string | null,
  pullNumber: number,
): Promise<MergeOutcome | null> {
  if (mergeCommit === null) {
    logGithubError(
      ctx,
      item,
      new GitHubError(
        "invalid-output",
        "viewPull",
        "viewPull: MERGED without a merge commit",
        "viewPull",
      ),
    );
    return "pending";
  }
  const li = await readReviewItem(ctx, item.id);
  if (li.phase !== "merging") {
    return closeMerged(ctx, item, h, mergeCommit, false, true, pullNumber);
  }
  const base = li.trial?.baseSha ?? null;
  const trialFresh = base !== null && li.trial?.headSha === h && li.trial.passed;
  if (!trialFresh) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" is merging without a passed trial`,
    );
  }
  const parents = await ctx.github.commitParents(item.repo, mergeCommit);
  if (baseCheck(parents, base, h) !== "race") {
    return closeMerged(ctx, item, h, mergeCommit, false, false, pullNumber);
  }
  if (
    await setMergeHold(ctx, {
      mergeSha: mergeCommit,
      workItemId: item.id,
      expectedBase: base,
      parents: [...parents],
      since: ctx.now().toISOString(),
    })
  ) {
    ctx.log.log({ event: "merge-base-race", workItemId: item.id, sha: mergeCommit });
  }
  const escalated = await escalate(
    ctx,
    item,
    `race:${mergeCommit}`,
    `Merge ${mergeCommit} of pull request #${String(pullNumber)} has parents ${parents.join(", ")}, not [${base}, ${h}]: the merged tree was not trial-merged.`,
  );
  if (escalated === "pending") {
    return "pending";
  }
  return closeMerged(ctx, item, h, mergeCommit, true, false, pullNumber);
}

async function decideOnView(
  ctx: MergeContext,
  item: WorkItem,
  li: LoopItem,
  h: string,
  baseBranch: string,
  pullNumber: number,
  spec: FactorySpec,
): Promise<MergeOutcome> {
  const view = await ctx.github.viewPull(item.repo, pullNumber);
  const first = m1(view, h, baseBranch);
  if (first.kind !== "pass") {
    return decideMerge(
      ctx,
      item,
      { kind: "early", early: first.kind, detail: first, mergeCommit: view.mergeCommit },
      h,
      view.mergeCommit,
      pullNumber,
    );
  }
  const runs = await ctx.github.checkRuns(item.repo, h);
  const verdict = verdictCheck(
    await readVerdicts(ctx.auditor.config.verdictDir, item.id),
    pullNumber,
    h,
    authorModelsOf(await readLedger("Loop ledger", ctx.ledgerPath), item.id),
  );
  const markerOk =
    (verdict.kind === "clean" || verdict.kind === "findings") &&
    markerMatches(
      factoryMarkers(await ctx.github.commentFirstLines(item.repo, pullNumber), ctx.factoryLogin),
      item.repo,
      pullNumber,
      h,
      verdict.verdict,
    );
  const approved =
    spec.mergeMode === "human-approval" &&
    (await ctx.approvals.approvedMerge(item.id, pullNumber, h));
  return decideMerge(
    ctx,
    item,
    {
      kind: "full",
      step: mergeStep({
        view,
        headSha: h,
        baseBranch,
        ci: ciStatus(runs, ctx.requiredChecks),
        verdict,
        markerOk,
        mergeMode: spec.mergeMode,
        approved,
      }),
      verdict,
    },
    h,
    view.mergeCommit,
    pullNumber,
  );
}
