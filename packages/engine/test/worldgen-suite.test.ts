import { describe, expect, test } from "bun:test";
import {
  type Command,
  canonicalize,
  createWorld,
  decodeSnapshot,
  type EngineEvent,
  encodeSnapshot,
  readView,
  type Seed,
  step,
  type World,
  worldStatus,
} from "../src/index.ts";
import {
  generateChunk,
  genesisSeal,
  observe,
  type PreparedGenesis,
  prepareGenesis,
  terrainDigest,
} from "../src/worldgen/index.ts";
import {
  type ProbeChunk,
  type ProbeGlobal,
  probeRuleset,
  WATCH_LIMIT,
} from "./fixtures/probe-ruleset.ts";
import { STALE_GLOBAL } from "./support/barrier-rulesets.ts";
import {
  type MutableGenesis,
  TAMPER_TICK,
  tamper,
  tampersBehindBarrier,
  tampersThroughWriteGlobal,
} from "./support/broken-probe.ts";
import { recordRun, type TickRecord } from "./support/determinism-records.ts";
import {
  type DeterminismReport,
  type DeterminismSubject,
  runDeterminismSuite,
} from "./support/determinism-suite.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import {
  boundaryTicks,
  PROBE_IDS,
  PROBE_SECONDS_PER_TICK,
  probeGenesis,
  probeGlobal,
  probeScript,
  probeWorld,
  REJECTED,
} from "./support/probe-world.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * Worldgen inside the kernel (ADR 0021, "Proof without a production ruleset"; plan §12, tests 13,
 * 14, 16, and 21, invariants I7 and I8): the probe ruleset materializes chunks by command,
 * measures observables inside the step, and counts calendar boundaries, and it passes every check
 * of the determinism suite under audit, with cuts at calendar boundaries, at ticks that
 * materialize, and at seeded random ticks (tracker L33). What the probe computes inside a tick
 * equals what worldgen computes outside for the same genesis, chunk, cell, and instant; and the
 * genesis stays sealed: each way of changing it fails where ADR 0021 says it does.
 *
 * Time: the suite runs about 11,400 probe ticks in process, about 7,800 of them under audit, and
 * four child processes: three resumes of about 1,600 ticks under audit, and the second seed's run
 * of 600. A probe tick costs about 60 µs, most of it preparing the genesis, which the probe does in
 * every run of a system or handler, and a materialization about 0.7 ms more (worldgen.md, Measured
 * cost). With the other runs here, the file takes 6 to 10 s on the 2-core Codespace (Bun 1.4.4,
 * 2026-10-25; indicative). The timeouts are budgets, as in determinism-suite.test.ts.
 */

const PROBE = { module: import.meta.resolve("./fixtures/probe-ruleset.ts"), name: "probeRuleset" };
const SEEDS: readonly [Seed, Seed] = [
  [11, 22],
  [33, 44],
];
const TICKS = 600;
const SCRIPT = probeScript(2027, TICKS);
const BOUNDARIES = boundaryTicks(TICKS);
const MEASURES = SCRIPT.commands.flat().filter(({ type }) => type === "probe.measure").length;
const BUDGET_MS = 60_000;

/** The message of a seal that does not match its genesis (worldgen/genesis.ts). */
const SEAL_MISMATCH =
  "the seal does not match the genesis: the genesis changed after it was sealed, or the seal was made for another genesis";

/** Each tick and the one before it: a cut at t − 1 resumes into t, and one at t from its end. */
const around = (ticks: readonly (number | undefined)[]) =>
  ticks.flatMap((tick) => (tick === undefined ? [] : [tick - 1, tick]));

/** Four seeded random ticks in [0, TICKS). */
const RANDOM_CUTS = (() => {
  const random = new Sfc32(2028);
  return Array.from({ length: 4 }, () => random.below(TICKS));
})();

/**
 * The cuts: around the first dusk and dawn, and a later dawn and dusk; around the first, the
 * third, and the tenth materialization; and the random ticks. Each list is computed, and pinned
 * below.
 */
const CALENDAR_CUTS = around([BOUNDARIES[0], BOUNDARIES[1], BOUNDARIES[13], BOUNDARIES[18]]);
const { materializations } = SCRIPT;
const MATERIALIZATION_CUTS = around([
  materializations[0],
  materializations[2],
  materializations[9],
]);
const CUTS = [...new Set([...CALENDAR_CUTS, ...MATERIALIZATION_CUTS, ...RANDOM_CUTS])].sort(
  (a, b) => a - b,
);
/** A child resume at the first dawn, at the fifth materialization, and at a random tick. */
const CHILD_CUTS = [BOUNDARIES[1] ?? 0, materializations[4] ?? 0, RANDOM_CUTS[0] ?? 0].sort(
  (a, b) => a - b,
);

