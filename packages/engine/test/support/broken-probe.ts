import type { ChunkKey, Digest } from "../../src/index.ts";
import type { Genesis } from "../../src/worldgen/index.ts";
import {
  generatedTerrain,
  probeRuleset,
  probeRulesetWith,
  type TerrainOf,
} from "../fixtures/probe-ruleset.ts";
import type { SuiteRuleset } from "./determinism-records.ts";
import { handler, system } from "./step-rulesets.ts";

/**
 * Negative controls of worldgen inside the kernel (plan §12, tests 14 and 15): probe rulesets
 * broken on purpose, each in a way a test must catch. As in broken-rulesets.ts, each export is a
 * factory that the suite's child process can import by name.
 *
 * - tampersThroughWriteGlobal changes the genesis through writeGlobal: the seal must fail the
 *   commit of that tick.
 * - tampersBehindBarrier changes it through a live read at TAMPER_TICK: audit must find it at that
 *   tick, encodeSnapshot must refuse the world, and its next global write must fail at the seal.
 * - sharedMemoWithoutGenesis caches terrain digests by chunk key alone, without the genesis: the
 *   observer test and the suite's interleaving must find it.
 * - moduleMemoWithoutGenesis keeps that cache in this module, one per process: the suite's
 *   interleaving, whose second seed runs alone in a child process, must find it.
 */

/** A genesis that ruleset code can change, as the live global value lets it. */
export type MutableGenesis = { laws: { radiance: { peak: number } } } & Genesis;

/**
 * Changes `genesis` into another valid genesis: the peak radiance drops by 1, from 1,000 to 999 by
 * default, still above the night floor. Only the seal can tell the two apart.
 */
export function tamper(genesis: MutableGenesis): void {
  genesis.laws.radiance.peak -= 1;
}

/** The genesis that the live global value of a tick holds. */
const liveGenesis = (global: unknown) => (global as { genesis: MutableGenesis }).genesis;

/** A probe whose command probe.tamper changes the genesis through writeGlobal. */
export function tampersThroughWriteGlobal(): SuiteRuleset {
  const probe = probeRuleset();
  const writing = handler((ctx) => tamper(liveGenesis(ctx.writeGlobal())));
  return { ...probe, commands: { ...probe.commands, "probe.tamper": writing } };
}

/** The tick at which tampersBehindBarrier changes the genesis. */
export const TAMPER_TICK = 5;

/** A probe with a system that changes the genesis through readGlobal at TAMPER_TICK. */
export function tampersBehindBarrier(): SuiteRuleset {
  const probe = probeRuleset();
  const sneaky = system("tamper", (ctx) => {
    if (ctx.tick === TAMPER_TICK) tamper(liveGenesis(ctx.readGlobal()));
  });
  return { ...probe, systems: [...probe.systems, sneaky] };
}

/**
 * Terrain digests through `memo`, keyed by chunk key alone: the defect. The first genesis to
 * digest a chunk decides what every later caller gets for it, under any genesis.
 */
export function keyOnlyMemo(memo: Map<ChunkKey, Digest>): TerrainOf {
  return (prepared, key) => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const digest = generatedTerrain(prepared, key);
    memo.set(key, digest);
    return digest;
  };
}

/**
 * A probe whose terrain digests go through `memo`, keyed by chunk key alone. Whoever shares the
 * memo, an observer or another world, can make the probe store the terrain of another genesis.
 * The suite calls it with no argument, so each ruleset object gets a memo of its own, which the
 * interleaving's worlds share.
 */
export function sharedMemoWithoutGenesis(memo = new Map<ChunkKey, Digest>()): SuiteRuleset {
  return probeRulesetWith(keyOnlyMemo(memo));
}

/** The memo of moduleMemoWithoutGenesis: one per process, as a cache kept in a module is. */
const moduleMemo = new Map<ChunkKey, Digest>();

/**
 * A probe whose terrain digests go through one memo per process, keyed by chunk key alone: the
 * cache a ruleset might keep in a module. Every world of the process shares it, even with a fresh
 * ruleset object, so only a run in a fresh process digests its own terrain: the suite's run of the
 * second seed alone, in a child process, must find it.
 */
export function moduleMemoWithoutGenesis(): SuiteRuleset {
  return probeRulesetWith(keyOnlyMemo(moduleMemo));
}
