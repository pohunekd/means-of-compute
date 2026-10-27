// Dispatcher service: starts sessions through DispatcherPort, watches them
// to a terminal state, and records terminal usage in the ledger. Everything
// outside src/dispatcher/ uses this service or the port type, never an
// adapter. The budget gate is called only in start; watch, diff and cancel
// never call it.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isPlacementDecision, isWorkItem } from "../../contracts/v1/validate.js";
import type { PlacementDecision, TokenUsage, WorkItem } from "../../contracts/v1/types.js";
import type { BudgetGate } from "../budget/gate.js";
import { readInputText, statInputPath } from "../fs/input.js";
import { readLedger } from "../ledger/read.js";
import { appendPending } from "../ledger/store.js";
import type { LedgerContents, PendingUsage, WriteOutcome } from "../ledger/types.js";
import type { DispatcherConfig } from "./config.js";
import type {
  CancelReason,
  DiffResult,
  DispatcherPort,
  ModelSelection,
  PortUsage,
  SessionHandle,
  SessionRef,
  StartRequest,
  TerminalState,
  WaitResult,
} from "./port.js";
import { PortRejectedError, PortUnreachableError } from "./port.js";
import {
  insertRegistryEntry,
  readRegistry,
  removeProvisionalEntry,
  replaceRegistryEntry,
} from "./registry.js";
import type { RegistryEntry, RegistryTerminal } from "./registry.js";

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
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "lost"; readonly requestId: string; readonly ledger: WriteOutcome };

export type DispatchStateCode =
  | "request-provisional"
  | "request-conflict"
  | "request-unappended"
  | "request-ledger-mismatch"
  | "port-binding-conflict"
  | "invalid-handle";

export class DispatchStateError extends Error {
  readonly code: DispatchStateCode;
  readonly requestId: string;
  constructor(
    code: DispatchStateCode,
    requestId: string,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message ?? `${code}: ${requestId}`, options);
    this.name = "DispatchStateError";
    this.code = code;
    this.requestId = requestId;
  }
}

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

