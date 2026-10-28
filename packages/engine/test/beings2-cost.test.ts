/**
 * The cost of the tick of beings@2 (ADR 0024, docs/architecture/mind.md "Cost"), by count: the
 * calls of the beings system to its tick context stay within the bound of T4, since perception
 * reads no chunk beyond those the window reads, the contest for room reads the chunk an arrival
 * enters in the place of a contest over food, which an arrival never has at that tick, and a
 * delivery finds its hearer among the chunks the speaker's window read, writing only the hearer's;
 * and no mental work touches a being that is not due: its record and its mind stay the very values
 * the state held, and a mind is never copied at a wake.
 */
import { describe, expect, test } from "bun:test";
import {
  beings,
  type CanonicalValue,
  createWorld,
  type Ruleset,
  readView,
  step,
  type TickContext,
} from "../src/index.ts";
import {
  type Calls,
  counting,
  DISPERSED_CELLS,
  exploredChunks,
  windowChunks,
} from "./support/beings-cost.ts";
import { type BeingsWorld, behavior, chunkOf, spawn, testGenesis } from "./support/beings-world.ts";
import { type Cell, standable } from "./support/beings2-mind.ts";
import { being2, brain2, chunksOf, gateMind, life2With } from "./support/beings2-world.ts";

/** A window a brain sensed: the cell it starts at and its side. */
type Window = { origin: [number, number]; side: number };

/**
 * A brain of beings@2 that walks one to six steps along the heading of its first draw, as far as
 * the window lets it, then eats to full and idles a minute: T4's roamer, which decides often,
 * crosses chunks, and eats.
 */
const roamer = brain2((senses) => {
  const [first = 0, second = 0] = senses.draws;
  const heading = first % 8;
  const { side, edgeMs } = senses.window;
  const [dx, dy] = beings.DIRECTIONS[heading] as readonly [number, number];
  let [x, y] = [(side - 1) / 2, (side - 1) / 2];
  let dirs = "";
  while (dirs.length < 1 + (second % 6) && (edgeMs[(y * side + x) * 8 + heading] ?? -1) >= 0) {
    dirs += `${heading}`;
    x += dx;
    y += dy;
  }
  const meal = [
    { kind: "eat", untilNutrition: beings.NEED_MAX },
    { kind: "idle", ms: 60_000 },
  ] as const;
  return {
    steps: dirs === "" ? meal : [{ kind: "walk", dirs }, ...meal],
    wakeWhen: {},
    behavior: behavior("roam", heading),
  };
}, "roamer@2");

/**
 * A brain of beings@2 that greets, half the time, the nearest being it perceives within reach and
 * awake, and roams otherwise: beings that meet talk, and deliveries reach beings not due.
 */
const talker = brain2((senses) => {
  const [first = 0] = senses.draws;
  const [x = 0, y = 0] = senses.self.cell;
  const near = senses.perceived.beings.find(
    ({ cell: [bx = 0, by = 0], activity }) =>
      Math.max(Math.abs(bx - x), Math.abs(by - y)) <= 3 && activity !== "sleep",
  );
  if (near === undefined || first % 2 === 1) return roamer.decide(senses);
  return {
    steps: [{ kind: "talk", to: near.id, act: "greet" }],
    wakeWhen: {},
    behavior: behavior("roam"),
  };
}, "talker@2");

/**
 * A speaker's cell on the west edge of a chunk, beside the border, and two hearers' within its
 * reach: SAME in its chunk, and ACROSS, two cells west, in the chunk beyond the border.
 */
const [SPEAKER, SAME, ACROSS] = ((): [Cell, Cell, Cell] => {
  for (let y = -40; y < 40; y += 1) {
    const cells: [Cell, Cell, Cell] = [
      [64, y],
      [65, y],
      [62, y],
    ];
    if (cells.every(standable)) return cells;
  }
  throw new Error("no standable cells beside the border at x 64");
})();

/** Each cell of DISPERSED_CELLS, and one two cells east of it: ten pairs in sight of each other. */
const PAIRED_CELLS = DISPERSED_CELLS.flatMap(([x, y]) => [[x, y] as const, [x + 2, y] as const]);

/** `inner`, which records in `sink` the window of every decision it makes, unchanged. */
function recorded(inner: beings.Controller2, sink: Window[]): beings.Controller2 {
  return {
    ...inner,
    decide: (senses) => {
      const [x = 0, y = 0] = senses.window.origin;
      sink.push({ origin: [x, y], side: senses.window.side });
      return inner.decide(senses);
    },
  };
}

