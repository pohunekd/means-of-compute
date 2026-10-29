// Scheduler slice: one non-overlapping tick over every loop item, plus
// startup recovery. PR 9 calls recoverAtStartup once, then tick every tickMs.
import type { WorkItem } from "../../contracts/v1/types.js";
import { readVerdicts } from "../auditor/store.js";
import type { HostObservation, HostStateCollector } from "../hoststate/collector.js";
import { readRegistry } from "../dispatcher/registry.js";
import { readLoopState, updateLoopState, LoopStateDataError } from "./state.js";
import type { LoopItem, MergeHold } from "./types.js";
import type { MergeContext } from "./merge.js";
import { mergeCheck, finishMerge } from "./merge.js";
import {
  auditStep,
  ciStep,
  checkoutDirOf,
  logGithubError,
  previousRoundOf,
  publishStep,
} from "./review.js";
import type { PlacementConfig } from "../placement/config.js";
import { placeObserved } from "../placement/observed.js";
import type { LoopRoutingConfig } from "./config.js";
import { chooseModel } from "./policy.js";
import { briefBranchOf, buildBrief } from "./brief.js";
import { reconcile } from "./project.js";
import { readResults, type ResultLine } from "./results.js";
import { appendMissingResults } from "./rounds.js";
import { advancePark, escalate, parkOperator, unparkLost } from "./park.js";
import {
  checkSessionTimeout,
  claimStart,
  driveStart,
  initialLoopItem,
  watchSession,
} from "./start.js";
import { readWorkStore, readyItems } from "../work/store.js";
import { fetchRefs, isAncestor, GitError, type GitDeps } from "./git.js";
import { GitHubError, type CheckRun } from "./github.js";
import { ciStatus } from "./merge-rule.js";

function asMergeHold(value: unknown): MergeHold {
  if (value === null || typeof value !== "object") {
    throw new LoopStateDataError("loop state has a malformed merge hold");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["mergeSha"] !== "string" ||
    typeof record["workItemId"] !== "string" ||
    typeof record["expectedBase"] !== "string" ||
    !Array.isArray(record["parents"]) ||
    typeof record["since"] !== "string"
  ) {
    throw new LoopStateDataError("loop state has a malformed merge hold");
  }
  return value as MergeHold;
}

export interface SchedulerContext extends MergeContext {
  readonly collector: HostStateCollector;
  readonly placementConfig: PlacementConfig;
  readonly routing: LoopRoutingConfig;
  readonly maxActiveItems: number;
  readonly maxBriefBytes: number;
  readonly ciPollMs: number;
}

export interface TickReport {
  readonly claimed: readonly string[];
  readonly launched: readonly string[];
}

export interface Scheduler {
  tick(): Promise<TickReport>;
  stop(): void;
  settled(): Promise<void>;
}

