/**
 * The world plane as compose() wires it (ADR 0025), on a fake clock and timer whose callbacks let
 * the journal's acknowledgements run between ticks, as the event loop does: the world runs at its
 * rate and publishes only what the journal committed; stop flushes the partial batch; a lagging
 * journal stalls the scheduler without shortfall; a journal failure, an engine fault, and an
 * unhandled rejection halt the world; the source's world is projected once per tick, timed, and
 * its terrain served, and one that is not a world of beings is refused; and the status validates
 * against the admin contract.
 */
import { describe, expect, test } from "bun:test";
import { readView, type World, worldgen } from "@open-origin/engine";
import { ServerStatus } from "@open-origin/protocol/admin";
import { TerrainPublic } from "@open-origin/protocol/public";
import { compose, type WorldPlaneDeps } from "../src/compose.ts";
import { type Config, parseConfig } from "../src/config/config.ts";
import { calendarClock } from "../src/projection/clock.ts";
import { BeingsProjection, type WorldProjection } from "../src/projection/projection.ts";
import type { TickJournal } from "../src/world/journal.ts";
import type { PublishedTick } from "../src/world/published.ts";
import { ScenarioSource, ScriptedSource, type WorldSource } from "../src/world/source.ts";
import { countingWorld } from "./support/counting-world.ts";
import { FakeClock, FakeTimer } from "./support/fake-time.ts";
import { ControlledJournal, settle } from "./support/journals.ts";
import { emptyProjection } from "./support/projections.ts";

/** One period at 5 Hz, in microseconds. */
const P = 200_000;

/** The configuration of an ephemeral server, with `env` added. */
function configOf(env: Record<string, string> = {}): Config {
  const result = parseConfig({ OPEN_ORIGIN_DURABILITY: "ephemeral", ...env });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.config;
}

type Options = Omit<WorldPlaneDeps, "clock" | "timer" | "source"> & {
  readonly config?: Config;
  /** The source, or "default" for the one compose picks when none is given. */
  readonly source?: WorldSource | "default";
};

/**
 * A world plane over a fake clock, by default over a counting world that never faults, which holds
 * no beings and so takes the empty projection; the default source takes compose's own.
 */
function plane({
  config = configOf(),
  source = new ScriptedSource(countingWorld(1_000_000), []),
  ...deps
}: Options = {}) {
  const clock = new FakeClock();
  const timer = new FakeTimer(clock);
  const world = compose(config, {
    clock,
    timer,
    ...(source === "default" ? {} : { source, projectionOf: emptyProjection }),
    ...deps,
  });
  const published: number[] = [];
  world.subscribeToPublished(({ tick }) => {
    published.push(tick);
  });
  /** The status, parsed by the admin contract, which also checks E ≥ C ≥ P. */
  const status = () => ServerStatus.parse(world.status());
  return { clock, timer, world, published, status };
}

