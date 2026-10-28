/**
 * The contest for room of beings@2 (ADR 0024, docs/architecture/mind.md "The tick of beings@2",
 * phase 3): a chunk has as free places its capacity less the beings it holds when the beings system
 * starts, after the commands of the tick; when more beings arrive than it has free places, the
 * arrivals, by increasing id, are ordered by `random.permutation` on `beings.crowd`, keyed by the
 * lowest arriving id, and the first take the places; the rest end their walk where they started
 * the tick, `failed` and `crowded`, idle 1 ms, and wake at t + 1. A seeded fuzz of crowding keeps
 * every chunk within its capacity and every being in the chunk of its cell at every tick.
 */
import { describe, expect, test } from "bun:test";
import {
  beings,
  type Command,
  DrawSequence,
  type EngineEvent,
  readView,
  type Seed,
  step,
  streamId,
  tickKey,
  worldgen,
  worldStatus,
} from "../src/index.ts";
import {
  type BeingsWorld,
  behavior,
  beingOf,
  beingsOf,
  centerEdge,
  chunkOf,
  PREPARED,
  runTo,
  SPECIES,
  spawn,
  windowAt,
} from "./support/beings-world.ts";
import {
  being2,
  beings2World,
  brain2,
  chunksOf,
  gateMind,
  life2With,
} from "./support/beings2-world.ts";
import { Sfc32 } from "./support/sfc32.ts";

type Cell = readonly [number, number];

/** The tick at which a step started at tick 2 arrives, for a step of `ms` milliseconds. */
const arrivalOf = (ms: number) => 2 + Math.ceil(ms / 12_000);

/** The east column of chunk (1, −2), whose beings step east into chunk (2, −2), and back. */
const EDGE = 63;
const FROM = "1,-2";
const TO = "2,-2";

/** Whether a being may stand at `cell`: no deeper liquid than the species wades. */
function standable(cell: Cell): boolean {
  const level = worldgen.liquidLevel(worldgen.genesisOf(PREPARED));
  const rect = { x: cell[0], y: cell[1], width: 1, height: 1 };
  const [elevation = -1] = worldgen.sampleSurface(PREPARED, rect, 0).elevation;
  return level - elevation <= SPECIES.locomotion.maxWade;
}

/** Whether the steps across the edge at row `y` both arrive at `tick`, if they can be taken. */
function crossesAt(y: number, tick: number): boolean {
  const east = centerEdge(windowAt([EDGE, y]), 0);
  const west = centerEdge(windowAt([EDGE + 1, y]), 4);
  return east > 0 && west > 0 && arrivalOf(east) === tick && arrivalOf(west) === tick;
}

/** The tick the crossings of these tests arrive at: that of the first row of chunk row −2. */
const ARRIVAL = arrivalOf(centerEdge(windowAt([EDGE, -64]), 0));

/**
 * Four rows y of chunk row −2 where a being at the edge steps east, and one beside it west, each
 * arriving at ARRIVAL, and the cell two east of the edge can hold a resident.
 */
const ROWS: readonly number[] = (() => {
  const rows: number[] = [];
  for (let y = -64; y < -32 && rows.length < 4; y += 1)
    if (crossesAt(y, ARRIVAL) && standable([EDGE + 2, y]) && standable([EDGE + 3, y])) rows.push(y);
  return rows;
})();

const row = (n: number): number => ROWS[n] as number;

function idle(ms = 6_000_000): beings.Intention {
  return { steps: [{ kind: "idle", ms }], wakeWhen: {}, behavior: behavior("rest") };
}

/**
 * A brain that, at its first decision, walks one step east from the edge or west from beside it, and
 * idles otherwise: every crossing of these tests starts at tick 2 and arrives at ARRIVAL.
 */
const crosser = brain2((senses) => {
  const first = senses.self.outcome.result === "none";
  const [x] = senses.self.cell;
  if (first && x === EDGE)
    return { steps: [{ kind: "walk", dirs: "0" }], wakeWhen: {}, behavior: behavior("travel") };
  if (first && x === EDGE + 1)
    return { steps: [{ kind: "walk", dirs: "4" }], wakeWhen: {}, behavior: behavior("travel") };
  return idle();
});

/** Admin spawns of beings on `cells` at `tick`, in order, from `seq`. */
const spawnsAt = (tick: number, cells: readonly Cell[], from = 0): Command[] =>
  cells.map((cell, n) => spawn(tick, { species: "s1", cell: [cell[0], cell[1]] }, from + n));

/** A world of crossers under laws of `capacity`, with `seed`. */
const roomWorld = (capacity: number, seed: Seed = [1, 2]): BeingsWorld =>
  beings2World({ controllers: { s1: crosser }, life: life2With(undefined, capacity), seed });

