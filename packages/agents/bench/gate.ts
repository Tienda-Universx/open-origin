/**
 * The gate of the entity section (ADR 0024; docs/architecture/mind.md, "Cost", "The gate of the
 * entity section"): manual, never run by `bun test`, because it measures wall-clock time. Before
 * any brain can fill a mind (mental operations arrive in T5-5a), it builds "dispersed 1,000", the
 * scenario of T4's benchmark (scale.ts), on the terrain of the public label `open-origin/t5/bench`,
 * as initial chunks given to createWorld, every being of beings@2 holding exactly the gate's mind,
 * and runs it under beings@2 with the mindless baseline, `utility@1` unchanged. Beside it, stepped
 * in turn, the same beings run under beings@1 with `utility@1`: the baseline lives the same life,
 * so both worlds have the same wakes and decisions at every tick, which the benchmark checks.
 *
 *   bun packages/agents/bench/gate.ts [--ticks N]
 *
 * It prints, per tick of each world, the KB hashed and the time of the tick, median and p99, and
 * the cost of a wake that does not decide; then the gate's decision: below 1 MB hashed at p99 the
 * entity section stays in T7. It times one simulated day after the first decisions and 100 ticks
 * of warm-up, unless `--ticks N` says otherwise. On a shared machine, run it at low priority:
 * `nice -n 19 bun packages/agents/bench/gate.ts`.
 */
import { beings, createWorld, step, type World, worldgen } from "@open-origin/engine";
import { chunksOf, gateMind } from "../../engine/test/support/beings2-world.ts";
import { Sfc32 } from "../../engine/test/support/sfc32.ts";
import { utilityController } from "../src/index.ts";
import { mindlessUtility } from "../test/support/mindless.ts";
import { labelSeeds, terrainOf } from "../test/support/scenario.ts";
import { median, quantile } from "./beings.ts";
import { type Cell, DAY_TICKS, dispersedCells, SPS, Wakes } from "./scale.ts";

/** The label whose seeds give the gate's terrain, world, and draws. */
export const GATE_LABEL = "open-origin/t5/bench";

/** The beings of "dispersed 1,000", and the ticks of warm-up after their first decisions. */
const BEINGS = 1_000;
const WARM_UP = 100;

/** The gate's trigger: 1 MB hashed in a tick, at p99. */
export const TRIGGER_BYTES = 1024 * 1024;

/**
 * The terrain of the gate: its label's seeds, the prepared genesis, and its spawn area's center.
 */
export type GateScene = {
  readonly seeds: ReturnType<typeof labelSeeds>;
  readonly prepared: worldgen.PreparedGenesis;
  readonly center: Cell;
};

/**
 * The scene of `label`: the default genesis of its terrain seed, and the center chunk of the spawn
 * area the preregistration's rule finds on it (docs/architecture/beings.md, "Scenario").
 */
export function gateScene(label = GATE_LABEL): GateScene {
  const seeds = labelSeeds(label);
  const prepared = worldgen.prepareGenesis(worldgen.defaultGenesis(seeds.terrain));
  const center = terrainOf(label).area?.center;
  if (center === undefined) throw new Error(`${label} has no spawn area`);
  return { seeds, prepared, center };
}

/** What one being of the gate draws: its needs, then its six traits. */
export type GateDraw = {
  readonly needs: { readonly nutrition: number; readonly rest: number };
  readonly traits: beings.Traits2;
};

/**
 * The draws of `count` beings from the test generator seeded with `seed`, in the order of mind.md
 * ("Seeds and scenario"): for each being in turn, nutrition and rest in [600,000, 900,000], then
 * appetite, sleepiness, curiosity, sociability, credulity, and retention within the species'
 * trait bounds. The cells come from the benchmark's placement rule instead of a draw.
 */
export function gateDraws(count: number, seed: number): GateDraw[] {
  const random = new Sfc32(seed);
  const { min, max } = (beings.defaultLife2().species[0] as beings.Species2).traits;
  return Array.from({ length: count }, () => {
    const needs = {
      nutrition: random.between(600_000, 900_000),
      rest: random.between(600_000, 900_000),
    };
    const [appetite, sleepiness, curiosity, sociability, credulity, retention] = Array.from(
      { length: 6 },
      () => random.between(min, max),
    ) as [number, number, number, number, number, number];
    return {
      needs,
      traits: { appetite, sleepiness, curiosity, sociability, credulity, retention },
    };
  });
}

/** A being of beings@1 at tick 0 on `cell`, as a spawn at tick 0 would make it. */
function being1(id: number, cell: Cell, draw: GateDraw): beings.Being {
  const { appetite, sleepiness, curiosity } = draw.traits;
  return {
    id,
    species: "s1",
    stage: "adult",
    born: 0,
    cell: [cell[0], cell[1]],
    needs: { ...draw.needs },
    health: beings.NEED_MAX,
    anchor: 0,
    traits: { appetite, sleepiness, curiosity },
    condition: "ok",
    activity: { kind: "idle", start: 0, ms: 1 },
    plan: [],
    behavior: { kind: "none", since: 0, heading: 0 },
    wakeWhen: {},
    wake: 1,
    outcome: { result: "none", tick: 0, reason: "" },
    cooldowns: [],
  };
}

