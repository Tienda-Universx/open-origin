import { describe, expect, test } from "bun:test";
import {
  type ChunkKey,
  type Command,
  type Digest,
  encodeSnapshot,
  parseChunkKey,
  readView,
  type Seed,
  step,
  type World,
} from "../src/index.ts";
import { chunkKeyIssues, prepareGenesis, sealOf } from "../src/worldgen/index.ts";
import {
  generatedTerrain,
  type ProbeGlobal,
  probeRuleset,
  probeRulesetWith,
  type TerrainOf,
} from "./fixtures/probe-ruleset.ts";
import { keyOnlyMemo, sharedMemoWithoutGenesis } from "./support/broken-probe.ts";
import {
  firstDivergence,
  type SuiteRuleset,
  type TickRecord,
  tickRecord,
} from "./support/determinism-records.ts";
import { runDeterminismSuite } from "./support/determinism-suite.ts";
import { probeGenesis, probeScript, probeWorld } from "./support/probe-world.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * Observer independence with worldgen (AGENTS.md rule 4; plan §12, test 15, invariant I4): what a
 * host reads or generates between ticks never changes the world. The probe world runs the same
 * commands under three observer regimes, and each gives the same record at every tick (checksum,
 * events, changed chunks, and statistics) and the same final snapshot text:
 *
 * - (a) no observer;
 * - (b) an observer that, between ticks, reads the view, the global value, and every chunk, and
 *   generates chunks under another genesis, and under the world's own;
 * - (c) the same, through a memo keyed by (seal, chunk key) that the probe's terrain digest shares.
 *
 * Two negative controls show that the comparison detects coupling: a memo keyed by chunk key alone
 * that the observer and the probe share (sharedMemoWithoutGenesis), which the suite's interleaving
 * also catches, and a host that materializes each chunk its observer looks at. The same memo kept
 * in a module (moduleMemoWithoutGenesis) shows that the interleaving catches it there too.
 *
 * Time: each regime runs 240 probe ticks and generates up to 720 chunks; with the control's suite
 * run, about 4 s on the 2-core Codespace (Bun 1.4.4, 2026-10-25; indicative).
 */

const TICKS = 240;
const SEED: Seed = [11, 22];
const SCRIPT = probeScript(2027, TICKS);
const BUDGET_MS = 60_000;

/** Another genesis than the world's: its terrain seed differs, so its chunks differ too. */
const OTHER = prepareGenesis(probeGenesis([99, 98]));

/** The chunks inside the world that the script materializes, which an observer looks at too. */
const SCRIPT_KEYS = [
  ...new Set(
    SCRIPT.commands.flatMap((commands) =>
      commands.flatMap(({ type, payload }) => {
        if (type !== "probe.materialize") return [];
        const { x, y } = payload as { readonly x?: unknown; readonly y?: unknown };
        return [`${x},${y}`];
      }),
    ),
  ),
].filter((key) => chunkKeyIssues(key).length === 0);

/**
 * An observer: it runs between ticks, before `tick`, and returns the keys of the chunks it looked
 * at, which only a coupled host turns into commands.
 */
type Observer = (world: World, tick: number) => readonly ChunkKey[];

/** What a regime gives: the record of every tick and the final snapshot text. */
type RegimeRun = { readonly records: readonly TickRecord[]; readonly finalText: string };

/** The materialization of each chunk in `keys`, sent at `tick` after the script's commands. */
function materializations(tick: number, keys: readonly ChunkKey[], after: number): Command[] {
  return keys.map((key, index) => ({
    applyTick: tick,
    seq: after + index,
    type: "probe.materialize",
    origin: { kind: "admin" },
    payload: parseChunkKey(key),
  }));
}

/**
 * Runs the probe world with SEED under `ruleset` through the script. Before each tick, `observer`
 * looks at the world; a coupled host also materializes what it looked at.
 */
function runRegime(ruleset: SuiteRuleset, observer?: Observer, coupled = false): RegimeRun {
  const world = probeWorld(SEED, ruleset, false);
  const records: TickRecord[] = [];
  for (let tick = 1; tick <= TICKS; tick += 1) {
    const looked = observer?.(world, tick) ?? [];
    const scripted = SCRIPT.commands[tick - 1] ?? [];
    const added = coupled ? materializations(tick, looked, scripted.length) : [];
    records.push(tickRecord(step(world, [...scripted, ...added])));
  }
  return { records, finalText: encodeSnapshot(world) };
}

/** How `run` differs from the run without an observer: its first divergence, and its final text. */
function differences(baseline: RegimeRun, run: RegimeRun) {
  return {
    divergence: firstDivergence(baseline.records, run.records),
    sameFinalText: run.finalText === baseline.finalText,
  };
}

const IDENTICAL = { divergence: undefined, sameFinalText: true };

/** Reads everything a host can read of `world`: its tick, every chunk, and its global value. */
function readEverything(world: World): ProbeGlobal {
  const view = readView(world);
  expect(view.tick).toBeGreaterThanOrEqual(0);
  for (const key of view.chunkKeys()) expect(view.readChunk(key)).toBeDefined();
  return view.readGlobal() as unknown as ProbeGlobal;
}