/** One counted tick: the calls of the system, and the world around it. */
type CountedTick = {
  readonly tick: number;
  readonly calls: Calls;
  readonly occupied: readonly string[];
  readonly listed: readonly string[];
  readonly after: readonly string[];
  readonly wakes: number;
  readonly windows: readonly Window[];
  readonly dayTurns: boolean;
  /** The acts delivered at the tick. */
  readonly delivered: number;
};

const SPS = 12;
const DAY = testGenesis().laws.day.length;

/** The occupied chunks before the next tick of `world`, and the beings due at it. */
function before(world: BeingsWorld) {
  const view = readView(world);
  const occupied = view.readGlobal().occupancy;
  const wakes = occupied
    .flatMap((key) => view.readChunk(key)?.beings ?? [])
    .filter((being) => being.wake <= view.tick + 1).length;
  return { occupied: [...occupied], wakes };
}

/** The chunks of every being of `world`. */
function beingChunks(world: BeingsWorld): string[] {
  const view = readView(world);
  return view
    .readGlobal()
    .occupancy.flatMap((key) => view.readChunk(key)?.beings ?? [])
    .map(({ cell: [x = 0, y = 0] }) => chunkOf([x, y]));
}

/**
 * `ticks` ticks of beings of beings@2 deciding with `brain`, ten roamers by default, hungry and
 * rested, spawned at tick 1 on `cells` among 4,096 empty chunks of the test genesis, every tick
 * from 2 on counted.
 */
function countedRun(
  ticks: number,
  brain: beings.Controller2 = roamer,
  cells: readonly (readonly [number, number])[] = DISPERSED_CELLS,
): CountedTick[] {
  const sink: Calls[] = [];
  const windows: Window[] = [];
  const ruleset = beings.createBeingsRuleset({
    controllers: { s1: recorded(brain, windows) },
    rules: "beings@2",
  });
  const world = createWorld(
    {
      seed: [8, 9],
      simSecondsPerTick: SPS,
      global: beings.beingsGlobal(testGenesis(), beings.defaultLife2()),
      chunks: exploredChunks(4_096),
      ruleset: counting(ruleset, sink),
    },
    { audit: false },
  );
  const needs = { nutrition: 300_000, rest: beings.NEED_MAX };
  step(
    world,
    cells.map((cell, seq) => spawn(1, { species: "s1", cell: [...cell], needs }, seq)),
  );
  const counted: CountedTick[] = [];
  for (let tick = 2; tick <= ticks; tick += 1) {
    const { occupied, wakes } = before(world);
    const [calls, decided] = [sink.length, windows.length];
    const { events } = step(world, []);
    counted.push({
      tick,
      calls: sink[calls] as Calls,
      occupied,
      listed: readView(world).readGlobal().occupancy,
      after: beingChunks(world),
      wakes,
      windows: windows.slice(decided),
      dayTurns: Math.floor((tick * SPS) / DAY) > Math.floor(((tick - 1) * SPS) / DAY),
      delivered: events.filter(({ type }) => type === "speech.delivered").length,
    });
  }
  return counted;
}

/**
 * The most chunks a tick of beings@2 may read: T4's bound (beings-cost.test.ts), each listed chunk,
 * each chunk a decision senses, five per wake, and the prune's reads. Perception adds nothing: it
 * reads the chunks the window read. A being that arrives in another chunk reads it once more, for
 * the contest for room, but has no claim on food at that tick, whose contest is one of the five: a
 * claim needs a meal under way, and a meal started at a tick bites from the next.
 */
function readBound(tick: CountedTick): number {
  const sensed = tick.windows.reduce((sum, w) => sum + windowChunks(w.origin, w.side).length, 0);
  const prune = tick.dayTurns ? tick.occupied.length + tick.wakes : 0;
  return tick.occupied.length + sensed + 5 * tick.wakes + prune;
}

/** Every problem of the calls of `tick`, as beings-cost.test.ts checks those of beings@1. */
function callIssues(tick: CountedTick): string[] {
  const { calls } = tick;
  const issues: string[] = [];
  if (calls.chunkKeys > 0) issues.push(`tick ${tick.tick}: calls of chunkKeys: ${calls.chunkKeys}`);
  const grown = tick.listed.some((key) => !tick.occupied.includes(key));
  const writes = tick.dayTurns || grown ? 1 : 0;
  if (calls.writeGlobal > writes)
    issues.push(
      `tick ${tick.tick}: writes of the global value: ${calls.writeGlobal}, at most ${writes}`,
    );
  if (calls.readChunk > readBound(tick))
    issues.push(`tick ${tick.tick}: chunk reads: ${calls.readChunk}, at most ${readBound(tick)}`);
  const reasons = new Set([
    ...tick.occupied,
    ...tick.after,
    ...tick.windows.flatMap((w) => windowChunks(w.origin, w.side)),
  ]);
  const stray = [...new Set(calls.keys.filter((key) => !reasons.has(key)))];
  if (stray.length > 0)
    issues.push(`tick ${tick.tick}: read ${stray.join(" ")}, neither listed, sensed, nor occupied`);
  return issues;
}

