import { describe, expect, test } from "bun:test";
import { IssueList } from "../src/errors.ts";
import { createWorld, readView, simSeconds, step, worldgen } from "../src/index.ts";
import {
  CURVE_SCALE,
  dayCurve,
  dayPosition,
  diurnal,
  type Instant,
  instantOf,
  radiance,
  readInstant,
  timeLawIssues,
} from "../src/worldgen/calendar.ts";
import { lightPeriod } from "../src/worldgen/genesis.ts";
import { GOLDEN_TIME } from "./fixtures/golden-time.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { revokedProxy } from "./support/revoked.ts";
import { Sfc32 } from "./support/sfc32.ts";
import { stepRuleset, system } from "./support/step-rulesets.ts";

/**
 * The calendar (ADR 0021, permanent and temporal layers; plan §12 test 12): instants, the day
 * position, the day curve, radiance and the diurnal swing, the time laws, and the golden time
 * values, checked against an exact BigInt reference up to the largest genesis.
 */

const { defaultGenesis, prepareGenesis, WORLDGEN_VERSION } = worldgen;
type Genesis = worldgen.Genesis;
type Laws = worldgen.Laws;
type PreparedGenesis = worldgen.PreparedGenesis;

const SEED = [0x0123_4567, 0x89ab_cdef, 0xdead_beef, 0, 1, 2, 3, 0xffff_ffff];
const OTHER_SEED = [9, 8, 7, 6, 5, 4, 3, 2];
const S = 2 ** 16;
const MAX = Number.MAX_SAFE_INTEGER;
const NOT_INSTANT = "the instant must be a record { tick, simSecondsPerTick }";
const ACCESSOR = "the property is an accessor: only data properties are read";
const NOT_PREPARED = "the value is not a prepared genesis: prepareGenesis makes them";
const notTick = (value: string) => `${value} is not a tick: ticks are safe integers from 0`;
const notPerTick = (value: string) => `${value} seconds per tick is not a positive safe integer`;

/** The laws the calendar reads; each one left out keeps the default genesis's. */
type TimeLaws = {
  readonly length?: number;
  readonly daylight?: number;
  readonly peak?: number;
  readonly night?: number;
  readonly diurnal?: number;
};

/** The default genesis around `seed`, with the time laws `time`. */
function genesisWith(time: TimeLaws, seed: readonly number[] = SEED): Genesis {
  const genesis = defaultGenesis(seed);
  const { day, thermal, radiance: light } = genesis.laws;
  return {
    ...genesis,
    laws: {
      ...genesis.laws,
      day: { length: time.length ?? day.length, daylight: time.daylight ?? day.daylight },
      thermal: { ...thermal, diurnal: time.diurnal ?? thermal.diurnal },
      radiance: { peak: time.peak ?? light.peak, night: time.night ?? light.night },
    },
  };
}

const preparedWith = (time: TimeLaws, seed?: readonly number[]) =>
  prepareGenesis(genesisWith(time, seed));

const at = (tick: number, simSecondsPerTick = 1): Instant => ({ tick, simSecondsPerTick });

/** The largest of `values`, which may be too many to spread into Math.max. */
const largest = (values: readonly number[]) => values.reduce((a, b) => Math.max(a, b), -Infinity);

/** What calendar.ts computes at `instant` under `prepared`. */
function measured(prepared: PreparedGenesis, instant: Instant) {
  return {
    position: dayPosition(prepared, instant),
    curve: dayCurve(prepared, instant),
    radiance: radiance(prepared, instant),
    diurnal: diurnal(prepared, instant),
  };
}

/**
 * The same values, computed exactly with BigInt from the formulas of ADR 0021 and
 * docs/architecture/worldgen.md, with every intermediate value they pass through.
 */
