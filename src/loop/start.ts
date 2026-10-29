// Driver start slice: claim, drive, watch and timeout of a work item
// start. T3 writes the session on started; S5 closes start-rejected and
// lost rounds with the Y6 exclusion fields; S7 and S8 park session errors.
import type { PlacementDecision, WorkItem } from "../../contracts/v1/types.js";
import { BudgetGateError } from "../budget/gate.js";
import type { DispatcherConfig } from "../dispatcher/config.js";
import {
  DispatchClockError,
  DispatchPreconditionError,
  DispatchStateError,
  deriveStartRequest,
  type FinishOutcome,
  type createDispatcher,
} from "../dispatcher/dispatcher.js";
import { PortRejectedError, PortUnreachableError } from "../dispatcher/port.js";
import { readRegistry } from "../dispatcher/registry.js";
import { readLedger } from "../ledger/read.js";
import { MeterUnavailableError } from "../meter/meter.js";
import { readWorkStore } from "../work/store.js";
import type { ModelChoice } from "./policy.js";
import { parkLost, parkOperator, parkStall, type ParkContext } from "./park.js";
import { reconcile } from "./project.js";
import { closeRound } from "./rounds.js";
import { LoopStateDataError, readLoopState, updateLoopState } from "./state.js";
import type { LoopItem, RoundAttempt, RoundOutcome } from "./types.js";

export type StartDispatcher = Pick<
  ReturnType<typeof createDispatcher>,
  "start" | "watch" | "cancel"
>;

export interface StartContext extends ParkContext {
  readonly dispatcher: StartDispatcher;
  readonly dispatcherConfig: DispatcherConfig;
  readonly sessionTimeoutMs: number;
  readonly unreachableRetryMs: number;
  readonly budgetBackoffMs: number;
  readonly maxStartRejections: number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface ClaimInput {
  readonly decision: PlacementDecision;
  readonly choice: ModelChoice;
  readonly brief: string;
}

export type StartStep = "running" | "publishing" | "idle" | "parked";

// Single read of the fresh loop item; an unknown id is a data error
// like in rounds.ts. The write twin below commits one L change.
async function readLoopItem(statePath: string, id: string): Promise<LoopItem> {
  const current = await updateLoopState(statePath, (state) => {
    const found = state.items[id] as unknown as LoopItem | undefined;
    if (found === undefined) {
      throw new LoopStateDataError(`loop state ${statePath}: unknown item "${id}"`);
    }
    return Promise.resolve({ next: null, value: found });
  });
  return current;
}

async function writeLoopItem(statePath: string, id: string, next: LoopItem): Promise<LoopItem> {
  return updateLoopState(statePath, (state) => {
    const current = state.items[id] as unknown as LoopItem | undefined;
    if (current === undefined) {
      throw new LoopStateDataError(`loop state ${statePath}: unknown item "${id}"`);
    }
    const stored: Record<string, unknown> = { ...(next as unknown as Record<string, unknown>) };
    return Promise.resolve({
      next: { ...state, items: { ...state.items, [id]: stored } },
      value: next,
    });
  });
}

// The step the caller reports for a stored item: parked wins, then the
// two live session phases, otherwise the item is idle to the scheduler.
function stepOf(li: LoopItem): StartStep {
  if (li.park !== null) {
    return "parked";
  }
  if (li.phase === "running") {
    return "running";
  }
  if (li.phase === "publishing") {
    return "publishing";
  }
  return "idle";
}

// A fresh loop item for a work store item with no loop state yet.
export function initialLoopItem(): LoopItem {
  return {
    phase: "idle",
    round: 0,
    retry: 0,
    park: null,
    session: null,
    fallbackUsed: false,
    start: null,
    requestId: null,
    pull: null,
    ciSince: null,
    trial: null,
    rounds: [],
    failures: {},
    excludedHosts: [],
    startRejections: 0,
    escalations: [],
    followups: [],
    humanInterventions: 0,
    finalize: null,
    auditAttempts: null,
    mergeAttempts: null,
    backoffUntil: null,
  };
}

interface StartClose {
  readonly outcome: RoundOutcome;
  readonly attempt: RoundAttempt;
  readonly requestId: string | null;
  readonly model: string;
  readonly providerId: string;
  readonly hostAlias: string | null;
}

// S5: close a start round, then park or release the item. The host
// exclusion and the rejection count join the closeRound write set (Y6),
// so a crash between the close and the park keeps the exclusion.
async function closeStart(
  ctx: StartContext,
  item: WorkItem,
  close: StartClose,
): Promise<StartStep> {
  const decision = await closeRound(ctx, item, {
    outcome: close.outcome,
    attempt: close.attempt,
    requestId: close.requestId,
    model: close.model,
    providerId: close.providerId,
    hostAlias: close.hostAlias,
    headSha: null,
    failingChecks: [],
    verdict: null,
    baseRace: false,
  });
  if (decision.kind === "park") {
    await parkStall(ctx, item, decision);
    return "parked";
  }
  if (close.outcome === "lost") {
    await parkLost(ctx, item);
    return "parked";
  }
  const stored = await readLoopItem(ctx.statePath, item.id);
  if (stored.startRejections >= ctx.maxStartRejections) {
    await parkOperator(ctx, item, "start-rejected");
    return "parked";
  }
  return "idle";
}

// S3: the started write. Clears the intent, opens the session, drops the
// exclusion list and the rejection count, then projects W to running.
async function applyStarted(ctx: StartContext, item: WorkItem, li: LoopItem): Promise<LoopItem> {
  const start = li.start;
  if (start === null || start.decision.chosenHostAlias === null) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" has no start intent to open`,
    );
  }
  const hostAlias = start.decision.chosenHostAlias;
  const next: LoopItem = {
    ...li,
    phase: "running",
    requestId: start.requestId,
    start: null,
    session: {
      hostAlias,
      providerId: start.model.providerId,
      model: start.model.model,
    },
    excludedHosts: [],
    startRejections: 0,
    fallbackUsed: li.fallbackUsed || start.model.model !== item.modelRouting.preferredModel,
  };
  const stored = await writeLoopItem(ctx.statePath, item.id, next);
  ctx.log.log({
    event: "started",
    workItemId: item.id,
    round: li.round,
    requestId: start.requestId,
    hostAlias,
  });
  await reconcile(ctx.storePath, item.id, stored, ctx);
  return stored;
}

