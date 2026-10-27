/**
 * The scale benchmark of the beings (plan §7; docs/architecture/beings.md, "Measured cost"):
 * manual, never run by `bun test`, because it measures wall-clock time. It prints Markdown tables
 * of indicative numbers, then each target of plan §7 against what it measured; compare runs on one
 * machine, before and after a change, never across machines.
 *
 *   bun packages/agents/bench/beings.ts [micro dispersed concentrated sleeping explored] [--large]
 *     [--ticks N]
 *
 * The words name the groups of scenarios, all five by default (scale.ts builds their worlds):
 *
 * - `micro`: the senses at radius 8, 16, 24, and 32, and Dijkstra and A* over their windows;
 * - `dispersed`: 10, 100, and 1,000 beings, one to a chunk, timed over one simulated day;
 * - `concentrated`: 10, 100, and 1,000 beings in one chunk and in 3 × 3 chunks, for 500 ticks;
 * - `sleeping`: 10 active beings beside 1,000 sleeping ones, and alone, for 1,000 ticks, then a
 *   tick that adds a chunk to the occupancy index; and ticks that process 1,000, 2,000, and 4,000
 *   beings at once;
 * - `explored`: 10 active beings in worlds of 0 and 1,000 empty chunks, for 1,000 ticks.
 *
 * `--large` adds the large scenarios: 10,000 dispersed beings, 10,000 and 100,000 sleeping ones,
 * ticks that process 8,000 and 16,000 beings at once, and 200,000 empty chunks. Each one starts
 * only while the system has at least 1.5 GB of memory available (read from /proc/meminfo, where
 * there is one), and is skipped with a message otherwise. `--ticks N` times N ticks of every
 * scenario instead of its own number; the sleeping beings sleep until tick 1,325 at the latest, so
 * `sleeping` with more than 1,100 ticks may time them awake. Every scenario first runs the spawn at
 * tick 1, the first decisions at tick 2, and 100 more ticks before any is timed. Any other
 * argument, or one given twice, is an error, and exits with code 2.
 *
 * It runs one scenario at a time, in this process, and prints its peak resident memory at the end.
 * On a shared machine, run it at low priority: `nice -n 19 bun packages/agents/bench/beings.ts`.
 */
import { readFileSync } from "node:fs";
import { beings, readView } from "@open-origin/engine";
import { exploredChunks } from "../../engine/test/support/beings-cost.ts";
import { aStar, dijkstra } from "../src/index.ts";
import {
  BENCH_LABEL,
  type BenchWorld,
  benchCenter,
  benchWorld,
  type Cell,
  concentratedCells,
  DAY_TICKS,
  dispersedCells,
  measureRun,
  PREPARED,
  type Run,
  SPS,
  sleepingCells,
  spawnsOf,
  timedStep,
} from "./scale.ts";

const GROUPS = ["micro", "dispersed", "concentrated", "sleeping", "explored"] as const;
export type Group = (typeof GROUPS)[number];

/** What the arguments ask for: the groups, the large sizes, and the ticks to time. */
export type Arguments = {
  readonly groups: readonly Group[];
  readonly large: boolean;
  readonly ticks: number | undefined;
};

/**
 * The arguments of the benchmark. Throws an Error that says what is wrong: an unknown word or
 * option, an option without a valid value, or a word or option given twice.
 */
export function parseArguments(argv: readonly string[]): Arguments {
  const reading: { groups: Group[]; large: boolean; ticks?: number } = { groups: [], large: false };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] as string;
    if (arg === "--ticks") {
      if (reading.ticks !== undefined) throw new Error("--ticks is given twice");
      reading.ticks = positive(argv[at + 1]);
      at += 1;
    } else if (arg === "--large") {
      if (reading.large) throw new Error("--large is given twice");
      reading.large = true;
    } else readGroup(reading.groups, arg);
  }
  const { groups, large, ticks } = reading;
  return { groups: groups.length === 0 ? [...GROUPS] : groups, large, ticks };
}