function reference(laws: Laws, instant: Instant) {
  const one = BigInt(S);
  const length = BigInt(laws.day.length);
  const second = BigInt(instant.tick) * BigInt(instant.simSecondsPerTick);
  const secondOfDay = second % length;
  const daylight = length * BigInt(laws.day.daylight);
  const light = daylight / 1000n;
  const intermediates = [second, daylight];
  let curve = 0n;
  if (secondOfDay < light) {
    const scaled = secondOfDay * one;
    const s = scaled / light;
    const parabola = 4n * s * (one - s);
    const v = parabola / one;
    curve = (v * v) / one;
    intermediates.push(scaled, parabola, v * v);
  }
  const span = BigInt(laws.radiance.peak - laws.radiance.night) * curve;
  const swing = BigInt(laws.thermal.diurnal) * curve;
  intermediates.push(span, swing);
  return {
    values: {
      position: { dayIndex: Number(second / length), secondOfDay: Number(secondOfDay) },
      curve: Number(curve),
      radiance: laws.radiance.night + Number(span / one),
      diurnal: Number(swing / one),
    },
    intermediates,
  };
}

describe("readInstant", () => {
  /** What readInstant returns for `value` at "/instant", and the issues it reports. */
  function read(value: unknown) {
    const issues = new IssueList();
    const instant = readInstant(value, "/instant", issues);
    return { instant, issues: issues.issues, cause: issues.toError("invalid_value").cause };
  }

  test("returns a fresh record of a valid instant, up to the last safe second", () => {
    for (const value of [at(0, 1), at(MAX, 1), at(1, MAX), at(Math.floor(MAX / 12), 12)]) {
      const { instant, issues } = read(value);
      expect(issues).toEqual([]);
      expect(instant).toEqual(value);
      expect(instant).not.toBe(value);
    }
  });

  test("reads only tick and simSecondsPerTick, from any object that is not an array", () => {
    class Moment {
      readonly label = "noon";
      constructor(
        readonly tick: number,
        readonly simSecondsPerTick: number,
      ) {}
    }
    const { instant, issues } = read(new Moment(5, 60));
    expect(issues).toEqual([]);
    expect(instant).toEqual({ tick: 5, simSecondsPerTick: 60 });
    expect(Object.getPrototypeOf(instant)).toBe(Object.prototype);
  });

  test.each<[string, unknown, { path: string; message: string }[]]>([
    [
      "a negative tick",
      { tick: -1, simSecondsPerTick: 12 },
      [{ path: "/instant/tick", message: notTick("-1") }],
    ],
    [
      "a fractional tick",
      { tick: 1.5, simSecondsPerTick: 12 },
      [{ path: "/instant/tick", message: notTick("1.5") }],
    ],
    [
      "a tick of -0",
      { tick: -0, simSecondsPerTick: 12 },
      [{ path: "/instant/tick", message: notTick("-0") }],
    ],
    [
      "a tick that is a string",
      { tick: "3", simSecondsPerTick: 12 },
      [{ path: "/instant/tick", message: notTick("a value of type string") }],
    ],
    [
      "a missing tick",
      { simSecondsPerTick: 12 },
      [{ path: "/instant/tick", message: notTick("a value of type undefined") }],
    ],
    [
      "zero seconds per tick",
      { tick: 0, simSecondsPerTick: 0 },
      [{ path: "/instant/simSecondsPerTick", message: notPerTick("0") }],
    ],
    [
      "seconds per tick beyond the safe integers",
      { tick: 0, simSecondsPerTick: 2 ** 53 },
      [{ path: "/instant/simSecondsPerTick", message: notPerTick("9007199254740992") }],
    ],
    [
      "both members",
      { tick: -1, simSecondsPerTick: Number.NaN },
      [
        { path: "/instant/tick", message: notTick("-1") },
        { path: "/instant/simSecondsPerTick", message: notPerTick("NaN") },
      ],
    ],
  ])("reports %s at its path", (_, value, expected) => {
    const { instant, issues } = read(value);
    expect(instant).toBeUndefined();
    expect(issues).toEqual(expected);
  });

  test.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["an array", [0, 12]],
    ["a number", 12],
    ["a string", "tick 3"],
  ])("rejects %s, which is not a record", (_, value) => {
    expect(read(value)).toEqual({
      instant: undefined,
      issues: [{ path: "/instant", message: NOT_INSTANT }],
      cause: undefined,
    });
  });

  test("reports a product beyond the safe integers at its path, as simSeconds does", () => {
    const tick = Math.floor(MAX / 12) + 1;
    const message = `tick ${tick} at 12 seconds per tick is beyond the largest safe integer`;
    expect(engineErrorOf(() => simSeconds(tick, 12)).issues).toEqual([{ path: "", message }]);
    expect(read(at(tick, 12))).toEqual({
      instant: undefined,
      issues: [{ path: "/instant", message }],
      cause: undefined,
    });
  });

  test("rejects an accessor without running it, and reads an inherited member as missing", () => {
    let calls = 0;
    const value = Object.defineProperty({ simSecondsPerTick: 12 }, "tick", {
      get: () => {
        calls += 1;
        return 3;
      },
      enumerable: true,
    });
    expect(read(value).issues).toEqual([{ path: "/instant/tick", message: ACCESSOR }]);
    expect(calls).toBe(0);
    const inherited = Object.create({ tick: 3, simSecondsPerTick: 12 });
    expect(read(inherited).issues).toEqual([
      { path: "/instant/tick", message: notTick("a value of type undefined") },
      { path: "/instant/simSecondsPerTick", message: notPerTick("a value of type undefined") },
    ]);
  });

  test("reports an instant that throws while read as one issue at its path, with the cause", () => {
    const { instant, issues, cause } = read(revokedProxy());
    expect(instant).toBeUndefined();
    expect(issues.map(({ path }) => path)).toEqual(["/instant"]);
    expect(issues[0]?.message).toStartWith("the object threw while being read: TypeError");
    expect(cause).toBeInstanceOf(TypeError);
  });
});

