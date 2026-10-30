// Metered dispatcher port: opens and binds a meter grant around the
// inner port start, and settles the grant on every terminal wait or
// cancel. The factory owns the meter, so close() only closes the port.
import type {
  CancelReason,
  DiffResult,
  DispatcherPort,
  ReleaseRef,
  ReleaseResult,
  RetireOutcome,
  SessionHandle,
  SessionRef,
  StartRequest,
  WaitResult,
} from "../dispatcher/port.js";
import { PortRejectedError, PortUnreachableError } from "../dispatcher/port.js";
import type { Meter, MeterGrantCode, MeterLogEvent } from "./meter.js";
import { MeterGrantError } from "./meter.js";

function rejectedOf(code: MeterGrantCode, error: MeterGrantError): PortRejectedError {
  return new PortRejectedError(`meter-${code}`, error.message);
}

export function createMeteredPort(
  inner: DispatcherPort,
  meter: Meter,
  log: (event: MeterLogEvent) => void,
): DispatcherPort {
  async function start(request: StartRequest): Promise<SessionHandle> {
    try {
      await meter.openGrant({
        requestId: request.requestId,
        workItemId: request.workItemId,
        hostAlias: request.hostAlias,
        providerId: request.model.providerId,
        model: request.model.model,
      });
    } catch (error: unknown) {
      if (error instanceof MeterGrantError) {
        if (error.code === "grant-closed") {
          log({ level: "error", event: "grant-closed-on-start", requestId: request.requestId });
          throw new PortUnreachableError(`meter grant closed for ${request.requestId}`);
        }
        throw rejectedOf(error.code, error);
      }
      throw error;
    }
    const handle = await inner.start(request);
    try {
      await meter.bindGrant(request.requestId, handle.sessionId);
    } catch (error: unknown) {
      if (error instanceof MeterGrantError) {
        if (error.code === "session-conflict") {
          throw new PortRejectedError("request-conflict", error.message);
        }
        if (error.code === "unknown-request") {
          throw new PortRejectedError("meter-unknown-request", error.message);
        }
        throw rejectedOf(error.code, error);
      }
      throw error;
    }
    return handle;
  }

  async function settleTerminalResult(result: WaitResult): Promise<WaitResult> {
    if (
      result.state !== "finished" &&
      result.state !== "failed" &&
      result.state !== "lost" &&
      result.state !== "cancelled"
    ) {
      return result;
    }
    if (result.usage !== null) {
      log({ level: "error", event: "port-usage-ignored", count: result.usage.tokens.length });
    }
    const usage = await meter.settle(result.sessionId, result.state);
    return { ...result, usage };
  }

  async function wait(
    ref: SessionRef,
    timeoutMs: number,
    cursor: string | null,
  ): Promise<WaitResult> {
    const result = await inner.wait(ref, timeoutMs, cursor);
    return settleTerminalResult(result);
  }

  async function cancel(ref: SessionRef, reason: CancelReason): Promise<WaitResult> {
    const result = await inner.cancel(ref, reason);
    return settleTerminalResult(result);
  }

  async function diff(ref: SessionRef, base: string): Promise<DiffResult> {
    return inner.diff(ref, base);
  }

  async function close(): Promise<void> {
    await inner.close();
  }

  async function release(ref: ReleaseRef): Promise<ReleaseResult> {
    return inner.release(ref);
  }

  async function retire(ref: SessionRef): Promise<RetireOutcome> {
    return inner.retire(ref);
  }

  return { start, wait, diff, cancel, release, retire, close };
}
