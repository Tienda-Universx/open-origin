/**
 * The cost of the C0 projection per tick (plan §11, "Proyección de chunks cambiados": p99 at most
 * 2 ms on the default world, and at most 10 % of the step in "dispersed 1,000"). Manual, never run
 * by `bun test`, because it measures wall-clock time; compare runs on one machine, never across
 * machines.
 *
 *   bun apps/server/bench/projection.ts [default] [dense] [--ticks N]
 *
 * - `default`: the default world of T5 (`ScenarioSource`), its eight spawns at tick 1; the next
 *   20,000 ticks are timed, about 67 minutes of the world at 5 Hz.
 * - `dense`: the world of the beings benchmark's "dispersed 1,000"
 *   (packages/agents/bench/scale.ts): 1,000 beings under `utility@1`, one to a chunk, chunks two
 *   apart, spawned at tick 1; the next 2,000 ticks are timed, a third of a simulated day, so a
 *   run stays under a minute on one core.
 *
 * In both, ticks 1 to 100 (the spawns, the first decisions, and 98 more) warm up first.
 *
 * Both run by default; `--ticks N` times N ticks of each instead. Each tick is stepped with the
 * engine's `step`, then projected, as `WorldHost` does, and each is timed apart with
 * `Bun.nanoseconds`, so the projection's share of the step is the sum of its times over the sum of
 * the step's. On a shared machine, run it pinned and at low priority:
 * `taskset -c 0 nice -n 19 bun apps/server/bench/projection.ts`.
 */
import { header, ms, percentilesOf, positiveArg, table } from "./report.ts";
import type { BenchSource, TimedTick } from "./worlds.ts";

const WORLDS = ["default", "dense"] as const;
export type WorldName = (typeof WORLDS)[number];

export type ProjectionArguments = {
  readonly worlds: readonly WorldName[];
  readonly ticks: number | undefined;
};

/**
 * The arguments of the benchmark: the worlds, both unless named, and `--ticks N`. Throws an Error
 * naming an unknown argument, a world or `--ticks` given twice, or a value of `--ticks` that is not
 * a positive integer.
 */
export function parseArguments(argv: readonly string[]): ProjectionArguments {
  const worlds: WorldName[] = [];
  let ticks: number | undefined;
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === "--ticks") {
      if (ticks !== undefined) throw new Error("--ticks is given twice");
      ticks = positiveArg("--ticks", argv[at + 1]);
      at += 1;
      continue;
    }
    const world = WORLDS.find((name) => name === arg);
    if (world === undefined || worlds.includes(world))
      throw new Error(`unknown argument "${arg}": give ${WORLDS.join(", ")}, or --ticks N`);
    worlds.push(world);
  }
  return { worlds: worlds.length === 0 ? [...WORLDS] : worlds, ticks };
}

/** One timed tick: its step and its projection, and what the projection published. */
export type TickSample = {
  readonly stepNs: number;
  readonly projectNs: number;
  /** The chunks the step changed, and those whose C0 content changed. */
  readonly changed: number;
  readonly chunks: number;
  /** The records published, and the published tick's bytes of JSON. */
  readonly records: number;
  readonly bytes: number;
};

/** The sample of a timed tick. */
function sampleOf({ stepNs, projectNs, changedChunks, published }: TimedTick): TickSample {
  return {
    stepNs,
    projectNs,
    changed: changedChunks,
    chunks: published.chunks.length,
    records: published.chunks.reduce((total, chunk) => total + chunk.upsert.length, 0),
    bytes: JSON.stringify(published).length,
  };
}

/** The ticks each world runs before any is timed: its spawns, its first decisions, and more. */
const WARM_UP = 100;

/** The ticks of each world timed unless `--ticks` says otherwise. */
const DEFAULT_TICKS = 20_000;
const DENSE_TICKS = 2_000;

/** The module of the worlds, loaded when a run needs it. */
type Worlds = typeof import("./worlds.ts");

/** Runs `source` for WARM_UP ticks, projected, then times `ticks` more. */
function run(worlds: Worlds, source: BenchSource, ticks: number): TickSample[] {
  const projection = worlds.projectionOf(source);
  for (let tick = 0; tick < WARM_UP; tick += 1) worlds.timedTick(source, projection);
  Bun.gc(true);
  return Array.from({ length: ticks }, () => sampleOf(worlds.timedTick(source, projection)));
}