describe("instantOf", () => {
  test("takes the tick and seconds per tick of a view, in a fresh record", () => {
    const view = { tick: 9, simSecondsPerTick: 60, readGlobal: () => ({}) };
    expect(instantOf(view)).toEqual({ tick: 9, simSecondsPerTick: 60 });
  });

  test("inside the step that computes tick T, equals the instant of the world at tick T", () => {
    const prepared = prepareGenesis(defaultGenesis(SEED));
    const inside: { instant: Instant; radiance: number }[] = [];
    const ruleset = stepRuleset([
      system("light", (ctx) => {
        const instant = instantOf(ctx);
        inside.push({ instant, radiance: radiance(prepared, instant) });
      }),
    ]);
    // 7,000 seconds per tick puts ticks 1 to 3 in the light period, where radiance changes.
    const world = createWorld({
      seed: [1, 2],
      simSecondsPerTick: 7000,
      global: {},
      chunks: {},
      ruleset,
    });
    expect(instantOf(readView(world))).toEqual({ tick: 0, simSecondsPerTick: 7000 });
    for (let tick = 1; tick <= 3; tick += 1) {
      step(world, []);
      const outside = instantOf(readView(world));
      expect(outside).toEqual({ tick, simSecondsPerTick: 7000 });
      expect(inside.at(-1)).toEqual({ instant: outside, radiance: radiance(prepared, outside) });
    }
    expect(new Set(inside.map((entry) => entry.radiance)).size).toBe(3);
  });
});