/** The payloads of the events of `type` at `tick`. */
const payloadsAt = (events: readonly EngineEvent[], tick: number, type: string) =>
  events
    .filter((event) => event.tick === tick && event.type === type)
    .map(({ payload }) => payload);

/** The crowded end of a walk, as its being.finished event reports it. */
const crowded = (id: number) => ({ id, activity: "walk", result: "failed", reason: "crowded" });

/**
 * A crosser whose decision at its arrival changes everything a decision may change: its behavior,
 * its wake conditions, and its cooldowns; at its first decision it walks as `crosser` does.
 */
const resolute = brain2((senses) => {
  if (senses.self.outcome.result === "none") return crosser.decide(senses);
  return {
    steps: [{ kind: "idle", ms: 6_000_000 }],
    wakeWhen: { nutritionBelow: 1 },
    behavior: behavior("rest", 5),
    cooldowns: [{ cell: [0, 0], ms: 60_000 }],
  };
});

describe("the contest for room", () => {
  test("finds crossings for its scenarios", () => {
    expect(ROWS.length).toBe(4);
  });

  test("orders more arrivals than free places by a draw keyed by the lowest arriving id", () => {
    // Chunk TO holds one resident under a capacity of 2: one free place for two arrivals.
    const seeds: Seed[] = [
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ];
    const winners = new Set<number>();
    for (const seed of seeds) {
      const world = roomWorld(2, seed);
      const events = runTo(
        world,
        ARRIVAL,
        spawnsAt(1, [
          [EDGE + 2, row(0)],
          [EDGE, row(1)],
          [EDGE, row(2)],
        ]),
      );
      const order = new DrawSequence(
        seed,
        streamId(beings.CROWD_STREAM),
        tickKey(ARRIVAL, 2),
      ).permutation(2);
      const [winner, loser] = order.map((index) => [2, 3][index] as number) as [number, number];
      winners.add(winner);
      // The loser's walk ended and it decided in the second phase; the ledger keeps none of it.
      expect(payloadsAt(events, ARRIVAL, "being.finished")).toEqual([
        { id: winner, activity: "walk", result: "done", reason: "" },
        crowded(loser),
      ]);
      expect(chunkOf(beingOf(world, winner).cell)).toBe(TO);
      const lost = beingOf(world, loser);
      expect(lost).toMatchObject({
        cell: [EDGE, row(loser - 1)],
        activity: { kind: "idle", start: ARRIVAL, ms: 1 },
        outcome: { result: "failed", tick: ARRIVAL, reason: "crowded" },
        plan: [],
        wake: ARRIVAL + 1,
      });
      expect(beingsOf(world).filter(({ cell }) => chunkOf(cell) === TO)).toHaveLength(2);
    }
    // The draw decides: across the seeds, each arrival won at least once.
    expect([...winners].sort()).toEqual([2, 3]);
  });

  test("lets every arrival in when the free places cover them, without a draw", () => {
    const world = roomWorld(3);
    const events = runTo(
      world,
      ARRIVAL,
      spawnsAt(1, [
        [EDGE + 2, row(0)],
        [EDGE, row(1)],
        [EDGE, row(2)],
      ]),
    );
    expect(payloadsAt(events, ARRIVAL, "being.finished")).not.toContainEqual(crowded(2));
    expect(payloadsAt(events, ARRIVAL, "being.finished")).not.toContainEqual(crowded(3));
    expect(beingsOf(world).map(({ cell }) => chunkOf(cell))).toEqual([TO, TO, TO]);
  });

  test("counts the beings spawned by the commands of the tick, before the system runs", () => {
    // One free place, which a spawn at the arrival tick takes before the arrival comes.
    const world = roomWorld(2);
    const events = runTo(world, ARRIVAL, [
      ...spawnsAt(1, [
        [EDGE + 2, row(0)],
        [EDGE, row(1)],
      ]),
      ...spawnsAt(ARRIVAL, [[EDGE + 3, row(0)]]),
    ]);
    expect(payloadsAt(events, ARRIVAL, "being.spawned")).toHaveLength(1);
    expect(payloadsAt(events, ARRIVAL, "being.finished")).toContainEqual(crowded(2));
    expect(beingOf(world, 2).cell).toEqual([EDGE, row(1)]);
    // Without that spawn, the arrival takes the free place.
    const open = roomWorld(2);
    runTo(
      open,
      ARRIVAL,
      spawnsAt(1, [
        [EDGE + 2, row(0)],
        [EDGE, row(1)],
      ]),
    );
    expect(chunkOf(beingOf(open, 2).cell)).toBe(TO);
  });

  test("frees no place by a departure until the next tick: two beings that swap chunks both fail", () => {
    // Capacity 1: each chunk holds the one being that leaves it, so neither has room this tick.
    const world = roomWorld(1);
    const events = runTo(
      world,
      ARRIVAL,
      spawnsAt(1, [
        [EDGE + 1, row(0)],
        [EDGE, row(0)],
      ]),
    );
    expect(payloadsAt(events, ARRIVAL, "being.finished").slice(-2)).toEqual([
      crowded(1),
      crowded(2),
    ]);
    expect(beingsOf(world).map(({ cell }) => cell)).toEqual([
      [EDGE + 1, row(0)],
      [EDGE, row(0)],
    ]);
    expect(beingsOf(world).map(({ cell }) => chunkOf(cell))).toEqual([TO, FROM]);
    // At the next tick each decides again, where it started.
    const next = step(world, []);
    expect(next.events.filter(({ type }) => type === "being.started")).toHaveLength(2);
  });

  test("keeps nothing of a loser's decision at the tick: its record and mind are as they were", () => {
    const placed = [
      being2(1, [EDGE + 1, row(0)], { mind: gateMind() }),
      being2(2, [EDGE, row(0)], { mind: gateMind() }),
    ];
    const world = beings2World({
      controllers: { s1: resolute },
      life: life2With(undefined, 1),
      chunks: chunksOf(placed),
    });
    // The initial beings decide at tick 1, so their crossings arrive one tick earlier.
    runTo(world, ARRIVAL - 1);
    for (const id of [1, 2]) {
      const lost = beingOf(world, id) as beings.Being2;
      expect(lost.outcome).toEqual({ result: "failed", tick: ARRIVAL - 1, reason: "crowded" });
      expect(lost).toMatchObject({
        behavior: { kind: "travel", since: 1, heading: 0 },
        wakeWhen: {},
        cooldowns: [],
        plan: [],
      });
      expect(lost.mind).toEqual(gateMind());
    }
  });

  test("emits a loser's crowded walk alone, after the second phase, and nothing of its decision", () => {
    const world = roomWorld(1);
    const events = runTo(
      world,
      ARRIVAL,
      spawnsAt(1, [
        [EDGE + 1, row(0)],
        [EDGE, row(0)],
      ]),
    );
    // Both walks ended done at ARRIVAL and both beings decided there; both lost, so the tick shows
    // only their crowded walks, in the order of the contest for room, by chunk key.
    expect(
      events.filter(({ tick }) => tick === ARRIVAL).map(({ type, payload }) => [type, payload]),
    ).toEqual([
      ["being.finished", crowded(1)],
      ["being.finished", crowded(2)],
    ]);
  });

  test("keeps a loser's events of its body: incapacitated at its arrival, it stays so", () => {
    // Starving, the walker reaches health 0 at the tick its walk arrives: placed beings decide at
    // tick 1, so their crossings arrive at ARRIVAL − 1. Its health was re-anchored at tick 1, when
    // its rates changed, so it holds there what falls in the ticks to its arrival.
    const arrival = ARRIVAL - 1;
    const starve = SPECIES.health.starve;
    const fallen = (ticks: number) => Math.floor((starve.num * 12 * ticks) / starve.den);
    const walker = {
      ...being2(2, [EDGE, row(1)], { needs: { nutrition: 0, rest: 900_000 } }),
      health: fallen(arrival - 1) + fallen(1),
    };
    const world = beings2World({
      controllers: { s1: crosser },
      life: life2With(undefined, 1),
      chunks: chunksOf([being2(1, [EDGE + 2, row(0)]), walker]),
    });
    const events = runTo(world, arrival);
    expect(
      events.filter(({ tick }) => tick === arrival).map(({ type, payload }) => [type, payload]),
    ).toEqual([
      ["being.incapacitated", { id: 2 }],
      ["being.finished", crowded(2)],
    ]);
    expect(beingOf(world, 2)).toMatchObject({
      cell: [EDGE, row(1)],
      condition: "incapacitated",
      health: 0,
      outcome: { result: "failed", tick: arrival, reason: "crowded" },
    });
  });

  test("leaves the events of a being that wins its room as they were, in order", () => {
    const at = (capacity: number) => {
      const world = roomWorld(capacity);
      const events = runTo(
        world,
        ARRIVAL,
        spawnsAt(1, [
          [EDGE + 2, row(0)],
          [EDGE, row(1)],
          [EDGE, row(2)],
        ]),
      );
      return events
        .filter(({ tick }) => tick === ARRIVAL)
        .map(({ type, payload }) => [type, payload]);
    };
    // With room for everyone, both crossers end their walks and decide; with one free place, the
    // winner's events are those, unchanged and in the same order, and the loser's are one event.
    const roomy = at(3);
    const tight = at(2);
    const idOf = ([, payload]: unknown[]) => (payload as { id: number }).id;
    const reasonOf = ([, payload]: unknown[]) => (payload as { reason?: string }).reason;
    const loser = idOf(tight.find((event) => reasonOf(event) === "crowded") ?? []);
    const winner = loser === 2 ? 3 : 2;
    expect(tight.filter(([, payload]) => (payload as { id: number }).id === winner)).toEqual(
      roomy.filter(([, payload]) => (payload as { id: number }).id === winner),
    );
    expect(
      roomy.filter(([, payload]) => (payload as { id: number }).id === loser).length,
    ).toBeGreaterThan(1);
    expect(tight.filter(([, payload]) => (payload as { id: number }).id === loser)).toEqual([
      ["being.finished", crowded(loser)],
    ]);
    expect(tight.at(-1)).toEqual(["being.finished", crowded(loser)]);
  });
});

