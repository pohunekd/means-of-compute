// Meter facade: grant lifecycle, settle and close of design sections 2.7,
// 4.5 and 4.6. The request handler lives in proxy.ts, the store in
// usage-log.ts and the join in join.ts.
import type { PortUsage, SessionRef, TerminalState } from "../dispatcher/port.js";
import type { ProviderDescriptor } from "../providers/types.js";
import { MeterConfigError, type MeterConfig, type MeterEnv } from "./config.js";
import { joinUsage } from "./join.js";
import { handleMeterRequest } from "./proxy.js";
import type { ProxyState } from "./proxy.js";
import type { UsageIndex } from "./usage-log.js";
import { serveMeter, type MeterServer } from "./server.js";
import type { MeterTimers } from "./timers.js";
import { tokenFor } from "./token.js";
import { openUsageAppender, replayUsageLog } from "./usage-log.js";
import type { UsageAppender, UsageLogIo } from "./usage-log.js";

export interface GrantSpec {
  readonly requestId: string;
  readonly workItemId: string;
  readonly hostAlias: string;
  readonly providerId: string;
  readonly model: string;
}

export type MeterGrantCode =
  | "request-conflict"
  | "grant-closed"
  | "provider-not-routed"
  | "model-mismatch"
  | "unknown-host"
  | "unknown-request"
  | "session-conflict";

export class MeterGrantError extends Error {
  readonly code: MeterGrantCode;
  constructor(code: MeterGrantCode, message: string) {
    super(message);
    this.name = "MeterGrantError";
    this.code = code;
  }
}

export class MeterUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MeterUnavailableError";
  }
}

export interface MeterLogEvent {
  readonly level: "info" | "warn" | "error";
  readonly event: string;
  readonly requestId?: string;
  readonly callId?: string;
  readonly hostAlias?: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly status?: number;
  readonly code?: string;
  readonly outcome?: string;
  readonly billed?: boolean;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly ms?: number;
  readonly bytesIn?: number;
  readonly bytesOut?: number;
  readonly count?: number;
}

export interface LiveCall {
  readonly callId: string;
  readonly ended: Promise<void>;
  requestAbort(reason: "closed-abort"): void;
  attachAborter(abort: (reason: "closed-abort") => void): void;
  finish(): void;
}

export interface MeterDeps {
  readonly config: MeterConfig;
  readonly env: MeterEnv;
  readonly providers: Readonly<Record<string, ProviderDescriptor>>;
  readonly now: () => Date;
  readonly log: (event: MeterLogEvent) => void;
  readonly timers: MeterTimers;
  readonly logIo: UsageLogIo;
}

export interface MeterLiveView {
  readonly liveCount: (requestId: string) => number;
}

export interface MeterInternals {
  buildState(): ProxyState;
  readonly usageIndex: UsageIndex;
}

export interface Meter extends MeterLiveView {
  readonly port: number;
  tokenFor(requestId: string): string;
  openGrant(spec: GrantSpec): Promise<void>;
  bindGrant(requestId: string, sessionId: string): Promise<void>;
  settle(sessionId: string, state: TerminalState): Promise<PortUsage | null>;
  close(): Promise<void>;
  liveCount(requestId: string): number;
}

export type { SessionRef };

const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}:(0|[1-9][0-9]*)$/;
const WORK_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function checkFailed(appender: UsageAppender): void {
  if (appender.failed) {
    throw new MeterUnavailableError("meter: usage log failed");
  }
}