const SUBJECT: DeterminismSubject = {
  ruleset: PROBE,
  world: probeWorld,
  seeds: SEEDS,
  ticks: TICKS,
  commands: (tick) => SCRIPT.commands[tick - 1] ?? [],
  cuts: CUTS,
  childCuts: CHILD_CUTS,
};

/** The suite's report on the probe, computed once for every test that reads it. */
let suite: Promise<DeterminismReport> | undefined;
const suiteReport = () => {
  suite ??= runDeterminismSuite(SUBJECT);
  return suite;
};

/** The events of `records`, each tick's parsed from its canonical text. */
function eventsOf(records: readonly TickRecord[]): EngineEvent[] {
  return records.flatMap((record) =>
    "fault" in record ? [] : (JSON.parse(record.events) as EngineEvent[]),
  );
}

/** The events of `type` among `events`. */
const ofType = (events: readonly EngineEvent[], type: string) =>
  events.filter((event) => event.type === type);

/** The world in a snapshot text, as JSON.parse reads it. */
type SnapshotWorld = {
  readonly tick: number;
  readonly global: ProbeGlobal;
  readonly chunks: { readonly [key: string]: ProbeChunk };
};
const worldOf = (text: string | undefined) =>
  (JSON.parse(text ?? "{}") as { readonly world: SnapshotWorld }).world;

/** What a run gives: the record of every tick and the final snapshot text. */
type ProbeRun = { readonly records: readonly TickRecord[]; readonly finalText: string };

/**
 * The run of the probe world with the second seed through the whole script, with a fresh ruleset,
 * computed once: the suite reports only the first seed's run.
 */
let secondRun: ProbeRun | undefined;
function secondSeedRun(): ProbeRun {
  if (secondRun !== undefined) return secondRun;
  const world = probeWorld(SEEDS[1], probeRuleset(), false);
  const records = recordRun(world, SCRIPT.commands);
  secondRun = { records, finalText: encodeSnapshot(world) };
  return secondRun;
}

