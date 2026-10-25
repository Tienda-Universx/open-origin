import { type Command, step, type World, worldgen } from "../src/index.ts";
import { ChaCha20Key } from "../src/rng/chacha.ts";
import { GOLDEN_WORLDGEN, maximumGenesis } from "../test/fixtures/golden-worldgen.ts";
import { probeRuleset } from "../test/fixtures/probe-ruleset.ts";
import { median } from "../test/support/cost-worlds.ts";
import { probeWorld } from "../test/support/probe-world.ts";
import {
  type Data,
  type StepRuleset,
  stepRuleset,
  stepWorld,
  system,
} from "../test/support/step-rulesets.ts";
import { liveHeap } from "./measure.ts";

/**
 * Worldgen's benchmark (plan §11, §12 "Benchmarks", §16 criterion 8): manual, never run by
 * `bun test`, because it measures wall-clock time. Run it with
 * `bun packages/engine/bench/worldgen.ts`. It prints one table of indicative numbers, which
 * docs/architecture/worldgen.md records with the machine and Bun version they came from; compare
 * runs on one machine, before and after a change to worldgen, never across machines.
 *
 * Every time is the median of timed batches after a warm-up, divided by the calls in a batch, and
 * every heap figure is read after a full collection. The plan's targets: at most 2 ms
 * per chunk with the default genesis and 4 ms with the maximum one, at most 48 KB retained per
 * chunk of the maximum genesis, and a ratio of at most 2 after 10,000 generations.
 *
 * Slow windows. The two-core Codespace runs its two hardware threads on one physical core. While
 * other work ran on the second thread, another process or the runtime's own collector and
 * compiler, this thread ran up to 1.8 times slower, in windows from a quarter of a second to
 * several seconds (observed on 2026-10-25). So each measurement spans many batches, the variants a
 * row compares run in turn, and the benchmark belongs on an otherwise idle machine; compare
 * several runs, not one.
 */

type Row = readonly [string, string];

const {
  defaultGenesis,
  generateChunk,
  MAX_CHUNK,
  observe,
  prepareGenesis,
  sampleRegion,
  sealedGenesisIssues,
  sealOf,
} = worldgen;

/** How long each measurement warms up before its timed batches: enough for the JIT's top tier. */
const WARM_UP_NS = 500e6;

type Action = (call: number) => unknown;
type Batches = { readonly batch: number; readonly batches: number };

/**
 * The median cost of one call of each of `actions`, in nanoseconds. After a full collection, so
 * that garbage of earlier rows is not collected during these, the actions run batches of `batch`
 * calls in turn for WARM_UP_NS, then `batches` timed batches each, still in turn, so that a drift
 * of the machine or the JIT affects all of them alike; each median batch is divided by `batch`.
 */
function perCallEach(actions: readonly Action[], { batch, batches }: Batches): number[] {
  const timedBatch = (action: Action) => {
    const start = Bun.nanoseconds();
    for (let call = 0; call < batch; call += 1) action(call);
    return Bun.nanoseconds() - start;
  };
  Bun.gc(true);
  for (const end = Bun.nanoseconds() + WARM_UP_NS; Bun.nanoseconds() < end; ) {
    for (const action of actions) timedBatch(action);
  }
  const times = actions.map((): number[] => []);
  for (let run = 0; run < batches; run += 1) {
    for (const [index, action] of actions.entries()) times[index]?.push(timedBatch(action));
  }
  return times.map((list) => median(list) / batch);
}

/** The median cost of one call of `action`, in nanoseconds, as perCallEach measures it. */
function perCall(action: Action, options: Batches): number {
  return perCallEach([action], options)[0] ?? Number.NaN;
}

const micro = (nanoseconds: number) => `${(nanoseconds / 1e3).toFixed(1)} µs`;
const milli = (nanoseconds: number) => `${(nanoseconds / 1e6).toFixed(3)} ms`;
const perSecond = (nanoseconds: number, unit: string) =>
  `${Math.round(1e9 / nanoseconds).toLocaleString("en")} ${unit}/s`;

/** A terrain seed of the goldens: the mixed pattern. */
const SEED = GOLDEN_WORLDGEN.seeds[1] as readonly number[];
const DEFAULT_GENESIS = defaultGenesis(SEED);
const MAXIMUM_GENESIS = maximumGenesis(SEED);
const DEFAULT = prepareGenesis(DEFAULT_GENESIS);