const ticks = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe("compose", () => {
  test("runs the world at its rate and publishes only what the journal committed", async () => {
    const { timer, world, published, status } = plane();
    expect(status()).toEqual({
      executedTick: 0,
      committedTick: 0,
      publishedTick: 0,
      tickRateHz: 5,
      simSecondsPerTick: 12,
      durability: "ephemeral",
      state: "paused",
      latenessMicros: { p50: 0, p95: 0, p99: 0 },
      stepMicros: { p50: 0, p95: 0, p99: 0 },
      projectionMicros: { p50: 0, p95: 0, p99: 0 },
      fanOutMicros: { p50: 0, p95: 0, p99: 0 },
      shortfallTicks: 0,
      rebases: 0,
      connections: 0,
    });
    world.start();
    await timer.runUntilSettled(10 * P);
    // Ticks 1 to 11 ran at 0, P, …, 10P; the batches of F = 5 that the journal acknowledged hold
    // ticks 1 to 10, and tick 11 waits for its batch.
    expect(status()).toMatchObject({
      executedTick: 11,
      committedTick: 10,
      publishedTick: 10,
      state: "running",
      shortfallTicks: 0,
    });
    expect(published).toEqual(ticks(1, 10));
    expect(world.halted()).toBeUndefined();
  });

  test("stop flushes the partial batch and publishes it, and start resumes", async () => {
    const { timer, world, published, status } = plane();
    world.start();
    await timer.runUntilSettled(10 * P);
    await world.stop();
    expect(status()).toMatchObject({
      executedTick: 11,
      committedTick: 11,
      publishedTick: 11,
      state: "paused",
    });
    expect(published).toEqual(ticks(1, 11));
    expect(timer.pending).toBe(0);
    // Twenty periods pass while stopped: the resumed schedule starts when start is called.
    await timer.runUntilSettled(30 * P);
    expect(status().executedTick).toBe(11);
    world.start();
    await timer.runUntilSettled(32 * P);
    expect(status()).toMatchObject({
      executedTick: 14,
      state: "running",
      shortfallTicks: 0,
      rebases: 0,
    });
  });

  test("a lagging journal stalls the world beyond W = 4F, without shortfall", async () => {
    const journal = new ControlledJournal();
    const { timer, world, published, status } = plane({ journal });
    world.start();
    await timer.runUntilSettled(40 * P);
    // E − C may reach W = 20; the tick that takes it past W runs, then the scheduler holds.
    expect(status()).toMatchObject({ executedTick: 21, committedTick: 0, state: "stalled" });
    expect(timer.pending).toBe(0);
    journal.ack();
    await settle();
    expect(status()).toMatchObject({ committedTick: 5, publishedTick: 5, state: "running" });
    await timer.runUntilSettled(60 * P);
    expect(status()).toMatchObject({
      executedTick: 26,
      committedTick: 5,
      state: "stalled",
      shortfallTicks: 0,
      rebases: 0,
    });
    expect(published).toEqual(ticks(1, 5));
    expect(journal.maxInFlight).toBe(1);
  });

  test("a journal failure halts the world, with nothing uncommitted published", async () => {
    const journal = new ControlledJournal();
    const { timer, world, published, status } = plane({ journal });
    world.start();
    await timer.runUntilSettled(6 * P);
    expect(status()).toMatchObject({ executedTick: 7, committedTick: 0 });
    journal.fail();
    await settle();
    expect(status()).toMatchObject({
      executedTick: 7,
      committedTick: 0,
      publishedTick: 0,
      state: "halted",
    });
    expect(published).toEqual([]);
    expect(timer.pending).toBe(0);
    // The halt keeps what the journal rejected with, for the entry point's log.
    expect(world.halted()).toEqual({
      code: "journal_failed",
      tick: 8,
      cause: { message: "the journal failed" },
    });
    await timer.runUntilSettled(20 * P);
    expect(status().executedTick).toBe(7);
  });

  test("a journal that throws within a tick halts the world in that tick, with its cause", async () => {
    const journal: TickJournal = {
      level: "none",
      append: () => {
        throw Object.assign(new Error("no space left on the device"), { code: "ENOSPC" });
      },
    };
    const config = configOf({ PUBLICATION_BATCH_TICKS: "1" });
    const { timer, world, published, status } = plane({ journal, config });
    world.start();
    await timer.runUntilSettled(10 * P);
    // Tick 1's batch of F = 1 threw within the tick: the gate failed, the host halted, and the
    // scheduler, woken inside the tick, stopped before it armed another timer.
    expect(status()).toMatchObject({
      executedTick: 1,
      committedTick: 0,
      publishedTick: 0,
      state: "halted",
    });
    expect(world.halted()).toEqual({
      code: "journal_failed",
      tick: 2,
      cause: { code: "ENOSPC", message: "no space left on the device" },
    });
    expect(published).toEqual([]);
    expect(timer.pending).toBe(0);
  });

  test("an engine fault halts the world once the valid ticks are committed", async () => {
    const { timer, world, published, status } = plane({
      source: new ScriptedSource(countingWorld(7), []),
    });
    world.start();
    await timer.runUntilSettled(20 * P);
    expect(status()).toMatchObject({
      executedTick: 6,
      committedTick: 6,
      publishedTick: 6,
      state: "halted",
    });
    expect(published).toEqual(ticks(1, 6));
    expect(timer.pending).toBe(0);
    // An engine error leaves its code alone: its issues may name C3 data.
    expect(world.halted()).toEqual({ code: "system_fault", tick: 7 });
  });

  test("a source that throws halts the world once the valid ticks are committed", async () => {
    const counting = countingWorld(1_000_000);
    const source: WorldSource = {
      world: counting,
      commandsAt: (tick) => {
        if (tick === 7) throw new Error("a broken source");
        return [];
      },
    };
    const { timer, world, published, status } = plane({ source });
    world.start();
    await timer.runUntilSettled(20 * P);
    expect(status()).toMatchObject({
      executedTick: 6,
      committedTick: 6,
      publishedTick: 6,
      state: "halted",
    });
    expect(published).toEqual(ticks(1, 6));
    expect(timer.pending).toBe(0);
    expect(world.halted()).toEqual({
      code: "unexpected_error",
      tick: 7,
      cause: { message: "a broken source" },
    });
  });

  test("an unhandled rejection halts the world under AI_MODE=off, flushing first", async () => {
    const { timer, world, published, status } = plane();
    world.start();
    await timer.runUntilSettled(2 * P);
    world.unhandledRejection();
    await settle();
    expect(status()).toMatchObject({
      executedTick: 3,
      committedTick: 3,
      publishedTick: 3,
      state: "halted",
    });
    expect(published).toEqual([1, 2, 3]);
    expect(timer.pending).toBe(0);
    expect(world.halted()).toEqual({ code: "unhandled_rejection", tick: 4 });
    world.start();
    await timer.runUntilSettled(20 * P);
    expect(status().executedTick).toBe(3);
  });

  test("reads its rate and batch size from the configuration", async () => {
    const config = configOf({ TICK_RATE_HZ: "20", PUBLICATION_BATCH_TICKS: "2" });
    const { timer, world, published, status } = plane({ config });
    world.start();
    await timer.runUntilSettled(4 * 50_000);
    expect(status()).toMatchObject({ tickRateHz: 20, executedTick: 5, committedTick: 4 });
    expect(published).toEqual([1, 2, 3, 4]);
  });

  test("runs the default world of T5 when no source is given, with checkpoints every K", async () => {
    const journal = new ControlledJournal();
    const { timer, world, status } = plane({ journal, checkpointTicks: 2, source: "default" });
    world.start();
    await timer.runUntilSettled(P);
    journal.ack();
    await settle();
    expect(status()).toMatchObject({ executedTick: 2, committedTick: 2, simSecondsPerTick: 12 });
    // The first batch closed at the checkpoint of tick 2, and carried the admin spawns of tick 1.
    expect(journal.batches[0]?.toTick).toBe(2);
    expect(journal.batches[0]?.checkpoint).toStartWith("{");
    expect(journal.batches[0]?.records[0]?.commands).toHaveLength(8);
    expect(TerrainPublic.safeParse(world.readTerrain([0, 0])).success).toBe(true);
  });

  test("refuses a source whose world is not a world of beings, naming the cause", () => {
    const clock = new FakeClock();
    const timer = new FakeTimer(clock);
    const source = new ScriptedSource(countingWorld(1_000_000), []);
    expect(() => compose(configOf(), { clock, timer, source })).toThrow(
      "the world is not a world of beings: its global value holds no genesis",
    );
  });

  test("projects every tick of the source's world, times each projection, and serves terrain", async () => {
    const clock = new FakeClock();
    const timer = new FakeTimer(clock);
    const source = new ScenarioSource();
    const genesis = readView(source.world as World<{ genesis: worldgen.Genesis }>).readGlobal();
    const calendar = calendarClock(worldgen.prepareGenesis(genesis.genesis), 12);
    // A projection that takes 137 microseconds of the fake clock.
    const projectionOf = (world: World): WorldProjection => {
      const projection = new BeingsProjection(world);
      return {
        project: (result) => {
          clock.advance(137);
          return projection.project(result);
        },
        readTerrain: (chunk) => projection.readTerrain(chunk),
      };
    };
    const plane = compose(configOf(), { clock, timer, source, projectionOf });
    const published: PublishedTick[] = [];
    plane.subscribeToPublished((tick) => {
      published.push(tick);
    });
    plane.start();
    await timer.runUntilSettled(9 * P);
    expect(published.map(({ tick }) => tick)).toEqual(ticks(1, 10));
    expect(published.map(({ clock: at }) => at)).toEqual(ticks(1, 10).map(calendar));
    expect(published[0]?.feed.map(({ kind }) => kind)).toEqual(Array(8).fill("arrival"));
    const status = ServerStatus.parse(plane.status());
    expect(status.projectionMicros).toEqual({ p50: 137, p95: 137, p99: 137 });
    // A step's duration covers its whole tick, the projection included.
    expect(status.stepMicros.p50).toBeGreaterThanOrEqual(137);
    expect(plane.readTerrain([1, -1])).toEqual(
      new BeingsProjection(source.world).readTerrain([1, -1]),
    );
  });
});
