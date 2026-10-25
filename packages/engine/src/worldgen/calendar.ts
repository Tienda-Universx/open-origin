/**
 * The calendar (ADR 0021, permanent and temporal layers): where an instant falls in the day, and
 * the temporal layer that follows it, radiance and the diurnal swing of the thermal level. They
 * depend on the laws and the instant only, never on a cell or the terrain seed. Every function is
 * pure, O(1), and exact in safe integers, and there is no implicit clock nor default instant: each
 * measurement takes the instant it is for.
 *
 * An instant is a tick and the seconds per tick; its simulated second is their product, as the
 * kernel's simSeconds computes it. Each day starts at dawn, its second 0: the light period lasts
 * lightPeriod(day) seconds (genesis.ts), and the night the rest of the day. The day curve, in Q16
 * (CURVE_SCALE is 1), is 0 at night and 16s²(1 − s)² during the light period, where s in [0, 1) is
 * the share of the light period that has passed: it is C1 at dawn and dusk, and exactly 1 at
 * mid-light.
 *
 * Every intermediate value stays below 2^53 within GENESIS_BOUNDS. A day lasts at most 2^36
 * seconds, so the second of the day times 2^16 is below 2^52. With s and v in Q16, 4s(S − s) and
 * v² are at most S² = 2^32. The laws' spans, at most 2^20, times the curve are at most 2^36.
 */
import type { CanonicalValue, IssueSink } from "../canonical/value.ts";
import { EngineError, type Issue, IssueList } from "../errors.ts";
import { floorDiv, floorMod } from "../int.ts";
import { secondsPerTickProblem, simSeconds, type Tick, tickProblem } from "../time/tick.ts";
import type { ReadView } from "../world/contracts.ts";
import { expectRecord, readMember, UNREAD } from "../world/members.ts";
import {
  type DayLaw,
  type Laws,
  lightPeriod,
  type PreparedGenesis,
  sharedGenesis,
} from "./genesis.ts";

/** 1 in Q16, 2^16: the day curve lies from 0 to CURVE_SCALE. */
export const CURVE_SCALE = 0x1_0000;

/** The fewest ticks a day may last, so that every day has at least that many distinct phases. */
const MIN_DAY_TICKS = 16;

/** A moment of a world: its tick, and the simulated seconds each tick lasts. */
export type Instant = { readonly tick: Tick; readonly simSecondsPerTick: number };

/** Where an instant falls: its day, from 0, and its second of that day, from 0 at dawn. */
export type DayPosition = { readonly dayIndex: number; readonly secondOfDay: number };

const NOT_INSTANT = "the instant must be a record { tick, simSecondsPerTick }";

/**
 * The instant of `view`, a world's view or a tick's context: its tick and its seconds per tick, in
 * a fresh record. Inside the step that computes tick T, the context's tick is T, so a measurement
 * taken there equals one taken outside, on the world at tick T. It checks nothing: the engine's
 * views hold a valid tick and seconds per tick, and the measurements reject an instant whose
 * simulated second is not a safe integer.
 */
export function instantOf(
  view: Pick<ReadView<CanonicalValue, CanonicalValue>, "tick" | "simSecondsPerTick">,
): Instant {
  return { tick: view.tick, simSecondsPerTick: view.simSecondsPerTick };
}

/**
 * The member `name` of the host object `instant`, read once through its own descriptor, if it is a
 * tick or a number of seconds per tick as `name` requires; undefined after an issue at
 * `path/name`.
 */
function readPart(
  instant: object,
  name: keyof Instant,
  path: string,
  sink: IssueSink,
): number | undefined {
  const at = `${path}/${name}`;
  const value = readMember(instant, name, at, sink);
  if (value === UNREAD) return undefined;
  const problem = name === "tick" ? tickProblem(value) : secondsPerTickProblem(value);
  if (problem !== undefined) sink.report(at, problem);
  return typeof value === "number" && problem === undefined ? value : undefined;
}

/**
 * The tick and the seconds per tick of the host value `value`, not yet checked against each
 * other; undefined after every problem is reported to `sink` under `path`.
 */
function readParts(value: unknown, path: string, sink: IssueSink): Instant | undefined {
  if (!expectRecord(value, path, NOT_INSTANT, sink)) return undefined;
  const tick = readPart(value, "tick", path, sink);
  const simSecondsPerTick = readPart(value, "simSecondsPerTick", path, sink);
  if (tick === undefined || simSecondsPerTick === undefined) return undefined;
  return { tick, simSecondsPerTick };
}

/**
 * The instant that the host value `value` names, as a fresh record; undefined after every problem
 * is reported to `sink` under `path`. `value` is any object that is not an array, and only its
 * `tick` and `simSecondsPerTick` are read, each once, as readCell reads a cell (space.ts): an
 * inherited member reads as missing, an accessor never runs, and an object that throws while read
 * is one issue at `path`. Each member's problem is reported at its path in simSeconds' words, and a
 * product beyond the safe integers at `path`, as simSeconds reports it.
 */
export function readInstant(value: unknown, path: string, sink: IssueSink): Instant | undefined {
  const instant = readParts(value, path, sink);
  if (instant === undefined) return undefined;
  try {
    simSeconds(instant.tick, instant.simSecondsPerTick);
    return instant;
  } catch (error) {
    // Both members are valid, so simSeconds throws only its tick_overflow, with one issue at "".
    if (!EngineError.isEngineError(error)) throw error;
    for (const issue of error.issues) sink.report(`${path}${issue.path}`, issue.message);
    return undefined;
  }
}