describe("the calls of the beings system of beings@2, counted", () => {
  test("each tick reads only the chunks listed, sensed, or occupied, within the bound", () => {
    const counted = countedRun(250);
    expect(counted.flatMap(callIssues)).toEqual([]);
    // Not vacuous: beings decided, several in one tick, and left their chunks for others.
    expect(counted.reduce((sum, tick) => sum + tick.windows.length, 0)).toBeGreaterThan(100);
    expect(Math.max(...counted.map((tick) => tick.windows.length))).toBeGreaterThan(1);
    expect(new Set(counted.flatMap((tick) => tick.after)).size).toBeGreaterThan(
      DISPERSED_CELLS.length,
    );
    expect(counted.some((tick) => tick.calls.readChunk > 2 * tick.occupied.length)).toBe(true);
  });

  test("each tick of beings that talk stays within the same bound", () => {
    const counted = countedRun(250, talker, PAIRED_CELLS);
    expect(counted.flatMap(callIssues)).toEqual([]);
    // Not vacuous: the pairs talked, and acts reached their hearers on many ticks.
    expect(counted.reduce((sum, tick) => sum + tick.delivered, 0)).toBeGreaterThan(20);
    expect(counted.filter((tick) => tick.delivered > 0).length).toBeGreaterThan(10);
  });

  test("finding a hearer reads no chunk beyond the speaker's window; writing it, its own once", () => {
    // Being 1 ends at tick 2 either an act addressed to being 2 or an idle, and decides in both:
    // the reads of that tick differ by the hearer's chunk when it lies in another chunk, which the
    // delivery writes, and by nothing when it shares the speaker's.
    const readsAt2 = (hearer: Cell, talks: boolean) => {
      const sink: Calls[] = [];
      const first: beings.Intention2 = talks
        ? {
            steps: [{ kind: "talk", to: 2, act: "greet" }],
            wakeWhen: {},
            behavior: behavior("roam"),
          }
        : { steps: [{ kind: "idle", ms: 12_000 }], wakeWhen: {}, behavior: behavior("roam") };
      const brain = brain2((senses) =>
        senses.self.id === 1 && senses.self.outcome.result === "none"
          ? first
          : { steps: [{ kind: "idle", ms: 6_000_000 }], wakeWhen: {}, behavior: behavior("rest") },
      );
      const chunks = chunksOf([being2(1, SPEAKER), being2(2, hearer)]);
      const world = createWorld(
        {
          seed: [1, 2],
          simSecondsPerTick: SPS,
          global: {
            ...beings.beingsGlobal(testGenesis(), beings.defaultLife2()),
            occupancy: Object.keys(chunks).sort(),
          },
          chunks: chunks as { [key: string]: CanonicalValue },
          ruleset: counting(
            beings.createBeingsRuleset({ controllers: { s1: brain }, rules: "beings@2" }),
            sink,
          ),
        },
        { audit: false },
      );
      step(world, []);
      const { events } = step(world, []);
      const delivered = events.filter(({ type }) => type === "speech.delivered").length;
      return { reads: (sink[1] as Calls).readChunk, delivered };
    };
    const [same, other] = [readsAt2(SAME, true), readsAt2(SAME, false)];
    expect(same.delivered).toBe(1);
    expect(same.reads).toBe(other.reads);
    const [across, idle] = [readsAt2(ACROSS, true), readsAt2(ACROSS, false)];
    expect(across.delivered).toBe(1);
    expect(across.reads).toBe(idle.reads + 1);
  });

  test("the bound: T4's, five reads per wake, and no more", () => {
    const calls = (readChunk: number, keys: string[]): Calls => ({
      chunkKeys: 0,
      readChunk,
      writeGlobal: 0,
      keys,
    });
    const sensed = ["-1,-1", "0,-1", "-1,0", "0,0"];
    const tick: CountedTick = {
      tick: 7,
      calls: calls(11, ["0,0", "1,0", ...sensed, "0,0", "0,0", "0,0", "1,0", "-1,-1"]),
      occupied: ["0,0", "1,0"],
      listed: ["0,0", "1,0"],
      after: ["0,0", "1,0"],
      wakes: 1,
      windows: [{ origin: [-24, -24], side: 49 }],
      dayTurns: false,
      delivered: 0,
    };
    expect(callIssues(tick)).toEqual([]);
    expect(callIssues({ ...tick, calls: calls(12, [...tick.calls.keys, "0,0"]) })).toEqual([
      "tick 7: chunk reads: 12, at most 11",
    ]);
  });
});

