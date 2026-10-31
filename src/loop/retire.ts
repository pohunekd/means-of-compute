// Session cleanup: a settled, ledgered registry entry that no loop item names
// any more belongs to a closed round, so its session and worktree are removed
// from the host. A failed retire is logged and retried after retireRetryMs; it
// never changes an item. Retired entries are remembered in memory only, so the
// first sweep after a restart asks the host once per old entry.
import type { createDispatcher } from "../dispatcher/dispatcher.js";
import type { DispatcherConfig } from "../dispatcher/config.js";
import { PortRejectedError, PortUnreachableError } from "../dispatcher/port.js";
import { readRegistry } from "../dispatcher/registry.js";
import type { LoopLog } from "./log.js";
import type { StartDispatcher } from "./start.js";
import { readLoopState } from "./state.js";
import type { LoopItem } from "./types.js";

export type SchedulerDispatcher = StartDispatcher &
  Pick<ReturnType<typeof createDispatcher>, "retire">;

export interface RetireContext {
  readonly dispatcher: Pick<SchedulerDispatcher, "retire">;
  readonly dispatcherConfig: DispatcherConfig;
  readonly statePath: string;
  readonly retireRetryMs: number;
  readonly log: LoopLog;
  readonly now: () => Date;
}

export interface RetireMemory {
  readonly done: Set<string>;
  readonly retryAt: Map<string, number>;
}

export function createRetireMemory(): RetireMemory {
  return { done: new Set(), retryAt: new Map() };
}

export async function retireClosedSessions(
  ctx: RetireContext,
  memory: RetireMemory,
): Promise<void> {
  const entries = await readRegistry(ctx.dispatcherConfig.registryPath);
  const state = await readLoopState(ctx.statePath);
  const named = new Set<string>();
  for (const value of Object.values(state.items)) {
    const li = value as unknown as LoopItem;
    if (li.requestId !== null) {
      named.add(li.requestId);
    }
    if (li.start !== null) {
      named.add(li.start.requestId);
    }
  }
  for (const entry of entries) {
    if (
      entry.sessionId === null ||
      entry.terminal === null ||
      !entry.terminal.ledgerAppended ||
      named.has(entry.requestId) ||
      memory.done.has(entry.requestId)
    ) {
      continue;
    }
    const due = memory.retryAt.get(entry.requestId);
    if (due !== undefined && ctx.now().getTime() < due) {
      continue;
    }
    try {
      await ctx.dispatcher.retire(entry.requestId);
      memory.done.add(entry.requestId);
      memory.retryAt.delete(entry.requestId);
    } catch (error: unknown) {
      if (!(error instanceof PortRejectedError) && !(error instanceof PortUnreachableError)) {
        throw error;
      }
      memory.retryAt.set(entry.requestId, ctx.now().getTime() + ctx.retireRetryMs);
      ctx.log.log({
        event: "retire-failed",
        workItemId: entry.workItemId,
        requestId: entry.requestId,
        hostAlias: entry.hostAlias,
        code: error instanceof PortRejectedError ? error.code : "unreachable",
      });
    }
  }
}
