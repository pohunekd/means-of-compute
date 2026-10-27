// Pohunek-backed DispatcherPort (design section 3): the port composes the
// pure decisions in map.ts over SDK clients behind DispatcherPort.
import { MAX_SESSION_WAIT_TURN_MS } from "@pohunek/sdk";
import type {
  Client,
  HostCapabilities,
  SessionInfo,
  SessionNewResult,
  SessionWaitTurnResult,
} from "@pohunek/sdk";
import {
  PortRejectedError,
  PortUnreachableError,
  type CancelReason,
  type DiffResult,
  type SessionHandle,
  type SessionRef,
  type StartRequest,
  type TerminalState,
  type WaitResult,
} from "../port.js";
import { createHostConnector } from "./connection.js";
import { loadHostRoutes } from "./routes.js";
import type { HostConnector } from "./connection.js";
import type { PohunekAdapterConfig } from "./config.js";
import {
  MOC_METADATA,
  acceptanceFailure,
  hostPreflightFailure,
  isSessionNotFound,
  lookupDecision,
  portErrorOf,
  requestDigestOf,
  sessionNewParams,
  waitDecision,
} from "./map.js";

export interface AdapterLogEvent {
  readonly level: "info" | "error";
  readonly event: string;
  readonly hostAlias: string;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly code?: string;
  readonly detail?: string;
}

export interface PohunekPortDeps {
  readonly connector: HostConnector;
  readonly log: (event: AdapterLogEvent) => void;
}

export class PohunekAdapterError extends Error {
  readonly code: "closed" | "void-incomplete";
  constructor(code: "closed" | "void-incomplete", message?: string) {
    super(message ?? code);
    this.name = "PohunekAdapterError";
    this.code = code;
  }
}

type TerminalResult = Extract<WaitResult, { state: TerminalState }>;

interface PortInternals {
  readonly config: PohunekAdapterConfig;
  readonly connector: HostConnector;
  readonly log: (event: AdapterLogEvent) => void;
  closed: boolean;
  closeDone: boolean;
  readonly inspected: Map<string, Client>;
  readonly terminals: Map<string, TerminalResult>;
}

function terminalKey(hostAlias: string, sessionId: string): string {
  return `${hostAlias}|${sessionId}`;
}

function cachedTerminal(
  port: PortInternals,
  hostAlias: string,
  sessionId: string,
): TerminalResult | undefined {
  return port.terminals.get(terminalKey(hostAlias, sessionId));
}

// Put-if-absent: the first terminal stored wins; every caller gets the stored
// value back (3.7).
function storeTerminal(
  port: PortInternals,
  hostAlias: string,
  result: TerminalResult,
): TerminalResult {
  const key = terminalKey(hostAlias, result.sessionId ?? "");
  const stored = port.terminals.get(key);
  if (stored !== undefined) {
    return stored;
  }
  port.terminals.set(key, result);
  return result;
}

async function dropConnection(port: PortInternals, alias: string): Promise<void> {
  try {
    await port.connector.drop(alias);
  } catch {
    // Best effort: a broken connection must not hide the port error.
  } finally {
    port.inspected.delete(alias);
  }
  port.log({ level: "info", event: "adapter-connection-dropped", hostAlias: alias });
}

// Every caught SDK error goes through portErrorOf (3.6). An unreachable error
// drops the connection so the next call re-resolves the route; anything else
// propagates unchanged. Callers throw the result, so control never continues
// past a caught error.
async function mappedError(
  port: PortInternals,
  alias: string,
  error: unknown,
): Promise<PortUnreachableError | PortRejectedError> {
  const mapped = portErrorOf(error, alias);
  if (mapped instanceof PortUnreachableError) {
    await dropConnection(port, alias);
    return mapped;
  }
  if (mapped instanceof PortRejectedError) {
    return mapped;
  }
  if (error instanceof Error) {
    throw error;
  }
  throw new PortRejectedError("daemon-error");
}

// One inspected client per alias (S1): host.inspect runs once per Client
// instance; a dropped client is inspected again on next use.
async function clientFor(port: PortInternals, alias: string): Promise<Client> {
  let client: Client;
  try {
    client = await port.connector.client(alias);
  } catch (error) {
    throw await mappedError(port, alias, error);
  }
  if (port.inspected.get(alias) === client) {
    return client;
  }
  let capabilities: HostCapabilities;
  try {
    capabilities = await client.call("host.inspect", null);
  } catch (error) {
    throw await mappedError(port, alias, error);
  }
  const failed = hostPreflightFailure(capabilities, port.config);
  if (failed !== null) {
    port.log({
      level: "error",
      event: "adapter-host-unsupported",
      hostAlias: alias,
      detail: failed,
    });
    throw new PortRejectedError("host-unsupported");
  }
  port.inspected.set(alias, client);
  return client;
}

