// Round close: appends the RoundRecord in one loop-state write, then the
// result line, then logs the close and returns the stall decision. A
// lost or start-rejected close never counts as work; a result-line
// failure is fatal like the P6 log latch.
import type { WorkItem } from "../../contracts/v1/types.js";
import type { LoopStallConfig } from "./config.js";
import type { LoopLog } from "./log.js";
import { failuresAfter, newlyMetOf, stallDecision, type StallDecision } from "./policy.js";
import { appendResultLine, readResults, resultLineOf } from "./results.js";
import { LoopStateDataError, readLoopState, updateLoopState } from "./state.js";
import type { LoopItem, RoundAttempt, RoundOutcome, RoundRecord } from "./types.js";
import type { ProjectionContext } from "./project.js";

export interface RoundClose {
  readonly outcome: RoundOutcome;
  readonly attempt: RoundAttempt;
  readonly requestId: string | null;
  readonly model: string;
  readonly providerId: string;
  readonly hostAlias: string | null;
  readonly headSha: string | null;
  readonly failingChecks: readonly string[];
  readonly verdict: RoundRecord["verdict"];
  readonly baseRace: boolean;
}

export interface CoreContext extends ProjectionContext {
  readonly statePath: string;
  readonly resultsPath: string;
  readonly storePath: string;
  readonly stall: LoopStallConfig;
  readonly log: LoopLog;
  readonly now: () => Date;
}

export async function closeRound(
  ctx: CoreContext,
  item: WorkItem,
  close: RoundClose,
): Promise<StallDecision> {
  const built = await updateLoopState(ctx.statePath, (state) => {
    const li = state.items[item.id] as unknown as LoopItem | undefined;
    if (li === undefined) {
      throw new LoopStateDataError(`loop state ${ctx.statePath}: unknown item "${item.id}"`);
    }
    const record: RoundRecord = {
      round: li.round,
      retry: li.retry,
      requestId: close.requestId,
      model: close.model,
      providerId: close.providerId,
      hostAlias: close.hostAlias,
      attempt: close.attempt,
      outcome: close.outcome,
      headSha: close.headSha,
      failingChecks: [...close.failingChecks],
      verdict: close.verdict,
      newlyMet: [...newlyMetOf(item, li.rounds, close.outcome)],
      at: ctx.now().toISOString(),
      baseRace: close.baseRace,
    };
    const rounds = [...li.rounds, record];
    // A close from phase starting keeps rule (b): the intent is gone.
    const nextItem: Record<string, unknown> = {
      ...li,
      failures: failuresAfter(li.failures, record),
      round: li.round + 1,
      session: null,
      requestId: null,
      phase: "idle",
      start: null,
      rounds,
    };
    return Promise.resolve({
      next: { ...state, items: { ...state.items, [item.id]: nextItem } },
      value: { record, rounds, retry: li.retry },
    });
  });
  await appendResultLine(ctx.resultsPath, resultLineOf(item, built.record));
  ctx.log.log({
    event: "round-closed",
    workItemId: item.id,
    round: built.record.round,
    code: close.outcome,
  });
  return stallDecision(item.id, built.retry, built.rounds, ctx.stall);
}

export async function appendMissingResults(
  ctx: CoreContext,
  items: readonly WorkItem[],
): Promise<number> {
  const lines = await readResults(ctx.resultsPath);
  const seen = new Set(lines.map((line) => line.key));
  const state = await readLoopState(ctx.statePath);
  let appended = 0;
  for (const item of items) {
    const li = state.items[item.id] as unknown as LoopItem | undefined;
    if (li === undefined) {
      continue;
    }
    for (const record of li.rounds) {
      const key = `${item.id}:${String(record.round)}`;
      if (seen.has(key)) {
        continue;
      }
      await appendResultLine(ctx.resultsPath, resultLineOf(item, record));
      seen.add(key);
      appended += 1;
    }
  }
  return appended;
}