describe("the calendar's measurements", () => {
  const prepared = prepareGenesis(defaultGenesis(SEED));
  const measurements = [
    ["dayPosition", dayPosition],
    ["dayCurve", dayCurve],
    ["radiance", radiance],
    ["diurnal", diurnal],
  ] as const;

  test.each(measurements)("%s rejects an invalid instant as simSeconds does", (_, measure) => {
    const error = engineErrorOf(() => measure(prepared, at(-1, 0)));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      { path: "/tick", message: notTick("-1") },
      { path: "/simSecondsPerTick", message: notPerTick("0") },
    ]);
    expect(error.issues).toEqual(engineErrorOf(() => simSeconds(-1, 0)).issues);
    const notRecord = engineErrorOf(() => measure(prepared, null as unknown as Instant));
    expect(notRecord.code).toBe("invalid_value");
    expect(notRecord.issues).toEqual([{ path: "", message: NOT_INSTANT }]);
  });

  test.each(measurements)("%s throws tick_overflow past the last safe second", (_, measure) => {
    const last = Math.floor(MAX / 12);
    expect(() => measure(prepared, at(last, 12))).not.toThrow();
    const error = engineErrorOf(() => measure(prepared, at(last + 1, 12)));
    expect(error.code).toBe("tick_overflow");
    expect(error.issues).toEqual(engineErrorOf(() => simSeconds(last + 1, 12)).issues);
  });

  test.each(measurements)("%s rejects a forged prepared genesis", (_, measure) => {
    const forged = Object.create(prepared) as PreparedGenesis;
    const error = engineErrorOf(() => measure(forged, at(0, 12)));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([{ path: "", message: NOT_PREPARED }]);
  });

  test("depend only on the laws and the instant: not on the terrain seed nor the terrain", () => {
    const other = genesisWith({}, OTHER_SEED);
    const terrain = { ...other.terrain, relief: { wavelength: 64, octaves: 1, amplitude: 7 } };
    const elsewhere = prepareGenesis({ ...other, terrain });
    const random = new Sfc32(0x5eed);
    for (let round = 0; round < 500; round += 1) {
      const instant = at(random.below(2 ** 32), 1 + random.below(600));
      expect(measured(elsewhere, instant)).toEqual(measured(prepared, instant));
    }
  });
});

describe("the day", () => {
  test("dawn, dusk, and the day rollover land on exact seconds", () => {
    // A day of 32 seconds with 500‰ of daylight: light from dawn, its second 0, to dusk at 16.
    const prepared = preparedWith({ length: 32, daylight: 500 });
    const curve = Array.from({ length: 64 }, (_, tick) => dayCurve(prepared, at(tick)));
    expect(curve.slice(32)).toEqual(curve.slice(0, 32));
    expect([curve[0], curve[1], curve[8], curve[15], curve[16]]).toEqual([0, 3600, S, 3600, 0]);
    expect(curve.slice(1, 16).every((value) => value > 0)).toBe(true);
    expect(curve.slice(16, 32)).toEqual(Array.from({ length: 16 }, () => 0));
    expect(dayPosition(prepared, at(31))).toEqual({ dayIndex: 0, secondOfDay: 31 });
    expect(dayPosition(prepared, at(32))).toEqual({ dayIndex: 1, secondOfDay: 0 });
    // At 4 seconds per tick: tick 3 is the last of the light period, tick 4 is dusk, 8 is dawn.
    expect(dayCurve(prepared, at(3, 4))).toBe(dayCurve(prepared, at(12)));
    expect(dayCurve(prepared, at(4, 4))).toBe(0);
    expect(dayPosition(prepared, at(8, 4))).toEqual({ dayIndex: 1, secondOfDay: 0 });
  });

  test("the night floor holds through every night, where the diurnal swing is 0", () => {
    const prepared = preparedWith({
      length: 1000,
      daylight: 300,
      peak: 500,
      night: 123,
      diurnal: 77,
    });
    const wrong: number[] = [];
    let nights = 0;
    for (let tick = 0; tick < 3000; tick += 1) {
      const { position, curve, radiance: light, diurnal: swing } = measured(prepared, at(tick));
      const night = position.secondOfDay >= 300;
      if (night) nights += 1;
      const floor = night ? light === 123 && swing === 0 && curve === 0 : light >= 123;
      if (!floor) wrong.push(tick);
    }
    expect(wrong).toEqual([]);
    expect(nights).toBe(2100);
  });

  test("radiance lies in [night, peak] and the diurnal swing in [0, diurnal], ends included", () => {
    const random = new Sfc32(0x7a11);
    const wrong: unknown[] = [];
    for (let round = 0; round < 100; round += 1) {
      const daylight = 1 + random.below(999);
      const length = Math.ceil(1000 / daylight) + random.below(2 ** 30);
      const peak = 1 + random.below(2 ** 20);
      const time = { length, daylight, peak, night: random.below(peak + 1) };
      const genesis = genesisWith({ ...time, diurnal: random.below(2 ** 20 + 1) });
      const prepared = prepareGenesis(genesis);
      for (let draw = 0; draw < 20; draw += 1) {
        const instant = at(random.below(2 ** 32), 1 + random.below(2 ** 20));
        const values = measured(prepared, instant);
        const { night } = genesis.laws.radiance;
        const inRange =
          values.radiance >= night &&
          values.radiance <= peak &&
          values.diurnal >= 0 &&
          values.diurnal <= genesis.laws.thermal.diurnal;
        if (!inRange) wrong.push({ genesis: genesis.laws, instant });
        expect(values).toEqual(reference(genesis.laws, instant).values);
      }
    }
    expect(wrong).toEqual([]);
    const ends = preparedWith({ length: 2 ** 17, daylight: 500, peak: 900, night: 7, diurnal: 50 });
    expect([radiance(ends, at(S / 2)), diurnal(ends, at(S / 2))]).toEqual([900, 50]);
    expect([radiance(ends, at(S)), diurnal(ends, at(S))]).toEqual([7, 0]);
  });
});

