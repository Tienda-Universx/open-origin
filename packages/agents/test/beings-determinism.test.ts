/**
 * Determinism and observer independence of a world of beings under `utility@1` (plan §9.2, tests
 * 7, 9, and 10; §11, criteria 3 and 4).
 *
 * The subject: five beings around the small patch of food of the patch world, whose day lasts 100
 * ticks, spawned at tick 1 in the dark with needs near the levels where the brain changes its
 * mind: two hungry beings on one cell with food for one bite, who contest it; a hungry one north
 * of a chunk edge, who crosses it to forage; one starving and tired, who sleeps until hunger wakes
 * it; and a sated, rested one, who rests until dawn and then wanders. Over 120 ticks they eat,
 * contest, walk across chunks, sleep and wake, react to dawn and dusk, and the day turns.
 *
 * The determinism suite runs it with audit, cuts at 0, 1, the first chunk crossing, the first
 * contest, the first sleep that ends, and T − 1, and child processes at 0, the middle, and T − 1;
 * its interleaving shares one ruleset object, and so one brain, among three worlds.
 *
 * Observers read, before every tick, every being, its needs in closed form, the senses of one of
 * them, and the terrain and light: the records and the final snapshot equal the suite's reference
 * run, which had none. Two coupled hosts, which turn what their observer looked at into commands
 * that materialize those chunks or add them to the occupancy index, change the records at once.
 *
 * The cuts fall at ticks 7 (contest), 33 (crossing), and 51 (wake). Time (Bun 1.4.4, 2026-10-27;
 * indicative): about 3.4 s on the Codespace, with four child processes beside it.
 */
import { describe, expect, test } from "bun:test";
import {
  beings,
  type ChunkKey,
  type Command,
  type CommandHandler,
  encodeSnapshot,
  type Seed,
  type StepResult,
  step,
  type World,
  worldgen,
} from "@open-origin/engine";
import {
  firstDivergence,
  type TickRecord,
  tickRecord,
} from "../../engine/test/support/determinism-records.ts";
import {
  type DeterminismReport,
  runDeterminismSuite,
} from "../../engine/test/support/determinism-suite.ts";
import {
  beingsIn,
  chunkIn,
  chunkOf,
  globalOf,
  PATCH_PREPARED,
  PATCH_SPS,
  patchWorld,
  type Spawn,
  spawnsAt,
} from "./support/patch-world.ts";
import { UTILITY_RULESET, utilityRuleset } from "./support/utility-ruleset.ts";

const TICKS = 120;
const SEEDS: readonly [Seed, Seed] = [
  [7, 7],
  [8, 9],
];
const BUDGET_MS = 60_000;

/** The five beings of the subject, spawned at tick 1. */
const SUBJECT: readonly Spawn[] = [
  // Hungry on a cell of 38 units, less than two bites of 25: they contest the first bite.
  { cell: [-52, -67], nutrition: 560_000, rest: 960_000 },
  { cell: [-52, -67], nutrition: 570_000, rest: 960_000 },
  // Hungry in chunk (−2, −2), north of the patch in chunk (−2, −3).
  { cell: [-49, -58], nutrition: 590_000, rest: 960_000 },
  // Starving and tired in the dark: sleep outweighs some food, and hunger at 250,000 wakes it.
  { cell: [-56, -62], nutrition: 252_000, rest: 400_000 },
  // Sated and rested: rests in the dark, wanders by day.
  { cell: [-46, -70], nutrition: 900_000, rest: 960_000 },
];

const SCRIPT: readonly (readonly Command[])[] = Array.from({ length: TICKS }, (_, index) =>
  index === 0 ? spawnsAt(1, SUBJECT) : [],
);

/** The ticks at which something first happened in the subject's run. */
type Landmarks = { readonly crossing: number; readonly contest: number; readonly wake: number };

/** An observer: it looks at the world before `tick`, and returns the chunks its senses covered. */
type Observer = (world: World, tick: number) => readonly ChunkKey[];

/** What a run gave: the record of every tick, the final snapshot text, and its landmarks. */
type Observed = {
  readonly records: readonly TickRecord[];
  readonly finalText: string;
  readonly landmarks: Landmarks;
  /** The chunks its observers looked at, and the world at the end. */
  readonly looked: ReadonlySet<ChunkKey>;
  readonly world: World;
};

const SPECIES = beings.defaultLife().species[0] as beings.Species;

/** The chunk keys a window from `origin` of `side` cells covers. */
function windowChunks(origin: readonly [number, number], side: number): ChunkKey[] {
  const keys: ChunkKey[] = [];
  const [x0, y0] = [worldgen.chunkOfCell(origin[0]), worldgen.chunkOfCell(origin[1])];
  const [x1, y1] = [
    worldgen.chunkOfCell(origin[0] + side - 1),
    worldgen.chunkOfCell(origin[1] + side - 1),
  ];
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) keys.push(`${x},${y}`);
  return keys;
}