describe("the probe passes the determinism suite under audit (test 13)", () => {
  test(
    "every check, resuming at calendar boundaries, materializations, and random ticks",
    async () => {
      // The computed cuts, pinned: a change of the laws, the script, or the draws shows here.
      expect(BOUNDARIES.slice(0, 4)).toEqual([28, 50, 78, 100]);
      expect(CALENDAR_CUTS).toEqual([27, 28, 49, 50, 349, 350, 477, 478]);
      expect(MATERIALIZATION_CUTS).toEqual([0, 1, 20, 21, 170, 171]);
      expect(RANDOM_CUTS).toEqual([148, 554, 578, 176]);
      const report = await suiteReport();
      expect(report.failures).toEqual([]);
      expect(report.resumed).toEqual([
        0, 1, 20, 21, 27, 28, 49, 50, 148, 170, 171, 176, 349, 350, 477, 478, 554, 578,
      ]);
      expect(report.childResumed).toEqual([47, 50, 148]);
      expect(report.reference).toHaveLength(TICKS);
    },
    BUDGET_MS,
  );

  test(
    "each calendar boundary of the laws, and only those, changes the watched chunks",
    async () => {
      const { reference, finalText } = await suiteReport();
      const boundaries = ofType(eventsOf(reference), "probe.boundary");
      expect(boundaries.map((event) => event.tick)).toEqual(BOUNDARIES);
      // Dusk ends the light period and dawn starts the next day.
      expect(boundaries.slice(0, 3).map((event) => event.payload)).toEqual([
        { day: 0, light: false },
        { day: 1, light: true },
        { day: 1, light: false },
      ]);
      const { chunks, global } = worldOf(finalText);
      for (const [key, chunk] of Object.entries(chunks)) {
        const watched = global.watch.includes(key);
        const seen = BOUNDARIES.filter((tick) => tick >= chunk.at).length;
        expect([key, chunk.readings]).toEqual([key, watched ? seen : 0]);
      }
    },
    BUDGET_MS,
  );

  test(
    "chunks are created only by accepted materializations, one each, and the first are watched",
    async () => {
      const { reference, finalText } = await suiteReport();
      const created = reference.flatMap((record) => {
        if ("fault" in record) return [];
        const { createdChunks } = JSON.parse(record.stats) as { readonly createdChunks: number };
        return createdChunks === 0 ? [] : [[record.tick, createdChunks]];
      });
      expect(created).toEqual(materializations.map((tick) => [tick, 1]));
      const { chunks, global } = worldOf(finalText);
      const ats = Object.values(chunks)
        .map((chunk) => chunk.at)
        .sort((a, b) => a - b);
      expect(ats).toEqual([...materializations]);
      expect(materializations.length).toBeGreaterThan(WATCH_LIMIT);
      expect(global.watch).toHaveLength(WATCH_LIMIT);
      const firstWatched = global.watch.map((key) => chunks[key]?.at);
      expect(firstWatched).toEqual(materializations.slice(0, WATCH_LIMIT));
    },
    BUDGET_MS,
  );

  test(
    "check rejects a chunk outside the world, a duplicate, an inhabitant's, and an invalid query",
    async () => {
      const { reference } = await suiteReport();
      const rejected = ofType(eventsOf(reference), "engine.command_rejected");
      const { outside, duplicate, inhabitant, query } = REJECTED;
      expect(rejected.map(({ tick, payload }) => [tick, payload])).toEqual([
        [
          outside.tick,
          {
            seq: 0,
            type: "probe.materialize",
            origin: { kind: "admin" },
            reason: "outside_world",
            details: {
              key: "67108864,0",
              problems: [
                "the x of the chunk key, 67108864, is outside the world: chunk coordinates lie from -67108864 to 67108863",
              ],
            },
          },
        ],
        [
          duplicate.tick,
          {
            seq: 0,
            type: "probe.materialize",
            origin: { kind: "admin" },
            reason: "materialized",
            details: { key: "0,0" },
          },
        ],
        [
          inhabitant.tick,
          {
            seq: 0,
            type: "probe.materialize",
            origin: { kind: "inhabitant", actor: 3 },
            reason: "admin_only",
          },
        ],
        [
          query.tick,
          {
            seq: 0,
            type: "probe.measure",
            origin: { kind: "admin" },
            reason: "invalid_query",
            details: {
              issues: [
                {
                  path: "/query/id",
                  message: "the genesis defines 2 deposits, deposit.0 to deposit.1",
                },
                {
                  path: "/query/cell/x",
                  message:
                    "2147483648 is outside the world: cell coordinates lie from -2147483648 to 2147483647",
                },
              ],
            },
          },
        ],
      ]);
    },
    BUDGET_MS,
  );
});

/** A probe.materialize command from the admin plane, at `tick`, of the chunk `{ x, y }`. */
const materializeCommand = (tick: number, chunk: { readonly x: number; readonly y: number }) =>
  adminCommand(tick, "probe.materialize", chunk);

/** A command of `type` from the admin plane, alone in its tick. */
function adminCommand(tick: number, type: string, payload: { readonly [key: string]: number }) {
  const command: Command = { applyTick: tick, seq: 0, type, origin: { kind: "admin" }, payload };
  return command;
}

/** The prepared genesis of the probe world with `seed`, as worldgen prepares it outside. */
const preparedOf = (seed: Seed): PreparedGenesis => prepareGenesis(probeGenesis(seed));

/** Each chunk's stored terrain digest, and the one generated outside under `prepared`. */
function terrainPairs(text: string | undefined, prepared: PreparedGenesis) {
  return Object.entries(worldOf(text).chunks).map(([key, chunk]) => ({
    key,
    inside: chunk.terrain,
    outside: terrainDigest(generateChunk(prepared, key)),
  }));
}

/** Each probe.reading of `records`, and observe outside at its cell and its event's tick. */
function readingPairs(records: readonly TickRecord[], prepared: PreparedGenesis) {
  return ofType(eventsOf(records), "probe.reading").map(({ tick, payload }) => {
    const { id, cell, value } = payload as {
      readonly id: string;
      readonly cell: { readonly x: number; readonly y: number };
      readonly value: number;
    };
    const instant = { tick, simSecondsPerTick: PROBE_SECONDS_PER_TICK };
    return { id, inside: value, outside: observe(prepared, { id, cell, instant }) };
  });
}