describe("the day curve", () => {
  // A day of 2^17 seconds with 500‰ of daylight has a light period of 2^16 seconds, so at one
  // second per tick, the tick is s, the light period's elapsed fraction in Q16.
  const prepared = preparedWith({ length: 2 ** 17, daylight: 500 });
  const curve = Array.from({ length: S }, (_, s) => dayCurve(prepared, at(s)));
  const steps = curve.slice(1).map((value, s) => value - (curve[s] ?? 0));

  test("is 0 at both ends of the light period and exactly 1 at mid-light", () => {
    expect(CURVE_SCALE).toBe(S);
    expect([curve[0], curve[S / 2], curve[S - 1], dayCurve(prepared, at(S))]).toEqual([0, S, 0, 0]);
    expect(largest(curve)).toBe(S);
  });

  test("rises on [0, S/2] and falls on [S/2, S), symmetric about mid-light", () => {
    const wrong: number[] = [];
    for (let s = 1; s < S; s += 1) {
      const step = steps[s - 1] ?? 0;
      const monotonic = s <= S / 2 ? step >= 0 : step <= 0;
      if (!monotonic || curve[s] !== curve[S - s]) wrong.push(s);
    }
    expect(wrong).toEqual([]);
  });

  test("is C1 at dawn and dusk: within 1/64 of either end, each step is at most 1", () => {
    const edge = S / 64;
    const dawn = steps.slice(0, edge);
    const dusk = steps.slice(S - 1 - edge);
    expect(largest([...dawn, ...dusk].map(Math.abs))).toBe(1);
    // The curve lies less than 3 below the exact 16s²(1 − s)²·S, as v is floored before its
    // square, and the exact curve's slope, 32s(1 − s)(1 − 2s), never exceeds 3.08 per step: so no
    // step exceeds 6, and the curve has no jump.
    expect(largest(steps.map(Math.abs))).toBeLessThanOrEqual(6);
    // The night joins both ends without a jump: its last second, and the next dawn.
    expect([dayCurve(prepared, at(2 ** 17 - 1)), dayCurve(prepared, at(2 ** 17))]).toEqual([0, 0]);
  });
});