/**
 * An observer that reads every being and its needs and health in closed form, the senses of the
 * being `offset` places after the tick's turn, the terrain of its chunk, and the light. Each read
 * is checked against what it must be, so that none is skipped.
 */
function looking(offset: number): Observer {
  return (world, tick) => {
    const now = tick - 1;
    const all = beingsIn(world);
    for (const being of all) {
      const body = beings.bodyAt(SPECIES, being, now, PATCH_SPS);
      expect(body.health).toBeGreaterThan(0);
    }
    const being = all[(tick + offset) % Math.max(all.length, 1)];
    if (being === undefined) return [];
    const view = { readChunk: (key: ChunkKey) => chunkIn(world, key) };
    const window = beings.senseWindow({
      prepared: PATCH_PREPARED,
      species: SPECIES,
      center: [being.cell[0], being.cell[1]],
      view,
      nowSeconds: now * PATCH_SPS,
      simSecondsPerTick: PATCH_SPS,
    });
    expect(window.side).toBe(2 * SPECIES.senses.radius + 1);
    const [cx, cy] = chunkOf(being.cell).split(",").map(Number) as [number, number];
    const chunk = { x: cx * 32, y: cy * 32, width: 32, height: 32 };
    expect(worldgen.sampleSurface(PATCH_PREPARED, chunk, 0).elevation).toHaveLength(1024);
    expect(
      worldgen.radiance(PATCH_PREPARED, { tick: now, simSecondsPerTick: PATCH_SPS }),
    ).toBeGreaterThanOrEqual(0);
    return windowChunks(window.origin, window.side);
  };
}

/** How a host couples what its observer looked at to the world: not at all, or by a command. */
type Coupling = "none" | "materialize" | "occupy";

/** The command of a coupled host: the chunks its observer looked at before the tick. */
const LOOKED = "host.looked";

/**
 * The beings ruleset with `utility@1`, plus the command of a coupled host: it materializes each
 * chunk the host's observer looked at, and with "occupy" also adds it to the occupancy index. A
 * defect on purpose, of the kind observer independence forbids (AGENTS.md, rule 4).
 */
function coupledRuleset(coupling: "materialize" | "occupy") {
  const ruleset = utilityRuleset();
  const looked: CommandHandler<beings.BeingsGlobal, beings.BeingsChunk> = {
    check: (_view, command) =>
      command.origin.kind === "admin" ? undefined : { reason: "admin_only" },
    apply: (ctx, command) => {
      for (const key of (command.payload as { keys: string[] }).keys) {
        if (ctx.readChunk(key) === undefined)
          ctx.createChunk(key, { beings: [], depletion: [], due: beings.MAX_TICK });
        if (coupling === "occupy" && !ctx.readGlobal().occupancy.includes(key))
          beings.insertOccupied(ctx.writeGlobal().occupancy, key);
      }
      return undefined;
    },
  };
  return { ...ruleset, commands: { ...ruleset.commands, [LOOKED]: looked } };
}

/** The command a coupled host sends at `tick`, after `after` scripted ones: what it looked at. */
function hostCommands(
  coupling: Coupling,
  tick: number,
  after: number,
  looked: ChunkKey[],
): Command[] {
  if (coupling === "none" || looked.length === 0) return [];
  const origin = { kind: "admin" } as const;
  return [{ applyTick: tick, seq: after, type: LOOKED, origin, payload: { keys: looked } }];
}

/** A tracker of the landmarks of a run: the first contest, wake, and chunk crossing. */
function landmarkTracker() {
  const found = { crossing: 0, contest: 0, wake: 0 };
  const chunks = new Map<number, string>();
  const firstAt = (name: keyof Landmarks, tick: number) => {
    if (found[name] === 0) found[name] = tick;
  };
  const track = (result: StepResult, world: World) => {
    for (const event of result.events) {
      const { activity } = event.payload as { activity?: string };
      if (event.type === "being.contested") firstAt("contest", result.tick);
      if (event.type === "being.finished" && activity === "sleep") firstAt("wake", result.tick);
    }
    for (const being of beingsIn(world)) {
      const key = chunkOf(being.cell);
      const before = chunks.get(being.id);
      if (before !== undefined && before !== key) firstAt("crossing", result.tick);
      chunks.set(being.id, key);
    }
  };
  return { found, track };
}

/**
 * Runs the subject's world for `ticks` ticks under `observers`, which look at it before every
 * tick; a coupled host also sends what they looked at as a command of that tick. Returns the
 * records, the final snapshot, the ticks of the first chunk crossing, contest, and wake, what the
 * observers looked at, and the world.
 */