// S2 refused path: clear the intent, stay idle, and skip the item until
// the backoff bound. A refusal closes no round and writes no W change
// beyond the projection of the idle item.
async function applyRefused(
  ctx: StartContext,
  item: WorkItem,
  li: LoopItem,
  code: string,
  detail: string,
): Promise<void> {
  const backoffUntil = new Date(ctx.now().getTime() + ctx.budgetBackoffMs).toISOString();
  await writeLoopItem(ctx.statePath, item.id, {
    ...li,
    start: null,
    phase: "idle",
    backoffUntil,
  });
  ctx.log.log({ event: "budget-refused", workItemId: item.id, code, detail });
}

// S7: park a watch or cancel error under a guard. In a running phase
// the guard is the S6 one (phase running, same requestId); in a starting
// phase it is the same-request analogue (phase starting, same intent).
// Only while the guard holds does the T12 fire; otherwise the caller
// drops the error and reports the fresh step. Anything outside the
// table is fatal and propagates.
async function parkSessionError(
  ctx: StartContext,
  item: WorkItem,
  rid: string,
  error: unknown,
  phase: "running" | "starting",
): Promise<"parked" | null> {
  let code: string;
  if (error instanceof PortRejectedError) {
    code = "watch-rejected";
  } else if (error instanceof DispatchStateError) {
    code = error.code;
  } else if (error instanceof DispatchPreconditionError) {
    code = "precondition";
  } else if (error instanceof DispatchClockError) {
    code = "clock";
  } else {
    throw error;
  }
  const fresh = await readLoopItem(ctx.statePath, item.id);
  const held =
    phase === "running"
      ? fresh.phase === "running" && fresh.requestId === rid
      : fresh.phase === "starting" && fresh.start?.requestId === rid;
  if (held) {
    await parkOperator(ctx, item, code);
    return "parked";
  }
  return null;
}