/** A random walker: a pure function of its senses, whose choices come from its two draws. */
const wanderer = brain2((senses) => {
  const [a = 0, b = 0] = senses.draws;
  const heading = a % 8;
  const { side, edgeMs } = senses.window;
  let [x, y] = [(side - 1) / 2, (side - 1) / 2];
  const [dx, dy] = beings.DIRECTIONS[heading] as readonly [number, number];
  let dirs = "";
  while (dirs.length < 1 + (b % 5) && (edgeMs[(y * side + x) * 8 + heading] ?? -1) >= 0) {
    dirs += `${heading}`;
    x += dx;
    y += dy;
  }
  if (dirs === "") return idle(1 + (b % 120_000));
  return {
    steps: [
      { kind: "walk", dirs },
      { kind: "idle", ms: 1 + (b % 60_000) },
    ],
    wakeWhen: {},
    behavior: behavior("roam", heading),
  };
});

/** Laws of crowding: a capacity of 3 and a window of radius 4, so that the fuzz stays cheap. */
const CROWDED = life2With(
  (species) => ({
    ...species,
    senses: { radius: 4 },
    perception: { ...species.perception, sight: { day: 4, dim: 4 } },
  }),
  3,
);

/** Every problem of the chunks of `world` at its tick: over capacity, or a being outside its chunk. */
function roomIssues(world: BeingsWorld): string[] {
  const view = readView(world);
  const issues: string[] = [];
  for (const key of view.chunkKeys()) {
    const chunk = view.readChunk(key) as beings.BeingsChunk;
    if (chunk.beings.length > CROWDED.capacity)
      issues.push(`tick ${view.tick}: chunk ${key} holds ${chunk.beings.length} beings`);
    for (const being of chunk.beings)
      if (chunkOf(being.cell) !== key)
        issues.push(`tick ${view.tick}: being ${being.id} is outside ${key}`);
    if (chunk.due !== beings.dueOf(chunk.beings))
      issues.push(`tick ${view.tick}: chunk ${key} has a stale due`);
  }
  return issues;
}