export function createScheduler(ctx: SchedulerContext): Scheduler {
  const launches = new Map<string, { promise: Promise<unknown>; watch: boolean }>();
  const steps = new Set<string>();
  const timeouts = new Map<string, Promise<unknown>>();
  const seenOrphans = new Set<string>();
  const ciDue = new Map<string, number>();
  let stopped = false;
  let failure: unknown = null;

  function settled(): boolean {
    return stopped || failure !== null;
  }

  function fail(error: unknown): void {
    if (failure === null) {
      failure = error;
    }
  }

  function launchStep(id: string, run: () => Promise<unknown>, watch = false): void {
    if (settled()) {
      return;
    }
    const promise = run();
    launches.set(id, { promise, watch });
    steps.add(id);
    promise.then(
      () => {
        if (launches.get(id)?.promise === promise) {
          launches.delete(id);
        }
        steps.delete(id);
      },
      (error: unknown) => {
        fail(error);
        if (launches.get(id)?.promise === promise) {
          launches.delete(id);
        }
        steps.delete(id);
      },
    );
  }

  function launchTimeout(id: string, run: () => Promise<unknown>): void {
    if (settled()) {
      return;
    }
    const running = run();
    timeouts.set(id, running);
    running.then(
      () => {
        if (timeouts.get(id) === running) {
          timeouts.delete(id);
        }
      },
      (error: unknown) => {
        fail(error);
        if (timeouts.get(id) === running) {
          timeouts.delete(id);
        }
      },
    );
  }

  async function settledWait(): Promise<void> {
    for (;;) {
      const pending = [
        ...[...launches.values()].filter((entry) => !entry.watch).map((entry) => entry.promise),
        ...timeouts.values(),
      ];
      if (pending.length === 0) {
        if (failure !== null) {
          throw failure as Error;
        }
        return;
      }
      await Promise.allSettled(pending);
    }
  }

  return {
    tick: () =>
      tickOnce(
        ctx,
        launches,
        steps,
        timeouts,
        launchStep,
        launchTimeout,
        () => stopped,
        () => failure,
        seenOrphans,
        ciDue,
      ),
    stop: () => {
      stopped = true;
    },
    settled: settledWait,
  };
}

export async function recoverAtStartup(ctx: SchedulerContext): Promise<void> {
  const store = await readWorkStore(ctx.storePath);
  const state = await readLoopState(ctx.statePath);
  const missing: string[] = [];
  for (const item of store.items) {
    if (item.status !== "running" && item.status !== "review") {
      continue;
    }
    const li = state.items[item.id] as unknown as LoopItem | undefined;
    if (li === undefined || li.phase === "idle") {
      missing.push(item.id);
    }
  }
  if (missing.length > 0) {
    throw new LoopStateDataError(`loop state missing for ${missing.sort().join(", ")}`);
  }
  await appendMissingResults(ctx, store.items);
}

// One scheduler pass over the registry: log each unknown live session once
// and escalate it when its work item already has a loop item. Never cancel.
async function reportOrphans(
  ctx: SchedulerContext,
  seen: Set<string>,
  steps: ReadonlySet<string>,
): Promise<void> {
  const entries = await readRegistry(ctx.dispatcherConfig.registryPath);
  const state = await readLoopState(ctx.statePath);
  const named = new Set<string>();
  for (const li of Object.values(state.items)) {
    const item = li as unknown as LoopItem;
    if (item.requestId !== null) {
      named.add(item.requestId);
    }
    if (item.start !== null) {
      named.add(item.start.requestId);
    }
  }
  const store = await readWorkStore(ctx.storePath);
  const byId = new Map(store.items.map((entry) => [entry.id, entry] as const));
  for (const entry of entries) {
    if (entry.terminal !== null || named.has(entry.requestId)) {
      continue;
    }
    if (!seen.has(entry.requestId)) {
      seen.add(entry.requestId);
      ctx.log.log({
        event: "orphan-session",
        workItemId: entry.workItemId,
        requestId: entry.requestId,
      });
    }
    const li = state.items[entry.workItemId] as unknown as LoopItem | undefined;
    const storeItem = byId.get(entry.workItemId);
    if (li !== undefined && storeItem !== undefined && !steps.has(entry.workItemId)) {
      await escalate(
        ctx,
        storeItem,
        `orphan:${entry.requestId}`,
        `Session ${entry.requestId} runs with no loop item that names it. It was not cancelled.`,
      );
    }
  }
}