function runObserved(
  observers: readonly Observer[],
  ticks: number,
  coupling: Coupling = "none",
): Observed {
  const ruleset = coupling === "none" ? utilityRuleset() : coupledRuleset(coupling);
  const world = patchWorld(SEEDS[0], ruleset, false);
  const records: TickRecord[] = [];
  const landmarks = landmarkTracker();
  const seen = new Set<ChunkKey>();
  for (let tick = 1; tick <= ticks; tick += 1) {
    const looked = [...new Set(observers.flatMap((observer) => observer(world, tick)))].sort();
    for (const key of looked) seen.add(key);
    const scripted = SCRIPT[tick - 1] ?? [];
    const result = step(world, [
      ...scripted,
      ...hostCommands(coupling, tick, scripted.length, looked),
    ]);
    records.push(tickRecord(result));
    landmarks.track(result, world);
  }
  const finalText = encodeSnapshot(world);
  return { records, finalText, landmarks: landmarks.found, looked: seen, world };
}

/** The two observers of the observed run. */
const OBSERVERS: readonly Observer[] = [looking(0), looking(2)];

let observedRun: Observed | undefined;
/** The subject's run under OBSERVERS, computed once: its landmarks are the suite's cuts. */
const observed = () => {
  observedRun ??= runObserved(OBSERVERS, TICKS);
  return observedRun;
};

let suiteRun: Promise<DeterminismReport> | undefined;
/** The suite's report on the subject, with cuts at the landmarks, computed once. */
function suiteReport(): Promise<DeterminismReport> {
  const { crossing, contest, wake } = observed().landmarks;
  suiteRun ??= runDeterminismSuite({
    ruleset: UTILITY_RULESET,
    world: patchWorld,
    seeds: SEEDS,
    ticks: TICKS,
    commands: (tick) => SCRIPT[tick - 1] ?? [],
    cuts: [0, 1, contest, crossing, wake, TICKS - 1],
    childCuts: [0, TICKS / 2, TICKS - 1],
  });
  return suiteRun;
}

describe("the determinism suite on a world of beings (plan §9.2, tests 7 and 9)", () => {
  test(
    "passes every check, with cuts at 0, 1, the first contest, crossing, and wake, and T − 1",
    async () => {
      const { landmarks } = observed();
      // The landmarks the cuts need all happen, in this order, before the last tick.
      expect(landmarks.contest).toBeGreaterThan(1);
      expect(landmarks.crossing).toBeGreaterThan(landmarks.contest);
      expect(landmarks.wake).toBeGreaterThan(landmarks.crossing);
      expect(landmarks.wake).toBeLessThan(TICKS - 1);
      const report = await suiteReport();
      expect(report.failures).toEqual([]);
      const { crossing, contest, wake } = landmarks;
      expect(report.resumed).toEqual([0, 1, contest, crossing, wake, TICKS - 1]);
      expect(report.childResumed).toEqual([0, TICKS / 2, TICKS - 1]);
      // Not vacuous: the beings decided, walked, ate, slept, and woke.
      const events = report.reference.flatMap((record) =>
        "events" in record ? [record.events] : [],
      );
      for (const type of ["being.started", "being.ate", "being.contested", "being.finished"])
        expect(events.some((text) => text.includes(type))).toBe(true);
    },
    BUDGET_MS,
  );
});

describe("observer independence of a world of beings (plan §9.2, test 10)", () => {
  test(
    "observers that read beings, needs, senses, terrain, and light leave every record unchanged",
    async () => {
      const report = await suiteReport();
      const run = observed();
      expect(firstDivergence(report.reference, run.records)).toBeUndefined();
      expect(report.finalText).toBeDefined();
      expect(run.finalText).toBe(report.finalText ?? "");
    },
    BUDGET_MS,
  );

  test.each(["materialize", "occupy"] as const)(
    "a host that turns what its observer looked at into commands that %s changes the records at once",
    async (coupling) => {
      const report = await suiteReport();
      const ticks = 10;
      const run = runObserved(OBSERVERS, ticks, coupling);
      // Before tick 2 the observers see the beings spawned at tick 1, and look at their windows.
      expect(firstDivergence(report.reference.slice(0, ticks), run.records)).toEqual({
        tick: 2,
        detail: "checksum, changedChunks, stats differ",
      });
      // Each did what it was built to do: every chunk looked at exists, and only the second host
      // lists chunks without beings in the occupancy index.
      const { occupancy } = globalOf(run.world);
      for (const key of run.looked) expect(chunkIn(run.world, key)).toBeDefined();
      const empty = occupancy.filter((key) => chunkIn(run.world, key)?.beings.length === 0);
      expect(empty.length > 0).toBe(coupling === "occupy");
    },
    BUDGET_MS,
  );
});