/**
 * The simulated second of `instant`. Throws as simSeconds does: EngineError("invalid_value") with
 * every problem of the instant, at /tick and /simSecondsPerTick (or at "" for a value that is not a
 * record), and EngineError("tick_overflow") when their product is not a safe integer.
 */
function secondOf(instant: Instant): number {
  const issues = new IssueList();
  const parts = readParts(instant, "", issues);
  if (parts === undefined) throw issues.toError("invalid_value");
  return simSeconds(parts.tick, parts.simSecondsPerTick);
}

/**
 * The day curve at the second of the day `secondOfDay`, in Q16. Precondition: `day` is the day of
 * a valid genesis, so its light period lasts at least one second, and `secondOfDay` lies in
 * [0, day.length).
 */
function curveAt(day: DayLaw, secondOfDay: number): number {
  const light = lightPeriod(day);
  if (secondOfDay >= light) return 0;
  const s = floorDiv(secondOfDay * CURVE_SCALE, light);
  const v = floorDiv(4 * s * (CURVE_SCALE - s), CURVE_SCALE);
  return floorDiv(v * v, CURVE_SCALE);
}

/** The laws of `prepared` and the day curve at `instant`, after both are checked. */
function lawsAndCurve(
  prepared: PreparedGenesis,
  instant: Instant,
): { readonly laws: Laws; readonly curve: number } {
  const laws = sharedGenesis(prepared).laws;
  const secondOfDay = floorMod(secondOf(instant), laws.day.length);
  return { laws, curve: curveAt(laws.day, secondOfDay) };
}

/**
 * Where `instant` falls in the days of `prepared`: ⌊second / length⌋ and second mod length, for its
 * simulated second. Throws invalid_value for a forged prepared genesis, and throws as simSeconds
 * does for an invalid instant: invalid_value with every problem, or tick_overflow.
 */
export function dayPosition(prepared: PreparedGenesis, instant: Instant): DayPosition {
  const { day } = sharedGenesis(prepared).laws;
  const second = secondOf(instant);
  return { dayIndex: floorDiv(second, day.length), secondOfDay: floorMod(second, day.length) };
}

/**
 * The day curve of `prepared` at `instant`, in Q16, from 0 to CURVE_SCALE: 0 at night, and
 * 16s²(1 − s)² during the light period, exactly CURVE_SCALE at mid-light. Throws as dayPosition.
 */
export function dayCurve(prepared: PreparedGenesis, instant: Instant): number {
  return lawsAndCurve(prepared, instant).curve;
}

/**
 * The radiance of `prepared` at `instant`: night + ⌊(peak − night)·curve / CURVE_SCALE⌋, in
 * [night, peak]: the night floor at night, and the peak at mid-light. Throws as dayPosition.
 */
export function radiance(prepared: PreparedGenesis, instant: Instant): number {
  const { laws, curve } = lawsAndCurve(prepared, instant);
  const { peak, night } = laws.radiance;
  return night + floorDiv((peak - night) * curve, CURVE_SCALE);
}

/**
 * The diurnal swing of the thermal level of `prepared` at `instant`: ⌊diurnal·curve /
 * CURVE_SCALE⌋, in [0, diurnal], and 0 at night. The thermal level is the cell's thermal base plus
 * this swing. Throws as dayPosition.
 */
export function diurnal(prepared: PreparedGenesis, instant: Instant): number {
  const { laws, curve } = lawsAndCurve(prepared, instant);
  return floorDiv(laws.thermal.diurnal * curve, CURVE_SCALE);
}

/**
 * Why a world with `laws` and `simSecondsPerTick` would have a calendar its ticks cannot resolve:
 * a day shorter than 16 ticks, which would have fewer than 16 distinct phases, or a light period or
 * a night shorter than one tick, which a tick could step over. Issues carry JSON Pointers into
 * { laws, simSecondsPerTick }: /simSecondsPerTick when it is not a positive safe integer, and then
 * nothing else is checked; /laws/day/length for the day; and /laws/day for the light period and
 * the night, which its length and its daylight decide together. Empty when the pair is valid.
 *
 * `laws` are the laws of a valid genesis (genesisIssues). validateGlobal cannot see the seconds per
 * tick, so the host that creates a world calls this before createWorld (ADR 0021); decoding does
 * not repeat it, as both values are immutable and were checked together at creation.
 */
export function timeLawIssues(laws: Laws, simSecondsPerTick: number): Issue[] {
  const problem = secondsPerTickProblem(simSecondsPerTick);
  if (problem !== undefined) return [{ path: "/simSecondsPerTick", message: problem }];
  const { length, daylight } = laws.day;
  const issues: Issue[] = [];
  // Multiplying by 16, a power of two, is exact, even past the safe integers.
  if (length < MIN_DAY_TICKS * simSecondsPerTick) {
    issues.push({
      path: "/laws/day/length",
      message: `a day of ${length} seconds is shorter than ${MIN_DAY_TICKS} ticks of ${simSecondsPerTick} seconds: it must last at least ${MIN_DAY_TICKS} ticks, so that every day has at least ${MIN_DAY_TICKS} distinct phases`,
    });
  }
  const light = lightPeriod(laws.day);
  const parts = [
    ["light period", light],
    ["night", length - light],
  ] as const;
  for (const [part, seconds] of parts) {
    if (seconds >= simSecondsPerTick) continue;
    issues.push({
      path: "/laws/day",
      message: `the ${part} lasts ${seconds} seconds, shorter than one tick of ${simSecondsPerTick} seconds: a day of ${length} seconds with ${daylight}‰ of daylight must have a light period and a night of at least one tick each`,
    });
  }
  return issues;
}
