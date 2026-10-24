import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { ENGINE_VERSION, fullChecksum, stateRoot, step } from "../src/index.ts";
import { GOLDEN_TALLY } from "./fixtures/golden-tally.ts";
import { TALLY_VERSIONS, tallyCommands, tallyWorld } from "./fixtures/tally-ruleset.ts";

/**
 * Golden replay (plan §8 "Golden"): the tally run must give the pinned checksums at ticks 1, 10,
 * 100, and 1000, and the pinned final state root, under the pinned engine and ruleset versions.
 * The values pin behavior and do not prove it correct (fixtures/golden-tally.ts).
 */

// 1,000 ticks take about a third of a second here; a cold CI runner can take longer.
setDefaultTimeout(30_000);

describe("the golden tally run", () => {
  test("runs under the versions its values were recorded with", () => {
    expect(ENGINE_VERSION).toBe(GOLDEN_TALLY.engineVersion);
    expect(TALLY_VERSIONS).toEqual(GOLDEN_TALLY.versions);
  });

  test("gives the pinned checksums and state root, and exercises every part of tally", () => {
    const world = tallyWorld(GOLDEN_TALLY.seed);
    const checksums: Record<string, string> = {};
    const events = new Set<string>();
    const reasons = new Set<string>();
    let created = 0;
    for (let tick = 1; tick <= GOLDEN_TALLY.ticks; tick += 1) {
      const result = step(world, tallyCommands(tick));
      if (`${tick}` in GOLDEN_TALLY.checksums) checksums[tick] = result.checksum;
      created += result.stats.createdChunks;
      for (const event of result.events) {
        events.add(event.type);
        const { reason } = event.payload as { reason?: string };
        if (reason !== undefined) reasons.add(reason);
      }
    }
    expect(checksums).toEqual(GOLDEN_TALLY.checksums);
    expect(stateRoot(world)).toBe(GOLDEN_TALLY.stateRoot);
    expect(fullChecksum(world)).toBe(GOLDEN_TALLY.stateRoot);
    // The run covers what tally claims to exercise, so the golden values are not vacuous.
    expect(created).toBe(143);
    expect([...events].sort()).toEqual([
      "born",
      "census",
      "engine.command_rejected",
      "lottery.won",
      "market.sold",
      "migrated",
    ]);
    expect([...reasons].sort()).toEqual(["no_chunk", "too_much", "unknown_type"]);
  });
});
