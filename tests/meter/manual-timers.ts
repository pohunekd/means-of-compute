// Deterministic deadlines for meter tests: every meter deadline goes
// through this clock, so tests advance time instead of sleeping.
import type { MeterTimers } from "../../src/meter/timers.js";

export interface ManualTimers extends MeterTimers {
  advance(ms: number): void;
  waitForTimer(ms: number): Promise<void>;
}

interface Pending {
  readonly scheduledAt: number;
  readonly due: number;
  readonly seq: number;
  readonly duration: number;
  readonly fire: () => void;
  settled: boolean;
}

export function createManualTimers(): ManualTimers {
  let clock = 0;
  let seq = 0;
  const pending: Pending[] = [];
  const durationWaiters: Array<{ ms: number; resolve: () => void }> = [];

  function notify(): void {
    for (let i = durationWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = durationWaiters[i] as { ms: number; resolve: () => void };
      if (pending.some((t) => !t.settled && t.duration === waiter.ms)) {
        durationWaiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }

  return {
    after(ms: number, fire: () => void) {
      const entry: Pending = {
        scheduledAt: clock,
        due: clock + ms,
        seq: seq++,
        duration: ms,
        fire,
        settled: false,
      };
      pending.push(entry);
      notify();
      return () => {
        entry.settled = true;
      };
    },
    advance(ms: number): void {
      const target = clock + ms;
      for (;;) {
        let next: Pending | null = null;
        for (const t of pending) {
          if (t.settled || t.due <= clock || t.due > target) {
            continue;
          }
          if (next === null || t.due < next.due || (t.due === next.due && t.seq < next.seq)) {
            next = t;
          }
        }
        if (next === null) {
          break;
        }
        clock = next.due;
        next.settled = true;
        next.fire();
      }
      clock = target;
    },
    waitForTimer(ms: number): Promise<void> {
      if (pending.some((t) => !t.settled && t.duration === ms)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        durationWaiters.push({ ms, resolve });
      });
    },
  };
}