describe("the largest genesis", () => {
  const LIMIT = 2n ** 53n;
  const LENGTH = 2 ** 36;

  /** Instants that probe every part of the day, and the last safe seconds, at three tick sizes. */
  function probes(light: number): Instant[] {
    const seconds = [0, 1, Math.floor(light / 4), Math.floor(light / 2) - 1, Math.floor(light / 2)];
    seconds.push(Math.floor(light / 2) + 1, light - 2, light - 1, light, LENGTH - 1, LENGTH);
    seconds.push(LENGTH + light - 1, MAX - (MAX % LENGTH), MAX - (MAX % LENGTH) + light - 1, MAX);
    const random = new Sfc32(light);
    for (let draw = 0; draw < 300; draw += 1) {
      seconds.push(random.below(2 ** 21) * 2 ** 32 + random.next());
    }
    return [1, 12, LENGTH].flatMap((perTick) =>
      seconds.map((second) => at(Math.floor(second / perTick), perTick)),
    );
  }

  test.each([999, 500, 1])("computes exactly with %d‰ of daylight, below 2^53", (daylight) => {
    const time = { length: LENGTH, daylight, peak: 2 ** 20, night: 0, diurnal: 2 ** 20 };
    const genesis = genesisWith(time);
    const prepared = prepareGenesis(genesis);
    const unsafe: bigint[] = [];
    for (const instant of probes(lightPeriod(genesis.laws.day))) {
      const expected = reference(genesis.laws, instant);
      expect(measured(prepared, instant)).toEqual(expected.values);
      unsafe.push(...expected.intermediates.filter((value) => value >= LIMIT));
    }
    expect(unsafe).toEqual([]);
  });

  test("keeps the second of the day times 2^16 below 2^53 at its last second of light", () => {
    const light = lightPeriod({ length: LENGTH, daylight: 999 });
    expect(light).toBe(68_650_757_259);
    expect(BigInt(light - 1) * BigInt(S) < LIMIT).toBe(true);
    // A day of 2^40 seconds, the bound before T3-4, would not.
    expect(BigInt(2 ** 40 - 1) * BigInt(S) >= LIMIT).toBe(true);
  });

  test("reaches its peak and its full diurnal swing exactly at mid-light", () => {
    const time = { length: LENGTH, daylight: 500, peak: 2 ** 20, night: 0, diurnal: 2 ** 20 };
    const prepared = preparedWith(time);
    const noon = at(LENGTH / 4);
    expect([dayCurve(prepared, noon), radiance(prepared, noon), diurnal(prepared, noon)]).toEqual([
      S,
      2 ** 20,
      2 ** 20,
    ]);
    const dark = preparedWith({ ...time, night: 2 ** 20 });
    expect(radiance(dark, noon)).toBe(2 ** 20);
  });
});

describe("timeLawIssues", () => {
  const lawsWith = (time: TimeLaws) => genesisWith(time).laws;
  const shortDay = (length: number, perTick: number) =>
    `a day of ${length} seconds is shorter than 16 ticks of ${perTick} seconds: it must last at least 16 ticks, so that every day has at least 16 distinct phases`;
  const shortPart = (part: string, seconds: number, time: [number, number], perTick: number) =>
    `the ${part} lasts ${seconds} seconds, shorter than one tick of ${perTick} seconds: a day of ${time[0]} seconds with ${time[1]}‰ of daylight must have a light period and a night of at least one tick each`;

  test.each([1, 7, 12, 13, 60, 4725])(
    "accepts the default laws at %d seconds per tick",
    (perTick) => {
      expect(timeLawIssues(defaultGenesis(SEED).laws, perTick)).toEqual([]);
    },
  );

  test("a day lasts at least 16 ticks", () => {
    expect(timeLawIssues(lawsWith({ length: 192, daylight: 500 }), 12)).toEqual([]);
    expect(timeLawIssues(lawsWith({ length: 191, daylight: 500 }), 12)).toEqual([
      { path: "/laws/day/length", message: shortDay(191, 12) },
    ]);
    expect(timeLawIssues(defaultGenesis(SEED).laws, 4726)).toEqual([
      { path: "/laws/day/length", message: shortDay(75_600, 4726) },
    ]);
  });

  test("the light period lasts at least one tick", () => {
    expect(timeLawIssues(lawsWith({ length: 1200, daylight: 10 }), 12)).toEqual([]);
    expect(timeLawIssues(lawsWith({ length: 1200, daylight: 9 }), 12)).toEqual([
      { path: "/laws/day", message: shortPart("light period", 10, [1200, 9], 12) },
    ]);
  });

  test("the night lasts at least one tick", () => {
    expect(timeLawIssues(lawsWith({ length: 1200, daylight: 990 }), 12)).toEqual([]);
    expect(timeLawIssues(lawsWith({ length: 1200, daylight: 991 }), 12)).toEqual([
      { path: "/laws/day", message: shortPart("night", 11, [1200, 991], 12) },
    ]);
  });

  test("reports every problem at once", () => {
    expect(timeLawIssues(lawsWith({ length: 150, daylight: 500 }), 100)).toEqual([
      { path: "/laws/day/length", message: shortDay(150, 100) },
      { path: "/laws/day", message: shortPart("light period", 75, [150, 500], 100) },
      { path: "/laws/day", message: shortPart("night", 75, [150, 500], 100) },
    ]);
    expect(timeLawIssues(defaultGenesis(SEED).laws, MAX)).toHaveLength(3);
  });

  test.each<[string, unknown, string]>([
    ["0", 0, notPerTick("0")],
    ["-0", -0, notPerTick("-0")],
    ["a fraction", 1.5, notPerTick("1.5")],
    ["NaN", Number.NaN, notPerTick("NaN")],
    ["2^53", 2 ** 53, notPerTick("9007199254740992")],
    ["a string", "12", notPerTick("a value of type string")],
  ])("rejects %s seconds per tick, and checks nothing else", (_, perTick, message) => {
    const laws = lawsWith({ length: 150, daylight: 500 });
    expect(timeLawIssues(laws, perTick as number)).toEqual([
      { path: "/simSecondsPerTick", message },
    ]);
  });
});

