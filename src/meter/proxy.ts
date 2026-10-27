// Metering proxy request handler: route, call authorization, forwarding,
// response pump, timers and usage extraction of design sections 3.1 to 3.7.
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { TerminalState } from "../dispatcher/port.js";
import type { ProviderDescriptor } from "../providers/types.js";
import type { MeterConfig } from "./config.js";
import type { MeterLogEvent } from "./meter.js";
import { createJsonUsageTap, createSseUsageTap } from "./sse.js";
import { verifyBearer } from "./token.js";
import type { CallOutcome, UsageAppender, UsageIndex, UsageLogRecord } from "./usage-log.js";

export type MeterRejectCode =
  | "not-found"
  | "method-not-allowed"
  | "unauthorized"
  | "no-grant"
  | "grant-closed"
  | "grant-unbound"
  | "wrong-host"
  | "unsupported-media-type"
  | "body-too-large"
  | "invalid-json"
  | "invalid-body"
  | "model-mismatch"
  | "provider-key-missing"
  | "session-concurrency"
  | "meter-unavailable"
  | "upstream-unreachable"
  | "upstream-timeout"
  | "upstream-error";

export interface ProxyState {
  readonly config: MeterConfig;
  readonly secret: Buffer;
  readonly hostAddresses: ReadonlyMap<string, ReadonlySet<string>>;
  readonly providers: Readonly<Record<string, ProviderDescriptor>>;
  readonly appender: () => UsageAppender;
  readonly maxInFlight: (requestId: string) => number;
  readonly now: () => Date;
  readonly log: (event: MeterLogEvent) => void;
  readonly trackCall: (requestId: string) => () => void;
  readonly drainSignal: (requestId: string) => AbortSignal | null;
}

interface GrantView {
  readonly requestId: string;
  readonly hostAlias: string;
  readonly providerId: string;
  readonly closed: boolean;
  readonly sessionId: string | null;
  readonly lastOpenAt: string;
}

const TERMINAL_STATES: readonly string[] = ["finished", "failed", "lost", "cancelled"];

