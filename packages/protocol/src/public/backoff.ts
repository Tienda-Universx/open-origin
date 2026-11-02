/**
 * Reconnecting (ADR 0026): exponential backoff with full jitter, from 0.5 s up to 30 s, and at
 * least 5 s after the server refused the upgrade with HTTP 503. The delay is a pure function of
 * the attempt and a random draw the caller injects, so a client and its tests agree on it.
 */

/** The parameters of the backoff, in milliseconds. */
export const RECONNECT_BACKOFF = Object.freeze({
  /** The shortest delay. */
  minMs: 500,
  /** The highest ceiling: no delay reaches it. */
  maxMs: 30_000,
  /** The shortest delay after an HTTP 503. */
  afterUnavailableMs: 5000,
} as const);

/** The ceiling of attempt `attempt`: 1 s, doubled once per attempt, capped at 30 s. */
function ceilingMs(attempt: number): number {
  let ceiling = 2 * RECONNECT_BACKOFF.minMs;
  for (let doubled = 0; doubled < attempt && ceiling < RECONNECT_BACKOFF.maxMs; doubled += 1) {
    ceiling *= 2;
  }
  return Math.min(ceiling, RECONNECT_BACKOFF.maxMs);
}

/**
 * How many milliseconds to wait before reconnect attempt `attempt`, counted from 0, given `draw`,
 * a random number in [0, 1): a whole number spread uniformly over [0.5 s, ceiling), where the
 * ceiling is 1 s for the first attempt and doubles with each one up to 30 s, so clients that lose
 * the server together spread their returns. After an HTTP 503 (`unavailable`), the delay is at
 * least 5 s. Throws a RangeError when `attempt` is not a non-negative safe integer or `draw` is
 * not in [0, 1).
 */
export function reconnectDelayMs(attempt: number, draw: number, unavailable = false): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RangeError("the attempt must be a non-negative safe integer");
  }
  if (!(draw >= 0 && draw < 1)) throw new RangeError("the draw must be in [0, 1)");
  const { minMs, afterUnavailableMs } = RECONNECT_BACKOFF;
  const delay = minMs + Math.floor(draw * (ceilingMs(attempt) - minMs));
  return unavailable ? Math.max(delay, afterUnavailableMs) : delay;
}