// One merge-hold clear attempt: fetch the base, then clear only when the
// stored merge is an ancestor of the base and its checks are green.
async function clearMergeHold(
  ctx: SchedulerContext,
  steps: ReadonlySet<string>,
): Promise<void> {
  const state = await readLoopState(ctx.statePath);
  if (state.mergeHold === null) {
    return;
  }
  const raw = asMergeHold(state.mergeHold);
  const store = await readWorkStore(ctx.storePath);
  const item = store.items.find((entry) => entry.id === raw.workItemId);
  if (item === undefined) {
    throw new LoopStateDataError(`loop state merge hold names unknown item ${raw.workItemId}`);
  }
  if (steps.has(item.id)) {
    return;
  }
  let base: string;
  try {
    base = await ctx.github.baseSha(item.repo, ctx.dispatcherConfig.baseBranch);
  } catch (error: unknown) {
    if (error instanceof GitHubError || error instanceof GitError) {
      logGithubError(ctx, item, error);
      return;
    }
    throw error;
  }
  const checkoutDir = checkoutDirOf(ctx, item);
  const git: GitDeps = ctx.git;
  try {
    await fetchRefs(checkoutDir, git, [
      `+refs/heads/${ctx.dispatcherConfig.baseBranch}:refs/remotes/origin/${ctx.dispatcherConfig.baseBranch}`,
    ]);
  } catch (error: unknown) {
    if (error instanceof GitHubError || error instanceof GitError) {
      logGithubError(ctx, item, error);
      return;
    }
    throw error;
  }
  let contained: boolean;
  try {
    contained = await isAncestor(checkoutDir, git, raw.mergeSha, base);
  } catch (error: unknown) {
    if (error instanceof GitHubError || error instanceof GitError) {
      logGithubError(ctx, item, error);
      return;
    }
    throw error;
  }
  let runs: readonly CheckRun[];
  try {
    runs = await ctx.github.checkRuns(item.repo, base);
  } catch (error: unknown) {
    if (error instanceof GitHubError || error instanceof GitError) {
      logGithubError(ctx, item, error);
      return;
    }
    throw error;
  }
  if (!contained || ciStatus(runs, ctx.requiredChecks) !== "green") {
    return;
  }
  const progress = await escalate(
    ctx,
    item,
    `race-cleared:${raw.mergeSha}`,
    `Merge hold for ${raw.mergeSha} cleared: ${base} contains it and its checks are green.`,
  );
  if (progress === "pending") {
    return;
  }
  const cleared = await updateLoopState(ctx.statePath, (current) => {
    const hold = current.mergeHold === null ? null : asMergeHold(current.mergeHold);
    if (hold === null || hold.mergeSha !== raw.mergeSha) {
      return Promise.resolve({ next: null, value: false });
    }
    return Promise.resolve({ next: { ...current, mergeHold: null }, value: true });
  });
  if (cleared) {
    ctx.log.log({
      event: "merge-hold-cleared",
      workItemId: raw.workItemId,
      sha: base,
    });
  }
}

interface ClaimCarry {
  active: number;
  running: WorkItem[];
  claimed: string[];
  launched: string[];
}

// One claim candidate: place it, build its brief, and start it. Returns
// false when the tick's claims end here, true to try the next candidate.
async function claimOne(
  ctx: SchedulerContext,
  item: WorkItem,
  carry: ClaimCarry,
  launchStep: (id: string, run: () => Promise<unknown>) => void,
  results: readonly ResultLine[],
  observations: readonly HostObservation[],
): Promise<boolean> {
  const state = await readLoopState(ctx.statePath);
  const stored = state.items[item.id] as unknown as LoopItem | undefined;
  const li = stored ?? initialLoopItem();
  const choice = chooseModel(item, li, results, ctx.routing);
  const filtered = observations.filter((entry) => !li.excludedHosts.includes(entry.hostAlias));
  const decision = placeObserved(item, filtered, carry.running, ctx.placementConfig);
  if (decision.chosenHostAlias === null) {
    ctx.log.log({ event: "no-host", workItemId: item.id, detail: decision.reason });
    return li.excludedHosts.length > 0;
  }
  const brief = buildBrief(
    {
      item,
      branch: briefBranchOf(item.branch, ctx.branchPrefix, item.id),
      baseBranch: ctx.dispatcherConfig.baseBranch,
      previous:
        stored === undefined
          ? null
          : previousRoundOf(li, await readVerdicts(ctx.auditor.config.verdictDir, item.id)),
    },
    ctx.maxBriefBytes,
  );
  if (brief.kind === "too-large") {
    if (stored === undefined) {
      await updateLoopState(ctx.statePath, (current) => {
        if (current.items[item.id] !== undefined) {
          return Promise.resolve({ next: null, value: undefined });
        }
        return Promise.resolve({
          next: { ...current, items: { ...current.items, [item.id]: { ...initialLoopItem() } } },
          value: undefined,
        });
      });
    }
    await parkOperator(ctx, item, "brief-too-large");
    return true;
  }
  const outcome = await claimStart(ctx, item, { decision, choice, brief: brief.brief });
  if (outcome === "parked") {
    return true;
  }
  carry.active += 1;
  carry.claimed.push(item.id);
  carry.launched.push(item.id);
  carry.running.push({ ...item, status: "running", assignedHostAlias: decision.chosenHostAlias });
  const claimed = { ...item };
  launchStep(item.id, () => driveStart(ctx, claimed));
  return true;
}

