/**
 * The golden time values of worldgen@1 (ADR 0021, permanent and temporal layers; plan §12 test 12):
 * the day position, the day curve, radiance, and the diurnal swing at boundary instants of the
 * default laws. They pin behavior; they do not prove it correct, which is the job of the
 * properties and the exact BigInt reference in worldgen-calendar.test.ts. They depend only on the
 * laws and the instant, never on the terrain seed: the test computes them under two seeds.
 *
 * Each set is one number of seconds per tick, and each row an instant of it, named by `at`:
 * `dawn` is tick 0; `quarterLight` and `midLight` are the first ticks at or past a quarter and a
 * half of the light period; `lastLight` and `firstNight` are the last tick before dusk and the
 * first at or past it; `lastOfDay` and `nextDawn` are the last tick of day 0 and the first of day 1;
 * and `nearLimit` is the last tick whose simulated second is a safe integer. The test derives each
 * tick from its name, so a row cannot claim an instant it is not.
 *
 * - 12 seconds divides the day and its light period, so dusk and dawn fall on ticks.
 * - 7 divides them too, and mid-light as well, so `midLight` reads the curve's exact peak.
 * - 13 divides neither, so the phase drifts: day 1 starts at its second 8.
 *
 * Near dusk the curve is flat, as C1 requires, so `lastLight` already reads the night floor.
 *
 * `worldgen@1` is frozen when T3 closes (ADR 0021), and T3-6 changes no output. Update policy:
 * after the freeze, any change that alters one of these values changes what worldgen@1 outputs, so
 * it needs a new WORLDGEN_VERSION ("worldgen@2"), which worldgen-calendar.test.ts pins with the
 * default laws, and new values recorded in the same change. These values were recorded in T3-4, on
 * 2026-10-25 with Bun 1.4.4, from a BigInt reference that computes every step exactly, before
 * calendar.ts existed, and calendar.ts reproduced them.
 */
export const GOLDEN_TIME = {
  worldgenVersion: "worldgen@1",
  laws: {
    day: { length: 75_600, daylight: 550 },
    liquid: { level: 450 },
    thermal: { base: 400, spread: 120, lapse: { num: 3, den: 1000 }, diurnal: 60 },
    radiance: { peak: 1000, night: 40 },
  },
  sets: [
    {
      simSecondsPerTick: 12,
      instants: [
        { at: "dawn", tick: 0, dayIndex: 0, secondOfDay: 0, curve: 0, radiance: 40, diurnal: 0 },
        {
          at: "quarterLight",
          tick: 867,
          dayIndex: 0,
          secondOfDay: 10_404,
          curve: 36_904,
          radiance: 580,
          diurnal: 33,
        },
        {
          at: "midLight",
          tick: 1733,
          dayIndex: 0,
          secondOfDay: 20_796,
          curve: 65_534,
          radiance: 999,
          diurnal: 59,
        },
        {
          at: "lastLight",
          tick: 3464,
          dayIndex: 0,
          secondOfDay: 41_568,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "firstNight",
          tick: 3465,
          dayIndex: 0,
          secondOfDay: 41_580,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "lastOfDay",
          tick: 6299,
          dayIndex: 0,
          secondOfDay: 75_588,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "nextDawn",
          tick: 6300,
          dayIndex: 1,
          secondOfDay: 0,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "nearLimit",
          tick: 750_599_937_895_082,
          dayIndex: 119_142_847_284,
          secondOfDay: 70_584,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
      ],
    },
    {
      simSecondsPerTick: 7,
      instants: [
        { at: "dawn", tick: 0, dayIndex: 0, secondOfDay: 0, curve: 0, radiance: 40, diurnal: 0 },
        {
          at: "quarterLight",
          tick: 1485,
          dayIndex: 0,
          secondOfDay: 10_395,
          curve: 36_864,
          radiance: 580,
          diurnal: 33,
        },
        {
          at: "midLight",
          tick: 2970,
          dayIndex: 0,
          secondOfDay: 20_790,
          curve: 65_536,
          radiance: 1000,
          diurnal: 60,
        },
        {
          at: "lastLight",
          tick: 5939,
          dayIndex: 0,
          secondOfDay: 41_573,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "firstNight",
          tick: 5940,
          dayIndex: 0,
          secondOfDay: 41_580,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "lastOfDay",
          tick: 10_799,
          dayIndex: 0,
          secondOfDay: 75_593,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "nextDawn",
          tick: 10_800,
          dayIndex: 1,
          secondOfDay: 0,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "nearLimit",
          tick: 1_286_742_750_677_284,
          dayIndex: 119_142_847_284,
          secondOfDay: 70_588,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
      ],
    },
    {
      simSecondsPerTick: 13,
      instants: [
        { at: "dawn", tick: 0, dayIndex: 0, secondOfDay: 0, curve: 0, radiance: 40, diurnal: 0 },
        {
          at: "quarterLight",
          tick: 800,
          dayIndex: 0,
          secondOfDay: 10_400,
          curve: 36_883,
          radiance: 580,
          diurnal: 33,
        },
        {
          at: "midLight",
          tick: 1600,
          dayIndex: 0,
          secondOfDay: 20_800,
          curve: 65_534,
          radiance: 999,
          diurnal: 59,
        },
        {
          at: "lastLight",
          tick: 3198,
          dayIndex: 0,
          secondOfDay: 41_574,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "firstNight",
          tick: 3199,
          dayIndex: 0,
          secondOfDay: 41_587,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "lastOfDay",
          tick: 5815,
          dayIndex: 0,
          secondOfDay: 75_595,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "nextDawn",
          tick: 5816,
          dayIndex: 1,
          secondOfDay: 8,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
        {
          at: "nearLimit",
          tick: 692_861_481_133_922,
          dayIndex: 119_142_847_284,
          secondOfDay: 70_586,
          curve: 0,
          radiance: 40,
          diurnal: 0,
        },
      ],
    },
  ],
} as const;