/** Dry cells within two cells of the corner of four chunks, (0, 0), where the fuzz spawns. */
const CORNER: readonly Cell[] = (() => {
  const cells: Cell[] = [];
  for (let y = -2; y < 2; y += 1)
    for (let x = -2; x < 2; x += 1) if (standable([x, y])) cells.push([x, y]);
  return cells;
})();

/** How many spawns the fuzz sends at `tick`: two a tick at first, then one now and then. */
function spawnCount(random: Sfc32, tick: number): number {
  if (tick <= 10) return 2;
  return random.below(20) === 0 ? 1 : 0;
}

/** The events of `events` of `type`, or whose reason is `reason`, counted. */
const countOf = (events: readonly EngineEvent[], match: (event: EngineEvent) => boolean) =>
  events.filter(match).length;

describe("a fuzz of crowding", () => {
  test.each([1, 2, 3])("keeps every chunk within its capacity at every tick (seed %i)", (seed) => {
    const random = new Sfc32(seed);
    const world = beings2World({
      controllers: { s1: wanderer },
      life: CROWDED,
      seed: [seed, 7],
      audit: false,
    });
    const tally = { refused: 0, crowded: 0 };
    const issues: string[] = [];
    for (let tick = 1; tick <= 200; tick += 1) {
      const cells = Array.from(
        { length: spawnCount(random, tick) },
        () => CORNER[random.below(CORNER.length)] as Cell,
      );
      const { events } = step(world, spawnsAt(tick, cells));
      tally.refused += countOf(events, ({ type }) => type === "engine.command_rejected");
      tally.crowded += countOf(
        events,
        ({ payload }) => (payload as { reason?: string }).reason === "crowded",
      );
      issues.push(...roomIssues(world));
    }
    expect(issues).toEqual([]);
    expect(worldStatus(world)).toEqual({ kind: "ok", tick: 200 });
    // Not vacuous: chunks filled up, spawns were refused, and walks ended crowded.
    expect(CORNER.length).toBeGreaterThan(4);
    expect(beingsOf(world).length).toBeGreaterThan(6);
    expect(tally.refused).toBeGreaterThan(0);
    expect(tally.crowded).toBeGreaterThan(0);
  });
});