/** Adds the group `arg` names to `groups`; throws when it names none, or one already there. */
function readGroup(groups: Group[], arg: string): void {
  const group = GROUPS.find((name) => name === arg);
  if (group === undefined || groups.includes(group))
    throw new Error(`unknown argument "${arg}": give ${GROUPS.join(", ")}, --large, or --ticks N`);
  groups.push(group);
}

/** The value of `--ticks`, which must be a positive safe integer. */
function positive(text: string | undefined): number {
  if (text === undefined) throw new Error("--ticks needs a value: a positive integer");
  const value = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`--ticks must be a positive integer, not "${text}"`);
  return value;
}

/** The memory, in MB, that the system must have available before a large scenario starts. */
const ROOM_MB = 1_536;

/** A number of kB that /proc reports for `field` in `file`; undefined where there is none. */
function procKb(file: string, field: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // Not Linux, or no /proc: the figure is unknown, which the callers say.
    return undefined;
  }
  const kb = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(text)?.[1];
  return kb === undefined ? undefined : Number(kb);
}

/**
 * Whether a large scenario may start with `availableMb` of memory available: at least ROOM_MB, or
 * an amount unknown, so that the benchmark still runs where /proc/meminfo does not exist.
 */
export function hasRoom(availableMb: number | undefined): boolean {
  return availableMb === undefined || availableMb >= ROOM_MB;
}

/** Whether the large scenario `name` may start; prints why when it may not. */
function roomFor(name: string): boolean {
  const kb = procKb("/proc/meminfo", "MemAvailable");
  const availableMb = kb === undefined ? undefined : kb / 1024;
  if (hasRoom(availableMb)) return true;
  console.log(`\nSkipped ${name}: ${availableMb?.toFixed(0)} MB available, under ${ROOM_MB} MB.`);
  return false;
}

/** The ticks every scenario runs after its first decisions and before any is timed. */
const WARM_UP = 100;

/** The median of `values`: the middle one once sorted, or the upper of the two in the middle. */
export function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

