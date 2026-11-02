/**
 * The ports through which the world plane meets real time (ADR 0025, "Time and the scheduler"):
 * only the adapters read the host's clock and set its timers, so tests drive the world plane with
 * fake ones. Times and delays are whole microseconds.
 */

/** A monotonic clock. */
export interface Clock {
  /** The current time, in whole microseconds from an arbitrary origin; never decreases. */
  now(): number;
}

/** Cancels a timer that has not fired yet; does nothing once it has. */
export type CancelTimer = () => void;

/** One-shot timers, whose callbacks run in a task of their own, never inside the caller. */
export interface Timer {
  /** Runs `callback` once, `delayMicros` or more from now. */
  schedule(delayMicros: number, callback: () => void): CancelTimer;
}