/**
 * The beings of the gate on `cells`, ids 1 to n, under each version: the same bodies, and under
 * beings@2 the six traits and, for each being, its own copy of the gate's mind.
 */
export function gateBeings(cells: readonly Cell[], draws: readonly GateDraw[]) {
  const one = cells.map((cell, n) => being1(n + 1, cell, draws[n] as GateDraw));
  const two = one.map(
    (being, n): beings.Being2 => ({
      ...being,
      traits: { ...(draws[n] as GateDraw).traits },
      mind: gateMind(),
    }),
  );
  return { one, two };
}

/** A brain's decisions, counted. */
type Counter = { decisions: number };

/** A world of the gate and the count of its brain's decisions. */
export type GateWorld = {
  readonly world: World<beings.BeingsGlobal, beings.BeingsChunk>;
  readonly counter: Counter;
};

/**
 * A world at tick 0 of `placed`, under beings@2 with the baseline when `two` is set, and under
 * beings@1 with `utility@1` otherwise; audit off, as the benchmark of T4 runs.
 */
export function gateWorld(
  scene: GateScene,
  placed: readonly beings.Being[],
  two: boolean,
): GateWorld {
  const counter: Counter = { decisions: 0 };
  const count =
    <S, R>(decide: (senses: S) => R) =>
    (senses: S) => {
      counter.decisions += 1;
      return decide(senses);
    };
  const baseline = mindlessUtility();
  const utility = utilityController();
  const ruleset = two
    ? beings.createBeingsRuleset({
        controllers: { s1: { ...baseline, decide: count(baseline.decide) } },
        rules: "beings@2",
      })
    : beings.createBeingsRuleset({
        controllers: { s1: { ...utility, decide: count(utility.decide) } },
      });
  const chunks = chunksOf(placed);
  const life = two ? beings.defaultLife2() : beings.defaultLife();
  const global = beings.beingsGlobal(worldgen.genesisOf(scene.prepared), life);
  const world = createWorld(
    {
      seed: scene.seeds.world,
      simSecondsPerTick: SPS,
      global: { ...global, occupancy: Object.keys(chunks).sort() },
      chunks,
      ruleset,
    },
    { audit: false },
  );
  return { world, counter };
}

/** What one timed tick of a world did. */
export type GateSample = {
  readonly ns: number;
  readonly hashed: number;
  readonly wakes: number;
  readonly decisions: number;
};

/** Steps `bench` once, timed, with the beings due at the tick counted outside the timing. */
function timedTick(bench: GateWorld, wakes: Wakes, tick: number): GateSample {
  const due = wakes.due(tick);
  const decided = bench.counter.decisions;
  const start = Bun.nanoseconds();
  const result = step(bench.world, []);
  const ns = Bun.nanoseconds() - start;
  wakes.update(result.changedChunks);
  return {
    ns,
    hashed: result.stats.hashedBytes,
    wakes: due,
    decisions: bench.counter.decisions - decided,
  };
}

/**
 * The first decisions of both worlds, the warm-up, and `measured` timed ticks of each, the worlds
 * stepped in turn so that both run on the machine as it is at each moment.
 */
export function runGate(
  benches: readonly [GateWorld, GateWorld],
  measured: number,
  warmUp = WARM_UP,
) {
  const firstMs = benches.map(({ world }) => {
    const start = Bun.nanoseconds();
    step(world, []);
    return (Bun.nanoseconds() - start) / 1e6;
  });
  for (let tick = 2; tick <= 1 + warmUp; tick += 1)
    for (const { world } of benches) step(world, []);
  const wakes = benches.map(({ world }) => new Wakes(world));
  const samples: [GateSample[], GateSample[]] = [[], []];
  for (let round = 0; round < measured; round += 1) {
    const tick = 2 + warmUp + round;
    benches.forEach((bench, index) => {
      samples[index as 0 | 1].push(timedTick(bench, wakes[index] as Wakes, tick));
    });
  }
  return { firstMs, samples };
}

/**
 * The cost of a wake that does not decide, per tick: over the ticks with wakes and no decision,
 * the tick's time less that of a tick without a wake (the median of those, or the fastest tick
 * when every tick has one), divided by its wakes; their median, and how many ticks it read.
 */
