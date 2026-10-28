/**
 * The fuzz of the minds of beings@2 with the ledger oracle (ADR 0024, docs/architecture/mind.md
 * "Verification plan"): beings with a chaotic brain, which proposes valid and invalid mental
 * operations of every kind, crowd at a chunk border while research injects claims at random
 * ticks, some refused; after every tick every mind holds its bounds and invariants, no taint,
 * exposure, or id shrinks, every record the tick created equals what the being perceived or was
 * delivered, and the ledger oracle, which reads only the events, rebuilds every live record's
 * taints and citations and every exposure exactly.
 */
import { expect, test } from "bun:test";
import { step } from "../src/index.ts";
import {
  beingsById,
  cellsNear,
  chaosBrain,
  chunksById,
  injectionsAt,
  LedgerOracle,
  MindInvariants,
} from "./support/beings2-fuzz.ts";
import { being2, beings2World, chunksOf, life2With } from "./support/beings2-world.ts";
import { Sfc32 } from "./support/sfc32.ts";

/** The border between chunks (1, −2) and (2, −2), at x 63 and 64, where the beings crowd. */
const HOME = [64, -48] as const;
const BEINGS = 12;
const TICKS = 150;
const SEEDS = [1, 2];

/**
 * Small minds that fill, evict, and forget within the run, under a capacity the chunks hold from
 * the start: the twelve beings start six on each side of the border, six to a chunk at most, so
 * that a being that crosses it loses the contest for room while it is full.
 */
const LAWS = life2With(
  (species) => ({
    ...species,
    mind: {
      ...species.mind,
      episodes: 4,
      beliefs: 4,
      relations: 2,
      inbox: 2,
      ops: 6,
      depth: 3,
      halfLife: { episode: 120, belief: 600 },
    },
    relations: { ...species.relations, gap: 60, halfLife: 600 },
  }),
  6,
);

test("holds every invariant after every tick, and the ledger oracle matches every mind", () => {
  const exercised = {
    external: 0,
    relations: 0,
    related: 0,
    tainted: 0,
    flowed: 0,
    beliefs: 0,
    crowded: 0,
    injected: 0,
  };
  for (const seed of SEEDS) {
    const placed = cellsNear(HOME, BEINGS).map((cell, index) => being2(index + 1, cell));
    const world = beings2World({
      controllers: { s1: chaosBrain(HOME) },
      seed: [seed, seed * 31],
      life: LAWS,
      chunks: chunksOf(placed),
    });
    const random = new Sfc32(seed * 7919);
    const invariants = new MindInvariants(LAWS);
    const oracle = new LedgerOracle();
    let before = beingsById(world);
    let chunks = chunksById(world);
    for (let tick = 1; tick <= TICKS; tick += 1) {
      const commands = injectionsAt(tick, before, random);
      const { events } = step(world, commands);
      const after = beingsById(world);
      const record = { tick, before, after, chunks, commands, events };
      const problems = [
        ...invariants.check(record),
        ...oracle.read(events),
        ...oracle.compare(after, tick),
      ];
      if (problems.length > 0) throw new Error(`seed ${seed}:\n${problems.slice(0, 8).join("\n")}`);
      before = after;
      chunks = chunksById(world);
    }
    for (const [name, count] of Object.entries(invariants.seen))
      exercised[name as keyof typeof exercised] += count;
  }
  // Not vacuous: the run made what each invariant is about.
  for (const count of Object.values(exercised)) expect(count).toBeGreaterThan(0);
}, 30_000);