function errorResponse(code: MeterRejectCode, status: number): Response {
  return new Response(JSON.stringify({ error: { type: "moc_meter", code, message: code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeIp(address: string | null): string | null {
  if (address === null) {
    return null;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    return address.slice("::ffff:".length);
  }
  return address;
}

function grantView(index: UsageIndex, requestId: string): GrantView | null {
  const grant = index.grants.get(requestId);
  if (grant === undefined) {
    return null;
  }
  return {
    requestId,
    hostAlias: grant.open.hostAlias,
    providerId: grant.open.providerId,
    closed: grant.closed,
    sessionId: grant.sessionId,
    lastOpenAt: grant.lastOpenAt,
  };
}

function authorize(
  state: ProxyState,
  index: UsageIndex,
  req: Request,
  remoteAddress: string | null,
): { requestId: string; grant: GrantView } | { code: MeterRejectCode; status: number } {
  const requestId = verifyBearer(state.secret, req.headers.get("authorization"));
  if (requestId === null) {
    return { code: "unauthorized", status: 401 };
  }
  const grant = grantView(index, requestId);
  if (grant === null) {
    return { code: "no-grant", status: 403 };
  }
  if (grant.closed) {
    return { code: "grant-closed", status: 403 };
  }
  if (grant.sessionId === null) {
    const age = Date.parse(state.now().toISOString()) - Date.parse(grant.lastOpenAt);
    if (age > state.config.unboundGrantTtlMs) {
      return { code: "grant-unbound", status: 403 };
    }
  }
  const allowed = state.hostAddresses.get(grant.hostAlias);
  const normalized = normalizeIp(remoteAddress);
  if (allowed === undefined || normalized === null || !allowed.has(normalized)) {
    return { code: "wrong-host", status: 403 };
  }
  return { requestId, grant };
}

function isTerminalState(value: unknown): value is TerminalState {
  return typeof value === "string" && (TERMINAL_STATES as readonly string[]).includes(value);
}

export async function handleMeterRequest(
  state: ProxyState,
  req: Request,
  server: { timeout: (req: Request, seconds: number) => void } | null,
  remoteAddress: string | null,
  index: UsageIndex,
): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/v1/chat/completions") {
    return errorResponse("not-found", 404);
  }
  if (req.method !== "POST") {
    return errorResponse("method-not-allowed", 405);
  }
  const auth = authorize(state, index, req, remoteAddress);
  if ("code" in auth) {
    state.log({ level: "warn", event: "request-rejected", code: auth.code, status: auth.status });
    return errorResponse(auth.code, auth.status);
  }
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    state.log({
      level: "warn",
      event: "request-rejected",
      code: "unsupported-media-type",
      status: 415,
      requestId: auth.requestId,
    });
    return errorResponse("unsupported-media-type", 415);
  }
  const lengthRaw = req.headers.get("content-length");
  if (lengthRaw !== null && Number(lengthRaw) > state.config.maxRequestBytes) {
    state.log({
      level: "warn",
      event: "request-rejected",
      code: "body-too-large",
      status: 413,
      requestId: auth.requestId,
    });
    return errorResponse("body-too-large", 413);
  }
  server?.timeout(req, 0);
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    state.log({
      level: "warn",
      event: "request-rejected",
      code: "invalid-json",
      status: 400,
      requestId: auth.requestId,
    });
    return errorResponse("invalid-json", 400);
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    state.log({
      level: "warn",
      event: "request-rejected",
      code: "invalid-json",
      status: 400,
      requestId: auth.requestId,
    });
    return errorResponse("invalid-json", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse("invalid-body", 400);
  }
  const fields = body as Record<string, unknown>;
  if (
    ("stream" in fields && typeof fields["stream"] !== "boolean") ||
    ("stream_options" in fields &&
      (typeof fields["stream_options"] !== "object" ||
        fields["stream_options"] === null ||
        Array.isArray(fields["stream_options"])))
  ) {
    return errorResponse("invalid-body", 400);
  }
  if (fields["model"] !== state.config.sessionModelId) {
    state.log({
      level: "warn",
      event: "request-rejected",
      code: "model-mismatch",
      status: 400,
      requestId: auth.requestId,
    });
    return errorResponse("model-mismatch", 400);
  }
  const descriptor = state.providers[auth.grant.providerId];
  if (descriptor === undefined) {
    state.log({
      level: "warn",
      event: "request-rejected",
      code: "no-grant",
      status: 403,
      requestId: auth.requestId,
    });
    return errorResponse("no-grant", 403);
  }
  if (descriptor.apiKeyEnv !== undefined && !process.env[descriptor.apiKeyEnv]) {
    state.log({
      level: "warn",
      event: "request-rejected",
      code: "provider-key-missing",
      status: 503,
      requestId: auth.requestId,
    });
    return errorResponse("provider-key-missing", 503);
  }
  const stream = fields["stream"] === true;
  const grantId = auth.grant.requestId;
  const callId = randomUUID();
  const callStart: UsageLogRecord = {
    kind: "call-start",
    at: state.now().toISOString(),
    callId,
    requestId: grantId,
    providerId: descriptor.id,
    model: descriptor.model,
    stream,
  };
  const verdict = await state.appender().appendGuarded(callStart, (live) => {
    const liveGrant = live.grants.get(grantId);
    if (liveGrant === undefined || liveGrant.closed) {
      return "grant-closed";
    }
    if (state.maxInFlight(grantId) >= state.config.maxInFlightPerSession) {
      return "session-concurrency";
    }
    return null;
  });
  if (verdict === "grant-closed") {
    return errorResponse("grant-closed", 403);
  }
  if (verdict === "session-concurrency") {
    return errorResponse("session-concurrency", 429);
  }
  if (verdict === "meter-unavailable") {
    return errorResponse("meter-unavailable", 503);
  }
  // The call joins the in-flight set after its call-start resolves and
  // leaves after its call-end settles (5.4). forwardCall owns the release so
  // a streamed call stays counted until its end record is durable.
  const release = state.trackCall(grantId);
  try {
    return await forwardCall(state, descriptor, auth.requestId, callId, bodyText, fields, stream, release);
  } catch (error: unknown) {
    release();
    throw error;
  }
}

interface CallTimings {
  readonly firstByteMs: number;
  readonly idleMs: number;
  readonly totalMs: number;
}

function callTimings(state: ProxyState): CallTimings {
  return {
    firstByteMs: state.config.firstByteTimeoutMs,
    idleMs: state.config.idleTimeoutMs,
    totalMs: state.config.totalTimeoutMs,
  };
}

async function forwardCall(
  state: ProxyState,
  descriptor: ProviderDescriptor,
  requestId: string,
  callId: string,
  bodyText: string,
  fields: Record<string, unknown>,
  stream: boolean,
  release: () => void,
): Promise<Response> {
  const timings = callTimings(state);
  const callerBody = JSON.parse(bodyText) as Record<string, unknown>;
  callerBody["model"] = descriptor.model;
  if (stream) {
    const options =
      typeof callerBody["stream_options"] === "object" && callerBody["stream_options"] !== null
        ? (callerBody["stream_options"] as Record<string, unknown>)
        : {};
    callerBody["stream_options"] = { ...options, include_usage: true };
  }
  const upstreamHeaders: Record<string, string> = { "Content-Type": "application/json" };
  upstreamHeaders["Accept"] = stream ? "text/event-stream" : "application/json";
  if (descriptor.apiKeyEnv !== undefined) {
    const key = process.env[descriptor.apiKeyEnv];
    if (key) {
      upstreamHeaders["Authorization"] = `Bearer ${key}`;
    }
  }
  const url = `${descriptor.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const controller = new AbortController();
  let abortReason: string | null = null;
  const abortWith = (reason: string): void => {
    abortReason = reason;
    controller.abort();
  };
  const t0 = Date.now();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const clearTimers = (): void => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  };
  const drain = state.drainSignal(requestId);
  let onDrain: (() => void) | null = null;
  if (drain !== null) {
    if (drain.aborted) {
      abortWith("closed-abort");
    } else {
      onDrain = (): void => {
        abortWith("closed-abort");
      };
      drain.addEventListener("abort", onDrain, { once: true });
    }
  }
  timers.push(
    setTimeout(() => {
      if (abortReason === null) {
        abortWith("first-byte-timeout");
      }
    }, timings.firstByteMs),
    setTimeout(() => {
      if (abortReason === null) {
        abortWith("total-timeout");
      }
    }, timings.totalMs),
  );
  const bytesIn = new TextEncoder().encode(bodyText).length;
  const tap = stream
    ? createSseUsageTap(state.config.maxUsageScanBytes)
    : createJsonUsageTap(state.config.maxUsageScanBytes);
  let status: number | null = null;
  let outcome: CallOutcome | null = null;
  let clientGone = false;
  let bytesOut = 0;
  const finishEnd = async (final: {
    outcome: CallOutcome;
    billed: boolean;
    status: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    clientGone: boolean;
    ms: number;
    bytesOut: number;
  }): Promise<void> => {
    const record: UsageLogRecord = {
      kind: "call-end",
      at: state.now().toISOString(),
      callId,
      requestId,
      outcome: final.outcome,
      billed: final.billed,
      status: final.status,
      inputTokens: final.inputTokens,
      outputTokens: final.outputTokens,
      clientGone: final.clientGone,
      ms: final.ms,
      bytesIn,
      bytesOut: final.bytesOut,
    };
    await state.appender().appendUnguarded(record);
    state.log({
      level: "info",
      event: "call-finished",
      callId,
      requestId,
      hostAlias: undefined,
      providerId: descriptor.id,
      model: descriptor.model,
      status: final.status ?? undefined,
      outcome: final.outcome,
      billed: final.billed,
      inputTokens: final.inputTokens,
      outputTokens: final.outputTokens,
      ms: final.ms,
      bytesIn,
      bytesOut: final.bytesOut,
    });
  };

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(callerBody),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    clearTimers();
    if (onDrain !== null && drain !== null) {
      drain.removeEventListener("abort", onDrain);
    }
    const ms = Date.now() - t0;
    try {
      if (abortReason !== null) {
        const out = abortReason as CallOutcome;
        await finishEnd({
          outcome: out,
          billed: true,
          status: null,
          inputTokens: null,
          outputTokens: null,
          clientGone,
          ms,
          bytesOut: 0,
        });
        state.log({ level: "error", event: "error", outcome: (error as Error).name });
        return errorResponse(abortReason === "closed-abort" ? "upstream-error" : "upstream-timeout", 504);
      }
      if (error instanceof TypeError) {
        await finishEnd({
          outcome: "upstream-unreachable",
          billed: false,
          status: null,
          inputTokens: null,
          outputTokens: null,
          clientGone,
          ms,
          bytesOut: 0,
        });
        return errorResponse("upstream-unreachable", 502);
      }
      await finishEnd({
        outcome: "upstream-error",
        billed: true,
        status: null,
        inputTokens: null,
        outputTokens: null,
        clientGone,
        ms,
        bytesOut: 0,
      });
      state.log({ level: "error", event: "error", outcome: (error as Error).name });
      return errorResponse("upstream-error", 502);
    } finally {
      release();
    }
  }
  status = upstream.status;
  clearTimers();
  if (status < 200 || status > 299) {
    if (onDrain !== null && drain !== null) {
      drain.removeEventListener("abort", onDrain);
    }
    const body = await upstream.text().catch(() => "");
    bytesOut = new TextEncoder().encode(body).length;
    try {
      await finishEnd({
        outcome: "upstream-status",
        billed: false,
        status,
        inputTokens: null,
        outputTokens: null,
        clientGone,
        ms: Date.now() - t0,
        bytesOut,
      });
    } finally {
      release();
    }
    const headers = new Headers();
    const upstreamType = upstream.headers.get("content-type");
    if (upstreamType !== null) {
      headers.set("content-type", upstreamType);
    }
    return new Response(body, { status, headers });
  }
  // From here the body is pumped by hand so usage is recovered even when the
  // caller disconnects. Timeouts below cover the idle gap and the total time.
  const idleTimer = { current: null as ReturnType<typeof setTimeout> | null };
  const armIdle = (): void => {
    if (idleTimer.current !== null) {
      clearTimeout(idleTimer.current);
    }
    idleTimer.current = setTimeout(() => {
      if (abortReason === null) {
        abortWith("idle-timeout");
      }
    }, timings.idleMs);
  };
  armIdle();
  const totalTimer = setTimeout(() => {
    if (abortReason === null) {
      abortWith("total-timeout");
    }
  }, timings.totalMs);
  const reader = upstream.body?.getReader();
  const upstreamType = upstream.headers.get("content-type");
  let streamClosed = false;
  const callerStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (reader === undefined) {
          controller.close();
          streamClosed = true;
          return;
        }
        for (;;) {
          let read: Awaited<ReturnType<NonNullable<typeof reader>["read"]>>;
          try {
            read = await reader.read();
          } catch (error: unknown) {
            if (abortReason !== null) {
              outcome = abortReason as CallOutcome;
            } else {
              outcome = "upstream-broken";
            }
            throw error;
          }
          if (read.done) {
            break;
          }
          armIdle();
          tap.push(read.value);
          bytesOut += read.value.length;
          if (!clientGone) {
            try {
              controller.enqueue(read.value);
            } catch {
              clientGone = true;
            }
          }
          if (abortReason !== null) {
            outcome = abortReason as CallOutcome;
            try {
              await reader.cancel();
            } catch {
              // The upstream reader is already closed; the outcome stands.
            }
            break;
          }
        }
        if (outcome === null) {
          outcome = "ok";
        }
      } catch {
        if (outcome === null) {
          outcome = abortReason !== null ? (abortReason as CallOutcome) : "upstream-broken";
        }
        if (!clientGone) {
          try {
            controller.error(new Error(outcome));
          } catch {
            clientGone = true;
          }
        }
      } finally {
        if (idleTimer.current !== null) {
          clearTimeout(idleTimer.current);
        }
        clearTimeout(totalTimer);
        if (onDrain !== null && drain !== null) {
          drain.removeEventListener("abort", onDrain);
        }
        clearTimers();
        const seen = tap.end();
        const counts =
          status === 200 && seen.seen
            ? { inputTokens: seen.inputTokens, outputTokens: seen.outputTokens }
            : { inputTokens: null, outputTokens: null };
        let finalOutcome = outcome ?? "ok";
        let billed = true;
        if (finalOutcome === "ok" && !seen.seen && status === 200 && status !== null) {
          finalOutcome = "no-usage";
        }
        if (finalOutcome === "ok" && seen.seen) {
          billed = true;
        }
        try {
          await finishEnd({
            outcome: finalOutcome,
            billed,
            status,
            inputTokens: counts.inputTokens,
            outputTokens: counts.outputTokens,
            clientGone,
            ms: Date.now() - t0,
            bytesOut,
          });
        } finally {
          release();
        }
        if (!clientGone && outcome !== "ok" && outcome !== "no-usage") {
          try {
            controller.error(new Error(outcome ?? "upstream-broken"));
            return;
          } catch {
            // The caller left while the end was written; nothing to close.
          }
        }
        if (!streamClosed) {
          try {
            controller.close();
          } catch {
            // The caller cancelled first; the end record already stands.
          }
        }
      }
    },
    cancel() {
      // The provider already billed the call, so the pump reads upstream to
      // its end and discards the bytes to recover usage.
      clientGone = true;
    },
  });
  const headers = new Headers();
  if (upstreamType !== null) {
    headers.set("content-type", upstreamType);
  }
  return new Response(callerStream, { status, headers });
}

export function isTerminal(value: unknown): value is TerminalState {
  return isTerminalState(value);
}