// Shared T4 tail of S4 and S6: log the terminal line, then close a lost
// round from the session or publish the item. No W change on publish.
async function applyTerminal(
  ctx: StartContext,
  item: WorkItem,
  li: LoopItem,
  rid: string,
  o: FinishOutcome,
): Promise<StartStep> {
  ctx.log.log({
    event: "terminal",
    workItemId: item.id,
    round: li.round,
    requestId: rid,
    code: o.attempt,
  });
  if (o.attempt === "lost") {
    const session = li.session;
    if (session === null) {
      throw new LoopStateDataError(
        `loop state ${ctx.statePath}: item "${item.id}" is running without a session`,
      );
    }
    return closeStart(ctx, item, {
      outcome: "lost",
      attempt: "lost",
      requestId: rid,
      model: session.model,
      providerId: session.providerId,
      hostAlias: session.hostAlias,
    });
  }
  await writeLoopItem(ctx.statePath, item.id, { ...li, phase: "publishing" });
  return "publishing";
}

// S4 A3 classifier: replay the stored terminal for a starting item. A
// ledgered rejection closes start-rejected, a lost closes lost, anything
// else opens the session (T3) and then applies the T4 tail with o.
async function classifyWatch(ctx: StartContext, item: WorkItem, li: LoopItem): Promise<StartStep> {
  const start = li.start;
  if (start === null) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" is starting without an intent`,
    );
  }
  let o: FinishOutcome;
  try {
    o = await ctx.dispatcher.watch(start.requestId);
  } catch (error: unknown) {
    const parked = await parkSessionError(ctx, item, start.requestId, error, "starting");
    if (parked !== null) {
      return parked;
    }
    return stepOf(await readLoopItem(ctx.statePath, item.id));
  }
  const intent = {
    model: start.model.model,
    providerId: start.model.providerId,
    hostAlias: start.decision.chosenHostAlias,
  };
  if (
    o.result.sessionId === null &&
    o.result.state === "failed" &&
    o.result.detail.startsWith("start-rejected: ")
  ) {
    return closeStart(ctx, item, {
      outcome: "start-rejected",
      attempt: "failure",
      requestId: start.requestId,
      ...intent,
    });
  }
  if (o.attempt === "lost") {
    return closeStart(ctx, item, {
      outcome: "lost",
      attempt: "lost",
      requestId: start.requestId,
      ...intent,
    });
  }
  const stored = await applyStarted(ctx, item, li);
  const rid = stored.requestId;
  if (rid === null) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" started without a requestId`,
    );
  }
  return applyTerminal(ctx, item, stored, rid, o);
}

// On drift, cancel every live session of the item before the park.
// A provisional entry holds no session, so it is never cancelled and
// R6 reports it as an orphan.
async function cancelLiveSessions(ctx: StartContext, item: WorkItem): Promise<void> {
  const entries = await readRegistry(ctx.dispatcherConfig.registryPath);
  for (const entry of entries) {
    if (entry.workItemId !== item.id || entry.terminal !== null || entry.sessionId === null) {
      continue;
    }
    try {
      await ctx.dispatcher.cancel(entry.requestId, "operator");
    } catch (error: unknown) {
      if (error instanceof MeterUnavailableError) {
        throw error;
      }
      if (error instanceof PortUnreachableError) {
        throw error;
      }
    }
  }
}

async function parkDrift(ctx: StartContext, item: WorkItem): Promise<StartStep> {
  try {
    await cancelLiveSessions(ctx, item);
  } catch (error: unknown) {
    if (!(error instanceof PortUnreachableError)) {
      throw error;
    }
    const unreachable = error;
    ctx.log.log({
      event: "drift-cancel-unreachable",
      workItemId: item.id,
      detail: unreachable.message,
    });
    return "idle";
  }
  await parkOperator(ctx, item, "request-drift");
  return "parked";
}

