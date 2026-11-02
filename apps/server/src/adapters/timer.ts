/**
 * The host's timers behind the Timer port (ADR 0025): one `setTimeout` per deadline, never an
 * interval. Its callback runs in a task of its own, so the event loop runs before it. The delay is
 * rounded up to whole milliseconds, so the timer does not fire before the deadline it was set for.
 */
import type { Timer } from "../world/time.ts";

export const systemTimer: Timer = Object.freeze({
  schedule: (delayMicros: number, callback: () => void) => {
    const handle = setTimeout(callback, Math.ceil(delayMicros / 1000));
    return () => clearTimeout(handle);
  },
});