/** The timed ticks of `world`, `ticks` of them unless undefined. */
async function samplesOf(world: WorldName, ticks: number | undefined): Promise<TickSample[]> {
  const worlds = await import("./worlds.ts");
  if (world === "default") return run(worlds, worlds.defaultSource(), ticks ?? DEFAULT_TICKS);
  return run(worlds, worlds.dispersedSource(), ticks ?? DENSE_TICKS);
}

/** What a run's timed ticks cost and published. */
export type Summary = {
  readonly ticks: number;
  readonly step: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly project: { readonly p50: number; readonly p95: number; readonly p99: number };
  /** The projection's time over the step's, both summed over the timed ticks. */
  readonly share: number;
  readonly changed: { readonly p50: number; readonly max: number };
  readonly records: { readonly p50: number; readonly max: number };
  readonly bytes: { readonly p50: number; readonly p99: number };
};

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** The summary of `samples`, which must not be empty. */
export function summarize(samples: readonly TickSample[]): Summary {
  const of = (read: (sample: TickSample) => number) => samples.map(read);
  const stepNs = of((sample) => sample.stepNs);
  const projectNs = of((sample) => sample.projectNs);
  return {
    ticks: samples.length,
    step: percentilesOf(stepNs),
    project: percentilesOf(projectNs),
    share: sum(projectNs) / sum(stepNs),
    changed: {
      p50: percentilesOf(of((s) => s.changed)).p50,
      max: Math.max(...of((s) => s.changed)),
    },
    records: {
      p50: percentilesOf(of((s) => s.records)).p50,
      max: Math.max(...of((s) => s.records)),
    },
    bytes: {
      p50: percentilesOf(of((s) => s.bytes)).p50,
      p99: percentilesOf(of((s) => s.bytes)).p99,
    },
  };
}

const COLUMNS = [
  "World",
  "Ticks timed",
  "Step p50 / p95 / p99 ms",
  "Projection p50 / p95 / p99 ms",
  "Projection / step",
  "Chunks changed per tick, p50 / max",
  "Records published per tick, p50 / max",
  "Published bytes per tick, p50 / p99",
];

/** The row of `name`'s summary. */
export function row(name: string, summary: Summary): string[] {
  const three = ({ p50, p95, p99 }: Summary["step"]) => `${ms(p50)} / ${ms(p95)} / ${ms(p99)}`;
  return [
    name,
    String(summary.ticks),
    three(summary.step),
    three(summary.project),
    `${(summary.share * 100).toFixed(2)} %`,
    `${summary.changed.p50} / ${summary.changed.max}`,
    `${summary.records.p50} / ${summary.records.max}`,
    `${summary.bytes.p50} / ${summary.bytes.p99}`,
  ];
}

/** The budgets of plan §11 this benchmark measures, each met or missed, for the worlds it ran. */
export function verdicts(summaries: ReadonlyMap<WorldName, Summary>): string[] {
  const lines: string[] = [];
  const defaultWorld = summaries.get("default");
  if (defaultWorld !== undefined) {
    const p99 = defaultWorld.project.p99 / 1e6;
    lines.push(
      `default world, projection p99 ≤ 2 ms: ${p99.toFixed(3)} ms, ${p99 <= 2 ? "met" : "missed"}`,
    );
  }
  const dense = summaries.get("dense");
  if (dense !== undefined) {
    const share = dense.share * 100;
    lines.push(
      `dispersed 1,000, projection ≤ 10 % of the step: ${share.toFixed(2)} %, ${share <= 10 ? "met" : "missed"}`,
    );
  }
  return lines;
}

/** Runs the worlds `argv` names and prints their table and the budgets. */
async function main(argv: readonly string[]): Promise<void> {
  const options = parseArguments(argv);
  console.log(header("The projection's cost per tick (apps/server/bench/projection.ts)"));
  const summaries = new Map<WorldName, Summary>();
  for (const world of options.worlds)
    summaries.set(world, summarize(await samplesOf(world, options.ticks)));
  const rows = [...summaries].map(([name, summary]) => row(name, summary));
  console.log(table(COLUMNS, rows));
  console.log(`\n${verdicts(summaries).join("\n")}`);
}

if (import.meta.main) await main(process.argv.slice(2));