// Item-keyed FIFO lock shared by every dispatcher instance in this process:
// one promise chain per registry path and work item (rule 1.1.2). Two
// dispatcher instances on the same registry share the lock through this
// module-level map.
const itemLocks = new Map<string, Promise<void>>();

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const REQUEST_ID_PATTERN = /^([a-z0-9][a-z0-9-]{0,62}):(0|[1-9][0-9]*)$/;

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
    (!Number.isInteger(token.inputTokens) || token.inputTokens < 0)
  ) {
    return false;
  }
  if (
    token.outputTokens !== null &&
    (!Number.isInteger(token.outputTokens) || token.outputTokens < 0)
  ) {
    return false;
  }
  if (!Number.isInteger(token.requests) || token.requests < 0) {
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

function pendingEntryOf(entry: RegistryEntry, terminal: RegistryTerminal): PendingUsage {
  const stored = terminal;
  // usage is non-null only together with usageValid (enforced by the
  // registry schema), so a non-null usage here is always the reported one.
  return {
    entryId: `${entry.workItemId}:${entry.sessionId ?? entry.requestId}`,
    kind: "session",
    workItemId: entry.workItemId,
    finishedAt: stored.observedAt,
    startModel: entry.model.model,
    tokens:
      stored.usage !== null
        ? stored.usage.tokens.map((token) => ({
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
              source: stored.usageValid ? "usage-unreported" : "usage-invalid",
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
    sessionId: entry.sessionId ?? entry.requestId,
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

function checkStartContract(item: WorkItem, decision: PlacementDecision): void {
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
}

function checkBrief(brief: string): void {
  if (brief.trim().length === 0) {
    throw new DispatchPreconditionError(
      "dispatcher precondition brief-present: brief must not be blank",
    );
  }
}

function sameRequest(hit: RegistryEntry, request: StartRequest, briefSha256: string): boolean {
  return (
    hit.repo === request.repo &&
    hit.hostAlias === request.hostAlias &&
    hit.branch === request.branch &&
    hit.baseRef === request.baseRef &&
    hit.resume === request.resume &&
    hit.model.providerId === request.model.providerId &&
    hit.model.model === request.model.model &&
    hit.briefSha256 === briefSha256
  );
}

function handleOf(entry: RegistryEntry): SessionHandle {
  const sessionId = entry.sessionId;
  const worktree = entry.worktree;
  if (sessionId === null || worktree === null) {
    throw new Error(`dispatcher: entry ${entry.requestId} is provisional and has no handle`);
  }
  return {
    sessionId,
    requestId: entry.requestId,
    hostAlias: entry.hostAlias,
    branch: entry.branch,
    worktree,
    baseCommit: entry.baseCommit,
  };
}

function checkHandle(
  handle: SessionHandle,
  request: StartRequest,
  entries: readonly RegistryEntry[],
): void {
  const failures: Array<{ readonly check: string; readonly detail: string }> = [];
  if (handle.requestId !== request.requestId) {
    failures.push({
      check: "request-id",
      detail: `handle requestId "${handle.requestId}" differs from "${request.requestId}"`,
    });
  }
  if (handle.hostAlias !== request.hostAlias) {
    failures.push({
      check: "host",
      detail: `handle host "${handle.hostAlias}" differs from "${request.hostAlias}"`,
    });
  }
  if (handle.branch !== request.branch) {
    failures.push({
      check: "branch",
      detail: `handle branch "${handle.branch}" differs from "${request.branch}"`,
    });
  }
  if (handle.sessionId.length === 0) {
    failures.push({ check: "session-id", detail: "handle sessionId is empty" });
  }
  if (handle.worktree.length === 0) {
    failures.push({ check: "worktree", detail: "handle worktree is empty" });
  }
  if (handle.baseCommit !== null && handle.baseCommit.length === 0) {
    failures.push({ check: "base-commit", detail: "handle baseCommit is an empty string" });
  }
  if (entries.some((entry) => entry.sessionId === handle.sessionId)) {
    failures.push({
      check: "session-unique",
      detail: `sessionId "${handle.sessionId}" is already registered`,
    });
  }
  if (failures.length > 0) {
    const first = failures[0] as { readonly check: string; readonly detail: string };
    throw new DispatchStateError(
      "invalid-handle",
      request.requestId,
      `dispatcher state invalid-handle: ${first.check}: ${first.detail}`,
    );
  }
}

export function briefSha256Of(brief: string): string {
  return createHash("sha256").update(brief, "utf8").digest("hex");
}

export function deriveStartRequest(
  item: WorkItem,
  decision: PlacementDecision,
  model: ModelSelection,
  brief: string,
  config: DispatcherConfig,
  contents: LedgerContents,
): StartRequest {
  const branch = item.branch !== null ? item.branch : `${config.branchPrefix}${item.id}`;
  const resume = item.branch !== null;
  const baseRef = resume ? `origin/${branch}` : `origin/${config.baseBranch}`;
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
  // Port wait/cancel/diff and sleep always run outside a hold; port start
  // is the only port call made under the lock. The hold uses the
  // module-level itemLocks map above, so two dispatcher instances on the
  // same registry serialize on the same chain.

  async function withItemLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const previous = itemLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    itemLocks.set(
      key,
      previous.then(() => turn),
    );
    await previous;
    try {
      return await op();
    } finally {
      release();
      const chained = itemLocks.get(key);
      if (chained !== undefined) {
        void chained.then(() => {
          if (itemLocks.get(key) === chained) {
            itemLocks.delete(key);
          }
        });
      }
    }
  }

  function workItemIdOf(requestId: string): string {
    const match = REQUEST_ID_PATTERN.exec(requestId);
    if (match === null || match[1] === undefined) {
      throw new DispatchPreconditionError(
        `dispatcher precondition known-request: unknown requestId "${requestId}"`,
      );
    }
    return match[1];
  }

  function itemKeyFor(requestId: string): string {
    return `${resolve(deps.config.registryPath)}|${workItemIdOf(requestId)}`;
  }

  async function loadEntry(requestId: string): Promise<RegistryEntry> {
    const found = await readRegistry(deps.config.registryPath);
    const entry = found.find((candidate) => candidate.requestId === requestId);
    if (entry === undefined) {
      throw new DispatchPreconditionError(
        `dispatcher precondition known-request: unknown requestId "${requestId}"`,
      );
    }
    return entry;
  }

  async function persistTerminalAndAppend(
    entry: RegistryEntry,
    terminal: {
      readonly state: TerminalState;
      readonly observedAt: string;
      readonly seconds: number;
      readonly usage: PortUsage | null;
      readonly usageValid: boolean;
      readonly detail: string;
      readonly cursor: string | null;
    },
  ): Promise<FinishOutcome> {
    if (terminal.seconds < 0) {
      throw new DispatchClockError(`dispatcher clock: negative seconds for ${entry.requestId}`);
    }
    const { cursor, ...terminalFields } = terminal;
    const stored = { ...terminalFields, ledgerAppended: false };
    const updated: RegistryEntry = {
      ...entry,
      cursor,
      unreachableCount: 0,
      lastSeenAt: terminal.observedAt,
      revision: entry.revision + 1,
      terminal: stored,
    };
    await replaceRegistryEntry(deps.config.registryPath, updated);
    const pending = pendingEntryOf(updated, stored);
    const ledger = await appendPending(deps.ledgerPath, pending);
    const appended: RegistryEntry = {
      ...updated,
      revision: updated.revision + 1,
      terminal: { ...stored, ledgerAppended: true },
    };
    await replaceRegistryEntry(deps.config.registryPath, appended);
    const result = terminalResultOf(appended);
    deps.log({
      level: "info",
      event: "terminal",
      requestId: entry.requestId,
      workItemId: entry.workItemId,
      sessionId: entry.sessionId ?? entry.requestId,
      detail: terminal.state,
    });
    return { result, attempt: attemptOf(terminal.state, appended.cancelReason), ledger };
  }

  async function replayTerminal(entry: RegistryEntry): Promise<FinishOutcome> {
    const terminal = entry.terminal;
    if (terminal === null) {
      throw new Error(`dispatcher: entry ${entry.requestId} has no terminal state`);
    }
    if (terminal.ledgerAppended) {
      const result = terminalResultOf(entry);
      return {
        result,
        attempt: attemptOf(terminal.state, entry.cancelReason),
        ledger: "unchanged",
      };
    }
    const pending = pendingEntryOf(entry, terminal);
    const ledger = await appendPending(deps.ledgerPath, pending);
    const appended: RegistryEntry = {
      ...entry,
      revision: entry.revision + 1,
      terminal: { ...terminal, ledgerAppended: true },
    };
    await replaceRegistryEntry(deps.config.registryPath, appended);
    const result = terminalResultOf(appended);
    return { result, attempt: attemptOf(terminal.state, appended.cancelReason), ledger };
  }

  // Terminal helpers: each one makes exactly two registry writes and one
  // append in one hold. The invalid marker lives in the pending token
  // source ("usage-invalid") and the usage-invalid error event, never in
  // the stored usage, which stays null.
  async function finishObserved(
    entry: RegistryEntry,
    result: Extract<WaitResult, { state: TerminalState }>,
  ): Promise<FinishOutcome> {
    const observedAt = deps.now().toISOString();
    const seconds = Math.floor((Date.parse(observedAt) - Date.parse(entry.startedAt)) / 1000);
    if (seconds < 0) {
      throw new DispatchClockError(`dispatcher clock: negative seconds for ${entry.requestId}`);
    }
    const usageValid = result.usage === null ? true : checkUsageValid(result.usage);
    if (!usageValid) {
      deps.log({
        level: "error",
        event: "usage-invalid",
        requestId: entry.requestId,
        workItemId: entry.workItemId,
        sessionId: entry.sessionId ?? entry.requestId,
        detail: "port usage failed validation",
      });
    }
    return persistTerminalAndAppend(entry, {
      state: result.state,
      observedAt,
      seconds,
      usage: usageValid ? result.usage : null,
      usageValid,
      detail: result.detail,
      cursor: result.cursor,
    });
  }

  async function finishLost(entry: RegistryEntry, count: number): Promise<FinishOutcome> {
    const observedAt = deps.now().toISOString();
    const seconds = Math.floor((Date.parse(entry.lastSeenAt) - Date.parse(entry.startedAt)) / 1000);
    if (seconds < 0) {
      throw new DispatchClockError(`dispatcher clock: negative seconds for ${entry.requestId}`);
    }
    // A synthesized lost keeps the last observation and stores the final
    // unreachable count; only the terminal and the count change.
    const lost: RegistryEntry = {
      ...entry,
      unreachableCount: count,
      revision: entry.revision + 1,
      terminal: {
        state: "lost",
        observedAt,
        seconds,
        usage: null,
        usageValid: true,
        detail: `unreachable ${String(count)} times`,
        ledgerAppended: false,
      },
    };
    await replaceRegistryEntry(deps.config.registryPath, lost);
    const stored = lost.terminal;
    if (stored === null) {
      throw new Error(`dispatcher: entry ${entry.requestId} has no terminal state`);
    }
    const pending = pendingEntryOf(lost, stored);
    const ledger = await appendPending(deps.ledgerPath, pending);
    const appended: RegistryEntry = {
      ...lost,
      revision: lost.revision + 1,
      terminal: { ...stored, ledgerAppended: true },
    };
    await replaceRegistryEntry(deps.config.registryPath, appended);
    const result = terminalResultOf(appended);
    deps.log({
      level: "info",
      event: "terminal",
      requestId: entry.requestId,
      workItemId: entry.workItemId,
      sessionId: entry.sessionId ?? entry.requestId,
      detail: "lost",
    });
    return { result, attempt: attemptOf("lost", appended.cancelReason), ledger };
  }

  async function start(
    item: WorkItem,
    decision: PlacementDecision,
    model: ModelSelection,
    brief: string,
  ): Promise<StartOutcome> {
    // Design rule order 1-4, then 5, then 6: contract, provider, brief.
    checkStartContract(item, decision);
    await checkProviderModel(model);
    checkBrief(brief);
    const key = `${resolve(deps.config.registryPath)}|${item.id}`;
    return withItemLock(key, async () => {
      const contents = await readLedger("Dispatcher ledger", deps.ledgerPath);
      const request = deriveStartRequest(item, decision, model, brief, deps.config, contents);
      const sha = briefSha256Of(brief);
      const existing = await readRegistry(deps.config.registryPath);
      const hit = existing.find((candidate) => candidate.requestId === request.requestId);
      if (hit !== undefined) {
        if (hit.terminal !== null && !hit.terminal.ledgerAppended) {
          throw new DispatchStateError(
            "request-unappended",
            hit.requestId,
            `dispatcher state request-unappended: ${hit.requestId} finished but its ledger write is pending; watch it first`,
          );
        }
        if (hit.terminal !== null) {
          throw new DispatchStateError(
            "request-ledger-mismatch",
            hit.requestId,
            `dispatcher state request-ledger-mismatch: ${hit.requestId} is already ledgered; move on to the next attempt`,
          );
        }
        if (!sameRequest(hit, request, sha)) {
          throw new DispatchStateError(
            "request-conflict",
            hit.requestId,
            `dispatcher state request-conflict: ${hit.requestId} already holds other inputs`,
          );
        }
        if (hit.sessionId !== null) {
          // A settled hit returns the stored session: no gate, no port
          // call. A provisional hit falls through to port.start below.
          return { kind: "started", handle: handleOf(hit), request };
        }
      } else {
        const admission = await deps.budget.admit();
        if (!admission.admit) {
          return { kind: "refused", reason: admission.reason };
        }
        const provisional: RegistryEntry = {
          requestId: request.requestId,
          workItemId: request.workItemId,
          repo: request.repo,
          hostAlias: request.hostAlias,
          branch: request.branch,
          baseRef: request.baseRef,
          resume: request.resume,
          model,
          briefSha256: sha,
          sessionId: null,
          worktree: null,
          baseCommit: null,
          startedAt: deps.now().toISOString(),
          cursor: null,
          unreachableCount: 0,
          lastSeenState: "starting",
          lastSeenAt: deps.now().toISOString(),
          cancelReason: null,
          terminal: null,
          revision: 0,
        };
        await insertRegistryEntry(deps.config.registryPath, provisional);
      }
      const provisional = await loadEntry(request.requestId);
      let handle: SessionHandle;
      try {
        handle = await deps.port.start(request);
      } catch (error: unknown) {
        if (error instanceof PortUnreachableError) {
          const count = provisional.unreachableCount + 1;
          if (count < deps.config.lostAfterUnreachable) {
            const persisted: RegistryEntry = {
              ...provisional,
              unreachableCount: count,
              lastSeenAt: deps.now().toISOString(),
              revision: provisional.revision + 1,
            };
            await replaceRegistryEntry(deps.config.registryPath, persisted);
            deps.log({
              level: "info",
              event: "start-unreachable",
              requestId: request.requestId,
              workItemId: request.workItemId,
              detail: `unreachable ${String(count)} times`,
            });
            throw error;
          }
          const lost = await finishLost(provisional, count);
          return { kind: "lost", requestId: request.requestId, ledger: lost.ledger };
        }
        if (error instanceof PortRejectedError) {
          if (error.code === "request-conflict" || error.code === "request-duplicated") {
            deps.log({
              level: "error",
              event: "port-binding-conflict",
              requestId: request.requestId,
              workItemId: request.workItemId,
              detail: error.code,
            });
            throw new DispatchStateError(
              "port-binding-conflict",
              request.requestId,
              error.message,
              {
                cause: error,
              },
            );
          }
          await removeProvisionalEntry(
            deps.config.registryPath,
            request.requestId,
            provisional.revision,
          );
          deps.log({
            level: "info",
            event: "start-rejected",
            requestId: request.requestId,
            workItemId: request.workItemId,
            detail: error.code,
          });
          throw error;
        }
        throw error;
      }
      checkHandle(handle, request, existing);
      // startedAt stays the provisional insert time: the port call does
      // not move the session clock.
      const settled: RegistryEntry = {
        ...provisional,
        sessionId: handle.sessionId,
        worktree: handle.worktree,
        baseCommit: handle.baseCommit,
        unreachableCount: 0,
        lastSeenAt: deps.now().toISOString(),
        revision: provisional.revision + 1,
      };
      await replaceRegistryEntry(deps.config.registryPath, settled);
      deps.log({
        level: "info",
        event: "start",
        requestId: request.requestId,
        workItemId: request.workItemId,
        sessionId: handle.sessionId,
      });
      return { kind: "started", handle, request };
    });
  }

  async function watch(requestId: string): Promise<FinishOutcome> {
    const key = itemKeyFor(requestId);
    for (;;) {
      const prep = await withItemLock(key, async () => {
        const entry = await loadEntry(requestId);
        if (entry.terminal !== null) {
          return { kind: "outcome" as const, outcome: await replayTerminal(entry) };
        }
        if (entry.sessionId === null) {
          throw new DispatchStateError(
            "request-provisional",
            requestId,
            `dispatcher state request-provisional: ${requestId} has no session yet`,
          );
        }
        const ref: SessionRef = { sessionId: entry.sessionId, hostAlias: entry.hostAlias };
        return {
          kind: "wait" as const,
          ref,
          cursor: entry.cursor,
          rev: entry.revision,
        };
      });
      if (prep.kind === "outcome") {
        return prep.outcome;
      }
      let result: WaitResult;
      let miss = false;
      try {
        result = await deps.port.wait(prep.ref, deps.config.waitTimeoutMs, prep.cursor);
      } catch (error: unknown) {
        if (!(error instanceof PortUnreachableError)) {
          throw error;
        }
        miss = true;
        result = { state: "starting", sessionId: prep.ref.sessionId, cursor: prep.cursor };
      }
      const after = await withItemLock(key, async () => {
        const current = await loadEntry(requestId);
        if (current.terminal !== null) {
          return { kind: "outcome" as const, outcome: await replayTerminal(current) };
        }
        if (isTerminalResult(result)) {
          return { kind: "outcome" as const, outcome: await finishObserved(current, result) };
        }
        if (current.revision !== prep.rev) {
          return { kind: "loop" as const };
        }
        if (miss) {
          const count = current.unreachableCount + 1;
          if (count >= deps.config.lostAfterUnreachable) {
            return { kind: "outcome" as const, outcome: await finishLost(current, count) };
          }
          const persisted: RegistryEntry = {
            ...current,
            unreachableCount: count,
            revision: current.revision + 1,
          };
          await replaceRegistryEntry(deps.config.registryPath, persisted);
          return { kind: "sleep" as const };
        }
        const observedAt = deps.now().toISOString();
        const persisted: RegistryEntry = {
          ...current,
          cursor: result.cursor,
          unreachableCount: 0,
          lastSeenState: result.state,
          lastSeenAt: observedAt,
          revision: current.revision + 1,
        };
        await replaceRegistryEntry(deps.config.registryPath, persisted);
        return { kind: "loop" as const };
      });
      if (after.kind === "outcome") {
        return after.outcome;
      }
      if (after.kind === "sleep") {
        await deps.sleep(deps.config.unreachableBackoffMs);
      }
    }
  }

  async function diff(requestId: string): Promise<DiffResult> {
    const entry = await loadEntry(requestId);
    if (entry.sessionId === null) {
      throw new DispatchStateError(
        "request-provisional",
        requestId,
        `dispatcher state request-provisional: ${requestId} has no session yet`,
      );
    }
    return deps.port.diff(
      { sessionId: entry.sessionId, hostAlias: entry.hostAlias },
      `origin/${deps.config.baseBranch}`,
    );
  }

  async function cancel(requestId: string, reason: CancelReason): Promise<FinishOutcome> {
    const key = itemKeyFor(requestId);
    const first = await withItemLock(key, async () => {
      const entry = await loadEntry(requestId);
      if (entry.terminal !== null) {
        // A terminal result observed before the cancel keeps its own state
        // and its own attempt mapping; the port is never called again.
        return { kind: "outcome" as const, outcome: await replayTerminal(entry) };
      }
      if (entry.sessionId === null) {
        throw new DispatchStateError(
          "request-provisional",
          requestId,
          `dispatcher state request-provisional: ${requestId} has no session yet`,
        );
      }
      let current = entry;
      if (current.cancelReason === null) {
        // The first reason wins: a later cancel keeps the stored one.
        const persisted: RegistryEntry = {
          ...current,
          cancelReason: reason,
          revision: current.revision + 1,
        };
        await replaceRegistryEntry(deps.config.registryPath, persisted);
        current = persisted;
      }
      const ref: SessionRef = { sessionId: current.sessionId, hostAlias: current.hostAlias };
      return { kind: "cancel" as const, ref, rev: current.revision };
    });
    if (first.kind === "outcome") {
      return first.outcome;
    }
    const cancelResult = await deps.port.cancel(first.ref, reason);
    const second = await withItemLock(key, async () => {
      const current = await loadEntry(requestId);
      if (current.terminal !== null) {
        return { kind: "outcome" as const, outcome: await replayTerminal(current) };
      }
      if (isTerminalResult(cancelResult)) {
        return { kind: "outcome" as const, outcome: await finishObserved(current, cancelResult) };
      }
      if (current.revision !== first.rev) {
        return { kind: "watch" as const };
      }
      const observedAt = deps.now().toISOString();
      const persisted: RegistryEntry = {
        ...current,
        cursor: cancelResult.cursor,
        unreachableCount: 0,
        lastSeenState: cancelResult.state,
        lastSeenAt: observedAt,
        revision: current.revision + 1,
      };
      await replaceRegistryEntry(deps.config.registryPath, persisted);
      return { kind: "watch" as const };
    });
    if (second.kind === "outcome") {
      return second.outcome;
    }
    return watch(requestId);
  }

  return { start, watch, diff, cancel };
}

export { PortRejectedError, PortUnreachableError };
