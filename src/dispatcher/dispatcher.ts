// Dispatcher service: starts sessions through DispatcherPort, watches them
// to a terminal state, and records terminal usage in the ledger. Everything
// outside src/dispatcher/ uses this service or the port type, never an
// adapter. The budget gate is called only in start; watch, diff and cancel
// never call it.
import { isPlacementDecision, isWorkItem } from "../../contracts/v1/validate.js";
import type {
  PlacementDecision,
  TokenUsage,
  WorkItem,
} from "../../contracts/v1/types.js";
import type { BudgetGate } from "../budget/gate.js";
import { readInputText, statInputPath } from "../fs/input.js";
import { readLedger } from "../ledger/read.js";
import { appendPending } from "../ledger/store.js";
import type { PendingUsage, WriteOutcome } from "../ledger/types.js";
import type { DispatcherConfig } from "./config.js";
import type {
  CancelReason,
  DiffResult,
  DispatcherPort,
  ModelSelection,
  PortUsage,
  SessionHandle,
  StartRequest,
  TerminalState,
  WaitResult,
} from "./port.js";
import { PortRejectedError, PortUnreachableError } from "./port.js";
import { readRegistry, writeRegistry } from "./registry.js";
import type { RegistryEntry } from "./registry.js";

export interface DispatcherDeps {
  readonly port: DispatcherPort;
  readonly budget: BudgetGate;
  readonly ledgerPath: string;
  readonly config: DispatcherConfig;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (event: DispatchLogEvent) => void;
}

export interface DispatchLogEvent {
  readonly level: "info" | "error";
  readonly event: string;
  readonly requestId?: string;
  readonly workItemId?: string;
  readonly sessionId?: string;
  readonly detail?: string;
}

export type StartOutcome =
  | { readonly kind: "started"; readonly handle: SessionHandle; readonly request: StartRequest }
  | { readonly kind: "refused"; readonly reason: string };

export interface FinishOutcome {
  readonly result: Extract<WaitResult, { state: TerminalState }>;
  readonly attempt: "success" | "failure" | "stalled" | "lost";
  readonly ledger: WriteOutcome;
}

export class DispatchPreconditionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DispatchPreconditionError";
  }
}

export class DispatchClockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DispatchClockError";
  }
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function attemptOf(
  state: TerminalState,
  cancelReason: CancelReason | null,
): "success" | "failure" | "stalled" | "lost" {
  if (state === "finished") {
    return "success";
  }
  if (state === "failed") {
    return "failure";
  }
  if (state === "lost") {
    return "lost";
  }
  return cancelReason === "stall" ? "stalled" : "failure";
}

function isValidPortToken(token: TokenUsage): boolean {
  if (typeof token.provider !== "string" || token.provider.length === 0) {
    return false;
  }
  if (typeof token.model !== "string" || token.model.length === 0) {
    return false;
  }
  if (typeof token.source !== "string" || token.source.length === 0) {
    return false;
  }
  if (
    token.inputTokens !== null &&
    (!Number.isInteger(token.inputTokens) || (token.inputTokens as number) < 0)
  ) {
    return false;
  }
  if (
    token.outputTokens !== null &&
    (!Number.isInteger(token.outputTokens) || (token.outputTokens as number) < 0)
  ) {
    return false;
  }
  if (!Number.isInteger(token.requests) || (token.requests as number) < 0) {
    return false;
  }
  return true;
}

function checkUsageValid(usage: PortUsage): boolean {
  if (usage.tokens.length < 1) {
    return false;
  }
  return usage.tokens.every(isValidPortToken);
}

function isTerminalResult(
  result: WaitResult,
): result is Extract<WaitResult, { state: TerminalState }> {
  return (
    result.state === "finished" ||
    result.state === "failed" ||
    result.state === "lost" ||
    result.state === "cancelled"
  );
}

