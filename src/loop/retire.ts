// Session cleanup: a settled, ledgered registry entry that no loop item names
// any more belongs to a closed round, so its session and worktree are removed
// from the host and the entry is marked retiredAt, which later sweeps skip.
// An operator-parked item keeps its sessions until unpark so the operator can
// inspect them. A failed port call is logged and retried after retireRetryMs
// and never changes an item; only a registry or loop state error rejects the
// sweep. The sweep returns between entries once the scheduler stops.
import { DispatchPreconditionError, type createDispatcher } from "../dispatcher/dispatcher.js";
import type { DispatcherConfig } from "../dispatcher/config.js";
import { PortRejectedError, PortUnreachableError } from "../dispatcher/port.js";
import { RegistryDataError, readRegistry } from "../dispatcher/registry.js";
import { InputPathError } from "../fs/input.js";
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

// The log code of a failed retire: the port's refusal code, "unreachable",
// or the error's name for an error the adapter does not map.
function retireFailureCode(error: unknown): string {
  if (error instanceof PortRejectedError) {
    return error.code;
  }
  if (error instanceof PortUnreachableError) {
    return "unreachable";
  }
  return error instanceof Error ? error.name : "unknown";
}

export async function retireClosedSessions(
  ctx: RetireContext,
  memory: RetireMemory,
  isStopped: () => boolean,
): Promise<void> {
  const entries = await readRegistry(ctx.dispatcherConfig.registryPath);
  const state = await readLoopState(ctx.statePath);
  const named = new Set<string>();
  const operatorParked = new Set<string>();
  for (const [workItemId, value] of Object.entries(state.items)) {
    const li = value as unknown as LoopItem;
    if (li.requestId !== null) {
      named.add(li.requestId);
    }
    if (li.start !== null) {
      named.add(li.start.requestId);
    }
    if (li.park !== null && li.park.kind === "operator") {
      operatorParked.add(workItemId);
    }
  }
  for (const entry of entries) {
    if (isStopped()) {
      return;
    }
    if (
      entry.sessionId === null ||
      entry.terminal === null ||
      !entry.terminal.ledgerAppended ||
      entry.retiredAt !== undefined ||
      named.has(entry.requestId) ||
      operatorParked.has(entry.workItemId) ||
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
      if (
        error instanceof RegistryDataError ||
        error instanceof InputPathError ||
        error instanceof DispatchPreconditionError
      ) {
        throw error;
      }
      memory.retryAt.set(entry.requestId, ctx.now().getTime() + ctx.retireRetryMs);
      ctx.log.log({
        event: "retire-failed",
        workItemId: entry.workItemId,
        requestId: entry.requestId,
        hostAlias: entry.hostAlias,
        code: retireFailureCode(error),
      });
    }
  }
}