// S2: drive one start for a starting item. On started with the stored
// requestId the T3 write runs (S3); any other result follows D2, and the
// A3 classifier replays drifted or unappended entries.
export async function driveStart(ctx: StartContext, item: WorkItem): Promise<StartStep> {
  const li = await readLoopItem(ctx.statePath, item.id);
  const start = li.start;
  if (li.phase !== "starting" || start === null) {
    throw new LoopStateDataError(`loop state ${ctx.statePath}: item "${item.id}" is not starting`);
  }
  const entries = await readRegistry(ctx.dispatcherConfig.registryPath);
  const found = entries.find((entry) => entry.requestId === start.requestId);
  if (found !== undefined && found.terminal !== null) {
    return classifyWatch(ctx, item, li);
  }
  const contents = await readLedger("Loop ledger", ctx.ledgerPath);
  const derived = deriveStartRequest(
    { ...item, status: "queued", branch: start.itemBranch },
    start.decision,
    { providerId: start.model.providerId, model: start.model.model },
    start.brief,
    ctx.dispatcherConfig,
    contents,
  );
  if (derived.requestId !== start.requestId) {
    return parkDrift(ctx, item);
  }
  let outcome: Awaited<ReturnType<StartDispatcher["start"]>>;
  try {
    outcome = await ctx.dispatcher.start(
      { ...item, status: "queued", branch: start.itemBranch },
      start.decision,
      start.model,
      start.brief,
    );
  } catch (error: unknown) {
    if (error instanceof MeterUnavailableError) {
      throw error;
    }
    if (error instanceof PortUnreachableError) {
      await ctx.sleep(ctx.unreachableRetryMs);
      return driveStart(ctx, item);
    }
    if (error instanceof PortRejectedError) {
      return rejectStart(ctx, item, li, start.requestId);
    }
    if (error instanceof BudgetGateError) {
      await applyRefused(ctx, item, li, "budget-gate-error", error.message);
      return "idle";
    }
    if (error instanceof DispatchStateError) {
      if (error.code === "request-unappended") {
        return classifyWatch(ctx, item, li);
      }
      await parkOperator(ctx, item, error.code);
      return "parked";
    }
    if (error instanceof DispatchPreconditionError || error instanceof DispatchClockError) {
      await parkOperator(
        ctx,
        item,
        error instanceof DispatchPreconditionError ? "precondition" : "clock",
      );
      return "parked";
    }
    throw error;
  }
  if (outcome.kind === "refused") {
    await applyRefused(ctx, item, li, "refused", outcome.reason);
    return "idle";
  }
  if (outcome.kind === "lost") {
    return closeStart(ctx, item, {
      outcome: "lost",
      attempt: "lost",
      requestId: outcome.requestId,
      model: start.model.model,
      providerId: start.model.providerId,
      hostAlias: start.decision.chosenHostAlias,
    });
  }
  if (outcome.request.requestId !== start.requestId) {
    return parkDrift(ctx, item);
  }
  await applyStarted(ctx, item, li);
  return "running";
}

// The D2 rejected path: ledgered entries close start-rejected with the
// stored requestId, unledgered ones with a null requestId (C18/C19).
async function rejectStart(
  ctx: StartContext,
  item: WorkItem,
  li: LoopItem,
  requestId: string,
): Promise<StartStep> {
  const entries = await readRegistry(ctx.dispatcherConfig.registryPath);
  const recorded = entries.find((entry) => entry.requestId === requestId);
  const ledgered = recorded !== undefined && recorded.terminal !== null;
  const start = li.start;
  if (start === null) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" is starting without an intent`,
    );
  }
  return closeStart(ctx, item, {
    outcome: "start-rejected",
    attempt: "failure",
    requestId: ledgered ? requestId : null,
    model: start.model.model,
    providerId: start.model.providerId,
    hostAlias: start.decision.chosenHostAlias,
  });
}

// S6: watch the running session. The guard drops the result when another
// tick moved the item meanwhile; only the guarded terminal applies T4.
export async function watchSession(ctx: StartContext, item: WorkItem): Promise<StartStep> {
  const li = await readLoopItem(ctx.statePath, item.id);
  if (li.phase !== "running") {
    throw new LoopStateDataError(`loop state ${ctx.statePath}: item "${item.id}" is not running`);
  }
  const rid = li.requestId;
  if (rid === null) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" is running without a requestId`,
    );
  }
  let o: FinishOutcome;
  try {
    o = await ctx.dispatcher.watch(rid);
  } catch (error: unknown) {
    const parked = await parkSessionError(ctx, item, rid, error, "running");
    if (parked !== null) {
      return parked;
    }
    return stepOf(await readLoopItem(ctx.statePath, item.id));
  }
  const fresh = await readLoopItem(ctx.statePath, item.id);
  if (fresh.phase !== "running" || fresh.requestId !== rid) {
    return stepOf(fresh);
  }
  return applyTerminal(ctx, item, fresh, rid, o);
}

