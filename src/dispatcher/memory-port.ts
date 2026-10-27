import type {
  CancelReason,
  DiffResult,
  DispatcherPort,
  PortState,
  PortUsage,
  SessionHandle,
  SessionRef,
  StartRequest,
  TerminalState,
  WaitResult,
} from "./port.js";
import { PortRejectedError, PortUnreachableError } from "./port.js";

export interface MemoryPortControl {
  readonly port: DispatcherPort;
  pushCommit(branch: string, sha: string): void;
  complete(
    sessionId: string,
    outcome: {
      readonly state: "finished" | "failed";
      readonly usage: PortUsage | null;
      readonly detail: string;
    },
  ): void;
  loseHost(hostAlias: string): void;
  setUnreachable(hostAlias: string, unreachable: boolean): void;
  sessions(): readonly { readonly handle: SessionHandle; readonly state: PortState }[];
}

interface MemorySession {
  handle: SessionHandle;
  request: StartRequest;
  state: PortState;
  cursor: string | null;
  terminalUsage: PortUsage | null;
  terminalDetail: string | null;
}

function terminalOf(session: MemorySession): Extract<WaitResult, { state: TerminalState }> | null {
  if (
    session.state !== "finished" &&
    session.state !== "failed" &&
    session.state !== "lost" &&
    session.state !== "cancelled"
  ) {
    return null;
  }
  const usage =
    session.terminalUsage === null ? null : { tokens: [...session.terminalUsage.tokens] };
  return {
    state: session.state,
    sessionId: session.handle.sessionId,
    cursor: session.cursor,
    usage,
    detail: session.terminalDetail ?? "",
  };
}

function toBranch(baseRef: string): string {
  return baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : baseRef;
}