/** The two geneses every terrain row measures: its name, its genesis, and the prepared one. */
const GENESES = [
  { name: "default", genesis: DEFAULT_GENESIS, prepared: DEFAULT },
  { name: "maximum", genesis: MAXIMUM_GENESIS, prepared: prepareGenesis(MAXIMUM_GENESIS) },
] as const;

/** A chunk's cost and rate, at the origin and at the middle of the top edge, per genesis. */
function chunkRows(): Row[] {
  const keys = [
    ["origin", "0,0"],
    ["top edge", `0,${MAX_CHUNK}`],
  ] as const;
  return GENESES.flatMap(({ name, prepared }) => {
    const actions = keys.map(
      ([, key]) =>
        () =>
          generateChunk(prepared, key),
    );
    const times = perCallEach(actions, { batch: 5, batches: 100 });
    return keys.map(([where], index): Row => {
      const time = times[index] ?? Number.NaN;
      return [`32×32 chunk, ${name}, ${where}`, `${milli(time)}, ${perSecond(time, "chunks")}`];
    });
  });
}

/** A 1×1 and a 9×9 region near the origin, per genesis. */
function regionRows(): Row[] {
  const rects = [
    ["1×1", { x: 5, y: -7, width: 1, height: 1 }],
    ["9×9", { x: -4, y: -4, width: 9, height: 9 }],
  ] as const;
  return GENESES.flatMap(({ name, prepared }) => {
    const actions = rects.map(
      ([, rect]) =>
        () =>
          sampleRegion(prepared, rect),
    );
    const times = perCallEach(actions, { batch: 50, batches: 40 });
    return rects.map(
      ([size], index): Row => [`${size} region, ${name}`, micro(times[index] ?? Number.NaN)],
    );
  });
}

/** ChaCha20 blocks, one per counter, under one key, as worldgen draws its lattice. */
function chachaRow(): Row {
  const key = new ChaCha20Key(SEED);
  const input = new Uint32Array(4);
  const output = new Uint32Array(16);
  const time = perCall(
    (call) => {
      input[0] = call;
      key.blockInto(input, output);
    },
    { batch: 100_000, batches: 12 },
  );
  return ["ChaCha20 blocks (ChaCha20Key.blockInto)", perSecond(time, "blocks")];
}

/** What each generated chunk keeps alive, holding 1,000 distinct chunks, per genesis. */
function memoryRows(): Row[] {
  return GENESES.map(({ name, prepared }): Row => {
    const before = liveHeap();
    const held = Array.from({ length: 1_000 }, (_, x) => generateChunk(prepared, `${x},7`));
    const bytes = (liveHeap() - before) / held.length;
    // Reading `held` after the second measurement keeps every chunk alive until then.
    const label = `retained heap per chunk, ${name}, ${held.length.toLocaleString("en")} held`;
    return [label, `${(bytes / 1024).toFixed(1)} KB`];
  });
}

/**
 * One default chunk before and after 10,000 generations of other chunks: a cost that grows with
 * the chunks generated before, as state kept across calls would make it, shows as a ratio above 1.
 * It runs first, so that "before" follows no other generation but the warm-up of this chunk.
 */
function historyRows(): Row[] {
  const chunk = () => generateChunk(DEFAULT, "-7,9");
  // The two measurements cannot run in turn, so each spans about 0.5 s: one slow window of the
  // machine (see the note at the top) then cannot decide its median.
  const options = { batch: 10, batches: 100 };
  const before = perCall(chunk, options);
  for (let index = 0; index < 10_000; index += 1) {
    generateChunk(DEFAULT, `${index % 100},${1_000 + Math.floor(index / 100)}`);
  }
  const after = perCall(chunk, options);
  return [
    ["one default chunk, after 0 other generations", milli(before)],
    [
      "the same chunk, after 10,000 other generations",
      `${milli(after)}, ratio ${(after / before).toFixed(2)}`,
    ],
  ];
}

