/**
 * The golden observation values of worldgen@1 (ADR 0021, permanent and temporal layers; plan §6.2):
 * every primitive observable of the default genesis at pairs of a cell and an instant, so they span
 * both layers, where the terrain goldens (golden-worldgen.ts) cover only the permanent layer and the
 * time goldens (golden-time.ts) only the temporal one. They pin behavior; they do not prove it
 * correct, which is the job of the properties in worldgen-observables.test.ts.
 *
 * The genesis is the default one around the terrain seed GOLDEN_WORLDGEN.seeds[seedIndex]. Each
 * row names its cell, `where`, and its instant, `when`, and the test checks each name against the
 * row, so a row cannot claim a cell or an instant it is not:
 *
 * - `liquid` lies under the liquid and `dry` above it; `deposit0` and `deposit1` hold their
 *   deposit; `minMin`, `maxMax`, `minMax`, and `maxMin` are the four corners of the world, as
 *   `<x><y>`; `minusOne` is the cell (−1, −1).
 * - `dawn` is tick 0; `quarterLight` is the first tick at or past a quarter of the light period;
 *   `midLight` is mid-light exactly, where the curve peaks; `lateLight` lies in the last tenth of
 *   the light period; `night` lies after dusk; `nextMidLight` is the first tick at or past
 *   mid-light of day 1; `drifting` is at 13 seconds per tick, which do not divide the day;
 *   `lightNearLimit` lies in the light within one day of the last safe tick; and `lastSafe` is the
 *   last tick whose simulated second is a safe integer.
 *
 * Update policy: worldgen@1 is frozen with these values when T3 closes. Until then, a change that
 * alters one of them records the new values here in the same change; after that, it also needs a
 * new WORLDGEN_VERSION ("worldgen@2"), which this file pins. These were recorded on 2026-10-25 with
 * Bun 1.4.4 by a script outside the repository that computed each value from its definition, with
 * sampleRegion, liquidLevel, diurnal, and radiance, before observables.ts existed; two runs in
 * separate processes printed identical values, and observe reproduced them.
 */
export const GOLDEN_OBSERVATIONS = {
  worldgenVersion: "worldgen@1",
  seedIndex: 1,
  rows: [
    {
      where: "liquid",
      when: "dawn",
      cell: { x: 0, y: 0 },
      instant: { tick: 0, simSecondsPerTick: 12 },
      values: {
        elevation: -56_501,
        "liquid.depth": 50_501,
        substrate: 0,
        thermal: 485,
        radiance: 40,
        "deposit.0": 0,
        "deposit.1": 0,
      },
    },
    {
      where: "dry",
      when: "quarterLight",
      cell: { x: -3584, y: 0 },
      instant: { tick: 867, simSecondsPerTick: 12 },
      values: {
        elevation: 30_379,
        "liquid.depth": 0,
        substrate: 1,
        thermal: 550,
        radiance: 580,
        "deposit.0": 0,
        "deposit.1": 0,
      },
    },
    {
      where: "deposit0",
      when: "midLight",
      cell: { x: -3412, y: 0 },
      instant: { tick: 2970, simSecondsPerTick: 7 },
      values: {
        elevation: -259,
        "liquid.depth": 0,
        substrate: 0,
        thermal: 471,
        radiance: 1000,
        "deposit.0": 202,
        "deposit.1": 0,
      },
    },
    {
      where: "deposit1",
      when: "lateLight",
      cell: { x: 356, y: 1710 },
      instant: { tick: 3200, simSecondsPerTick: 12 },
      values: {
        elevation: 7638,
        "liquid.depth": 0,
        substrate: 1,
        thermal: 482,
        radiance: 116,
        "deposit.0": 0,
        "deposit.1": 201,
      },
    },
    {
      where: "minMin",
      when: "night",
      cell: { x: -2_147_483_648, y: -2_147_483_648 },
      instant: { tick: 4000, simSecondsPerTick: 12 },
      values: {
        elevation: 3644,
        "liquid.depth": 0,
        substrate: 1,
        thermal: 371,
        radiance: 40,
        "deposit.0": 0,
        "deposit.1": 0,
      },
    },
    {
      where: "maxMax",
      when: "nextMidLight",
      cell: { x: 2_147_483_647, y: 2_147_483_647 },
      instant: { tick: 8033, simSecondsPerTick: 12 },
      values: {
        elevation: -654,
        "liquid.depth": 0,
        substrate: 0,
        thermal: 383,
        radiance: 999,
        "deposit.0": 0,
        "deposit.1": 0,
      },
    },
    {
      where: "minMax",
      when: "drifting",
      cell: { x: -2_147_483_648, y: 2_147_483_647 },
      instant: { tick: 100_000, simSecondsPerTick: 13 },
      values: {
        elevation: -41_610,
        "liquid.depth": 35_610,
        substrate: 1,
        thermal: 452,
        radiance: 847,
        "deposit.0": 0,
        "deposit.1": 0,
      },
    },
    {
      where: "maxMin",
      when: "lightNearLimit",
      cell: { x: 2_147_483_647, y: -2_147_483_648 },
      instant: { tick: 750_599_937_891_283, simSecondsPerTick: 12 },
      values: {
        elevation: -5388,
        "liquid.depth": 0,
        substrate: 0,
        thermal: 529,
        radiance: 922,
        "deposit.0": 0,
        "deposit.1": 0,
      },
    },
    {
      where: "minusOne",
      when: "lastSafe",
      cell: { x: -1, y: -1 },
      instant: { tick: 750_599_937_895_082, simSecondsPerTick: 12 },
      values: {
        elevation: -56_404,
        "liquid.depth": 50_404,
        substrate: 0,
        thermal: 485,
        radiance: 40,
        "deposit.0": 0,
        "deposit.1": 0,
      },
    },
  ],
} as const;