describe("inside the step equals outside (tests 16 and 21)", () => {
  test(
    "each stored terrain digest equals generateChunk outside, under each world's own terrain seed",
    async () => {
      const { finalText } = await suiteReport();
      const second = secondSeedRun();
      for (const [text, seed] of [
        [finalText, SEEDS[0]],
        [second.finalText, SEEDS[1]],
      ] as const) {
        const pairs = terrainPairs(text, preparedOf(seed));
        expect(pairs).toHaveLength(materializations.length);
        for (const pair of pairs) expect(pair.inside).toBe(pair.outside);
      }
    },
    BUDGET_MS,
  );

  test(
    "I7: the world seed does not change terrain, and the terrain seed does",
    async () => {
      const { finalText } = await suiteReport();
      // The first seed's genesis in a world with another world seed.
      const world = createWorld({
        seed: [77, 88],
        simSecondsPerTick: PROBE_SECONDS_PER_TICK,
        global: probeGlobal(probeGenesis(SEEDS[0])),
        chunks: {},
        ruleset: probeRuleset(),
      });
      step(world, [materializeCommand(1, { x: 0, y: 0 })]);
      const stored = (readView(world).readChunk("0,0") as unknown as ProbeChunk).terrain;
      expect(stored).toBe(worldOf(finalText).chunks["0,0"]?.terrain ?? "");
      expect(stored).not.toBe(worldOf(secondSeedRun().finalText).chunks["0,0"]?.terrain);
    },
    BUDGET_MS,
  );

  test(
    "each reading equals observe outside with { tick: T, simSecondsPerTick } of its tick T",
    async () => {
      const { reference } = await suiteReport();
      for (const [records, seed] of [
        [reference, SEEDS[0]],
        [secondSeedRun().records, SEEDS[1]],
      ] as const) {
        const pairs = readingPairs(records, preparedOf(seed));
        expect(new Set(pairs.map(({ id }) => id))).toEqual(new Set(PROBE_IDS));
        // Every measurement of the script gives a reading, except the rejected query.
        expect(pairs).toHaveLength(MEASURES - 1);
        for (const pair of pairs) expect([pair.id, pair.inside]).toEqual([pair.id, pair.outside]);
      }
    },
    BUDGET_MS,
  );
});

/** Steps `world` from its tick to `tick` with no commands. */
function stepTo(world: World, tick: number): void {
  while (worldStatus(world).tick < tick) step(world, []);
}

describe("the probe's validators", () => {
  test("report every problem of its global value and chunks at once, with its path", () => {
    const genesis = probeGenesis(SEEDS[0]);
    const watched = Array.from({ length: WATCH_LIMIT - 1 }, (_, x) => `${x},0`);
    const global = { ...probeGlobal(genesis), extra: 1, watch: [...watched, "0,0", "67108864,0"] };
    const chunks = { "0,0": { at: 0, terrain: "xyz", readings: -1, color: "red" }, "1,0": 5 };
    const init = { seed: SEEDS[0], simSecondsPerTick: PROBE_SECONDS_PER_TICK, global, chunks };
    const error = engineErrorOf(() => createWorld({ ...init, ruleset: probeRuleset() }));
    expect([error.code, error.issues.map(({ path, message }) => ({ path, message }))]).toEqual([
      "invalid_input",
      [
        { path: "/init/global/extra", message: "unknown member" },
        {
          path: "/init/global/watch",
          message: `the watch list has ${WATCH_LIMIT + 1} keys: it holds at most ${WATCH_LIMIT}`,
        },
        { path: `/init/global/watch/${WATCH_LIMIT - 1}`, message: "the chunk is watched twice" },
        {
          path: `/init/global/watch/${WATCH_LIMIT}`,
          message:
            "the x of the chunk key, 67108864, is outside the world: chunk coordinates lie from -67108864 to 67108863",
        },
        { path: "/init/chunks/0,0/color", message: "unknown member" },
        { path: "/init/chunks/0,0/at", message: "must be a tick from 1" },
        { path: "/init/chunks/0,0/terrain", message: "must be a terrain digest, 32 hex digits" },
        { path: "/init/chunks/0,0/readings", message: "must be a safe integer from 0" },
        {
          path: "/init/chunks/1,0",
          message: "a probe chunk must be a record { at, terrain, readings }",
        },
      ],
    ]);
  });
});