/** The nearest-rank `q` quantile of `values`, for q in (0, 1]: p99 is quantile(values, 0.99). */
export function quantile(values: readonly number[], q: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

const ms = (ns: number) => (ns / 1e6).toFixed(3);
const kb = (bytes: number) => (bytes / 1024).toFixed(1);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * What a run's timed ticks cost per wake: the time of the ticks with a wake, less what a tick
 * without one costs (the median of those; the fastest tick when every tick had one), divided by
 * the wakes.
 */
export function nsPerWake(samples: Run["samples"]): number {
  const idle = samples.filter((sample) => sample.wakes === 0).map((sample) => sample.ns);
  const base = idle.length > 0 ? median(idle) : Math.min(...samples.map((sample) => sample.ns));
  const busy = samples.filter((sample) => sample.wakes > 0);
  const wakes = sum(busy.map((sample) => sample.wakes));
  return wakes === 0 ? 0 : sum(busy.map((sample) => sample.ns - base)) / wakes;
}

/** How many of `count` there are per being and simulated day over the timed ticks of `run`. */
const perBeingDay = (run: Run, count: number) =>
  (count * DAY_TICKS) / (run.samples.length * run.beings);

/** The slowest timed tick of `run`: its time, and how many beings decided in it. */
function busiest(run: Run): string {
  const slowest = run.samples.reduce((worst, sample) => (sample.ns > worst.ns ? sample : worst));
  return `${ms(slowest.ns)}, ${slowest.decisions}`;
}

/** The row of a run in the table of runs. */
function runRow(name: string, run: Run): string {
  const times = run.samples.map((sample) => sample.ns);
  const hashed = run.samples.map((sample) => sample.hashed);
  const decisions = sum(run.samples.map((sample) => sample.decisions));
  const events = sum(run.samples.map((sample) => sample.events));
  return `| ${[
    name,
    run.beings.toLocaleString("en-US"),
    run.samples.length.toLocaleString("en-US"),
    ms(median(times)),
    ms(quantile(times, 0.99)),
    busiest(run),
    (nsPerWake(run.samples) / 1e3).toFixed(1),
    perBeingDay(run, decisions).toFixed(1),
    perBeingDay(run, events).toFixed(1),
    `${kb(median(hashed))} / ${kb(quantile(hashed, 0.99))}`,
    run.snapshotPerBeing.toFixed(0),
    run.memoryPerBeing.toFixed(0),
    `${median(run.beingBytes)} (${Math.min(...run.beingBytes)}–${Math.max(...run.beingBytes)})`,
    run.spawnMs.toFixed(1),
    run.firstMs.toFixed(1),
  ].join(" | ")} |`;
}

const RUN_HEADER = [
  "| Scenario | Beings | Ticks timed | Median ms | p99 ms | Slowest tick: ms, decisions | µs per wake | Decisions per being and day | Events per being and day | KB hashed per tick, median / p99 | Snapshot B per being | Memory B per being | Being B, median (range) | Spawn tick ms | First decisions ms |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
];

/** What the targets of plan §7 read from the runs. */
export type Findings = {
  tenMedianMs?: number;
  thousandMs?: { median: number; p99: number };
  decisionMs?: { senses: number; brain: number; endToEnd: number };
  sleepingMarginalNs?: number;
  /** How many sleeping beings the marginal cost was measured beside. */
  sleepingBeside?: number;
  snapshotPerBeing?: number;
};

/** Runs `count` beings on `cells`, `utility@1` each, and prints its row. */
function runScenario(name: string, cells: readonly Cell[], measured: number): Run {
  const run = measureRun(benchWorld({}), spawnsOf("s1", cells), {
    warmUp: WARM_UP,
    measured,
  });
  console.log(runRow(name, run));
  return run;
}

/** The dispersed runs, over one simulated day unless `--ticks` says otherwise. */
function dispersed(options: Arguments, findings: Findings): Run[] {
  const large = options.large && roomFor("10,000 dispersed beings");
  const sizes = large ? [10, 100, 1_000, 10_000] : [10, 100, 1_000];
  const runs = sizes.map((size) =>
    runScenario(
      `dispersed ${size}`,
      dispersedCells(size, benchCenter()),
      options.ticks ?? DAY_TICKS,
    ),
  );
  const ten = runs[0] as Run;
  findings.tenMedianMs = median(ten.samples.map((sample) => sample.ns)) / 1e6;
  const thousand = runs[2] as Run;
  const times = thousand.samples.map((sample) => sample.ns);
  findings.thousandMs = { median: median(times) / 1e6, p99: quantile(times, 0.99) / 1e6 };
  findings.snapshotPerBeing = Math.max(...runs.map((run) => run.snapshotPerBeing));
  return runs;
}

/** The concentrated runs, one chunk and 3 × 3 chunks: ceilings, which 500 ticks show. */
function concentrated(options: Arguments): void {
  for (const side of [1, 3] as const) {
    for (const size of [10, 100, 1_000]) {
      const name = `concentrated ${size} in ${side} × ${side}`;
      runScenario(name, concentratedCells(size, side, benchCenter()), options.ticks ?? 500);
    }
  }
}

/**
 * The cost of one decision in `run`, end to end: the median tick whose one wake decided, less the
 * median tick whose one wake did not; and how many ticks of each there were.
 */
export function decisionCost(run: Run) {
  const single = run.samples.filter((s) => s.wakes === 1);
  const decided = single.filter((s) => s.decisions === 1).map((s) => s.ns);
  const undecided = single.filter((s) => s.decisions === 0).map((s) => s.ns);
  return { decided, undecided, ns: median(decided) - median(undecided) };
}

/**
 * The decisions of the dispersed runs: `utility@1` alone, and one decision end to end
 * (decisionCost). The target reads the end-to-end cost of the run of 100 beings, whose ticks are
 * cheap but have wakes, and the senses at radius 24 from the micro measurements.
 */
function decisions(runs: readonly Run[], sensesNs: number | undefined, findings: Findings): void {
  console.log(
    "\n| Scenario | Decisions timed | utility@1 median / mean / p99 µs | Ticks whose one wake decided: count, median ms | Ticks whose one wake did not: count, median ms | One decision, end to end, ms |",
  );
  console.log("|---|---|---|---|---|---|");
  for (const run of runs) {
    const { decided, undecided, ns } = decisionCost(run);
    const brain = [
      median(run.decideNs),
      sum(run.decideNs) / run.decideNs.length,
      quantile(run.decideNs, 0.99),
    ];
    console.log(
      `| dispersed ${run.beings} | ${run.decideNs.length} | ${brain.map((value) => (value / 1e3).toFixed(0)).join(" / ")} | ${decided.length}, ${ms(median(decided))} | ${undecided.length}, ${ms(median(undecided))} | ${ms(ns)} |`,
    );
  }
  const reference = runs[1];
  if (reference === undefined || sensesNs === undefined) return;
  findings.decisionMs = {
    senses: sensesNs / 1e6,
    brain: median(reference.decideNs) / 1e6,
    endToEnd: decisionCost(reference).ns / 1e6,
  };
}

/** The radii of the senses that the micro measurements cover. */
const RADII = [8, 16, 24, 32];

/** The window of radius `radius` around `cell`, sensed as the engine senses it, and its time. */
function sensed(cell: Cell, radius: number) {
  const species = { ...(beings.defaultLife().species[0] as beings.Species), senses: { radius } };
  const start = Bun.nanoseconds();
  const window = beings.senseWindow({
    prepared: PREPARED,
    species,
    center: [cell[0], cell[1]],
    view: { readChunk: () => undefined },
    nowSeconds: 0,
    simSecondsPerTick: SPS,
  });
  return { window, ns: Bun.nanoseconds() - start };
}

/** The species' shortest steps, the bounds of A*. */
const BOUNDS = beings.minimumSteps((beings.defaultLife().species[0] as beings.Species).locomotion);

/**
 * One window of radius `radius` around `cell`, and the searches over it: Dijkstra from its center,
 * and A* from its center to the cell min(16, R) cells away along the direction `heading`.
 */
function searchOnce(cell: Cell, radius: number, heading: number) {
  const { window, ns } = sensed(cell, radius);
  const { side } = window;
  const grid = { side, edgeMs: window.edgeMs };
  const [dx, dy] = beings.DIRECTIONS[heading] as readonly [number, number];
  const reach = Math.min(16, radius);
  const center = radius * side + radius;
  let start = Bun.nanoseconds();
  const paths = dijkstra(grid, center);
  const dijkstraNs = Bun.nanoseconds() - start;
  start = Bun.nanoseconds();
  const route = aStar(grid, center, (radius + dy * reach) * side + radius + dx * reach, BOUNDS);
  const starNs = Bun.nanoseconds() - start;
  return { ns, dijkstraNs, dijkstra: paths.expanded, starNs, star: route?.expanded, side };
}

/**
 * The senses at each radius over the cells of 64 dispersed beings, after a pass over every radius,
 * in three rounds, the first a warm-up; and over each window, Dijkstra and A* (searchOnce), heading
 * in turn along each of the eight directions. Returns the median time of the senses at radius 24.
 */
function micro(): number {
  const cells = dispersedCells(64, benchCenter());
  console.log(
    "\n| Radius | Window cells | Senses µs | Dijkstra µs | Dijkstra nodes, median (max) | A* µs | A* nodes, median (max) | A* routes found |",
  );
  console.log("|---|---|---|---|---|---|---|---|");
  let senses24 = 0;
  // One pass over every radius first, so that the JIT has compiled what each one runs.
  for (const radius of RADII)
    for (const [n, cell] of cells.entries()) searchOnce(cell, radius, n % 8);
  for (const radius of RADII) {
    const runs = [0, 1, 2].flatMap((round) =>
      cells.map((cell, n) => ({ round, ...searchOnce(cell, radius, n % 8) })),
    );
    const timed = runs.filter((run) => run.round > 0);
    const micros = (values: number[]) => (median(values) / 1e3).toFixed(0);
    const nodes = (values: number[]) => `${median(values)} (${Math.max(...values)})`;
    const routes = timed.filter((run) => run.star !== undefined);
    const senses = timed.map((run) => run.ns);
    if (radius === 24) senses24 = median(senses);
    const side = 2 * radius + 1;
    console.log(
      `| ${radius} | ${side * side} | ${micros(senses)} | ${micros(timed.map((run) => run.dijkstraNs))} | ${nodes(timed.map((run) => run.dijkstra))} | ${micros(timed.map((run) => run.starNs))} | ${nodes(routes.map((run) => run.star ?? 0))} | ${routes.length / 2} of ${cells.length} |`,
    );
  }
  return senses24;
}

/** Steps every world of `benches` once per round, in turn, and returns each one's timed ticks. */
function alternate(benches: readonly BenchWorld[], measured: number): number[][] {
  for (let tick = 3; tick <= 2 + WARM_UP; tick += 1)
    for (const { world } of benches) timedStep(world, []);
  const times = benches.map((): number[] => []);
  for (let round = 0; round < measured; round += 1) {
    for (const [index, { world }] of benches.entries())
      times[index]?.push(timedStep(world, []).ms * 1e6);
  }
  return times;
}

/**
 * The sleeping beings spawned per tick. The beings spawned at a tick are processed together at the
 * next one, and such a tick costs more per being the more there are (massWake), so spawning them
 * in batches keeps that cost out of the steady state that `sleeping` measures.
 */
const BATCH = 1_000;

/**
 * One world for each of `sizes`: ten active beings on `active`, spawned at tick 1, and the first
 * `size` cells of `asleep` for sleeping beings, BATCH a tick. Every world steps the same ticks, so
 * that the ticks timed later are the same ticks in each.
 */
function sleepingWorlds(
  sizes: readonly number[],
  active: readonly Cell[],
  asleep: readonly Cell[],
) {
  const benches = sizes.map(() => benchWorld({ sleeping: true }));
  for (let tick = 1; tick <= Math.ceil(Math.max(...sizes) / BATCH) + 1; tick += 1) {
    for (const [index, bench] of benches.entries()) {
      const batch = asleep.slice((tick - 1) * BATCH, Math.min(tick * BATCH, sizes[index] ?? 0));
      const spawns = [...(tick === 1 ? spawnsOf("s1", active) : []), ...spawnsOf("s2", batch)];
      timedStep(
        bench.world,
        spawns.map((command, seq) => ({ ...command, applyTick: tick, seq })),
      );
    }
  }
  return benches;
}

/**
 * Ten active beings alone and beside K sleeping ones, 1,000, or 10,000 and 100,000 with `--large`,
 * in their own chunks, stepped alternately:
 * the marginal cost of a sleeping being is the median, over the timed ticks, of the difference
 * between the two worlds' ticks, divided by K. The sleeping beings are spawned BATCH a tick. Then
 * each world spawns one being in a chunk that no being occupied, a tick that rewrites the
 * occupancy index.
 */
function sleeping(options: Arguments, findings: Findings): void {
  const active = dispersedCells(10, benchCenter());
  const large = options.large && roomFor("10,000 and 100,000 sleeping beings");
  const sizes = large ? [0, 10_000, 100_000] : [0, 1_000];
  const all = sleepingCells(Math.max(...sizes) + 1, active, benchCenter());
  const benches = sleepingWorlds(sizes, active, all);
  const times = alternate(benches, options.ticks ?? 1_000);
  const base = times[0] ?? [];
  const extra = all.at(-1) as Cell;
  console.log(
    "\n| Sleeping beings | Median ms | p99 ms | Marginal ns per sleeping being and tick | A tick that adds a chunk to the index: ms, KB hashed | Chunks in the index after it |",
  );
  console.log("|---|---|---|---|---|---|");
  for (const [index, size] of sizes.entries()) {
    const own = times[index] ?? [];
    const marginal = size === 0 ? 0 : median(own.map((ns, tick) => ns - (base[tick] ?? 0))) / size;
    if (size === Math.max(...sizes)) {
      findings.sleepingMarginalNs = marginal;
      findings.sleepingBeside = size;
    }
    const { world } = benches[index] as BenchWorld;
    const applyTick = readView(world).tick + 1;
    const spawns = spawnsOf("s2", [extra]).map((command) => ({ ...command, applyTick }));
    const grow = timedStep(world, spawns);
    const listed = readView(world).readGlobal().occupancy.length;
    console.log(
      `| ${size.toLocaleString("en-US")} | ${ms(median(own))} | ${ms(quantile(own, 0.99))} | ${size === 0 ? "-" : marginal.toFixed(1)} | ${grow.ms.toFixed(2)}, ${kb(grow.result.stats.hashedBytes)} | ${listed.toLocaleString("en-US")} |`,
    );
  }
}

/**
 * Ticks that process many beings at once: N sleeping beings spawned together, each in its own
 * chunk, are processed together at the next tick, where each decides to sleep with a window of
 * radius 1. Prints the spawn tick and that tick, and each one's time per being.
 */
function massWake(options: Arguments): void {
  const large = options.large && roomFor("8,000 and 16,000 beings processed in one tick");
  const sizes = large ? [1_000, 2_000, 4_000, 8_000, 16_000] : [1_000, 2_000, 4_000];
  const all = sleepingCells(Math.max(...sizes), [], benchCenter());
  console.log(
    "\n| Beings processed in one tick | Spawn tick: ms, µs per being | Their first processing: ms, µs per being |",
  );
  console.log("|---|---|---|");
  for (const size of sizes) {
    const { world } = benchWorld({ sleeping: true });
    const spawned = timedStep(world, spawnsOf("s2", all.slice(0, size)));
    const woken = timedStep(world, []);
    const per = (millis: number) => ((millis * 1e3) / size).toFixed(0);
    console.log(
      `| ${size.toLocaleString("en-US")} | ${spawned.ms.toFixed(0)}, ${per(spawned.ms)} | ${woken.ms.toFixed(0)}, ${per(woken.ms)} |`,
    );
  }
}

/**
 * Ten active beings, the cells of `dispersed 10`, in worlds of 0 and 1,000 empty chunks around
 * them, and of 200,000 with `--large`, stepped alternately: the ratio of each median to the first.
 */
function explored(options: Arguments): void {
  const cells = dispersedCells(10, benchCenter());
  const sizes = options.large && roomFor("200,000 empty chunks") ? [0, 1_000, 200_000] : [0, 1_000];
  const benches = sizes.map((size) => {
    const bench = benchWorld({ chunks: exploredChunks(size, benchCenter()) });
    timedStep(bench.world, spawnsOf("s1", cells));
    timedStep(bench.world, []);
    return bench;
  });
  Bun.gc(true);
  const times = alternate(benches, options.ticks ?? 1_000);
  const base = median(times[0] ?? []);
  console.log("\n| Empty chunks | Median ms | p99 ms | Ratio of medians to no empty chunk |");
  console.log("|---|---|---|---|");
  sizes.forEach((size, index) => {
    const own = times[index] ?? [];
    console.log(
      `| ${size.toLocaleString("en-US")} | ${ms(median(own))} | ${ms(quantile(own, 0.99))} | ${(median(own) / base).toFixed(2)} |`,
    );
  });
}

/** A target of plan §7: its name, its bound in words, and what was measured against it. */
type Target = {
  readonly name: string;
  readonly bound: string;
  readonly measured: string;
  readonly met: boolean;
};

/** The targets of plan §7 that `findings` measured, each met or missed. */
export function targets(findings: Findings): Target[] {
  const list: Target[] = [];
  const { tenMedianMs, thousandMs, decisionMs, sleepingMarginalNs, snapshotPerBeing } = findings;
  if (tenMedianMs !== undefined)
    list.push({
      name: "10 beings, median",
      bound: "≤ 1 ms",
      measured: `${tenMedianMs.toFixed(3)} ms`,
      met: tenMedianMs <= 1,
    });
  if (thousandMs !== undefined)
    list.push({
      name: "1,000 dispersed",
      bound: "median ≤ 50 ms, p99 ≤ 100 ms",
      measured: `median ${thousandMs.median.toFixed(2)} ms, p99 ${thousandMs.p99.toFixed(2)} ms`,
      met: thousandMs.median <= 50 && thousandMs.p99 <= 100,
    });
  if (decisionMs !== undefined) {
    const { senses, brain, endToEnd } = decisionMs;
    list.push({
      name: "One decision, R = 24, default genesis",
      bound: "≤ 3 ms",
      measured: `${endToEnd.toFixed(2)} ms end to end; apart, the senses ${senses.toFixed(2)} ms and utility@1 ${brain.toFixed(2)} ms (medians)`,
      met: endToEnd <= 3,
    });
  }
  if (sleepingMarginalNs !== undefined)
    list.push({
      name: "A sleeping dispersed being, marginal",
      bound: "≤ 1 µs per tick",
      measured: `${(sleepingMarginalNs / 1e3).toFixed(3)} µs per tick beside ${(findings.sleepingBeside ?? 0).toLocaleString("en-US")}`,
      met: sleepingMarginalNs <= 1_000,
    });
  if (snapshotPerBeing !== undefined)
    list.push({
      name: "Snapshot per being",
      bound: "≤ 1 KB",
      measured: `${snapshotPerBeing.toFixed(0)} B, the largest of the dispersed runs`,
      met: snapshotPerBeing <= 1024,
    });
  return list;
}

/** Runs the groups of runs `options` asks for, dispersed and concentrated, and their decisions. */
function runGroups(options: Arguments, senses24: number | undefined, findings: Findings): void {
  const want = (group: Group) => options.groups.includes(group);
  if (!want("dispersed") && !want("concentrated")) return;
  console.log(`\n${RUN_HEADER.join("\n")}`);
  const runs = want("dispersed") ? dispersed(options, findings) : [];
  if (want("concentrated")) concentrated(options);
  if (runs.length > 0) decisions(runs, senses24, findings);
}

/** Runs the groups `options` asks for and prints their tables, then the targets. */
function main(options: Arguments): void {
  const findings: Findings = {};
  const want = (group: Group) => options.groups.includes(group);
  const cores = navigator.hardwareConcurrency;
  console.log(`Bun ${Bun.version}, ${cores} cores; terrain of ${BENCH_LABEL}; ${SPS} s per tick`);
  const senses24 = want("micro") ? micro() : undefined;
  runGroups(options, senses24, findings);
  if (want("sleeping")) {
    sleeping(options, findings);
    massWake(options);
  }
  if (want("explored")) explored(options);
  console.log("\n| Target (plan §7) | Bound | Measured | Status |\n|---|---|---|---|");
  for (const target of targets(findings))
    console.log(
      `| ${target.name} | ${target.bound} | ${target.measured} | ${target.met ? "met" : "missed"} |`,
    );
  const peak = procKb("/proc/self/status", "VmHWM");
  console.log(
    `\nPeak resident memory: ${peak === undefined ? "unknown" : `${(peak / 1024).toFixed(0)} MB`}`,
  );
}

if (import.meta.main) {
  let options: Arguments | undefined;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`beings: ${(error as Error).message}`);
    process.exit(2);
  }
  main(options);
}