// Void path V (3.5): stop first, then unbind, so a session is never unbound
// while it may still run. Every path throws.
async function voidSession(
  port: PortInternals,
  client: Client,
  alias: string,
  session: { readonly id: string },
  req: StartRequest,
  code: string,
): Promise<never> {
  try {
    await client.call("session.stop", session.id);
  } catch (error) {
    if (isSessionNotFound(error)) {
      port.log({
        level: "error",
        event: "adapter-start-void",
        hostAlias: alias,
        requestId: req.requestId,
        sessionId: session.id,
        code,
      });
      throw new PortRejectedError(code);
    }
    throw await voidError(port, alias, error);
  }
  try {
    await client.call("session.set_metadata", {
      session_id: session.id,
      metadata: {
        [MOC_METADATA.requestId]: null,
        [MOC_METADATA.start]: "void",
        [MOC_METADATA.voidCode]: code,
        [MOC_METADATA.voidedRequestId]: req.requestId,
      },
    });
  } catch (error) {
    if (isSessionNotFound(error)) {
      port.log({
        level: "error",
        event: "adapter-start-void",
        hostAlias: alias,
        requestId: req.requestId,
        sessionId: session.id,
        code,
      });
      throw new PortRejectedError(code);
    }
    throw await voidError(port, alias, error);
  }
  port.log({
    level: "error",
    event: "adapter-start-void",
    hostAlias: alias,
    requestId: req.requestId,
    sessionId: session.id,
    code,
  });
  throw new PortRejectedError(code);
}

async function voidError(
  port: PortInternals,
  alias: string,
  error: unknown,
): Promise<PortUnreachableError | PohunekAdapterError> {
  const mapped = portErrorOf(error, alias);
  if (mapped instanceof PortUnreachableError) {
    await dropConnection(port, alias);
    return mapped;
  }
  return new PohunekAdapterError("void-incomplete");
}

async function listBound(
  port: PortInternals,
  client: Client,
  alias: string,
  requestId: string,
): Promise<SessionInfo[]> {
  try {
    return await client.call("session.list", {
      filters: [{ key: "metadata_eq", value: { key: MOC_METADATA.requestId, value: requestId } }],
    });
  } catch (error) {
    throw await mappedError(port, alias, error);
  }
}

// S4 cleanup: void every pending match of this digest with the daemon's mapped
// code, so a refused session.new leaves no binding (A9).
async function cleanupOrphans(
  port: PortInternals,
  client: Client,
  alias: string,
  req: StartRequest,
  digest: string,
  code: string,
): Promise<never> {
  const bound = await listBound(port, client, alias, req.requestId);
  for (const match of bound) {
    const startMeta: Record<string, string> | undefined = match.metadata;
    if (
      startMeta?.[MOC_METADATA.requestDigest] === digest &&
      startMeta[MOC_METADATA.start] === "pending"
    ) {
      await voidSession(port, client, alias, match, req, code);
    }
  }
  throw new PortRejectedError(code);
}

// S8 on the S3 path: the handle reads daemon branch and worktree, and the
// stored base commit with "" read as null.
function acceptedHandle(req: StartRequest, alias: string, session: SessionInfo): SessionHandle {
  const baseCommit = session.metadata?.[MOC_METADATA.baseCommit] ?? "";
  return {
    sessionId: session.id,
    requestId: req.requestId,
    hostAlias: alias,
    branch: session.branch ?? "",
    worktree: session.worktree_path ?? "",
    baseCommit: baseCommit === "" ? null : baseCommit,
  };
}

function logStartWarnings(
  port: PortInternals,
  alias: string,
  req: StartRequest,
  created: SessionNewResult,
): void {
  for (const warning of created.warnings ?? []) {
    port.log({
      level: "info",
      event: "adapter-start-warning",
      hostAlias: alias,
      requestId: req.requestId,
      sessionId: created.id,
      detail: warning.kind,
    });
  }
}