// S8: the timer tick. Without phase running it reports none; past the
// session bound it cancels once and reports cancelled. The FinishOutcome
// is ignored: only the watch result ever applies T4. A cancel that
// cannot reach the host reports pending and retries on the next tick.
export async function checkSessionTimeout(
  ctx: StartContext,
  item: WorkItem,
): Promise<"none" | "cancelled" | "pending" | "parked"> {
  const li = await readLoopItem(ctx.statePath, item.id);
  if (li.phase !== "running") {
    return "none";
  }
  const rid = li.requestId;
  if (rid === null) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" is running without a requestId`,
    );
  }
  const entries = await readRegistry(ctx.dispatcherConfig.registryPath);
  const found = entries.find((entry) => entry.requestId === rid);
  if (found === undefined || found.terminal !== null) {
    return "none";
  }
  if (ctx.now().getTime() - Date.parse(found.startedAt) < ctx.sessionTimeoutMs) {
    return "none";
  }
  try {
    await ctx.dispatcher.cancel(rid, "stall");
  } catch (error: unknown) {
    if (error instanceof PortUnreachableError) {
      return "pending";
    }
    const parked = await parkSessionError(ctx, item, rid, error, "running");
    if (parked !== null) {
      return parked;
    }
    return "none";
  }
  return "cancelled";
}

// S1: claim a ready item for a start. A fresh store item with no loop
// state gets its initial item; recovery never guesses a non-fresh one.
export async function claimStart(
  ctx: StartContext,
  item: WorkItem,
  input: ClaimInput,
): Promise<"claimed" | "parked"> {
  const stored = (await readLoopState(ctx.statePath)).items[item.id] as unknown as
    LoopItem | undefined;
  let li: LoopItem;
  if (stored === undefined) {
    const store = await readWorkStore(ctx.storePath);
    const fresh = store.items.find((entry) => entry.id === item.id);
    const pristine =
      fresh !== undefined &&
      fresh.status === "queued" &&
      fresh.retryCount === 0 &&
      fresh.stallRounds === 0 &&
      fresh.modelRouting.attempts === 0 &&
      !fresh.modelRouting.fallbackUsed &&
      fresh.branch === null &&
      fresh.pullNumber === null;
    if (!pristine) {
      throw new LoopStateDataError(`loop state missing for ${item.id}`);
    }
    li = initialLoopItem();
  } else {
    li = stored;
  }
  if (
    li.phase !== "idle" ||
    li.park !== null ||
    li.finalize !== null ||
    input.decision.chosenHostAlias === null
  ) {
    throw new LoopStateDataError(
      `loop state ${ctx.statePath}: item "${item.id}" cannot be claimed from phase "${li.phase}"`,
    );
  }
  if (li.startRejections >= ctx.maxStartRejections) {
    await parkOperator(ctx, item, "start-rejected");
    return "parked";
  }
  const contents = await readLedger("Loop ledger", ctx.ledgerPath);
  const requestId = deriveStartRequest(
    { ...item, status: "queued" },
    input.decision,
    { providerId: input.choice.providerId, model: input.choice.model },
    input.brief,
    ctx.dispatcherConfig,
    contents,
  ).requestId;
  await updateLoopState(ctx.statePath, (state) => {
    const current = (state.items[item.id] as unknown as LoopItem | undefined) ?? initialLoopItem();
    const next: LoopItem = {
      ...current,
      start: {
        round: current.round,
        decision: input.decision,
        model: { providerId: input.choice.providerId, model: input.choice.model },
        brief: input.brief,
        itemBranch: item.branch,
        requestId,
      },
      phase: "starting",
      backoffUntil: null,
    };
    return Promise.resolve({
      next: { ...state, items: { ...state.items, [item.id]: { ...next } } },
      value: undefined,
    });
  });
  ctx.log.log({
    event: "claim",
    workItemId: item.id,
    round: li.round,
    requestId,
    hostAlias: input.decision.chosenHostAlias,
  });
  if (input.choice.steered !== null) {
    ctx.log.log({
      event: "routing-steered",
      workItemId: item.id,
      code: item.modelRouting.preferredModel,
      detail: `${String(input.choice.steered.successes)}/${String(input.choice.steered.samples)}`,
    });
  }
  return "claimed";
}