async function runClaims(
  ctx: SchedulerContext,
  steps: ReadonlySet<string>,
  launchStep: (id: string, run: () => Promise<unknown>) => void,
  carry: ClaimCarry,
  isSettled: () => boolean,
): Promise<void> {
  const store = await readWorkStore(ctx.storePath);
  const state = await readLoopState(ctx.statePath);
  const results = await readResults(ctx.resultsPath);
  const observations = await ctx.collector.collect();
  const candidates = readyItems(store).filter((item) => {
    if (steps.has(item.id)) {
      return false;
    }
    const li = state.items[item.id] as unknown as LoopItem | undefined;
    if (li !== undefined && (li.phase !== "idle" || li.park !== null || li.finalize !== null)) {
      return false;
    }
    const backoff = li?.backoffUntil ?? null;
    return backoff === null || ctx.now().getTime() >= Date.parse(backoff);
  });
  for (const item of candidates) {
    if (isSettled() || carry.active >= ctx.maxActiveItems) {
      return;
    }
    const next = await claimOne(ctx, item, carry, launchStep, results, observations);
    if (!next) {
      return;
    }
  }
}

// One step call per launch (SR3). The result is unused; the step writes
// the loop state itself. The ci call is due at most every ciPollMs.
function launchItemStep(
  ctx: SchedulerContext,
  item: WorkItem,
  li: LoopItem,
  ciDue: Map<string, number>,
  launch: (id: string, run: () => Promise<unknown>, watch?: boolean) => void,
): void {
  if (li.park !== null) {
    if (li.park.kind === "lost") {
      const target = { ...item };
      launch(item.id, () => unparkLost(ctx, target));
      return;
    }
    const target = { ...item };
    launch(item.id, () => advancePark(ctx, target));
    return;
  }
  if (li.phase === "starting") {
    const target = { ...item };
    launch(item.id, () => driveStart(ctx, target));
    return;
  }
  if (li.phase === "running") {
    const target = { ...item };
    launch(item.id, () => watchSession(ctx, target), true);
    return;
  }
  if (li.phase === "publishing") {
    const target = { ...item };
    launch(item.id, () => publishStep(ctx, target));
    return;
  }
  if (li.phase === "ci") {
    const last = ciDue.get(item.id) ?? null;
    if (last === null || ctx.now().getTime() - last >= ctx.ciPollMs) {
      ciDue.set(item.id, ctx.now().getTime());
      const target = { ...item };
      launch(item.id, () => ciStep(ctx, target));
    }
    return;
  }
  if (li.phase === "auditing") {
    const target = { ...item };
    launch(item.id, async () => {
      const outcome = await auditStep(ctx, target);
      if (outcome === "audited") {
        await mergeCheck(ctx, target);
      }
    });
    return;
  }
  if (li.phase === "awaiting-approval" || li.phase === "merging") {
    const target = { ...item };
    launch(item.id, () => mergeCheck(ctx, target));
    return;
  }
  if (li.phase === "finalizing") {
    const target = { ...item };
    launch(item.id, () => finishMerge(ctx, target));
  }
}

