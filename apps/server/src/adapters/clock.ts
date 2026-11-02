/**
 * The host's monotonic clock behind the Clock port (ADR 0025): the only place the server reads
 * real time. `performance.now()` never decreases, unlike the wall clock.
 */
import type { Clock } from "../world/time.ts";

export const systemClock: Clock = Object.freeze({
  now: () => Math.floor(performance.now() * 1000),
});