export async function startMeterWithInternals(deps: MeterDeps): Promise<{
  meter: Meter;
  internals: MeterInternals;
}> {
  const { config, env, providers, now, log, timers, logIo } = deps;
  const index = await replayUsageLog(config.usageLogPath, "repair", log);
  const appender = await openUsageAppender(config.usageLogPath, index, log, logIo);
  // Live calls join inside their call-start atomic step and leave when
  // their call-end append settles; finish() is the only way out,
  // idempotent.
  const live = new Map<string, Map<string, LiveCall>>();
  let closing = false;
  const settleMemos = new Map<string, Promise<PortUsage | null>>();

  function reserveCall(requestId: string, callId: string): LiveCall {
    let byCall = live.get(requestId);
    if (byCall === undefined) {
      byCall = new Map();
      live.set(requestId, byCall);
    }
    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    let finished = false;
    let abortRequested = false;
    let aborter: ((reason: "closed-abort") => void) | null = null;
    const call: LiveCall = {
      callId,
      ended,
      requestAbort(): void {
        abortRequested = true;
        aborter?.("closed-abort");
      },
      attachAborter(abort: (reason: "closed-abort") => void): void {
        if (abortRequested) {
          abort("closed-abort");
        }
        aborter = abort;
      },
      finish(): void {
        if (finished) {
          return;
        }
        finished = true;
        live.get(requestId)?.delete(callId);
        resolveEnded();
      },
    };
    byCall.set(callId, call);
    return call;
  }

  const buildState = (): ProxyState => ({
    config,
    secret: env.secret,
    hostAddresses: env.hostAddresses,
    providers,
    timers,
    appender: () => appender,
    liveCount: (requestId: string) => live.get(requestId)?.size ?? 0,
    reserveCall: (requestId: string, callId: string) => reserveCall(requestId, callId),
    closing: () => closing,
    now,
    log,
  });

  let server: MeterServer;
  try {
    server = serveMeter(config, env.listen, buildState, index, log);
  } catch (error: unknown) {
    await appender.close().catch(() => {});
    const raw = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    const code = typeof raw === "string" && /^E[A-Z]+$/.test(raw) ? raw : "bind-failed";
    throw new MeterConfigError(`meter listener ${config.listenAlias}: ${code}`);
  }

  function mintToken(requestId: string): string {
    return tokenFor(env.secret, requestId);
  }

  async function openGrant(spec: GrantSpec): Promise<void> {
    checkFailed(appender);
    if (
      !REQUEST_ID_PATTERN.test(spec.requestId) ||
      !WORK_ITEM_ID_PATTERN.test(spec.workItemId) ||
      spec.requestId.split(":")[0] !== spec.workItemId
    ) {
      throw new MeterGrantError(
        "request-conflict",
        `meter: request conflict for "${spec.workItemId}"`,
      );
    }
    if (!(spec.providerId in providers)) {
      throw new MeterGrantError(
        "provider-not-routed",
        `meter: provider "${spec.providerId}" is not routed`,
      );
    }
    const descriptor = providers[spec.providerId] as ProviderDescriptor;
    if (descriptor.model !== spec.model) {
      throw new MeterGrantError(
        "model-mismatch",
        `meter: model "${spec.model}" does not match provider "${spec.providerId}"`,
      );
    }
    if (!env.hostAddresses.has(spec.hostAlias)) {
      throw new MeterGrantError("unknown-host", `meter: unknown host "${spec.hostAlias}"`);
    }
    // The open-vs-reopen check runs inside the append chain step, not
    // here — a pre-check would race with a concurrent opener.
    // A checkRecord rejection throws MeterUnavailableError with cause.
    let openVerdict: "request-conflict" | "grant-closed" | "meter-unavailable" | null;
    try {
      openVerdict = await appender.appendGuarded(
        {
          kind: "grant-open",
          at: now().toISOString(),
          requestId: spec.requestId,
          workItemId: spec.workItemId,
          hostAlias: spec.hostAlias,
          providerId: spec.providerId,
          model: spec.model,
        },
        (guarded) => {
          const live = guarded.grants.get(spec.requestId);
          if (live !== undefined) {
            if (live.closed) {
              return "grant-closed";
            }
            const first = live.open;
            if (
              first.workItemId !== spec.workItemId ||
              first.hostAlias !== spec.hostAlias ||
              first.providerId !== spec.providerId ||
              first.model !== spec.model
            ) {
              return "request-conflict";
            }
          }
          return null;
        },
      );
    } catch (error: unknown) {
      throw new MeterUnavailableError("meter: usage log rejected a record", { cause: error });
    }
    // A byte-identical reopen settles nothing and logs grant-opened
    // again; a conflicting reopen throws request-conflict.
    checkFailed(appender);
    if (openVerdict === "request-conflict") {
      throw new MeterGrantError(
        "request-conflict",
        `meter: request conflict for "${spec.workItemId}"`,
      );
    }
    if (openVerdict === "grant-closed") {
      throw new MeterGrantError("grant-closed", "meter: grant is closed");
    }
    if (openVerdict === "meter-unavailable") {
      throw new MeterUnavailableError("meter: usage log failed");
    }
    log({
      level: "info",
      event: "grant-opened",
      requestId: spec.requestId,
      hostAlias: spec.hostAlias,
      providerId: spec.providerId,
      model: spec.model,
    });
  }

  async function bindGrant(requestId: string, sessionId: string): Promise<void> {
    checkFailed(appender);
    // The bind check runs inside the append chain step, not here — a
    // pre-check would race with a concurrent binder. A checkRecord
    // rejection throws MeterUnavailableError with cause.
    let bindVerdict:
      "unknown-request" | "already-bound" | "session-conflict" | "meter-unavailable" | null;
    try {
      bindVerdict = await appender.appendGuarded(
        {
          kind: "grant-bind",
          at: now().toISOString(),
          requestId,
          sessionId,
        },
        (guarded) => {
          const live = guarded.grants.get(requestId);
          if (live === undefined) {
            return "unknown-request";
          }
          if (live.sessionId === sessionId) {
            return "already-bound";
          }
          if (live.sessionId !== null) {
            return "session-conflict";
          }
          const other = guarded.requestBySession.get(sessionId);
          if (other !== undefined && other !== requestId) {
            return "session-conflict";
          }
          return null;
        },
      );
    } catch (error: unknown) {
      throw new MeterUnavailableError("meter: usage log rejected a record", { cause: error });
    }
    checkFailed(appender);
    if (bindVerdict === "already-bound") {
      return;
    }
    if (bindVerdict === "meter-unavailable") {
      throw new MeterUnavailableError("meter: usage log failed");
    }
    if (bindVerdict === "unknown-request") {
      throw new MeterGrantError("unknown-request", "meter: unknown grant");
    }
    if (bindVerdict === "session-conflict") {
      throw new MeterGrantError("session-conflict", "meter: grant already bound");
    }
    log({ level: "info", event: "grant-bound", requestId });
  }

  async function settle(sessionId: string, state: TerminalState): Promise<PortUsage | null> {
    const requestId = index.requestBySession.get(sessionId);
    if (requestId === undefined) {
      log({ level: "error", event: "unknown-session" });
      return null;
    }
    const known = requestId;
    // A resolved memo is returned before the latch check: a grant
    // that has settled keeps its value. A grant that has not settled
    // still sees the latch first, because its close could never have
    // gone durable.
    const memo = settleMemos.get(known);
    if (memo !== undefined) {
      return memo;
    }
    checkFailed(appender);
    const fresh = settleGrant(known, state);
    settleMemos.set(known, fresh);
    return fresh;
  }

  async function settleGrant(requestId: string, state: TerminalState): Promise<PortUsage | null> {
    checkFailed(appender);
    const grant = index.grants.get(requestId);
    if (grant === undefined) {
      return null;
    }
    let closeVerdict: "already-closed" | "meter-unavailable" | null;
    try {
      closeVerdict = await appender.appendGuarded(
        {
          kind: "grant-close",
          at: now().toISOString(),
          requestId,
          state,
        },
        (guarded) => (guarded.grants.get(requestId)?.closed === true ? "already-closed" : null),
      );
    } catch (error: unknown) {
      throw new MeterUnavailableError("meter: usage log rejected a record", { cause: error });
    }
    if (closeVerdict === "meter-unavailable") {
      throw new MeterUnavailableError("meter: usage log failed");
    }
    // already-closed continues with no record.
    // After the grant-close is queued, the live set is snapshotted,
    // then the drain timer is armed: settle waits up to
    // drainTimeoutMs for the racing calls, aborts every call that is
    // still live, and only then joins usage. Because the timer arms
    // after the snapshot, a call that ends between the verdict and
    // the await still lets the race resolve instead of stalling on
    // an abort nobody needs.
    const racing = [...(live.get(requestId)?.values() ?? [])];
    let cancelDrain!: () => void;
    const drainTimer = new Promise<void>((resolve) => {
      cancelDrain = timers.after(config.drainTimeoutMs, resolve);
    });
    if (racing.length > 0) {
      await Promise.race([Promise.all(racing.map((c) => c.ended)), drainTimer]);
      cancelDrain();
    } else {
      // No live calls: never wait on the drain budget; the join follows
      // the durable close at once.
      cancelDrain();
    }
    const remaining = [...(live.get(requestId)?.values() ?? [])];
    for (const call of remaining) {
      call.requestAbort("closed-abort");
    }
    if (remaining.length > 0) {
      log({ level: "info", event: "drain-abort", requestId, count: remaining.length });
    }
    await Promise.all(racing.map((c) => c.ended));
    checkFailed(appender);
    let billed = 0;
    for (const callId of index.startOrder) {
      const start = index.starts.get(callId);
      if (start?.requestId !== requestId) {
        continue;
      }
      const endRecord = index.ends.get(callId);
      if (endRecord === undefined || endRecord.billed) {
        billed += 1;
      }
    }
    log({ level: "info", event: "grant-closed", requestId, count: billed });
    return joinUsage(index, requestId);
  }

  async function close(): Promise<void> {
    // Design 5.7: flag the close, stop the server, drain the append chain,
    // abort every live call, await every end, then close the handle.
    closing = true;
    server.stop(true);
    await appender.idle();
    const calls: LiveCall[] = [];
    for (const byCall of live.values()) {
      for (const call of byCall.values()) {
        calls.push(call);
      }
    }
    for (const call of calls) {
      call.requestAbort("closed-abort");
    }
    await Promise.all(calls.map((c) => c.ended));
    await appender.close();
  }

  function readLiveCount(requestId: string): number {
    return live.get(requestId)?.size ?? 0;
  }

  return {
    meter: {
      get port(): number {
        return server.port;
      },
      tokenFor: mintToken,
      openGrant,
      bindGrant,
      settle,
      close,
      liveCount: readLiveCount,
    },
    internals: { buildState, usageIndex: index },
  };
}

export async function startMeter(deps: MeterDeps): Promise<Meter> {
  return (await startMeterWithInternals(deps)).meter;
}

export { handleMeterRequest };
