import { describe, expect, test } from "bun:test";
import {
  type CanonicalValue,
  type Command,
  canonicalize,
  EngineError,
  fullChecksum,
  type Seed,
  stateRoot,
  step,
  type World,
} from "../src/index.ts";
import { tallyWorld } from "./fixtures/tally-ruleset.ts";
import { Sfc32 } from "./support/sfc32.ts";
import { validCommands } from "./support/tally-fuzz.ts";

/**
 * Command fuzz (plan §8 "Fuzz de comandos"): 64 seeds of 200 ticks each, with random commands
 * from sfc32, over tally and its systems. Each seed runs two worlds with the same valid lists:
 *
 * - an audited world, which before about one tick in eight also receives the valid list broken in
 *   one of seven ways: step must throw invalid_input and leave stateRoot and fullChecksum as they
 *   were, and audit makes the incremental root equal the full one after every tick;
 * - a control world without audit, which never receives a broken list.
 *
 * Both must give the same checksum, events, changed chunks, and statistics at every tick, so a
 * broken list changes nothing, and neither does audit.
 *
 * Size. A tally tick costs about 110 µs, and about 300 µs with audit, which rehashes every chunk
 * (measured on the 2-core Codespace with Bun 1.4.4; indicative). The plan's estimate of 200 seeds
 * took about 22 s, and every check and Phase B mutant runs the whole suite, so the fuzz runs 64
 * seeds, about 8 s: a fuzz gains less from each extra seed than from the systems it drives, which
 * stay in. For a larger sweep, raise SEEDS locally for one run, and restore it before committing;
 * the timeout follows SEEDS, and the test script stays `bun test`.
 *
 * Timeout. The test is synchronous, so Bun cannot interrupt it: it fails the test after it ran
 * longer than the timeout, and the CI job's timeout is what stops a hang. The timeout is thus a
 * budget that a correct run must not exceed on a slower runner. Measured on the 2-core Codespace,
 * 2026-10-24: 7.7 to 8.2 s alone (about 0.125 s per seed), 15 s with two runs at once, and 31 to
 * 32 s with four. SEED_BUDGET_MS allows about eight times the measured cost per seed, so a runner
 * that slow still passes, and a change that makes the fuzz ten times slower fails.
 */

const SEEDS = 64;
const TICKS = 200;
/** What one seed may take; the timeout is SEEDS times it. */
const SEED_BUDGET_MS = 1_000;

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

/** Steps `world` with the valid `commands` and returns what the tick did, as one line. */
function record(world: World, commands: readonly Command[]): string {
  const { tick, checksum, events, changedChunks, stats } = step(world, commands);
  return canonicalize([tick, checksum, events as CanonicalValue, changedChunks, stats]);
}

/** Steps `world` with the broken `commands`, which must be rejected whole, changing nothing. */
function expectRejected(world: World, commands: readonly unknown[]): void {
  const before = [stateRoot(world), fullChecksum(world)];
  let code: string | undefined;
  try {
    step(world, commands as Command[]);
  } catch (error) {
    code = error instanceof EngineError ? error.code : `${error}`;
  }
  expect(code).toBe("invalid_input");
  expect([stateRoot(world), fullChecksum(world)]).toEqual(before);
}

/**
 * The run of `seed` on two worlds: `audited`, under audit, which also receives a broken list
 * before about one tick in eight, and `control`, without audit, which never does. Returns each
 * world's record of every tick and how many broken lists were rejected.
 */
function run(seed: number) {
  const random = new Sfc32(seed);
  const worldSeed: Seed = [seed, (seed * 7 + 1) >>> 0];
  const audited = tallyWorld(worldSeed, true);
  const control = tallyWorld(worldSeed);
  const records = { audited: [] as string[], control: [] as string[] };
  let broken = 0;
  for (let tick = 1; tick <= TICKS; tick += 1) {
    const commands = validCommands(random, tick);
    if (random.below(8) === 0) {
      expectRejected(audited, random.pick(BREAKERS)(commands, tick));
      broken += 1;
    }
    records.audited.push(record(audited, commands));
    records.control.push(record(control, commands));
  }
  expect(stateRoot(control)).toBe(fullChecksum(control));
  return { ...records, broken };
}

describe("command fuzz over tally", () => {
  test(
    `${SEEDS} seeds of ${TICKS} ticks: an audited world that also rejects broken lists matches a control`,
    () => {
      let broken = 0;
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const result = run(seed);
        expect(result.audited).toEqual(result.control);
        broken += result.broken;
      }
      // About one tick in eight carries a broken list; the fuzz must exercise them.
      expect(broken).toBeGreaterThan((SEEDS * TICKS) / 16);
    },
    SEEDS * SEED_BUDGET_MS,
  );
});