export function createMemoryPort(): MemoryPortControl {
  let nextId = 1;
  const sessions = new Map<string, MemorySession>();
  const sessionByRequest = new Map<string, string>();
  const originCommits = new Map<string, string[]>();
  const localTips = new Map<string, string>();
  const unreachableHosts = new Set<string>();

  function originTip(branch: string): string | null {
    return originCommits.get(branch)?.at(-1) ?? null;
  }

  function checkReachable(hostAlias: string): void {
    if (unreachableHosts.has(hostAlias)) {
      throw new PortUnreachableError(`host ${hostAlias} unreachable`);
    }
  }

  function findSession(ref: SessionRef): MemorySession {
    const session = sessions.get(ref.sessionId);
    if (session === undefined || session.handle.hostAlias !== ref.hostAlias) {
      throw new PortRejectedError("session-not-found", `unknown session ${ref.sessionId}`);
    }
    return session;
  }

  function settle(
    session: MemorySession,
    state: TerminalState,
    usage: PortUsage | null,
    detail: string,
  ): void {
    session.state = state;
    session.terminalUsage = usage;
    session.terminalDetail = detail;
  }

  function start(request: StartRequest): Promise<SessionHandle> {
    // Async only for the port shape; the body runs through a resolved
    // promise so throws become rejections instead of sync throws.
    return Promise.resolve().then(() => startNow(request));
  }

  function startNow(request: StartRequest): SessionHandle {
    checkReachable(request.hostAlias);
    const existingId = sessionByRequest.get(request.requestId);
    if (existingId !== undefined) {
      const existing = sessions.get(existingId);
      if (existing === undefined) {
        throw new PortRejectedError(
          "request-duplicated",
          `duplicate session for ${request.requestId}`,
        );
      }
      if (Bun.deepEquals(existing.request, request)) {
        return existing.handle;
      }
      throw new PortRejectedError("request-conflict", `conflicting start for ${request.requestId}`);
    }
    let baseCommit: string | null;
    if (request.resume) {
      const commits = originCommits.get(request.branch) ?? [];
      const local = localTips.get(request.branch);
      // The origin history no longer contains the local base, so a fresh
      // worktree cannot fast-forward to it: the local branch diverged.
      if (local !== undefined && commits.length > 0 && !commits.includes(local)) {
        throw new PortRejectedError("branch-diverged", `local branch ${request.branch} diverged`);
      }
      baseCommit = originTip(request.branch);
      if (baseCommit !== null) {
        localTips.set(request.branch, baseCommit);
      }
    } else {
      baseCommit = originTip(toBranch(request.baseRef));
    }
    const sessionId = `mem-${String(nextId)}`;
    nextId += 1;
    const handle: SessionHandle = {
      sessionId,
      requestId: request.requestId,
      hostAlias: request.hostAlias,
      branch: request.branch,
      worktree: `/memory-worktrees/${request.hostAlias}/${sessionId}`,
      baseCommit,
    };
    sessions.set(sessionId, {
      handle,
      request,
      state: "starting",
      cursor: null,
      terminalUsage: null,
      terminalDetail: null,
    });
    sessionByRequest.set(request.requestId, sessionId);
    if (baseCommit !== null) {
      localTips.set(request.branch, baseCommit);
    }
    return handle;
  }

  function wait(ref: SessionRef, _timeoutMs: number, cursor: string | null): Promise<WaitResult> {
    return Promise.resolve().then(() => waitNow(ref, cursor));
  }

  function waitNow(ref: SessionRef, cursor: string | null): WaitResult {
    const session = findSession(ref);
    checkReachable(session.handle.hostAlias);
    session.cursor = cursor;
    // The current state is returned immediately; timeoutMs is ignored.
    const terminal = terminalOf(session);
    if (terminal !== null) {
      return terminal;
    }
    if (session.state !== "starting" && session.state !== "running") {
      throw new PortRejectedError("session-not-found", `unknown session ${ref.sessionId}`);
    }
    return { state: session.state, sessionId: session.handle.sessionId, cursor: session.cursor };
  }

  function diff(ref: SessionRef, base: string): Promise<DiffResult> {
    return Promise.resolve().then(() => diffNow(ref, base));
  }

  function diffNow(ref: SessionRef, base: string): DiffResult {
    const session = findSession(ref);
    checkReachable(session.handle.hostAlias);
    const commits = originCommits.get(session.handle.branch) ?? [];
    const tip = commits.at(-1) ?? "(none)";
    const lines = [`--- ${base}`, `+++ memory/${session.handle.branch}@${tip}`];
    for (const sha of commits) {
      lines.push(`+${sha}`);
    }
    return {
      sessionId: session.handle.sessionId,
      base,
      unifiedDiff: `${lines.join("\n")}\n`,
      truncated: false,
    };
  }

  function cancel(ref: SessionRef, reason: CancelReason): Promise<WaitResult> {
    return Promise.resolve().then(() => cancelNow(ref, reason));
  }

  function cancelNow(ref: SessionRef, reason: CancelReason): WaitResult {
    const session = findSession(ref);
    checkReachable(session.handle.hostAlias);
    const terminal = terminalOf(session);
    if (terminal !== null) {
      return terminal;
    }
    settle(session, "cancelled", null, `cancelled ${reason}`);
    const result = terminalOf(session);
    if (result === null) {
      throw new PortRejectedError("session-not-found", `unknown session ${ref.sessionId}`);
    }
    return result;
  }

  function close(): Promise<void> {
    return Promise.resolve();
  }

  const port: DispatcherPort = { start, wait, diff, cancel, close };

  function pushCommit(branch: string, sha: string): void {
    // A push originates from a session worktree, so both the origin history
    // and the branch worktree tip move. Only pushed commits survive a loss.
    const commits = originCommits.get(branch) ?? [];
    commits.push(sha);
    originCommits.set(branch, commits);
    localTips.set(branch, sha);
  }

  function complete(
    sessionId: string,
    outcome: {
      readonly state: "finished" | "failed";
      readonly usage: PortUsage | null;
      readonly detail: string;
    },
  ): void {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`unknown session ${sessionId}`);
    }
    if (terminalOf(session) !== null) {
      throw new Error(`session ${sessionId} already terminal`);
    }
    settle(session, outcome.state, outcome.usage, outcome.detail);
  }

  function loseHost(hostAlias: string): void {
    for (const session of sessions.values()) {
      if (session.handle.hostAlias === hostAlias && terminalOf(session) === null) {
        settle(session, "lost", null, "host lost");
      }
    }
  }

  function setUnreachable(hostAlias: string, unreachable: boolean): void {
    if (unreachable) {
      unreachableHosts.add(hostAlias);
    } else {
      unreachableHosts.delete(hostAlias);
    }
  }

  function list(): readonly { readonly handle: SessionHandle; readonly state: PortState }[] {
    return [...sessions.values()].map((session) => ({
      handle: session.handle,
      state: session.state,
    }));
  }

  return { port, pushCommit, complete, loseHost, setUnreachable, sessions: list };
}
