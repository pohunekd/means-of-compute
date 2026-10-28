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
  type ReleaseRef,
  type ReleaseResult,
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
  readonly meterToken: ((requestId: string) => string) | null;
}

export class PohunekAdapterError extends Error {
  readonly code: "closed" | "void-incomplete" | "no-meter";
  constructor(code: "closed" | "void-incomplete" | "no-meter", message?: string) {
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
  readonly meterToken: ((requestId: string) => string) | null;
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
// value back (3.7). The cache keys on the sessionId parameter, never on
// result.sessionId (M1).
function storeTerminal(
  port: PortInternals,
  hostAlias: string,
  sessionId: string,
  result: TerminalResult,
): TerminalResult {
  const key = terminalKey(hostAlias, sessionId);
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
// propagates unchanged. A thrown non-Error value is rethrown unchanged (L2),
// as 3.6 does for the null group. Callers throw the result, so control never
// continues past a caught error.
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
  throw error;
}

// Client for the start path (S0): the connector resolves the route, then
// S2 and S3 run (listBound, lookupDecision). Only the create branch runs
// the host preflight (S1) before S4 (decision R2-H1). The per-Client
// preflight cache is kept; a dropped client is inspected again on next use.
async function startClientFor(port: PortInternals, alias: string): Promise<Client> {
  try {
    return await port.connector.client(alias);
  } catch (error) {
    throw await mappedError(port, alias, error);
  }
}

// S1 host preflight on the create branch: host.inspect runs once per Client
// instance. A failing host throws PortRejectedError("host-unsupported") with
// no session.new on the create path.
async function startPreflight(port: PortInternals, alias: string, client: Client): Promise<void> {
  if (port.inspected.get(alias) === client) {
    return;
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
}

// Client for wait, cancel and diff (H2): no preflight, so these paths work
// even when the host later fails the start preflight. The connector still
// throws for unknown aliases and unreachable hosts.
async function clientFor(port: PortInternals, alias: string): Promise<Client> {
  try {
    return await port.connector.client(alias);
  } catch (error) {
    throw await mappedError(port, alias, error);
  }
}

// Stop then unbind one session: V1 stops the session (a missing session
// counts as stopped); V2 clears the binding with the five void keys (a
// missing session counts as unbound). Any other error becomes
// void-incomplete. Returns normally; callers decide what to throw or log.
async function stopAndUnbind(
  port: PortInternals,
  client: Client,
  alias: string,
  sessionId: string,
  requestId: string,
  code: string,
  unbind: boolean,
): Promise<void> {
  try {
    await client.call("session.stop", sessionId);
  } catch (error) {
    if (!isSessionNotFound(error)) {
      throw await voidError(port, alias, error);
    }
  }
  if (!unbind) {
    return;
  }
  try {
    await client.call("session.set_metadata", {
      session_id: sessionId,
      metadata: {
        [MOC_METADATA.requestId]: null,
        [MOC_METADATA.start]: "void",
        [MOC_METADATA.voidCode]: code,
        [MOC_METADATA.voidedRequestId]: requestId,
        [MOC_METADATA.meterToken]: null,
      },
    });
  } catch (error) {
    if (!isSessionNotFound(error)) {
      throw await voidError(port, alias, error);
    }
  }
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
  await stopAndUnbind(port, client, alias, session.id, req.requestId, code, true);
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
  if (port.meterToken === null) {
    throw new PohunekAdapterError("no-meter");
  }
  const token = port.meterToken(req.requestId);
  const alias = req.hostAlias;
  const client = await startClientFor(port, alias);
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
  await startPreflight(port, alias, client);
  let created: SessionNewResult;
  try {
    created = await client.call("session.new", sessionNewParams(req, port.config, digest, token));
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
// The cursor is the caller's cursor (W1) or null (X1); never "".
function lostTerminal(
  port: PortInternals,
  alias: string,
  id: string,
  cursor: string | null,
): TerminalResult {
  return storeTerminal(port, alias, id, {
    state: "lost",
    sessionId: id,
    cursor,
    usage: null,
    detail: "session missing",
  });
}

// Kebab code for a failed terminal stop (L1): the kebab code from
// portErrorOf(error, alias), or "unknown" when that gives null. Never the
// message.
function stopFailedCode(alias: string, error: unknown): string {
  const mapped = portErrorOf(error, alias);
  if (mapped instanceof PortRejectedError) {
    return mapped.code;
  }
  if (mapped instanceof PortUnreachableError) {
    const code = mapped.message.slice(alias.length + 2);
    return code.replaceAll("_", "-");
  }
  return "unknown";
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
      code: stopFailedCode(alias, error),
      detail,
    });
  }
  return storeTerminal(port, alias, id, {
    state,
    sessionId: id,
    cursor,
    usage: null,
    detail,
  });
}

// Non-mark terminal with stop: the outcome metadata is already present, so
// there is nothing to mark; stop a live session, then cache the terminal
// (H1). A stop failure is logged as adapter-stop-failed, as in W5, and the
// terminal is still returned.
async function stopThenStoreTerminal(
  port: PortInternals,
  client: Client,
  alias: string,
  id: string,
  cursor: string,
  state: TerminalState,
  detail: string,
): Promise<TerminalResult> {
  try {
    await client.call("session.stop", id);
  } catch (error) {
    port.log({
      level: "error",
      event: "adapter-stop-failed",
      hostAlias: alias,
      sessionId: id,
      code: stopFailedCode(alias, error),
      detail,
    });
  }
  return storeTerminal(port, alias, id, {
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
      return lostTerminal(port, alias, id, cursor);
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
  if (decision.stop) {
    return stopThenStoreTerminal(
      port,
      client,
      alias,
      id,
      turn.cursor,
      decision.state,
      decision.detail,
    );
  }
  return storeTerminal(port, alias, id, {
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
      return lostTerminal(port, ref.hostAlias, ref.sessionId, null);
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

// Operator release: stop every session on the host that is either the
// known id or bound to the request, then unbind each stopped bound one.
// The binding filter decides with daemon order; the known id comes first.
// A missing session counts as released. The daemon is the authority, so the
// terminal cache is neither read nor written. Any refusal becomes
// PortRejectedError("void-incomplete").
async function releaseSessions(port: PortInternals, ref: ReleaseRef): Promise<ReleaseResult> {
  if (port.closed) {
    throw new PohunekAdapterError("closed");
  }
  const alias = ref.hostAlias;
  const client = await clientFor(port, alias);
  const bound = await listBound(port, client, alias, ref.requestId);
  const ids: string[] = [];
  if (ref.sessionId !== null) {
    ids.push(ref.sessionId);
  }
  for (const match of bound) {
    if (!ids.includes(match.id)) {
      ids.push(match.id);
    }
  }
  try {
    for (const id of ids) {
      await stopAndUnbind(
        port,
        client,
        alias,
        id,
        ref.requestId,
        "operator-release",
        bound.some((session) => session.id === id),
      );
      port.log({
        level: "info",
        event: "adapter-release",
        hostAlias: alias,
        requestId: ref.requestId,
        sessionId: id,
        code: "operator-release",
      });
    }
  } catch (error) {
    if (error instanceof PohunekAdapterError && error.code === "void-incomplete") {
      throw new PortRejectedError("void-incomplete");
    }
    throw error;
  }
  return { sessionIds: ids };
}

// 3.9: close the connector once; a second close returns at once. Later
// start/wait/diff/cancel/release throw PohunekAdapterError("closed").
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
    meterToken: deps.meterToken,
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
    release: (ref: ReleaseRef): Promise<ReleaseResult> => releaseSessions(port, ref),
    close: () => closePort(port),
  };
}

export async function openPohunekPort(
  config: PohunekAdapterConfig,
  log: (event: AdapterLogEvent) => void,
  env: Readonly<Record<string, string | undefined>>,
  meterToken: ((requestId: string) => string) | null,
): Promise<import("../port.js").DispatcherPort> {
  const routes = await loadHostRoutes(config.hostRoutesFileEnv, env);
  const connector = createHostConnector(routes, { connectTimeoutMs: config.connectTimeoutMs }, env);
  return createPohunekPort(config, { connector, log, meterToken });
}
