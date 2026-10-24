import { describe, expect, test } from "bun:test";
import {
  type CanonicalValue,
  type Command,
  canonicalize,
  EngineError,
  fullChecksum,
  stateRoot,
  step,
  type World,
} from "../src/index.ts";
import { tallyWorld } from "./fixtures/tally-ruleset.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * Command fuzz (plan §8 "Fuzz de comandos"): 64 seeds of 200 ticks each, with random valid and
 * invalid commands from sfc32, over tally and its systems, run twice. Both runs must give the same
 * checksums, events, and rejections at every tick. The first run has audit on, so the incremental
 * root equals the full one after every tick; the second has it off, so audit is also shown not to
 * change a result.
 *
 * Size. A tally tick costs about 110 µs, and about 300 µs with audit, which rehashes every chunk
 * (measured on the 2-core Codespace with Bun 1.4.4; indicative). The plan's estimate of 200 seeds
 * took about 22 s, and every check and Phase B mutant runs the whole suite, so the fuzz runs 64
 * seeds, about 7.5 s: a fuzz gains less from each extra seed than from the systems it drives, which
 * stay in. For a larger sweep, raise SEEDS locally for one run (and the timeout with it, at about
 * 0.1 s per seed), and restore it before committing; the test script stays `bun test`.
 */

const SEEDS = 64;
const TICKS = 200;

/** Keys that exist, keys that do not, and text that is no chunk key. */
const KEYS = ["0,0", "1,0", "-1,0", "0,1", "9,9", "0,-0", "x"];
const TYPES = ["plant", "plant", "name", "birth", "lottery", "unknown.command"];
const NAMES = ["", "Ana", `Zo${String.fromCharCode(0xeb)}`, String.fromCodePoint(0x1f98a)];

function randomPayload(random: Sfc32, type: string): CanonicalValue {
  switch (type) {
    case "plant":
      return { at: random.pick(KEYS), amount: random.between(-5, 150) };
    case "name":
      return { entity: random.between(1, 20), name: random.pick(NAMES) };
    default:
      return random.below(2) === 0 ? {} : [random.next()];
  }
}

/** A valid list of 0 to 3 commands for `tick`. */
function validCommands(random: Sfc32, tick: number): Command[] {
  const commands: Command[] = [];
  let seq = random.below(3);
  for (let count = random.below(4); count > 0; count -= 1) {
    const type = random.pick(TYPES);
    const origin =
      random.below(2) === 0
        ? ({ kind: "admin" } as const)
        : ({ kind: "inhabitant", actor: random.between(1, 30) } as const);
    commands.push({ applyTick: tick, seq, type, origin, payload: randomPayload(random, type) });
    seq += 1 + random.below(3);
  }
  return commands;
}

/** One way to break a list: each returns a list that step must reject. */
const BREAKERS: ((commands: Command[], tick: number) => unknown[])[] = [
  (commands, tick) => [...commands, { ...commandAt(tick), applyTick: tick + 1 }],
  (commands, tick) => [{ ...commandAt(tick), seq: -1 }, ...commands],
  (commands, tick) => [...commands, { ...commandAt(tick), seq: 0 }, { ...commandAt(tick), seq: 0 }],
  (commands, tick) => [...commands, { ...commandAt(tick), seq: 999, payload: [Number.NaN] }],
  (commands, tick) => [...commands, { ...commandAt(tick), seq: 999, type: "" }],
  (commands, tick) => [...commands, { ...commandAt(tick), seq: 999, extra: 1 }],
  (commands, tick) => [...commands, { ...commandAt(tick), seq: 999, origin: { kind: "god" } }],
];

function commandAt(tick: number): Command {
  return { applyTick: tick, seq: 0, type: "birth", origin: { kind: "admin" }, payload: {} };
}

/** Steps `world` with `commands` and returns what the tick did, as one comparable line. */
function record(world: World, commands: readonly unknown[]): string {
  try {
    const { tick, checksum, events, changedChunks, stats } = step(world, commands as Command[]);
    return canonicalize([tick, checksum, events as CanonicalValue, changedChunks, stats]);
  } catch (error) {
    if (!(error instanceof EngineError) || error.code !== "invalid_input") throw error;
    return canonicalize(["invalid_input", error.issues as CanonicalValue]);
  }
}

/** The record of every tick of the run of `seed`, with or without audit. */
function run(seed: number, audit: boolean): string[] {
  const random = new Sfc32(seed);
  const world = tallyWorld([seed, (seed * 7 + 1) >>> 0], audit);
  const records: string[] = [];
  for (let tick = 1; tick <= TICKS; tick += 1) {
    const commands = validCommands(random, tick);
    if (random.below(8) === 0) {
      // Rejected as a whole, which must leave the world as it was for the valid list below.
      records.push(record(world, random.pick(BREAKERS)(commands, tick)));
    }
    records.push(record(world, commands));
  }
  expect(stateRoot(world)).toBe(fullChecksum(world));
  return records;
}

describe("command fuzz over tally", () => {
  test(`${SEEDS} seeds of ${TICKS} ticks give the same records twice, the first under audit`, () => {
    let invalid = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const audited = run(seed, true);
      const plain = run(seed, false);
      expect(plain).toEqual(audited);
      invalid += audited.filter((line) => line.startsWith('["invalid_input"')).length;
    }
    // About one tick in eight carries an invalid list; the fuzz must exercise them.
    expect(invalid).toBeGreaterThan((SEEDS * TICKS) / 16);
  }, 30_000);
});