// One tick in SR2 order: append results, report orphans, clear the hold,
// reconcile and launch one step call per item plus the timeout call, then
// claim. Every step is awaited except the launched calls themselves.
async function tickOnce(
  ctx: SchedulerContext,
  launches: Map<string, { promise: Promise<unknown>; watch: boolean }>,
  steps: Set<string>,
  timeouts: Map<string, Promise<unknown>>,
  launchStep: (id: string, run: () => Promise<unknown>, watch?: boolean) => void,
  launchTimeout: (id: string, run: () => Promise<unknown>) => void,
  isStopped: () => boolean,
  getFailure: () => unknown,
  seenOrphans: Set<string>,
  ciDue: Map<string, number>,
): Promise<TickReport> {
  if (isStopped()) {
    return { claimed: [], launched: [] };
  }
  const failure = getFailure();
  if (failure !== null) {
    throw failure as Error;
  }
  const store = await readWorkStore(ctx.storePath);
  await appendMissingResults(ctx, store.items);
  await reportOrphans(ctx, seenOrphans, steps);
  const holdState = await readLoopState(ctx.statePath);
  if (holdState.mergeHold !== null) {
    await clearMergeHold(ctx, steps);
  }
  const launched: string[] = [];
  const fresh = await readWorkStore(ctx.storePath);
  for (const item of fresh.items) {
    if (steps.has(item.id)) {
      continue;
    }
    const reread = await readLoopState(ctx.statePath);
    const li = reread.items[item.id] as unknown as LoopItem | undefined;
    if (li === undefined) {
      continue;
    }
    await reconcile(ctx.storePath, item.id, li, ctx);
    launchItemStep(ctx, item, li, ciDue, (id, run) => {
      if (isStopped() || getFailure() !== null) {
        return;
      }
      launchStep(id, run);
      launched.push(id);
    });
  }
  const runningState = await readLoopState(ctx.statePath);
  const runningStore = await readWorkStore(ctx.storePath);
  for (const item of runningStore.items) {
    if (timeouts.has(item.id)) {
      continue;
    }
    const li = runningState.items[item.id] as unknown as LoopItem | undefined;
    if (li === undefined || li.phase !== "running") {
      continue;
    }
    const target = { ...item };
    launchTimeout(item.id, () => checkSessionTimeout(ctx, target));
  }
  const carry: ClaimCarry = { active: 0, running: [], claimed: [], launched: [] };
  const counted = await readWorkStore(ctx.storePath);
  const countedState = await readLoopState(ctx.statePath);
  for (const item of counted.items) {
    const li = countedState.items[item.id] as unknown as LoopItem | undefined;
    if (li !== undefined && li.phase !== "idle" && li.phase !== "final") {
      carry.active += 1;
    }
  }
  carry.running = counted.items.filter((entry) => entry.status === "running");
  for (const item of counted.items) {
    const li = countedState.items[item.id] as unknown as LoopItem | undefined;
    if (li !== undefined && li.phase === "starting" && li.start !== null) {
      carry.running.push({
        ...item,
        status: "running",
        assignedHostAlias: li.start.decision.chosenHostAlias,
      });
    }
  }
  const paused = await ctx.approvals.fleetPaused();
  if (!paused) {
    await runClaims(
      ctx,
      steps,
      (id, run) => {
        if (isStopped() || getFailure() !== null) {
          return;
        }
        launchStep(id, run);
        carry.launched.push(id);
      },
      carry,
      () => isStopped() || getFailure() !== null,
    );
  }
  return { claimed: carry.claimed, launched: [...launched, ...carry.launched] };
}
