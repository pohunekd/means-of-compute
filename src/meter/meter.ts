// Meter facade: grant lifecycle, settle and close of design sections 2.7,
// 4.5 and 4.6. The request handler lives in proxy.ts, the store in
// usage-log.ts and the join in join.ts.
import type { PortUsage, SessionRef, TerminalState } from "../dispatcher/port.js";
import type { ProviderDescriptor } from "../providers/types.js";
import { MeterConfigError, type MeterConfig, type MeterEnv } from "./config.js";
import { joinUsage } from "./join.js";
import { handleMeterRequest, type ProxyState } from "./proxy.js";
import { serveMeter, type MeterServer } from "./server.js";
import { tokenFor } from "./token.js";
import {
  openUsageAppender,
  replayUsageLog,
  type UsageAppender,
  type UsageIndex,
} from "./usage-log.js";

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
  constructor(message: string) {
    super(message);
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

export interface MeterDeps {
  readonly config: MeterConfig;
  readonly env: MeterEnv;
  readonly providers: Readonly<Record<string, ProviderDescriptor>>;
  readonly now: () => Date;
  readonly log: (event: MeterLogEvent) => void;
}

export interface Meter {
  readonly port: number;
  tokenFor(requestId: string): string;
  openGrant(spec: GrantSpec): Promise<void>;
  bindGrant(requestId: string, sessionId: string): Promise<void>;
  settle(sessionId: string, state: TerminalState): Promise<PortUsage | null>;
  close(): Promise<void>;
}

export type { SessionRef };

const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}:(0|[1-9][0-9]*)$/;
const WORK_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function checkFailed(appender: UsageAppender): void {
  if (appender.failed) {
    throw new MeterUnavailableError("meter: usage log failed");
  }
}

export async function startMeter(deps: MeterDeps): Promise<Meter> {
  const { config, env, providers, now, log } = deps;
  const index = await replayUsageLog(config.usageLogPath, "repair", log);
  const appender = await openUsageAppender(config.usageLogPath, index, log);
  const inFlight = new Map<string, number>();
  const drainControllers = new Map<string, AbortController>();
  const settleMemos = new Map<string, Promise<PortUsage | null>>();

  const buildState = (live: UsageIndex): ProxyState => ({
    config,
    secret: env.secret,
    hostAddresses: env.hostAddresses,
    providers,
    appender: () => appender,
    maxInFlight: (requestId: string) => inFlight.get(requestId) ?? 0,
    now,
    log,
    trackCall: (requestId: string) => {
      inFlight.set(requestId, (inFlight.get(requestId) ?? 0) + 1);
      if (!drainControllers.has(requestId)) {
        drainControllers.set(requestId, new AbortController());
      }
      return () => {
        const left = (inFlight.get(requestId) ?? 1) - 1;
        if (left <= 0) {
          inFlight.delete(requestId);
        } else {
          inFlight.set(requestId, left);
        }
      };
    },
    drainSignal: (requestId: string) => drainControllers.get(requestId)?.signal ?? null,
  });

  let server: MeterServer;
  try {
    server = serveMeter(config, env.listen, buildState, index, log);
  } catch (error: unknown) {
    await appender.close().catch(() => {});
    const code = error instanceof Error ? error.message : String(error);
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
      throw new MeterGrantError("request-conflict", `meter: request conflict for "${spec.workItemId}"`);
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
    const existing = index.grants.get(spec.requestId);
    if (existing !== undefined) {
      if (existing.closed) {
        throw new MeterGrantError("grant-closed", "meter: grant is closed");
      }
      const first = existing.open;
      if (
        first.workItemId !== spec.workItemId ||
        first.hostAlias !== spec.hostAlias ||
        first.providerId !== spec.providerId ||
        first.model !== spec.model
      ) {
        throw new MeterGrantError("request-conflict", "meter: grant conflicts with the open grant");
      }
    }
    await appender.appendUnguarded({
      kind: "grant-open",
      at: now().toISOString(),
      requestId: spec.requestId,
      workItemId: spec.workItemId,
      hostAlias: spec.hostAlias,
      providerId: spec.providerId,
      model: spec.model,
    });
    checkFailed(appender);
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
    const grant = index.grants.get(requestId);
    if (grant === undefined) {
      throw new MeterGrantError("unknown-request", "meter: unknown grant");
    }
    if (grant.sessionId === sessionId) {
      return;
    }
    if (grant.sessionId !== null) {
      throw new MeterGrantError("session-conflict", "meter: grant already bound");
    }
    const other = index.requestBySession.get(sessionId);
    if (other !== undefined && other !== requestId) {
      throw new MeterGrantError("session-conflict", "meter: session already bound");
    }
    await appender.appendUnguarded({
      kind: "grant-bind",
      at: now().toISOString(),
      requestId,
      sessionId,
    });
    checkFailed(appender);
    log({ level: "info", event: "grant-bound", requestId });
  }

  async function settle(sessionId: string, state: TerminalState): Promise<PortUsage | null> {
    const requestId = index.requestBySession.get(sessionId);
    if (requestId === undefined) {
      log({ level: "error", event: "unknown-session" });
      return null;
    }
    const known = requestId;
    let memo = settleMemos.get(known);
    if (memo === undefined) {
      memo = settleGrant(known, state);
      settleMemos.set(known, memo);
    }
    return memo;
  }

  async function settleGrant(requestId: string, state: TerminalState): Promise<PortUsage | null> {
    checkFailed(appender);
    const grant = index.grants.get(requestId);
    if (grant === undefined) {
      return null;
    }
    if (!grant.closed) {
      await appender.appendUnguarded({
        kind: "grant-close",
        at: now().toISOString(),
        requestId,
        state,
      });
      checkFailed(appender);
    }
    const deadline = Date.now() + config.drainTimeoutMs;
    for (;;) {
      if ((inFlight.get(requestId) ?? 0) === 0) {
        break;
      }
      if (Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const remaining = inFlight.get(requestId) ?? 0;
    if (remaining > 0) {
      const controller = drainControllers.get(requestId);
      controller?.abort();
      log({ level: "info", event: "drain-abort", requestId, count: remaining });
      for (;;) {
        if ((inFlight.get(requestId) ?? 0) === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    drainControllers.delete(requestId);
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
    // Design 2.7: stop the server, abort every in-flight upstream call,
    // await each call-end append, then close the append handle.
    server.stop(true);
    for (const controller of drainControllers.values()) {
      controller.abort();
    }
    for (;;) {
      let busy = false;
      for (const count of inFlight.values()) {
        if (count > 0) {
          busy = true;
        }
      }
      if (!busy) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await appender.close();
  }

  return {
    get port(): number {
      return server.port;
    },
    tokenFor: mintToken,
    openGrant,
    bindGrant,
    settle,
    close,
  };
}

export { handleMeterRequest };
