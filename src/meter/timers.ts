// Injected deadlines and the monotonic clock for the meter: every meter
// deadline goes through MeterTimers so tests can drive time without
// wall-clock sleeps, and every call-end ms comes from elapsedMs.
export type CancelTimer = () => void;

export interface MeterTimers {
  after(ms: number, fire: () => void): CancelTimer;
  elapsedMs(): number;
}

export const systemTimers: MeterTimers = {
  after(ms: number, fire: () => void): CancelTimer {
    const handle = setTimeout(fire, ms);
    return () => {
      clearTimeout(handle);
    };
  },
  elapsedMs(): number {
    return performance.now();
  },
};
