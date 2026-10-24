import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "./files.ts";
import { createLintHarness } from "./lint-harness.ts";

/**
 * Proves that biome.json keeps Biome away from the frozen snapshot fixture, and from nothing else
 * (plan risk R4): the fixture is canonical text on one line, whose bytes its SHA-256 pins, so a
 * formatter must never rewrite it, while every other JSON file stays formatted and linted.
 */

// A cold CI runner can exceed Bun's 5-second default for one Biome run.
setDefaultTimeout(60_000);

const { cleanup, scratch } = await createLintHarness();
afterAll(cleanup);

const FIXTURE = "packages/engine/test/fixtures/snapshot-v1.canonical.json";

/** Paths next to the fixture, which a wider exclusion would also hide. */
const NEAR_MISSES = [
  "packages/engine/test/fixtures/snapshot-v2.canonical.json",
  "packages/engine/test/fixtures/other.json",
  "packages/engine/test/snapshot-v1.canonical.json",
];

/** A Biome diagnostic header: `<path> <category> ━━━`, with or without a line and column. */
const DIAGNOSTIC_HEADER = /^(\S+?)(?::\d+:\d+)? (\S+) ━/gm;

describe("Biome's exclusion of the frozen snapshot fixture", () => {
  test("covers exactly the fixture's path", async () => {
    const text = await Bun.file(`${REPO_ROOT}${FIXTURE}`).text();
    // One line of canonical text longer than the line width, which the formatter would break.
    expect(text.length).toBeGreaterThan(100);
    expect(text).not.toContain("\n");
    for (const path of [FIXTURE, ...NEAR_MISSES]) {
      const absolute = join(scratch, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
    }
    const result = Bun.spawnSync(
      [
        "bunx",
        "--no-install",
        "--bun",
        "biome",
        "check",
        "--max-diagnostics=none",
        `--config-path=${scratch}`,
        join(scratch, "packages/engine/test"),
      ],
      // A hung Biome is killed, instead of blocking the run.
      { cwd: REPO_ROOT, timeout: 30_000 },
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    const flagged = [...output.matchAll(DIAGNOSTIC_HEADER)].map((match) => ({
      path: (match[1] ?? "").replace(`${scratch}/`, ""),
      category: match[2],
    }));
    expect(flagged.sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      [...NEAR_MISSES].sort().map((path) => ({ path, category: "format" })),
    );
    // The fixture is not even read: Biome checks the near misses alone.
    expect(output.match(/Checked (\d+) files?/)?.[1]).toBe(`${NEAR_MISSES.length}`);
  });
});