async function startSession(port: PortInternals, req: StartRequest): Promise<SessionHandle> {
  if (port.closed) {
    throw new PohunekAdapterError("closed");
  }
  const alias = req.hostAlias;
  const client = await clientFor(port, alias);
  const digest = requestDigestOf(req);
  const bound = await listBound(port, client, alias, req.requestId);
  const decision = lookupDecision(bound, digest);
  if (decision.kind === "reject") {
    throw new PortRejectedError(decision.code);
  }
  if (decision.kind === "return") {
    return acceptedHandle(req, alias, decision.session);
  }
  if (decision.kind === "void") {
    await voidSession(port, client, alias, decision.session, req, "start-unconfirmed");
  }
  let created: SessionNewResult;
  try {
    created = await client.call("session.new", sessionNewParams(req, port.config, digest));
  } catch (error) {
    const mapped = portErrorOf(error, alias);
    if (mapped instanceof PortUnreachableError) {
      await dropConnection(port, alias);
      throw mapped;
    }
    if (mapped instanceof PortRejectedError) {
      if (mapped.code === "branch-diverged") {
        throw mapped;
      }
      await cleanupOrphans(port, client, alias, req, digest, mapped.code);
    }
    throw error;
  }
  const failure = acceptanceFailure(req, created);
  if (failure !== null) {
    await voidSession(port, client, alias, created, req, failure);
  }
  logStartWarnings(port, alias, req, created);
  try {
    await client.call("session.set_metadata", {
      session_id: created.id,
      metadata: {
        [MOC_METADATA.start]: "accepted",
        [MOC_METADATA.baseCommit]: created.worktree_source?.commit ?? "",
      },
    });
  } catch (error) {
    if (isSessionNotFound(error)) {
      throw new PortRejectedError("session-not-found");
    }
    const mapped = portErrorOf(error, alias);
    if (mapped instanceof PortUnreachableError) {
      await dropConnection(port, alias);
      throw mapped;
    }
    if (mapped instanceof PortRejectedError) {
      await voidSession(port, client, alias, created, req, mapped.code);
    }
    throw error;
  }
  port.log({
    level: "info",
    event: "adapter-start-accepted",
    hostAlias: alias,
    requestId: req.requestId,
    sessionId: created.id,
  });
  return {
    sessionId: created.id,
    requestId: req.requestId,
    hostAlias: alias,
    branch: created.branch ?? "",
    worktree: created.worktree_path ?? "",
    baseCommit: created.worktree_source?.commit ?? null,
  };
}

// Lost terminal shared by W1, W3, W5 and X1: no mark, no stop, cached (3.7).
function lostTerminal(
  port: PortInternals,
  alias: string,
  id: string,
  cursor: string,
): TerminalResult {
  return storeTerminal(port, alias, {
    state: "lost",
    sessionId: id,
    cursor,
    usage: null,
    detail: "session missing",
  });
}

// W5 mark then stop (rows with mark): if the cache already holds a terminal,
// return it. Else write the marker (session_not_found: lost / session
// missing), then stop; any stop error is logged as adapter-stop-failed with
// its code and does not change the result.
async function markThenStop(
  port: PortInternals,
  client: Client,
  alias: string,
  id: string,
  cursor: string,
  state: TerminalState,
  detail: string,
): Promise<TerminalResult> {
  const cached = cachedTerminal(port, alias, id);
  if (cached !== undefined) {
    return cached;
  }
  try {
    await client.call("session.set_metadata", {
      session_id: id,
      metadata: { [MOC_METADATA.outcome]: state, [MOC_METADATA.outcomeDetail]: detail },
    });
  } catch (error) {
    if (isSessionNotFound(error)) {
      return lostTerminal(port, alias, id, cursor);
    }
    throw await mappedError(port, alias, error);
  }
  try {
    await client.call("session.stop", id);
  } catch (error) {
    port.log({
      level: "error",
      event: "adapter-stop-failed",
      hostAlias: alias,
      sessionId: id,
      code: error instanceof Error ? error.constructor.name : "unknown",
      detail,
    });
  }
  return storeTerminal(port, alias, {
    state,
    sessionId: id,
    cursor,
    usage: null,
    detail,
  });
}

