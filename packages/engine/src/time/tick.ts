/**
 * Simulation time (ADR 0020): the engine knows only ticks. `simSecondsPerTick` is world
 * configuration; pacing ticks in real time belongs to the scheduler, and the calendar to a later
 * batch.
 */
import { describeValue, EngineError, type Issue } from "../errors.ts";

/** A simulation tick: a safe integer from 0; not -0, which is not canonical. */
export type Tick = number;

/** Why `value` is not a tick, as a message; undefined when it is one. */
export function tickProblem(value: unknown): string | undefined {
  const isTick = typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (isTick && !Object.is(value, -0)) return undefined;
  return `${describeValue(value)} is not a tick: ticks are safe integers from 0`;
}

/**
 * The tick after `tick`. Throws EngineError("tick_overflow") at Number.MAX_SAFE_INTEGER, whose
 * successor is not a safe integer, and EngineError("invalid_value") when `tick` is not a tick.
 */
export function nextTick(tick: Tick): Tick {
  const problem = tickProblem(tick);
  if (problem !== undefined)
    throw new EngineError("invalid_value", [{ path: "", message: problem }]);
  if (tick === Number.MAX_SAFE_INTEGER) {
    throw new EngineError("tick_overflow", [
      { path: "", message: `the tick ${tick} is the last one: the next is not a safe integer` },
    ]);
  }
  return tick + 1;
}

/** Why `value` is not a number of seconds per tick, as a message; undefined when it is one. */
export function secondsPerTickProblem(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return undefined;
  return `${describeValue(value)} seconds per tick is not a positive safe integer`;
}

/**
 * The simulated seconds at the start of `tick`: `tick * simSecondsPerTick`. Throws
 * EngineError("invalid_value") with every invalid argument, and EngineError("tick_overflow") when
 * the product is not a safe integer.
 */
export function simSeconds(tick: Tick, simSecondsPerTick: number): number {
  const issues: Issue[] = [];
  const problem = tickProblem(tick);
  if (problem !== undefined) issues.push({ path: "/tick", message: problem });
  const perTick = secondsPerTickProblem(simSecondsPerTick);
  if (perTick !== undefined) issues.push({ path: "/simSecondsPerTick", message: perTick });
  if (issues.length > 0) throw new EngineError("invalid_value", issues);
  const seconds = tick * simSecondsPerTick;
  // A product below 2^53 is exact. A larger one rounds to 2^53 or more, so it is never safe.
  if (!Number.isSafeInteger(seconds)) {
    const message = `tick ${tick} at ${simSecondsPerTick} seconds per tick is beyond the largest safe integer`;
    throw new EngineError("tick_overflow", [{ path: "", message }]);
  }
  return seconds;
}