function pendingEntryOf(entry: RegistryEntry, terminal: RegistryEntry["terminal"] & object): PendingUsage {
  const stored = terminal as {
    readonly state: TerminalState;
    readonly observedAt: string;
    readonly seconds: number;
    readonly usage: PortUsage | null;
    readonly usageValid: boolean;
  };
  const useReported = stored.usage !== null && stored.usageValid;
  return {
    entryId: `${entry.workItemId}:${entry.sessionId}`,
    kind: "session",
    workItemId: entry.workItemId,
    finishedAt: stored.observedAt,
    startModel: entry.model.model,
    tokens: useReported
      ? (stored.usage as PortUsage).tokens.map((token) => ({
          provider: token.provider,
          model: token.model,
          inputTokens: token.inputTokens,
          outputTokens: token.outputTokens,
          requests: token.requests,
          source: token.source,
        }))
      : [
          {
            provider: entry.model.providerId,
            model: entry.model.model,
            inputTokens: null,
            outputTokens: null,
            requests: null,
            source: stored.usage === null ? "usage-unreported" : "usage-invalid",
          },
        ],
    session: {
      hostAlias: entry.hostAlias,
      seconds: stored.seconds,
      source: "dispatcher-clock",
      result: attemptOf(stored.state, entry.cancelReason),
    },
  };
}

function terminalResultOf(entry: RegistryEntry): Extract<WaitResult, { state: TerminalState }> {
  const terminal = entry.terminal;
  if (terminal === null) {
    throw new Error(`dispatcher: entry ${entry.requestId} has no terminal state`);
  }
  return {
    state: terminal.state,
    sessionId: entry.sessionId,
    cursor: entry.cursor,
    usage: terminal.usage,
    detail: terminal.detail,
  };
}