/** observe for a static id, which samples a 1×1 region, and for radiance, which samples none. */
function observeRows(): Row[] {
  const instant = { tick: 1_000, simSecondsPerTick: 12 };
  const ids = [
    ["elevation", 50],
    ["radiance", 1_000],
  ] as const;
  return ids.map(([id, batch]): Row => {
    const query = (call: number) => ({ id, cell: { x: call, y: -3 }, instant });
    const time = perCall((call) => observe(DEFAULT, query(call)), { batch, batches: 40 });
    return [`observe, ${id}, default`, micro(time)];
  });
}

/** prepareGenesis, and sealedGenesisIssues of a sealed global value, per genesis, all in turn. */
function sealRows(): Row[] {
  const actions = GENESES.flatMap(({ name, genesis, prepared }): Action[] => {
    const global = { genesis, genesisSeal: sealOf(prepared) };
    if (sealedGenesisIssues(global).length > 0) throw new Error(`the ${name} global is not sealed`);
    return [() => prepareGenesis(genesis), () => sealedGenesisIssues(global)];
  });
  const times = perCallEach(actions, { batch: 50, batches: 40 });
  return GENESES.flatMap(({ name }, index): Row[] => [
    [`prepareGenesis, ${name}`, micro(times[2 * index] ?? Number.NaN)],
    [`sealedGenesisIssues, ${name}`, micro(times[2 * index + 1] ?? Number.NaN)],
  ]);
}

/** A world whose one system writes the global value every tick, validated by `validateGlobal`. */
function globalWriter(validateGlobal: StepRuleset["validateGlobal"]): World {
  const writer = system("writer", (ctx) => {
    (ctx.writeGlobal() as Data).writes = ctx.tick;
  });
  const global = { genesis: DEFAULT_GENESIS, genesisSeal: sealOf(DEFAULT), writes: 0 };
  return stepWorld({ ...stepRuleset([writer]), validateGlobal }, { global, chunks: {} });
}

/**
 * A tick that writes the global value, validated by sealedGenesisIssues and by a validator that
 * accepts everything: the difference is what checking the seal adds to such a tick.
 */
function tickRows(): Row[] {
  const sealed = globalWriter(sealedGenesisIssues);
  const unchecked = globalWriter(() => []);
  const [withSeal = Number.NaN, without = Number.NaN] = perCallEach(
    [() => step(sealed, []), () => step(unchecked, [])],
    { batch: 100, batches: 40 },
  );
  return [
    [
      "tick that writes the global, validated by sealedGenesisIssues",
      `${micro(withSeal)}, the seal adds ${micro(withSeal - without)}`,
    ],
    ["tick that writes the global, validator that accepts everything", micro(without)],
  ];
}

/** Steps `world` once per call from tick 1, with the commands that `commands` gives each tick. */
function ticking(world: World, commands: (tick: number) => Command[]): Action {
  let tick = 0;
  return () => {
    tick += 1;
    return step(world, commands(tick));
  };
}

/**
 * A tick of the probe ruleset (test/fixtures/probe-ruleset.ts) that materializes a new chunk, and
 * one with no command, in two probe worlds: the default genesis with a 600-second day. The
 * difference is what materializing costs inside a tick: preparing the genesis, generating the
 * chunk, and digesting its terrain.
 */
function probeRows(): Row[] {
  const materialize = (tick: number): Command[] => [
    {
      applyTick: tick,
      seq: 0,
      type: "probe.materialize",
      origin: { kind: "admin" },
      payload: { x: tick, y: 3 },
    },
  ];
  const [busy = Number.NaN, quiet = Number.NaN] = perCallEach(
    [
      ticking(probeWorld([11, 22], probeRuleset(), false), materialize),
      ticking(probeWorld([11, 22], probeRuleset(), false), () => []),
    ],
    { batch: 10, batches: 40 },
  );
  return [
    [
      "probe tick that materializes a chunk",
      `${milli(busy)}, materializing adds ${milli(busy - quiet)}`,
    ],
    ["probe tick with no command", micro(quiet)],
  ];
}

const history = historyRows();
const rows: Row[] = [
  ...chunkRows(),
  ...regionRows(),
  chachaRow(),
  ...memoryRows(),
  ...history,
  ...observeRows(),
  ...sealRows(),
  ...tickRows(),
  ...probeRows(),
];
console.log(`Bun ${Bun.version}, ${navigator.hardwareConcurrency} cores\n`);
console.log("| Measurement | Result |\n|---|---|");
for (const [name, value] of rows) console.log(`| ${name} | ${value} |`);
