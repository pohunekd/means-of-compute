// Metering proxy request handler: route, call authorization, forwarding,
// response pump, timers and usage extraction of design sections 3.1 to 3.7.
import { randomUUID } from "node:crypto";
import type { ProviderDescriptor } from "../providers/types.js";
import type { MeterConfig } from "./config.js";
import type { MeterLogEvent } from "./meter.js";
import type { MeterTimers } from "./timers.js";
import { createJsonUsageTap, createSseUsageTap } from "./sse.js";
import { verifyBearer } from "./token.js";
import { MeterLogError } from "./usage-log.js";
import type { CallOutcome, UsageAppender, UsageIndex, UsageLogRecord } from "./usage-log.js";
import type { LiveCall } from "./meter.js";

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
  readonly timers: MeterTimers;
  readonly appender: () => UsageAppender;
  readonly liveCount: (requestId: string) => number;
  readonly reserveCall: (requestId: string, callId: string) => LiveCall;
  readonly closing: () => boolean;
  readonly now: () => Date;
  readonly log: (event: MeterLogEvent) => void;
}

interface GrantView {
  readonly requestId: string;
  readonly hostAlias: string;
  readonly providerId: string;
  readonly closed: boolean;
  readonly sessionId: string | null;
  readonly lastOpenAt: string;
}

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
):
  | { requestId: string; grant: GrantView }
  | { code: MeterRejectCode; status: number; requestId?: string } {
  const requestId = verifyBearer(state.secret, req.headers.get("authorization"));
  if (requestId === null) {
    return { code: "unauthorized", status: 401 };
  }
  const grant = grantView(index, requestId);
  if (grant === null) {
    return { code: "no-grant", status: 403, requestId };
  }
  if (grant.closed) {
    return { code: "grant-closed", status: 403, requestId };
  }
  if (grant.sessionId === null) {
    const age = Date.parse(state.now().toISOString()) - Date.parse(grant.lastOpenAt);
    if (age > state.config.unboundGrantTtlMs) {
      return { code: "grant-unbound", status: 403, requestId };
    }
  }
  const allowed = state.hostAddresses.get(grant.hostAlias);
  const normalized = normalizeIp(remoteAddress);
  if (allowed === undefined || normalized === null || !allowed.has(normalized)) {
    return { code: "wrong-host", status: 403, requestId };
  }
  return { requestId, grant };
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
    state.log({ level: "warn", event: "request-rejected", code: "not-found", status: 404 });
    return errorResponse("not-found", 404);
  }
  if (req.method !== "POST") {
    state.log({
      level: "warn",
      event: "request-rejected",
      code: "method-not-allowed",
      status: 405,
    });
    return errorResponse("method-not-allowed", 405);
  }
  const auth = authorize(state, index, req, remoteAddress);
  if ("code" in auth) {
    if (auth.requestId === undefined) {
      state.log({ level: "warn", event: "request-rejected", code: auth.code, status: auth.status });
    } else {
      state.log({
        level: "warn",
        event: "request-rejected",
        code: auth.code,
        status: auth.status,
        requestId: auth.requestId,
      });
    }
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
    state.log({
      level: "warn",
      event: "request-rejected",
      code: "invalid-body",
      status: 400,
      requestId: auth.requestId,
    });
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
    state.log({
      level: "warn",
      event: "request-rejected",
      code: "invalid-body",
      status: 400,
      requestId: auth.requestId,
    });
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
      code: "provider-not-routed",
      status: 503,
      requestId: auth.requestId,
    });
    return errorResponse("provider-not-routed", 503);
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
  const holder: { reserved: LiveCall | null } = { reserved: null };
  let proceed = false;
  try {
    const verdict = await state.appender().appendGuarded(callStart, (index) => {
      const failure = callStartGuard(
        index,
        grantId,
        state.liveCount(grantId),
        state.config.maxInFlightPerSession,
        state.closing(),
      );
      if (failure === null) {
        holder.reserved = state.reserveCall(grantId, callId);
      }
      return failure;
    });
    if (verdict !== null) {
      state.log({
        level: "warn",
        event: "request-rejected",
        code: verdict,
        status: verdict === "grant-closed" ? 403 : verdict === "session-concurrency" ? 429 : 503,
        requestId: grantId,
      });
      if (verdict === "grant-closed") {
        return errorResponse("grant-closed", 403);
      }
      if (verdict === "session-concurrency") {
        return errorResponse("session-concurrency", 429);
      }
      return errorResponse("meter-unavailable", 503);
    }
    proceed = true;
  } catch (error: unknown) {
    if (!(error instanceof MeterLogError)) {
      throw error;
    }
    state.log({
      level: "warn",
      event: "request-rejected",
      code: "meter-unavailable",
      status: 503,
      requestId: grantId,
    });
    return errorResponse("meter-unavailable", 503);
  } finally {
    if (!proceed) {
      holder.reserved?.finish();
    }
  }
  // The LiveCall passes into forwardCall, which owns its finish(): the
  // outermost finally in forwardCall runs after the pump's call-end
  // append settles (L8). The handler catch also finishes it for throws
  // before the response; finish is idempotent.
  const call = holder.reserved;
  if (call === null) {
    throw new Error("meter: call-start step reserved nothing");
  }
  try {
    return await forwardCall(
      state,
      descriptor,
      auth.requestId,
      call,
      auth.grant.hostAlias,
      bodyText,
      fields,
      stream,
    );
  } catch (error: unknown) {
    call.finish();
    throw error;
  }
}