async function checkProviderModel(model: ModelSelection): Promise<void> {
  if (!PROVIDER_ID_PATTERN.test(model.providerId)) {
    throw new DispatchPreconditionError(
      `dispatcher precondition model-provider: invalid providerId "${model.providerId}"`,
    );
  }
  const path = `config/providers/${model.providerId}.json`;
  const label = "Provider descriptor";
  let status: Awaited<ReturnType<typeof statInputPath>>;
  try {
    status = await statInputPath(label, path);
  } catch (error: unknown) {
    throw new DispatchPreconditionError(
      `dispatcher precondition model-provider: cannot stat ${path}`,
      { cause: error },
    );
  }
  if (status === "absent") {
    throw new DispatchPreconditionError(
      `dispatcher precondition model-provider: missing descriptor ${path}`,
    );
  }
  let text: string;
  try {
    text = await readInputText(label, path);
  } catch (error: unknown) {
    throw new DispatchPreconditionError(
      `dispatcher precondition model-provider: unreadable descriptor ${path}`,
      { cause: error },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new DispatchPreconditionError(
      `dispatcher precondition model-provider: descriptor ${path} is not valid JSON`,
      { cause: error },
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DispatchPreconditionError(
      `dispatcher precondition model-provider: descriptor ${path} must be a JSON object`,
    );
  }
  if ((raw as Record<string, unknown>)["model"] !== model.model) {
    throw new DispatchPreconditionError(
      `dispatcher precondition model-provider: descriptor ${path} model differs`,
    );
  }
}

function checkStartPreconditions(
  item: WorkItem,
  decision: PlacementDecision,
  model: ModelSelection,
  brief: string,
): void {
  if (!isWorkItem(item) || !isPlacementDecision(decision)) {
    throw new DispatchPreconditionError(
      "dispatcher precondition contract: item must be a WorkItem and decision a PlacementDecision",
    );
  }
  if (decision.workItemId !== item.id) {
    throw new DispatchPreconditionError(
      "dispatcher precondition work-item-match: decision.workItemId must equal item.id",
    );
  }
  if (decision.chosenHostAlias === null) {
    throw new DispatchPreconditionError(
      "dispatcher precondition host-chosen: decision.chosenHostAlias must not be null",
    );
  }
  if (item.status !== "queued") {
    throw new DispatchPreconditionError(
      `dispatcher precondition item-queued: item.status must be "queued", got "${item.status}"`,
    );
  }
  if (brief.trim().length === 0) {
    throw new DispatchPreconditionError(
      "dispatcher precondition brief-present: brief must not be blank",
    );
  }
}

export function createDispatcher(deps: DispatcherDeps): {
  start(
    item: WorkItem,
    decision: PlacementDecision,
    model: ModelSelection,
    brief: string,
  ): Promise<StartOutcome>;
  watch(requestId: string): Promise<FinishOutcome>;
  diff(requestId: string): Promise<DiffResult>;
  cancel(requestId: string, reason: CancelReason): Promise<FinishOutcome>;
} {
  async function deriveRequest(
    item: WorkItem,
    decision: PlacementDecision,
    model: ModelSelection,
    brief: string,
  ): Promise<StartRequest> {
    const branch = item.branch !== null ? item.branch : `${deps.config.branchPrefix}${item.id}`;
    const resume = item.branch !== null;
    const baseRef = resume ? `origin/${branch}` : `origin/${deps.config.baseBranch}`;
    const contents = await readLedger("Dispatcher ledger", deps.ledgerPath);
    const pendingSessions = contents.pending.filter(
      (entry) => entry.workItemId === item.id && entry.kind === "session",
    ).length;
    const record = contents.records.find((entry) => entry.workItemId === item.id) ?? null;
    const n = pendingSessions + (record === null ? 0 : record.attempts.length);
    const hostAlias = decision.chosenHostAlias as string;
    return {
      requestId: `${item.id}:${String(n)}`,
      workItemId: item.id,
      repo: item.repo,
      hostAlias,
      branch,
      baseRef,
      resume,
      model,
      brief,
    };
  }

  async function loadEntry(requestId: string): Promise<{ entries: RegistryEntry[]; entry: RegistryEntry }> {
    const found = (await readRegistry(deps.config.registryPath)).slice();
    const entry = found.find((candidate) => candidate.requestId === requestId);
    if (entry === undefined) {
      throw new DispatchPreconditionError(
        `dispatcher precondition known-request: unknown requestId "${requestId}"`,
      );
    }
    return { entries: found as RegistryEntry[], entry };
  }

  async function persistTerminalAndAppend(
    entries: RegistryEntry[],
    entry: RegistryEntry,
    terminal: {
      readonly state: TerminalState;
      readonly observedAt: string;
      readonly seconds: number;
      readonly usage: PortUsage | null;
      readonly usageValid: boolean;
      readonly detail: string;
    },
  ): Promise<FinishOutcome> {
    if (terminal.seconds < 0) {
      throw new DispatchClockError(
        `dispatcher clock: negative seconds for ${entry.requestId}`,
      );
    }
    if (terminal.usage !== null && !terminal.usageValid) {
      deps.log({
        level: "error",
        event: "usage-invalid",
        requestId: entry.requestId,
        workItemId: entry.workItemId,
        sessionId: entry.sessionId,
        detail: "port usage failed validation",
      });
    }
    const stored = { ...terminal, ledgerAppended: false };
    const updated: RegistryEntry = {
      ...entry,
      cursor: entry.cursor,
      unreachableCount: 0,
      lastSeenAt: terminal.observedAt,
      terminal: stored,
    };
    await writeRegistry(
      deps.config.registryPath,
      entries.map((candidate) => (candidate.requestId === entry.requestId ? updated : candidate)),
    );
    const pending = pendingEntryOf(updated, stored);
    const ledger = await appendPending(deps.ledgerPath, pending);
    const appended: RegistryEntry = {
      ...updated,
      terminal: { ...stored, ledgerAppended: true },
    };
    await writeRegistry(
      deps.config.registryPath,
      entries.map((candidate) =>
        candidate.requestId === entry.requestId ? appended : candidate,
      ),
    );
    const result = terminalResultOf(appended);
    deps.log({
      level: "info",
      event: "terminal",
      requestId: entry.requestId,
      workItemId: entry.workItemId,
      sessionId: entry.sessionId,
      detail: terminal.state,
    });
    return { result, attempt: attemptOf(terminal.state, appended.cancelReason), ledger };
  }

  async function replayTerminal(
    entries: RegistryEntry[],
    entry: RegistryEntry,
  ): Promise<FinishOutcome> {
    const terminal = entry.terminal;
    if (terminal === null) {
      throw new Error(`dispatcher: entry ${entry.requestId} has no terminal state`);
    }
    if (terminal.ledgerAppended) {
      const result = terminalResultOf(entry);
      return { result, attempt: attemptOf(terminal.state, entry.cancelReason), ledger: "unchanged" };
    }
    const pending = pendingEntryOf(entry, terminal);
    const ledger = await appendPending(deps.ledgerPath, pending);
    const appended: RegistryEntry = {
      ...entry,
      terminal: { ...terminal, ledgerAppended: true },
    };
    await writeRegistry(
      deps.config.registryPath,
      entries.map((candidate) =>
        candidate.requestId === entry.requestId ? appended : candidate,
      ),
    );
    const result = terminalResultOf(appended);
    return { result, attempt: attemptOf(terminal.state, appended.cancelReason), ledger };
  }

  async function finishWait(
    entries: RegistryEntry[],
    entry: RegistryEntry,
    result: Extract<WaitResult, { state: TerminalState }>,
  ): Promise<FinishOutcome> {
    const observedAt = deps.now().toISOString();
    const seconds = Math.floor(
      (Date.parse(observedAt) - Date.parse(entry.startedAt)) / 1000,
    );
    return persistTerminalAndAppend(entries, entry, {
      state: result.state,
      observedAt,
      seconds,
      usage: result.usage,
      usageValid: result.usage === null ? true : checkUsageValid(result.usage),
      detail: result.detail,
    });
  }

  async function start(
    item: WorkItem,
    decision: PlacementDecision,
    model: ModelSelection,
    brief: string,
  ): Promise<StartOutcome> {
    checkStartPreconditions(item, decision, model, brief);
    await checkProviderModel(model);
    const request = await deriveRequest(item, decision, model, brief);
    const existing = await readRegistry(deps.config.registryPath);
    const hit = existing.find((candidate) => candidate.requestId === request.requestId);
    if (hit !== undefined) {
      // The registry holds no host-local worktree, so a replayed start
      // rebuilds the request and returns the stored session identity.
      const handle: SessionHandle = {
        sessionId: hit.sessionId,
        requestId: hit.requestId,
        hostAlias: hit.hostAlias,
        branch: hit.branch,
        worktree: "",
        baseCommit: null,
      };
      return { kind: "started", handle, request };
    }
    const admission = await deps.budget.admit();
    if (!admission.admit) {
      return { kind: "refused", reason: admission.reason };
    }
    const handle = await deps.port.start(request);
    const startedAt = deps.now().toISOString();
    const entry: RegistryEntry = {
      requestId: request.requestId,
      workItemId: request.workItemId,
      sessionId: handle.sessionId,
      hostAlias: request.hostAlias,
      branch: request.branch,
      model,
      startedAt,
      cursor: null,
      unreachableCount: 0,
      lastSeenState: "starting",
      lastSeenAt: startedAt,
      cancelReason: null,
      terminal: null,
    };
    await writeRegistry(deps.config.registryPath, [...existing, entry]);
    deps.log({
      level: "info",
      event: "start",
      requestId: request.requestId,
      workItemId: request.workItemId,
      sessionId: handle.sessionId,
    });
    return { kind: "started", handle, request };
  }

  async function watch(requestId: string): Promise<FinishOutcome> {
    const { entries, entry: initial } = await loadEntry(requestId);
    if (initial.terminal !== null) {
      return replayTerminal(entries, initial);
    }
    let current = initial;
    for (;;) {
      let result: WaitResult;
      try {
        result = await deps.port.wait(
          { sessionId: current.sessionId, hostAlias: current.hostAlias },
          deps.config.waitTimeoutMs,
          current.cursor,
        );
      } catch (error: unknown) {
        if (error instanceof PortUnreachableError) {
          const count = current.unreachableCount + 1;
          if (count >= deps.config.lostAfterUnreachable) {
            const observedAt = deps.now().toISOString();
            const seconds = Math.floor(
              (Date.parse(current.lastSeenAt) - Date.parse(current.startedAt)) / 1000,
            );
            const terminal = {
              state: "lost" as const,
              observedAt,
              seconds,
              usage: null,
              usageValid: true,
              detail: `unreachable ${String(count)} times`,
            };
            const persisted: RegistryEntry = { ...current, unreachableCount: count };
            await writeRegistry(
              deps.config.registryPath,
              entries.map((candidate) =>
                candidate.requestId === current.requestId ? persisted : candidate,
              ),
            );
            return persistTerminalAndAppend(entries, persisted, terminal);
          }
          const persisted: RegistryEntry = { ...current, unreachableCount: count };
          await writeRegistry(
            deps.config.registryPath,
            entries.map((candidate) =>
              candidate.requestId === current.requestId ? persisted : candidate,
            ),
          );
          current = persisted;
          await deps.sleep(deps.config.unreachableBackoffMs);
          continue;
        }
        throw error;
      }
      if (!isTerminalResult(result)) {
        const observedAt = deps.now().toISOString();
        const persisted: RegistryEntry = {
          ...current,
          cursor: result.cursor,
          unreachableCount: 0,
          lastSeenState: result.state,
          lastSeenAt: observedAt,
        };
        await writeRegistry(
          deps.config.registryPath,
          entries.map((candidate) =>
            candidate.requestId === current.requestId ? persisted : candidate,
          ),
        );
        current = persisted;
        continue;
      }
      const observed: RegistryEntry = {
        ...current,
        cursor: result.cursor,
        unreachableCount: 0,
        lastSeenAt: deps.now().toISOString(),
      };
      await writeRegistry(
        deps.config.registryPath,
        entries.map((candidate) =>
          candidate.requestId === current.requestId ? observed : candidate,
        ),
      );
      return finishWait(entries, observed, result);
    }
  }

  async function diff(requestId: string): Promise<DiffResult> {
    const { entry } = await loadEntry(requestId);
    return deps.port.diff(
      { sessionId: entry.sessionId, hostAlias: entry.hostAlias },
      `origin/${deps.config.baseBranch}`,
    );
  }

  async function cancel(requestId: string, reason: CancelReason): Promise<FinishOutcome> {
    const { entries, entry: initial } = await loadEntry(requestId);
    if (initial.terminal !== null) {
      // A terminal result observed before the cancel keeps its own state
      // and its own attempt mapping; the stored cancelReason is untouched.
      await deps.port.cancel(
        { sessionId: initial.sessionId, hostAlias: initial.hostAlias },
        reason,
      );
      return replayTerminal(entries, initial);
    }
    const persisted: RegistryEntry = { ...initial, cancelReason: reason };
    await writeRegistry(
      deps.config.registryPath,
      entries.map((candidate) =>
        candidate.requestId === initial.requestId ? persisted : candidate,
      ),
    );
    const cancelResult = await deps.port.cancel(
      { sessionId: persisted.sessionId, hostAlias: persisted.hostAlias },
      reason,
    );
    if (!isTerminalResult(cancelResult)) {
      const observed: RegistryEntry = {
        ...persisted,
        cursor: cancelResult.cursor,
        unreachableCount: 0,
        lastSeenState: cancelResult.state,
        lastSeenAt: deps.now().toISOString(),
      };
      await writeRegistry(
        deps.config.registryPath,
        entries.map((candidate) =>
          candidate.requestId === initial.requestId ? observed : candidate,
        ),
      );
      return watch(requestId);
    }
    const observed: RegistryEntry = {
      ...persisted,
      cursor: cancelResult.cursor,
      unreachableCount: 0,
      lastSeenAt: deps.now().toISOString(),
    };
    await writeRegistry(
      deps.config.registryPath,
      entries.map((candidate) =>
        candidate.requestId === initial.requestId ? observed : candidate,
      ),
    );
    return finishWait(entries, observed, cancelResult);
  }

  return { start, watch, diff, cancel };
}

export { PortRejectedError, PortUnreachableError };