/**
 * An observer that reads everything, then digests, through `terrain`, one chunk the script
 * materializes and one chunk near the origin under OTHER, and the first under the world's own
 * genesis, which it prepares from the global value it read. Its random draws are its own, seeded,
 * so each regime looks at the same chunks.
 */
function looking(terrain: TerrainOf): Observer {
  const random = new Sfc32(4242);
  return (world) => {
    const own = prepareGenesis(readEverything(world).genesis);
    const scripted = random.pick(SCRIPT_KEYS);
    const near = `${random.between(-24, 24)},${random.between(-24, 24)}`;
    terrain(OTHER, scripted);
    terrain(OTHER, near);
    terrain(own, scripted);
    return [scripted, near];
  };
}

/** A terrain memo keyed by (seal, chunk key), with the number of lookups it answered. */
function sealedMemo() {
  const memo = new Map<string, Digest>();
  let hits = 0;
  const terrain: TerrainOf = (prepared, key) => {
    const id = `${sealOf(prepared)} ${key}`;
    const cached = memo.get(id);
    if (cached !== undefined) {
      hits += 1;
      return cached;
    }
    const digest = generatedTerrain(prepared, key);
    memo.set(id, digest);
    return digest;
  };
  return { terrain, hits: () => hits };
}

/** The run without an observer, computed once. */
let baselineRun: RegimeRun | undefined;
const baseline = () => {
  baselineRun ??= runRegime(probeRuleset());
  return baselineRun;
};

describe("observer independence: the same records under every observer (test 15, I4)", () => {
  test(
    "(a) the run without an observer materializes chunks and crosses boundaries",
    () => {
      const { records } = baseline();
      expect(records).toHaveLength(TICKS);
      const events = records.flatMap((record) => ("fault" in record ? [] : [record.events]));
      expect(events.filter((text) => text.includes("probe.boundary"))).toHaveLength(9);
      expect(SCRIPT.materializations.length).toBeGreaterThan(5);
      expect(SCRIPT_KEYS.length).toBeGreaterThan(5);
    },
    BUDGET_MS,
  );

  test(
    "(b) an observer that reads the view and generates chunks under another genesis",
    () => {
      const run = runRegime(probeRuleset(), looking(generatedTerrain));
      expect(differences(baseline(), run)).toEqual(IDENTICAL);
    },
    BUDGET_MS,
  );

  test(
    "(c) the same through a memo keyed by (seal, key) that the probe shares",
    () => {
      const memo = sealedMemo();
      const run = runRegime(probeRulesetWith(memo.terrain), looking(memo.terrain));
      expect(differences(baseline(), run)).toEqual(IDENTICAL);
      // The probe used digests the observer computed: the memo was shared, not idle.
      expect(memo.hits()).toBeGreaterThan(0);
    },
    BUDGET_MS,
  );
});

describe("negative controls: the comparison detects coupling", () => {
  test(
    "sharedMemoWithoutGenesis: a memo keyed by chunk key alone stores another genesis's terrain",
    () => {
      const memo = new Map<ChunkKey, Digest>();
      const run = runRegime(sharedMemoWithoutGenesis(memo), looking(keyOnlyMemo(memo)));
      expect(differences(baseline(), run)).toEqual({
        divergence: { tick: 21, detail: "checksum differs" },
        sameFinalText: false,
      });
    },
    BUDGET_MS,
  );

  test(
    "sharedMemoWithoutGenesis also fails the suite's interleaving, and only it",
    async () => {
      const report = await runDeterminismSuite({
        ruleset: {
          module: import.meta.resolve("./support/broken-probe.ts"),
          name: "sharedMemoWithoutGenesis",
        },
        world: probeWorld,
        seeds: [SEED, [33, 44]],
        ticks: 120,
        commands: (tick) => SCRIPT.commands[tick - 1] ?? [],
        cuts: [0, 60],
        childCuts: [60],
      });
      expect(report.failures).toEqual([
        { property: "interleave", tick: 1, at: 1, detail: "checksum differs" },
      ]);
    },
    BUDGET_MS,
  );

  test(
    "a memo kept in a module, keyed by chunk key alone, fails the suite's interleaving, and only it",
    async () => {
      const report = await runDeterminismSuite({
        ruleset: {
          module: import.meta.resolve("./support/broken-probe.ts"),
          name: "moduleMemoWithoutGenesis",
        },
        world: probeWorld,
        seeds: [SEED, [33, 44]],
        ticks: 120,
        commands: (tick) => SCRIPT.commands[tick - 1] ?? [],
        cuts: [0, 60],
        childCuts: [60],
      });
      expect(report.failures).toEqual([
        { property: "interleave", tick: 1, at: 1, detail: "checksum differs" },
      ]);
    },
    BUDGET_MS,
  );

  test(
    "a host that materializes each chunk its observer looks at changes the records",
    () => {
      const run = runRegime(probeRuleset(), looking(generatedTerrain), true);
      expect(differences(baseline(), run)).toEqual({
        divergence: { tick: 1, detail: "checksum, changedChunks, stats differ" },
        sameFinalText: false,
      });
    },
    BUDGET_MS,
  );
});