// F1: a call joins the live set inside its call-start chain step, when
// the guard passes and before the write. It leaves when its call-end
// append settles; a failed call-start write removes it.
export function callStartGuard(
  index: UsageIndex,
  requestId: string,
  liveCount: number,
  max: number,
  closing: boolean,
): "grant-closed" | "session-concurrency" | "meter-unavailable" | null {
  if (closing) {
    return "meter-unavailable";
  }
  const grant = index.grants.get(requestId);
  if (grant === undefined || grant.closed) {
    return "grant-closed";
  }
  if (liveCount >= max) {
    return "session-concurrency";
  }
  return null;
}

async function forwardCall(
  state: ProxyState,
  descriptor: ProviderDescriptor,
  requestId: string,
  call: LiveCall,
  hostAlias: string,
  bodyText: string,
  fields: Record<string, unknown>,
  stream: boolean,
): Promise<Response> {
  const callId = call.callId;
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
  const upstreamController = new AbortController();
  const abortState: { reason: CallOutcome | null } = { reason: null };
  const abortWith = (reason: CallOutcome): void => {
    abortState.reason = reason;
    // controller.abort() is always called with no argument.
    upstreamController.abort();
  };
  // The aborter lets settle and close abort a call that reserved its slot
  // but has not reached fetch yet; the stored reason decides the outcome.
  call.attachAborter(() => {
    abortWith("closed-abort");
  });
  const m0 = state.timers.elapsedMs();
  // L1: the first-byte timer is cancelled at the headers, the idle timer
  // is armed at the headers and re-armed after each chunk, and the total
  // timer is armed once at t0 and cancelled only after the pump ends.
  const cancelFirstByte = state.timers.after(state.config.firstByteTimeoutMs, () => {
    if (abortState.reason === null) {
      abortWith("first-byte-timeout");
    }
  });
  const cancelTotal = state.timers.after(state.config.totalTimeoutMs, () => {
    if (abortState.reason === null) {
      abortWith("total-timeout");
    }
  });
  let cancelIdle: (() => void) | null = null;
  const armIdle = (): void => {
    cancelIdle?.();
    cancelIdle = state.timers.after(state.config.idleTimeoutMs, () => {
      if (abortState.reason === null) {
        abortWith("idle-timeout");
      }
    });
  };
  const cancelPumpTimers = (): void => {
    cancelIdle?.();
    cancelIdle = null;
    cancelTotal();
  };
  const bytesIn = new TextEncoder().encode(bodyText).length;
  const tap = stream
    ? createSseUsageTap(state.config.maxUsageScanBytes)
    : createJsonUsageTap(state.config.maxUsageScanBytes);
  let status: number | null = null;
  let outcome: CallOutcome | null = null;
  let clientGone = false;
  let bytesOut = 0;
  let errorReason: string | null = null;
  const errorCaller = (
    reason: string,
    streamController: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    state.log({
      level: "warn",
      event: "caller-stream-errored",
      callId,
      requestId,
      outcome: reason,
    });
    try {
      streamController.error(new Error(reason));
    } catch {
      clientGone = true;
    }
  };
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
    try {
      const verdict = await state.appender().appendGuarded(record, () => null);
      if (verdict !== null) {
        errorReason = "meter-unavailable";
      }
    } catch (error: unknown) {
      if (!(error instanceof MeterLogError)) {
        throw error;
      }
      errorReason = "meter-unavailable";
    }
    state.log({
      level: "info",
      event: "call-finished",
      callId,
      requestId,
      hostAlias,
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
      signal: upstreamController.signal,
    });
  } catch (error: unknown) {
    cancelFirstByte();
    cancelPumpTimers();
    const ms = Math.round(state.timers.elapsedMs() - m0);
    // The early paths use the F4 order: finishEnd, then finish, then the
    // error answer.
    if (abortState.reason !== null) {
      const out: CallOutcome = abortState.reason;
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
      call.finish();
      return errorResponse(
        abortState.reason === "closed-abort" ? "upstream-error" : "upstream-timeout",
        504,
      );
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
      call.finish();
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
    call.finish();
    return errorResponse("upstream-error", 502);
  }
  status = upstream.status;
  cancelFirstByte();
  armIdle();
  const httpStatus: number = upstream.status;
  const upstreamType = upstream.headers.get("content-type");
  const is2xx = httpStatus >= 200 && httpStatus <= 299;
  const reader = upstream.body?.getReader();
  let streamClosed = false;
  const callerStream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      // F4 order: the pump catch only records the outcome; after the pump
      // loop ends, for any reason, run exactly tap.end, finishEnd,
      // call.finish, then either errorCaller or close.
      try {
        if (reader !== undefined) {
          for (;;) {
            let read: Awaited<ReturnType<NonNullable<typeof reader>["read"]>>;
            try {
              read = await reader.read();
            } catch (error: unknown) {
              outcome = abortState.reason ?? "upstream-broken";
              throw error;
            }
            if (read.done) {
              break;
            }
            armIdle();
            const chunk = read.value as Uint8Array;
            if (is2xx) {
              tap.push(chunk);
            }
            bytesOut += chunk.length;
            if (!clientGone) {
              try {
                streamController.enqueue(chunk);
              } catch {
                clientGone = true;
              }
            }
            if (abortState.reason !== null) {
              outcome = abortState.reason;
              try {
                await reader.cancel();
              } catch {
                // The upstream reader is already closed; the outcome stands.
              }
              break;
            }
          }
        } else {
          streamClosed = true;
        }
        if (outcome === null) {
          outcome = "ok";
        }
      } catch {
        if (outcome === null) {
          outcome = abortState.reason ?? "upstream-broken";
        }
      } finally {
        cancelPumpTimers();
        const seen = is2xx ? tap.end() : { seen: false as const };
        let finalOutcome: CallOutcome;
        let billed: boolean;
        let inputTokens: number | null;
        let outputTokens: number | null;
        if (!is2xx) {
          // F2: whatever happens to the body, the end is upstream-status,
          // unbilled, with null counts.
          finalOutcome = "upstream-status";
          billed = false;
          inputTokens = null;
          outputTokens = null;
          const pumpOutcome: CallOutcome = outcome ?? "ok";
          if (pumpOutcome !== "ok") {
            errorReason = pumpOutcome;
          }
        } else {
          const counts =
            seen.seen && httpStatus >= 200 && httpStatus <= 299
              ? { inputTokens: seen.inputTokens, outputTokens: seen.outputTokens }
              : { inputTokens: null, outputTokens: null };
          finalOutcome = outcome ?? "ok";
          billed = true;
          if (finalOutcome === "ok" && !seen.seen) {
            finalOutcome = "no-usage";
          }
          inputTokens = counts.inputTokens;
          outputTokens = counts.outputTokens;
          if (!clientGone && outcome !== "ok" && outcome !== "no-usage") {
            errorReason = outcome ?? "upstream-broken";
          }
        }
        await finishEnd({
          outcome: finalOutcome,
          billed,
          status,
          inputTokens,
          outputTokens,
          clientGone,
          ms: Math.round(state.timers.elapsedMs() - m0),
          bytesOut,
        });
        call.finish();
        if (errorReason !== null) {
          errorCaller(errorReason, streamController);
        } else if (!streamClosed) {
          try {
            streamController.close();
          } catch {
            // The caller cancelled first; the end record already stands.
          }
        }
      }
    },
    cancel() {
      // The provider already billed the call, so the pump reads upstream to
      // its end and discards the bytes to recover usage. The caller is
      // gone: mark it now; the pump keeps reading but enqueues nothing.
      clientGone = true;
      state.log({ level: "info", event: "caller-gone", requestId });
    },
  });
  const headers = new Headers();
  if (upstreamType !== null) {
    headers.set("content-type", upstreamType);
  }
  return new Response(callerStream, { status, headers });
}
