/**
 * The light crossings of beings (ADR 0023): nextLightTick against a brute-force scan of every tick,
 * on default and short days, odd and even light periods, and thresholds inside and outside the
 * range of the radiance.
 */
import { describe, expect, test } from "bun:test";
import { beings, worldgen } from "../src/index.ts";
import { Sfc32 } from "./support/sfc32.ts";

const { nextLightTick } = beings;

/** A prepared genesis whose day lasts `length` seconds, `daylight` ‰ of it lit. */
function clockOf(length: number, daylight: number, simSecondsPerTick: number) {
  const base = worldgen.defaultGenesis([1, 2, 3, 4, 5, 6, 7, 8]);
  const genesis = { ...base, laws: { ...base.laws, day: { length, daylight } } };
  return { prepared: worldgen.prepareGenesis(genesis), day: genesis.laws.day, simSecondsPerTick };
}

/** The first tick after `after` that satisfies `watch` right after one that does not. */
function scan(
  clock: ReturnType<typeof clockOf>,
  after: number,
  watch: beings.LightWatch,
  horizon: number,
) {
  const at = (tick: number) =>
    worldgen.radiance(clock.prepared, { tick, simSecondsPerTick: clock.simSecondsPerTick });
  const met = (value: number) =>
    watch.direction === "below" ? value <= watch.threshold : value >= watch.threshold;
  let previous = met(at(after));
  for (let tick = after + 1; tick <= after + horizon; tick += 1) {
    const now = met(at(tick));
    if (now && !previous) return tick;
    previous = now;
  }
  return undefined;
}

describe("nextLightTick", () => {
  test.each([
    ["the default day at 12 s per tick", 75_600, 550, 12],
    ["a short day with an odd light period", 601, 333, 1],
    ["a short day at 7 s per tick", 1_400, 500, 7],
  ])("equals a scan of every tick on %s", (_name, length, daylight, sps) => {
    const clock = clockOf(length, daylight, sps);
    const ticksPerDay = Math.ceil(length / sps);
    const random = new Sfc32(length + daylight + sps);
    const peak = 1000;
    let found = 0;
    for (let round = 0; round < 120; round += 1) {
      const after = random.below(3 * ticksPerDay);
      const watch = {
        threshold: random.between(0, peak + 50),
        direction: random.below(2) === 0 ? ("below" as const) : ("above" as const),
      };
      const expected = scan(clock, after, watch, 3 * ticksPerDay + 2);
      expect(nextLightTick(clock, after, watch)).toBe(expected);
      if (expected !== undefined) found += 1;
    }
    // Not vacuous: most thresholds are crossed within the horizon.
    expect(found).toBeGreaterThan(60);
  });

  test("never wakes at once on a condition that already holds", () => {
    const clock = clockOf(75_600, 550, 12);
    // At night the radiance sits at its floor: "below 100" holds now and next comes the next dusk.
    const night = Math.ceil((75_600 * 0.8) / 12);
    const next = nextLightTick(clock, night, { threshold: 100, direction: "below" });
    expect(next).toBeGreaterThan(Math.ceil(75_600 / 12));
  });

  test("gives undefined for a level the light never reaches", () => {
    const clock = clockOf(75_600, 550, 12);
    expect(nextLightTick(clock, 0, { threshold: 1001, direction: "above" })).toBeUndefined();
    expect(nextLightTick(clock, 0, { threshold: 39, direction: "below" })).toBeUndefined();
  });
});