export function quietWakeNs(samples: readonly GateSample[]): {
  readonly ns: number;
  readonly ticks: number;
} {
  const idle = samples.filter((sample) => sample.wakes === 0).map((sample) => sample.ns);
  const base = idle.length > 0 ? median(idle) : Math.min(...samples.map((sample) => sample.ns));
  const quiet = samples.filter((sample) => sample.wakes > 0 && sample.decisions === 0);
  return {
    ns: median(quiet.map((sample) => (sample.ns - base) / sample.wakes)),
    ticks: quiet.length,
  };
}

/**
 * The paired cost that beings@2 adds to a wake that does not decide: over the ticks where both
 * worlds woke the same beings and none decided, the median of the difference of their times,
 * divided by the wakes.
 */
export function pairedQuietNs(one: readonly GateSample[], two: readonly GateSample[]): number {
  const differences = one.flatMap((sample, tick) => {
    const other = two[tick];
    if (other === undefined || sample.wakes === 0 || sample.decisions > 0) return [];
    return [(other.ns - sample.ns) / sample.wakes];
  });
  return median(differences);
}

/** The ticks at which the two worlds woke or decided differently: none, when they live one life. */
export function divergentTicks(one: readonly GateSample[], two: readonly GateSample[]): number[] {
  return one.flatMap((sample, tick) => {
    const other = two[tick];
    const same =
      other !== undefined && other.wakes === sample.wakes && other.decisions === sample.decisions;
    return same ? [] : [tick];
  });
}

const ms = (ns: number) => (ns / 1e6).toFixed(2);
const kb = (bytes: number) => (bytes / 1024).toFixed(1);

/** The row of one world in the table of the gate. */
function row(name: string, samples: readonly GateSample[], firstMs: number): string {
  const times = samples.map((sample) => sample.ns);
  const hashed = samples.map((sample) => sample.hashed);
  const quiet = quietWakeNs(samples);
  return `| ${[
    name,
    `${kb(median(hashed))} / ${kb(quantile(hashed, 0.99))}`,
    `${ms(median(times))} / ${ms(quantile(times, 0.99))}`,
    ms(Math.max(...times)),
    `${(quiet.ns / 1e3).toFixed(1)} (${quiet.ticks} ticks)`,
    firstMs.toFixed(0),
  ].join(" | ")} |`;
}

/** The value of `--ticks`, or one simulated day; throws on anything else. */
export function gateTicks(argv: readonly string[]): number {
  if (argv.length === 0) return DAY_TICKS;
  const [flag, text] = argv;
  const value = Number(text);
  if (argv.length !== 2 || flag !== "--ticks" || !/^[0-9]+$/.test(text ?? "") || value < 1)
    throw new Error("usage: gate.ts [--ticks N], N a positive integer");
  return value;
}

/** Builds the two worlds of the gate, runs them, and prints the table and the decision. */
function main(measured: number): void {
  const scene = gateScene();
  const cells = dispersedCells(BEINGS, scene.center, scene.prepared);
  const placed = gateBeings(cells, gateDraws(cells.length, scene.seeds.spawn));
  const benches: [GateWorld, GateWorld] = [
    gateWorld(scene, placed.one, false),
    gateWorld(scene, placed.two, true),
  ];
  Bun.gc(true);
  console.log(
    `Bun ${Bun.version}; terrain of ${GATE_LABEL}, center ${scene.center}; ${cells.length} dispersed beings; ${measured} ticks timed after ${WARM_UP} of warm-up`,
  );
  const { firstMs, samples } = runGate(benches, measured);
  const [one, two] = samples;
  console.log(
    "\n| World | KB hashed per tick, median / p99 | Tick ms, median / p99 | Slowest tick ms | µs per wake that does not decide | First decisions ms |",
  );
  console.log("|---|---|---|---|---|---|");
  console.log(row("beings@1, utility@1", one, firstMs[0] ?? 0));
  console.log(row("beings@2, the gate's mind, mindless(utility@1)", two, firstMs[1] ?? 0));
  const divergent = divergentTicks(one, two);
  const paired = pairedQuietNs(one, two);
  console.log(`\nTicks whose wakes or decisions differ between the worlds: ${divergent.length}`);
  console.log(
    `A wake that does not decide, beings@2 less beings@1, paired by tick: ${(paired / 1e3).toFixed(1)} µs`,
  );
  const p99 = quantile(
    two.map((sample) => sample.hashed),
    0.99,
  );
  const below = p99 < TRIGGER_BYTES;
  console.log(
    `\nThe gate: p99 hashed under beings@2 is ${kb(p99)} KB, ${below ? "below" : "at or above"} 1 MB (${kb(TRIGGER_BYTES)} KB): ${below ? "the entity section stays in T7" : "stop: the capacities come down first, by the maintainer's decision"}.`,
  );
}

if (import.meta.main) {
  let measured: number;
  try {
    measured = gateTicks(process.argv.slice(2));
  } catch (error) {
    console.error(`gate: ${(error as Error).message}`);
    process.exit(2);
  }
  main(measured);
}
