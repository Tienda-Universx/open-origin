import { describe, expect, test } from "bun:test";
import {
  decodeSnapshot,
  encodeSnapshot,
  fullChecksum,
  stateRoot,
  step,
  versionDifferences,
} from "../src/index.ts";
import { tallyCommands, tallyRuleset } from "./fixtures/tally-ruleset.ts";

/**
 * The frozen version 1 fixture (ADR 0020, snapshots; plan §5.2 "Migraciones", risk R4).
 * `fixtures/snapshot-v1.canonical.json` is the snapshot of the golden tally run (seed
 * [0x5eed, 0x7a11], the commands of tallyCommands) at tick 37, written by encodeSnapshot on
 * 2026-10-24 with ENGINE_VERSION 0.1.0. biome.json excludes exactly this file from formatting
 * (tests/repo/engine-lint.test.ts proves it), and its SHA-256 is pinned here.
 *
 * Every future engine must keep loading this fixture: directly while version 1 is the current
 * schema, and through the `v1 -> v2` migration once version 2 exists. Never regenerate or edit it;
 * a new schema version adds a fixture of its own. The step to tick 40 pins replay under engine
 * 0.1.0 and tally@1; a later version refuses that replay (version_mismatch) by design, and only
 * then may this part change.
 */

const FIXTURE = new URL("./fixtures/snapshot-v1.canonical.json", import.meta.url);
const SHA256 = "1e65fbc3ee050d9e8e638295406d897fcb1216769b880192193277ef76429feb";

/**
 * The checksums of ticks 38 to 40 and the state root at tick 40 after resuming the fixture: equal,
 * when they were recorded, to those of the golden run that was never interrupted.
 */
const RESUMED = {
  38: "7716ba25f5505643e9abdbb11011eae5",
  39: "f2f7031acd8846b4c222dfddbdfbfe7f",
  40: "b79909a9788d5e5713f897a01e15f7f3",
  stateRoot: "85cdb3a436601f6d5814f4dc3f123009",
} as const;

async function fixtureBytes(): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(FIXTURE).arrayBuffer());
}

describe("the frozen snapshot v1 fixture", () => {
  test("has the pinned SHA-256", async () => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await fixtureBytes());
    expect(hasher.digest("hex")).toBe(SHA256);
  });

  test("decodes, re-encodes byte-identically, and steps to tick 40 with tally", async () => {
    // Adapters decode UTF-8 with a fatal TextDecoder (ADR 0020, canonical values).
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await fixtureBytes());
    const world = decodeSnapshot(text, tallyRuleset());
    expect(encodeSnapshot(world)).toBe(text);
    expect(versionDifferences(world)).toEqual([]);
    for (const tick of [38, 39, 40] as const) {
      expect(step(world, tallyCommands(tick)).checksum).toBe(RESUMED[tick]);
    }
    expect(stateRoot(world)).toBe(RESUMED.stateRoot);
    expect(fullChecksum(world)).toBe(RESUMED.stateRoot);
  });
});
