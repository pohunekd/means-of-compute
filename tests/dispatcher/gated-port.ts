// Test gate for port calls: wraps a DispatcherPort so the listed methods
// park until the test acts on each call. No timers: the test releases,
// fails, or releases-then-fails every parked call, so a test that leaves
// a call parked fails at Bun's per-test timeout instead of hanging.
import type { BudgetGate } from "../../src/budget/gate.js";
import type {
  CancelReason,
  DiffResult,
  DispatcherPort,
  SessionHandle,
  SessionRef,
  StartRequest,
  WaitResult,
} from "../../src/dispatcher/port.js";

export type GatedMethod = "start" | "wait" | "cancel";

type PortArgs = readonly unknown[];

export interface PendingCall {
  readonly method: GatedMethod;
  readonly release: (after?: () => Promise<unknown>) => Promise<unknown>;
  readonly fail: (error: unknown) => void;
  readonly releaseThenFail: (error: unknown) => Promise<unknown>;
}

interface ParkedCall {
  readonly args: PortArgs;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export interface GatePort {
  readonly port: DispatcherPort;
  readonly next: (method: GatedMethod) => Promise<PendingCall>;
  readonly calls: (method: GatedMethod) => number;
}

export function gatePort(inner: DispatcherPort, methods: ReadonlySet<GatedMethod>): GatePort {
  const counts = new Map<GatedMethod, number>([
    ["start", 0],
    ["wait", 0],
    ["cancel", 0],
  ]);
  const queues = new Map<GatedMethod, ParkedCall[]>([
    ["start", []],
    ["wait", []],
    ["cancel", []],
  ]);
  const waiters = new Map<GatedMethod, Array<(call: PendingCall) => void>>([
    ["start", []],
    ["wait", []],
    ["cancel", []],
  ]);

  function makeCall(method: GatedMethod, parked: ParkedCall): PendingCall {
    // Bound thunks keep the port's `this`: indexed `inner[method]`
    // reads trip the unbound-method rule when detached from `inner`.
    const run: Record<GatedMethod, (...args: PortArgs) => Promise<unknown>> = {
      start: (request) => inner.start(request as StartRequest),
      wait: (ref, timeoutMs, cursor) =>
        inner.wait(ref as SessionRef, timeoutMs as number, cursor as string | null),
      cancel: (ref, reason) => inner.cancel(ref as SessionRef, reason as CancelReason),
    };
    const target = run[method];
    return {
      method,
      release: async (after?: () => Promise<unknown>): Promise<unknown> => {
        const result = await target(...parked.args);
        await after?.();
        parked.resolve(result);
        return result;
      },
      fail: (error: unknown): void => {
        parked.reject(error);
      },
      releaseThenFail: async (error: unknown): Promise<unknown> => {
        const result = await target(...parked.args);
        parked.reject(error);
        return result;
      },
    };
  }

  function gated(
    method: GatedMethod,
    args: PortArgs,
    direct: (...args: PortArgs) => Promise<unknown>,
  ): Promise<unknown> {
    if (!methods.has(method)) {
      return direct(...args);
    }
    counts.set(method, (counts.get(method) ?? 0) + 1);
    return new Promise<unknown>((resolve, reject) => {
      const parked: ParkedCall = { args, resolve, reject };
      const pending = waiters.get(method) ?? [];
      const waiter = pending.shift();
      if (waiter !== undefined) {
        waiter(makeCall(method, parked));
        return;
      }
      queues.get(method)?.push(parked);
    });
  }

  // The wrapper keeps diff and close ungated: tests never park them.
  const port: DispatcherPort = {
    start: (request: StartRequest): Promise<SessionHandle> =>
      gated("start", [request], (input) =>
        inner.start(input as StartRequest),
      ) as Promise<SessionHandle>,
    wait: (ref: SessionRef, timeoutMs: number, cursor: string | null): Promise<WaitResult> =>
      gated("wait", [ref, timeoutMs, cursor], (input, limit, seen) =>
        inner.wait(input as SessionRef, limit as number, seen as string | null),
      ) as Promise<WaitResult>,
    diff: (ref: SessionRef, base: string): Promise<DiffResult> => inner.diff(ref, base),
    cancel: (ref: SessionRef, reason: CancelReason): Promise<WaitResult> =>
      gated("cancel", [ref, reason], (input, why) =>
        inner.cancel(input as SessionRef, why as CancelReason),
      ) as Promise<WaitResult>,
    close: () => inner.close(),
  };

  return {
    port,
    next: (method: GatedMethod): Promise<PendingCall> => {
      const parked = queues.get(method)?.shift();
      if (parked !== undefined) {
        return Promise.resolve(makeCall(method, parked));
      }
      return new Promise<PendingCall>((resolve) => {
        waiters.get(method)?.push(resolve);
      });
    },
    calls: (method: GatedMethod): number => counts.get(method) ?? 0,
  };
}

export interface SwitchGate {
  readonly gate: BudgetGate;
  calls(): number;
  refuse(reason: string): void;
}

export function createSwitchGate(): SwitchGate {
  let count = 0;
  let refusal: string | null = null;
  return {
    gate: {
      admit() {
        count += 1;
        if (refusal !== null) {
          return Promise.resolve({ admit: false as const, reason: refusal, line: "refused: test" });
        }
        return Promise.resolve({ admit: true as const, line: "admitted: test" });
      },
    },
    calls(): number {
      return count;
    },
    refuse(reason: string): void {
      refusal = reason;
    },
  };
}