async function waitSession(
  port: PortInternals,
  ref: SessionRef,
  timeoutMs: number,
  cursor: string | null,
): Promise<WaitResult> {
  if (port.closed) {
    throw new PohunekAdapterError("closed");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SESSION_WAIT_TURN_MS) {
    throw new RangeError(`timeoutMs must be an integer in 1..${String(MAX_SESSION_WAIT_TURN_MS)}`);
  }
  const alias = ref.hostAlias;
  const id = ref.sessionId;
  const cached = cachedTerminal(port, alias, id);
  if (cached !== undefined) {
    return cached;
  }
  const client = await clientFor(port, alias);
  let turn: SessionWaitTurnResult;
  try {
    turn = await client.sessionWaitTurn({
      session_ids: [id],
      until: ["turn_completed", "agent_blocked", "approval_required", "exited"],
      ...(cursor === null ? {} : { after: cursor }),
      timeout_ms: timeoutMs,
    });
  } catch (error) {
    if (isSessionNotFound(error)) {
      return lostTerminal(port, alias, id, cursor ?? "");
    }
    throw await mappedError(port, alias, error);
  }
  const progress = turn.progress.find((entry) => entry.session_id === id) ?? null;
  if (progress === null) {
    throw new PortRejectedError("progress-mismatch");
  }
  if (turn.reason === "event" && turn.event !== undefined && turn.event.session_id !== id) {
    throw new PortRejectedError("progress-mismatch");
  }
  let info: SessionInfo;
  try {
    info = await client.call("session.inspect", id);
  } catch (error) {
    if (isSessionNotFound(error)) {
      return lostTerminal(port, alias, id, turn.cursor);
    }
    throw await mappedError(port, alias, error);
  }
  const decision = waitDecision(id, turn, info);
  if (decision.kind === "running") {
    return { state: decision.state, sessionId: id, cursor: turn.cursor };
  }
  if (decision.mark) {
    return markThenStop(port, client, alias, id, turn.cursor, decision.state, decision.detail);
  }
  return storeTerminal(port, alias, {
    state: decision.state,
    sessionId: id,
    cursor: turn.cursor,
    usage: null,
    detail: decision.detail,
  });
}

// X0-X2: a cached terminal wins; stop (stopped:false is fine,
// session_not_found is a cached lost); then wait with cancelWaitTimeoutMs.
// The reason is logged, never sent.
async function cancelSession(
  port: PortInternals,
  ref: SessionRef,
  reason: CancelReason,
): Promise<WaitResult> {
  if (port.closed) {
    throw new PohunekAdapterError("closed");
  }
  port.log({
    level: "info",
    event: "adapter-cancel",
    hostAlias: ref.hostAlias,
    sessionId: ref.sessionId,
    detail: reason,
  });
  const cached = cachedTerminal(port, ref.hostAlias, ref.sessionId);
  if (cached !== undefined) {
    return cached;
  }
  const client = await clientFor(port, ref.hostAlias);
  try {
    await client.call("session.stop", ref.sessionId);
  } catch (error) {
    if (isSessionNotFound(error)) {
      return lostTerminal(port, ref.hostAlias, ref.sessionId, "");
    }
    throw await mappedError(port, ref.hostAlias, error);
  }
  return waitSession(port, ref, port.config.cancelWaitTimeoutMs, null);
}

// 3.8: session.diff mapped onto DiffResult. session_not_found gives
// PortRejectedError("session-not-found").
async function diffSession(
  port: PortInternals,
  ref: SessionRef,
  base: string,
): Promise<DiffResult> {
  if (port.closed) {
    throw new PohunekAdapterError("closed");
  }
  const client = await clientFor(port, ref.hostAlias);
  try {
    const result = await client.call("session.diff", {
      session_id: ref.sessionId,
      base,
    });
    return {
      sessionId: ref.sessionId,
      base: result.base,
      unifiedDiff: result.diff,
      truncated: result.truncated,
    };
  } catch (error) {
    if (isSessionNotFound(error)) {
      throw new PortRejectedError("session-not-found");
    }
    throw await mappedError(port, ref.hostAlias, error);
  }
}

// 3.9: close the connector once; a second close returns at once. Later
// start/wait/diff/cancel throw PohunekAdapterError("closed").
async function closePort(port: PortInternals): Promise<void> {
  if (port.closeDone) {
    return;
  }
  port.closeDone = true;
  port.closed = true;
  await port.connector.close();
}

export function createPohunekPort(
  config: PohunekAdapterConfig,
  deps: PohunekPortDeps,
): import("../port.js").DispatcherPort {
  const port: PortInternals = {
    config,
    connector: deps.connector,
    log: deps.log,
    closed: false,
    closeDone: false,
    inspected: new Map(),
    terminals: new Map(),
  };
  return {
    start: (req: StartRequest) => startSession(port, req),
    wait: (ref: SessionRef, timeoutMs: number, cursor: string | null) =>
      waitSession(port, ref, timeoutMs, cursor),
    diff: (ref: SessionRef, base: string) => diffSession(port, ref, base),
    cancel: (ref: SessionRef, reason: CancelReason) => cancelSession(port, ref, reason),
    close: () => closePort(port),
  };
}

export async function openPohunekPort(
  config: PohunekAdapterConfig,
  log: (event: AdapterLogEvent) => void,
  env: Readonly<Record<string, string | undefined>>,
): Promise<import("../port.js").DispatcherPort> {
  const routes = await loadHostRoutes(config.hostRoutesFileEnv, env);
  const connector = createHostConnector(routes, { connectTimeoutMs: config.connectTimeoutMs }, env);
  return createPohunekPort(config, { connector, log });
}
