// Driver merge: take an audited item to merged under one mutex, then
// finalize the usage record. Trial and base reads use real git; the
// merge outcome closes the round through review.ts.
import { resolve } from "node:path";
import type { AuditVerdict, FactorySpec, WorkItem } from "../../contracts/v1/types.js";
import { m1, type M1Result } from "./merge-rule.js";
import { readVerdicts } from "../auditor/store.js";
import { authorModelsOf, readLedger } from "../ledger/read.js";
import { fetchRefs, isAncestor, trialMerge } from "./git.js";
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
import {
  readLoopItem,
  readLoopState,
  updateLoopState,
  writeLoopItem,
  LoopStateDataError,
} from "./state.js";
import type { LoopItem } from "./types.js";
import {
  checkoutDirOf,
  closeReviewRound,
  githubStep,
  logGithubError,
  registryBranchOf,
  type ReviewContext,
} from "./review.js";
import { fileFindingFollowups } from "./followups.js";
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

// The new head of a head-moved M1 or merge step, or null for any other kind.
function movedHeadOf(input: DecideInput): string | null {
  switch (input.kind) {
    case "early":
      return input.detail.kind === "head-moved" ? input.detail.headSha : null;
    case "full":
      return input.step.kind === "head-moved" ? input.step.headSha : null;
  }
}

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
    const moved = movedHeadOf(input);
    if (moved === null) {
      throw new LoopStateDataError(
        `loop state ${ctx.statePath}: item "${item.id}" has a head-moved step without a head`,
      );
    }
    const fresh = await readLoopItem(ctx.statePath, item.id);
    await writeLoopItem(ctx.statePath, item.id, {
      ...(await readLoopItem(ctx.statePath, item.id)),
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
    const fresh = await readLoopItem(ctx.statePath, item.id);
    if (fresh.phase === "ci") {
      return "ci";
    }
    await writeLoopItem(ctx.statePath, item.id, {
      ...(await readLoopItem(ctx.statePath, item.id)),
      phase: "ci",
      ciSince: ctx.now().toISOString(),
    });
    return "ci";
  }
  if (step.kind === "audit-missing") {
    const fresh = await readLoopItem(ctx.statePath, item.id);
    await writeLoopItem(ctx.statePath, item.id, { ...fresh, phase: "auditing" });
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
    const fresh = await readLoopItem(ctx.statePath, item.id);
    if (fresh.phase !== "auditing") {
      await writeLoopItem(ctx.statePath, item.id, {
        ...(await readLoopItem(ctx.statePath, item.id)),
        phase: "auditing",
      });
      return "auditing";
    }
    await parkOperator(ctx, item, "marker-missing");
    return "parked";
  }
  if (step.kind === "awaiting-approval") {
    const fresh = await readLoopItem(ctx.statePath, item.id);
    if (fresh.phase !== "awaiting-approval") {
      await writeLoopItem(ctx.statePath, item.id, {
        ...(await readLoopItem(ctx.statePath, item.id)),
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
  const baseStep = await githubStep(ctx, item, async () => {
    const base = await ctx.github.baseSha(item.repo, baseBranch);
    await fetchRefs(checkoutDir, ctx.git, [
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    return base;
  });
  if (!baseStep.ok) {
    return "pending";
  }
  const base = baseStep.value;
  const ancestorStep = await githubStep(ctx, item, () => isAncestor(checkoutDir, ctx.git, base, h));
  if (!ancestorStep.ok) {
    return "pending";
  }
  const ancestor = ancestorStep.value;
  const fresh = await readLoopItem(ctx.statePath, item.id);
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
    const trialStep = await githubStep(ctx, item, () =>
      trialMerge({
        dir: checkoutDir,
        scratchDir: resolve(ctx.trialMerge.scratchDir),
        id: item.id,
        baseSha: base,
        headSha: h,
        steps: ctx.trialMerge.steps,
        timeoutMs: ctx.trialMerge.timeoutMs,
        PATH: ctx.git.PATH,
        HOME: ctx.home,
      }),
    );
    if (!trialStep.ok) {
      return "pending";
    }
    const passed = trialStep.value.passed;
    const beforeTrial = await readLoopItem(ctx.statePath, item.id);
    const failedMerging = !passed && beforeTrial.phase === "merging";
    await writeLoopItem(ctx.statePath, item.id, {
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
  await writeLoopItem(ctx.statePath, item.id, {
    ...(await readLoopItem(ctx.statePath, item.id)),
    phase: "merging",
    trial: { baseSha: base, headSha: h, passed: true },
  });
  const movedStep = await githubStep(ctx, item, () => ctx.github.baseSha(item.repo, baseBranch));
  if (!movedStep.ok) {
    return "pending";
  }
  const moved = movedStep.value;
  if (moved !== base) {
    return "pending";
  }
  const prior = (await readLoopItem(ctx.statePath, item.id)).mergeAttempts;
  if (prior?.headSha === h && prior.count >= 1 + ctx.mergeRetries) {
    await parkOperator(ctx, item, "merge-failed");
    return "parked";
  }
  await writeLoopItem(ctx.statePath, item.id, {
    ...(await readLoopItem(ctx.statePath, item.id)),
    mergeAttempts: { headSha: h, count: prior?.headSha === h ? prior.count + 1 : 1 },
  });
  const mergeStepResult = await githubStep(ctx, item, () =>
    ctx.github.mergePull(item.repo, pull.number, h),
  );
  if (!mergeStepResult.ok) {
    return "pending";
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
  const li = await readLoopItem(ctx.statePath, item.id);
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
  const findings = await fileFindingFollowups(ctx, item);
  if (findings === "pending") {
    return "pending";
  }
  const fresh = await readLoopItem(ctx.statePath, item.id);
  const written = await writeLoopItem(ctx.statePath, item.id, { ...fresh, phase: "final" });
  await reconcile(ctx.storePath, item.id, written, ctx);
  return "done";
}

export async function mergeCheck(ctx: MergeContext, item: WorkItem): Promise<MergeOutcome> {
  const heads = await mergeHeads(ctx, item);
  const { li, baseBranch, pull, spec: readySpec } = heads;
  const h = pull.headSha;
  const step = await githubStep(ctx, item, () =>
    decideOnView(ctx, item, li, h, baseBranch, pull.number, readySpec),
  );
  return step.ok ? step.value : "pending";
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
  const li = await readLoopItem(ctx.statePath, item.id);
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
  const li = await readLoopItem(ctx.statePath, item.id);
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
  const li = await readLoopItem(ctx.statePath, item.id);
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
