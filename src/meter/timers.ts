// Injected deadlines for the meter: every meter deadline goes through
// MeterTimers so tests can drive time without wall-clock sleeps.
export type CancelTimer = () => void;

export interface MeterTimers {
  after(ms: number, fire: () => void): CancelTimer;
}

export const systemTimers: MeterTimers = {
  after(ms: number, fire: () => void): CancelTimer {
    const handle = setTimeout(fire, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};
