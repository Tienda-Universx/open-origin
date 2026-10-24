import type { CanonicalValue, Ruleset } from "../../src/index.ts";

/** A ruleset over any canonical global and chunk values, as the world tests use them. */
export type TestRuleset = Ruleset<CanonicalValue, CanonicalValue>;

/**
 * A valid ruleset with two systems and two command types, one of them without streams. Each call
 * returns fresh objects and functions, so a test can change it freely.
 */
export function testRuleset(): TestRuleset {
  return {
    versions: { ruleset: "test@1", generator: "flat@1", brain: "none@1" },
    systems: [
      { name: "growth", streams: ["growth"], run: () => undefined },
      { name: "weather", streams: ["weather.rain", "weather.wind"], run: () => undefined },
    ],
    commands: {
      say: { check: () => undefined, apply: () => undefined },
      move: { streams: ["conflicts"], check: () => undefined, apply: () => undefined },
    },
    validateGlobal: () => [],
    validateChunk: () => [],
  };
}

/** `ruleset` with its parts replaced by `parts`, for a ruleset a type would reject. */
export function rulesetWith(parts: Record<string, unknown>): TestRuleset {
  // Deliberately ill-typed, as a JavaScript host can be.
  return { ...testRuleset(), ...parts } as unknown as TestRuleset;
}
