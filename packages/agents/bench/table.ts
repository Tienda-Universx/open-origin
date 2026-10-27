/**
 * The tables the benches print of a run of the preregistered scenario: one row per being with every
 * acceptance item, and one summary row per run with the minimum of each item over its beings.
 */
import { misses, type RunRecord } from "../test/support/metrics.ts";

/** The widths of the columns of a being's row. */
const WIDTHS = [4, 6, 5, 6, 6, 6, 5, 6, 5, 7, 7, 7, 9, 9];

/** The header and one row per being of `run`, each item of the acceptance in a column. */
export function beingRows(run: RunRecord): string[] {
  const rows = run.beings.map((record) =>
    [
      record.id,
      record.incapacitated,
      record.died,
      record.exhausted,
      record.rejected,
      record.mealCells.length,
      record.ateOutsideBirthWindow ? "yes" : "no",
      record.meals,
      record.bigMeals,
      record.sleeps,
      record.restedWakes,
      record.walked,
      record.lowestNutrition,
      record.lowestHealth,
      misses(record).join(", ") || "-",
    ]
      .map((cell, index) => `${cell}`.padEnd(WIDTHS[index] ?? 0))
      .join(""),
  );
  return [
    "id  incap died rest0 rejct cells out  meals big  sleeps rested walked lowN     lowH     misses",
    ...rows,
  ];
}

/** The smallest of `values`. */
const least = (values: readonly number[]) => Math.min(...values);

/**
 * The summary of `run`, as the cells of a Markdown row: incapacities, rests at 0, and rejections
 * over all beings; the beings that ate outside their birth window; the minimum over the beings of
 * meal cells, big meals, sleeps and rested wakes, cells walked, and nutrition; whether some cell
 * regrew and was eaten again; and the acceptance: pass when every being meets every item and some
 * cell regrew and was eaten again, otherwise what failed.
 */
export function summaryCells(run: RunRecord): string[] {
  const all = run.beings;
  const sum = (count: (record: (typeof all)[number]) => number) =>
    all.reduce((total, record) => total + count(record), 0);
  const failing = all.filter((record) => misses(record).length > 0);
  const failures = failing.map((record) => `${record.id} (${misses(record).join(", ")})`);
  if (!run.regrewAndEaten) failures.push("no cell regrew and was eaten again");
  return [
    `${sum((r) => r.incapacitated)}, ${sum((r) => r.exhausted)}, ${sum((r) => r.rejected)}`,
    `${least(all.map((r) => r.mealCells.length))}`,
    `${all.filter((r) => r.ateOutsideBirthWindow).length} of ${all.length}`,
    `${least(all.map((r) => r.bigMeals))}`,
    `${least(all.map((r) => r.sleeps))}; ${least(all.map((r) => r.restedWakes))}`,
    `${least(all.map((r) => r.walked))}`,
    least(all.map((r) => r.lowestNutrition)).toLocaleString("en-US"),
    run.regrewAndEaten ? "yes" : "no",
    failures.length === 0 ? "pass" : `fail: ${failures.join("; ")}`,
  ];
}

/** What a run of the stationary control gave: its beings, and the first tick each was incapacitated. */
export type StationaryRun = {
  readonly beings: number;
  readonly incapacitatedAt: readonly (readonly [number, number])[];
  readonly secondsPerTick: number;
  readonly dayLength: number;
};

/**
 * The summary of a run of the stationary control, as the cells of a Markdown row: how many of its
 * beings were incapacitated, the day of the last incapacity, and whether every being was
 * incapacitated within `tenDays` ticks and within `horizon` ticks, H.
 */
export function stationaryCells(
  run: StationaryRun,
  ticks: { readonly tenDays: number; readonly horizon: number },
): string[] {
  const all = run.incapacitatedAt.length === run.beings;
  const last = Math.max(0, ...run.incapacitatedAt.map(([, tick]) => tick));
  const day = (last * run.secondsPerTick) / run.dayLength;
  const within = (bound: number) => (all && last <= bound ? "yes" : "no");
  return [
    `${run.incapacitatedAt.length} of ${run.beings}`,
    all ? `${day.toFixed(1)} (tick ${last})` : "-",
    within(ticks.tenDays),
    within(ticks.horizon),
  ];
}

/** The header of the table of the stationary control, for the cells of stationaryCells. */
export const STATIONARY_HEADER = [
  "| Run | Incapacitated | Day of the last incapacity | Within ten days | By H |",
  "|---|---|---|---|---|",
];

/** The header of the summary table, as Markdown, for the cells of summaryCells after a label. */
export const SUMMARY_HEADER = [
  "| Run | Incapacitated, rest 0, rejected | Meal cells | Ate outside birth window | Meals ≥ 300,000 | Sleeps; rested wakes | Walked | Lowest nutrition | Regrown and eaten | Acceptance |",
  "|---|---|---|---|---|---|---|---|---|---|",
];
