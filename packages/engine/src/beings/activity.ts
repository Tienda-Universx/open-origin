/**
 * The schedules of activities (ADR 0023): when the steps of a walk arrive, when the bites of a meal
 * fall due, and when a rest ends, from the activity's start tick and its exact durations in
 * simulated milliseconds. Several steps or bites may fall in one tick.
 */
import type { Tick } from "../time/tick.ts";
import type { Activity } from "./being.ts";
import { ceilDiv } from "./rates.ts";

type Walk = Extract<Activity, { kind: "walk" }>;
type Eat = Extract<Activity, { kind: "eat" }>;
type Idle = Extract<Activity, { kind: "idle" }>;

/** The tick at which a moment `ms` simulated milliseconds after the start of `start` is reached. */
export function tickAtMs(start: Tick, ms: number, simSecondsPerTick: number): Tick {
  return start + ceilDiv(ms, simSecondsPerTick * 1000);
}

/** How many steps of `walk` have arrived by the start of `tick`. */
export function arrivedSteps(walk: Walk, tick: Tick, simSecondsPerTick: number): number {
  let arrived = walk.done;
  while (
    arrived < walk.ms.length &&
    tickAtMs(walk.start, walk.ms[arrived] as number, simSecondsPerTick) <= tick
  ) {
    arrived += 1;
  }
  return arrived;
}

/** The tick at which the next step of `walk` arrives, or undefined when every step has. */
export function nextArrival(walk: Walk, simSecondsPerTick: number): Tick | undefined {
  const ms = walk.ms[walk.done];
  return ms === undefined ? undefined : tickAtMs(walk.start, ms, simSecondsPerTick);
}

/** How many bites of `eat` have fallen due by the start of `tick`: ⌊elapsed ms / biteMs⌋. */
export function bitesDue(
  eat: Eat,
  tick: Tick,
  input: { simSecondsPerTick: number; biteMs: number },
): number {
  const elapsedMs = (tick - eat.start) * input.simSecondsPerTick * 1000;
  return (elapsedMs - (elapsedMs % input.biteMs)) / input.biteMs;
}

/** The tick at which the next bite of `eat` falls due. */
export function nextBite(eat: Eat, input: { simSecondsPerTick: number; biteMs: number }): Tick {
  return tickAtMs(eat.start, (eat.bites + 1) * input.biteMs, input.simSecondsPerTick);
}

/** The tick at which `idle` ends. */
export function idleEnd(idle: Idle, simSecondsPerTick: number): Tick {
  return tickAtMs(idle.start, idle.ms, simSecondsPerTick);
}
