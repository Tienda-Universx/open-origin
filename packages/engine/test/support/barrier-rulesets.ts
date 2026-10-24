import type { Issue } from "../../src/index.ts";
import {
  type Data,
  type StepRuleset,
  stepRuleset,
  system,
  writable,
  writing,
} from "./step-rulesets.ts";

/**
 * Rulesets that write behind the barrier (ADR 0020, ownership; plan §2.2): each changes the state
 * without telling the engine, at tick `at + lag`: `at`, or `at + 1` for the reference kept from
 * tick 1.
 * Audit finds each at that tick; without audit, encodeSnapshot finds it. Each call returns a
 * fresh ruleset with state of its own, so the cases never affect each other.
 */

export const STALE_CHUNK =
  "the chunk changed without writeChunk: its cached term no longer matches it";
export const STALE_GLOBAL =
  "the global value changed without writeGlobal: its cached digest no longer matches it";

/** A ruleset that bypasses the barrier, and what finds the bypass. */
export type BarrierCase = {
  /** What the ruleset does, as the tests name it. */
  readonly name: string;
  /** The ruleset, for a bypass at tick `at`. */
  readonly ruleset: (at: number) => StepRuleset;
  /** How many ticks after `at` the bypass happens. */
  readonly lag: 0 | 1;
  /** The issues of the integrity_violation that audit and encodeSnapshot report. */
  readonly issues: Issue[];
  /** What fullChecksum throws, when the bypass leaves a value that is not canonical. */
  readonly notCanonical?: Issue;
};

/** A system that keeps the chunk 1,0 it writes at tick 1, and changes it at tick `at + 1`. */
function hoarder(at: number): StepRuleset {
  let stashed: Data | undefined;
  return stepRuleset([
    system("hoarder", (ctx) => {
      if (ctx.tick === 1) stashed = writable(ctx, "1,0");
      if (ctx.tick === at + 1 && stashed !== undefined) stashed.grass = 7;
    }),
  ]);
}

export const BARRIER_CASES: readonly BarrierCase[] = [
  {
    name: "a write through readChunk",
    ruleset: (at) =>
      stepRuleset([
        system("sneaky", (ctx) => {
          if (ctx.tick === at) (ctx.readChunk("0,0") as Data).grass = 9;
        }),
      ]),
    lag: 0,
    issues: [{ path: "/chunks/0,0", message: STALE_CHUNK }],
  },
  {
    name: "a reference from writeChunk kept and changed in a later tick",
    ruleset: hoarder,
    lag: 1,
    issues: [{ path: "/chunks/1,0", message: STALE_CHUNK }],
  },
  {
    name: "a change to the global value without writeGlobal",
    ruleset: (at) =>
      stepRuleset([
        system("sneaky", (ctx) => {
          if (ctx.tick === at) (ctx.readGlobal() as Data).population = 1;
        }),
      ]),
    lag: 0,
    issues: [{ path: "/global", message: STALE_GLOBAL }],
  },
  {
    name: "a commit-time validator that changes the chunk it checks",
    ruleset: (at) => ({
      ...writing(0, 0),
      validateChunk: (key, chunk) => {
        if (key === "0,0" && (chunk as Data).grass === at) (chunk as Data).checked = true;
        return [];
      },
    }),
    lag: 0,
    issues: [{ path: "/chunks/0,0", message: STALE_CHUNK }],
  },
  {
    name: "a write through readChunk of a value that is not canonical",
    ruleset: (at) =>
      stepRuleset([
        system("sneaky", (ctx) => {
          if (ctx.tick === at) (ctx.readChunk("1,0") as Data).grass = Number.NaN;
        }),
      ]),
    lag: 0,
    issues: [
      {
        path: "/chunks/1,0",
        message:
          "the chunk changed without writeChunk, and it is not canonical: at /grass: NaN is not a safe integer",
      },
    ],
    notCanonical: { path: "/chunks/1,0/grass", message: "NaN is not a safe integer" },
  },
];

/** The cases as test.each rows: each case after its name. */
export const BARRIER_ROWS = BARRIER_CASES.map((barrier) => [barrier.name, barrier] as const);