/** What the commits of a world showed of each being: its records and minds, as objects. */
type Identities = {
  /** Every distinct mind object a being held, by id. */
  readonly minds: Map<number, Set<object>>;
  /** Each being's record as the last commit saw it, and the tick of that commit. */
  readonly records: Map<number, { readonly record: object; readonly wake: number }>;
  /** Records of beings that were not due, yet were not the same object at the next commit. */
  readonly touched: string[];
  /** How many times a commit saw a being that was not due, in a chunk another being changed. */
  notDue: number;
};

/**
 * `ruleset` whose validateChunk, which the commit runs on every chunk a tick changed, records the
 * identity of each being's record and mind in `seen`, at the tick its system last ran.
 */
function watching(
  ruleset: Ruleset<beings.BeingsGlobal, beings.BeingsChunk>,
  seen: Identities,
): Ruleset<beings.BeingsGlobal, beings.BeingsChunk> {
  let tick = 0;
  return {
    ...ruleset,
    systems: ruleset.systems.map((system) => ({
      ...system,
      run: (ctx: TickContext<beings.BeingsGlobal, beings.BeingsChunk>) => {
        tick = ctx.tick;
        return system.run(ctx);
      },
    })),
    validateChunk: (key, value) => {
      for (const being of (value as beings.BeingsChunk).beings as beings.Being2[]) {
        const minds = seen.minds.get(being.id) ?? new Set<object>();
        minds.add(being.mind);
        seen.minds.set(being.id, minds);
        const last = seen.records.get(being.id);
        const due = last === undefined || last.wake <= tick;
        if (!due) seen.notDue += 1;
        if (!due && last.record !== being)
          seen.touched.push(`tick ${tick}: being ${being.id}, not due, has a new record`);
        seen.records.set(being.id, { record: being, wake: being.wake });
      }
      return ruleset.validateChunk(key, value);
    },
  };
}

describe("the minds of beings that are not due, and of wakes that decide nothing in them", () => {
  test("keep the very values the state held: no copy at a wake, no work for a being not due", () => {
    // A sleeper shares its chunk with two roamers: their ticks write its chunk, never its record.
    const sleeper = being2(1, DISPERSED_CELLS[0] as [number, number], {
      mind: gateMind(),
      needs: { nutrition: beings.NEED_MAX, rest: 400_000 },
    });
    const placed = [
      sleeper,
      ...[2, 3].map((id) =>
        being2(id, DISPERSED_CELLS[0] as [number, number], { mind: gateMind() }),
      ),
      ...[4, 5].map((id) =>
        being2(id, DISPERSED_CELLS[id] as [number, number], { mind: gateMind() }),
      ),
    ];
    const sleepy = brain2((senses) =>
      senses.self.id === 1
        ? {
            steps: [{ kind: "sleep", untilRest: beings.NEED_MAX }],
            wakeWhen: {},
            behavior: behavior("sleep"),
          }
        : roamer.decide(senses),
    );
    const seen: Identities = { minds: new Map(), records: new Map(), touched: [], notDue: 0 };
    const ruleset = watching(
      beings.createBeingsRuleset({ controllers: { s1: sleepy }, rules: "beings@2" }),
      seen,
    );
    const chunks = chunksOf(placed);
    const occupancy = Object.keys(chunks).sort();
    // Beings that perceive no other (attention 0): a decision that perceives one changes its mind
    // by the law of familiarity, while these brains propose no mental operation, so here every
    // decision leaves the mind as it was, and only a copy could make a new one.
    const unseeing = life2With((species) => ({
      ...species,
      perception: { ...species.perception, attention: 0 },
    }));
    const world = createWorld(
      {
        seed: [3, 3],
        simSecondsPerTick: SPS,
        global: { ...beings.beingsGlobal(testGenesis(), unseeing), occupancy },
        chunks: chunks as { [key: string]: CanonicalValue } as never,
        ruleset,
      },
      { audit: true },
    );
    let wakes = 0;
    for (let tick = 1; tick <= 150; tick += 1) {
      wakes += before(world).wakes;
      step(world, []);
    }
    expect(seen.touched).toEqual([]);
    // Every being held one mind object across every wake and every decision of the run.
    expect([...seen.minds].map(([id, minds]) => [id, minds.size])).toEqual(
      [1, 2, 3, 4, 5].map((id) => [id, 1]),
    );
    // Not vacuous: the beings woke many times, and chunks were written while beings in them slept.
    expect(wakes).toBeGreaterThan(50);
    expect(seen.notDue).toBeGreaterThan(20);
    const last = seen.records.get(1)?.record as beings.Being2 | undefined;
    expect(last?.activity.kind).toBe("sleep");
  });
});