describe("the genesis stays sealed inside the step (test 14, I8)", () => {
  const sealFault = [{ path: "/global/genesisSeal", message: SEAL_MISMATCH }];

  test("a handler that changes it through writeGlobal faults that tick at the seal, and poisons the world", () => {
    const world = probeWorld(SEEDS[0], tampersThroughWriteGlobal(), false);
    stepTo(world, 2);
    const fault = engineErrorOf(() => step(world, [adminCommand(3, "probe.tamper", {})]));
    expect([fault.code, fault.issues]).toEqual(["system_fault", sealFault]);
    expect(worldStatus(world)).toEqual({
      kind: "faulted",
      tick: 3,
      code: "system_fault",
      issues: sealFault,
    });
    // Nothing is saved, and the world never steps again.
    expect(engineErrorOf(() => encodeSnapshot(world)).code).toBe("world_faulted");
    expect(engineErrorOf(() => step(world, [])).code).toBe("world_faulted");
  });

  test("a system that changes it behind the barrier, through a read, is found by audit at that tick", () => {
    const world = probeWorld(SEEDS[0], tampersBehindBarrier(), true);
    stepTo(world, TAMPER_TICK - 1);
    const fault = engineErrorOf(() => step(world, []));
    expect([fault.code, fault.issues]).toEqual([
      "integrity_violation",
      [{ path: "/global", message: STALE_GLOBAL }],
    ]);
    expect(worldStatus(world)).toMatchObject({ kind: "faulted", tick: TAMPER_TICK });
  });

  test("without audit, encodeSnapshot refuses that world, and its next global write fails at the seal", () => {
    const refused = probeWorld(SEEDS[0], tampersBehindBarrier(), false);
    stepTo(refused, TAMPER_TICK);
    const encoding = engineErrorOf(() => encodeSnapshot(refused));
    expect([encoding.code, encoding.issues]).toEqual([
      "integrity_violation",
      [{ path: "/global", message: STALE_GLOBAL }],
    ]);
    const world = probeWorld(SEEDS[0], tampersBehindBarrier(), false);
    // A tick that does not write the global value does not validate it, so it still commits.
    stepTo(world, TAMPER_TICK + 1);
    // The materialization adds its chunk to the watch list: a global write.
    const materialize = materializeCommand(TAMPER_TICK + 2, { x: 3, y: 3 });
    const fault = engineErrorOf(() => step(world, [materialize]));
    expect([fault.code, fault.issues]).toEqual(["system_fault", sealFault]);
  });

  test("a snapshot whose genesis was edited but whose seal is stale is refused at decoding", () => {
    const genesis = probeGenesis(SEEDS[0]);
    const edited = structuredClone(genesis) as MutableGenesis;
    tamper(edited);
    const global = { ...probeGlobal(genesis), genesis: edited };
    // A world that accepts any global value runs the edited genesis with its stale seal, so its
    // snapshot has a valid state root: only the seal can refuse it.
    const lenient = { ...probeRuleset(), validateGlobal: () => [] };
    const init = { seed: SEEDS[0], simSecondsPerTick: PROBE_SECONDS_PER_TICK, chunks: {} };
    const world = createWorld({ ...init, global, ruleset: lenient });
    for (const commands of SCRIPT.commands.slice(0, 60)) step(world, commands);
    const fault = engineErrorOf(() => decodeSnapshot(encodeSnapshot(world), probeRuleset()));
    expect([fault.code, fault.issues]).toEqual([
      "invalid_snapshot",
      [{ path: "/world/global/genesisSeal", message: SEAL_MISMATCH }],
    ]);
  });

  test(
    "a snapshot edited as text is refused at the seal and at the state root",
    async () => {
      const { finalText } = await suiteReport();
      const parsed = JSON.parse(finalText ?? "{}") as {
        world: { global: { genesis: MutableGenesis } };
      };
      tamper(parsed.world.global.genesis);
      const fault = engineErrorOf(() => decodeSnapshot(canonicalize(parsed), probeRuleset()));
      expect(fault.code).toBe("invalid_snapshot");
      expect(fault.issues.map(({ path }) => path)).toEqual([
        "/world/global/genesisSeal",
        "/stateRoot",
      ]);
      expect(fault.issues[0]?.message).toBe(SEAL_MISMATCH);
    },
    BUDGET_MS,
  );

  test(
    "after the suite's run, the genesis and its seal are the initial ones",
    async () => {
      const { finalText } = await suiteReport();
      const { tick, global } = worldOf(finalText);
      const genesis = probeGenesis(SEEDS[0]);
      expect(tick).toBe(TICKS);
      expect(global.genesis).toEqual(genesis);
      expect(global.genesisSeal).toBe(genesisSeal(genesis));
    },
    BUDGET_MS,
  );
});