describe("the golden time values", () => {
  const { length, daylight } = GOLDEN_TIME.laws.day;
  const light = (length * daylight) / 1000;
  const ceil = (a: number, b: number) => Math.ceil(a / b);
  /** The tick each row names, derived from its name (fixtures/golden-time.ts). */
  const tickNamed: Record<string, (perTick: number) => number> = {
    dawn: () => 0,
    quarterLight: (perTick) => ceil(light, 4 * perTick),
    midLight: (perTick) => ceil(light, 2 * perTick),
    lastLight: (perTick) => ceil(light, perTick) - 1,
    firstNight: (perTick) => ceil(light, perTick),
    lastOfDay: (perTick) => ceil(length, perTick) - 1,
    nextDawn: (perTick) => ceil(length, perTick),
    nearLimit: (perTick) => Number(BigInt(MAX) / BigInt(perTick)),
  };
  const sets = GOLDEN_TIME.sets.map((set) => [set.simSecondsPerTick, set] as const);

  test("were recorded under worldgen@1 with the default laws", () => {
    expect(WORLDGEN_VERSION).toBe(GOLDEN_TIME.worldgenVersion);
    expect(defaultGenesis(SEED).laws).toEqual(GOLDEN_TIME.laws);
  });

  test.each(sets)("hold at %d seconds per tick, under either terrain seed", (perTick, set) => {
    for (const seed of [SEED, OTHER_SEED]) {
      const prepared = prepareGenesis(defaultGenesis(seed));
      const rows = set.instants.map(({ at: name, tick }) => {
        const { position, ...values } = measured(prepared, at(tick, perTick));
        return { at: name, tick, ...position, ...values };
      });
      expect(rows).toEqual([...set.instants]);
    }
  });

  test.each(sets)("name the instants they hold at %d seconds per tick", (perTick, set) => {
    expect(Object.keys(tickNamed)).toEqual(set.instants.map((row) => row.at));
    for (const row of set.instants) expect(tickNamed[row.at]?.(perTick)).toBe(row.tick);
  });

  test.each(sets)("end at the last safe second at %d seconds per tick", (perTick, set) => {
    const prepared = prepareGenesis(defaultGenesis(SEED));
    const last = set.instants.at(-1)?.tick ?? 0;
    expect(engineErrorOf(() => radiance(prepared, at(last + 1, perTick))).code).toBe(
      "tick_overflow",
    );
  });
});
