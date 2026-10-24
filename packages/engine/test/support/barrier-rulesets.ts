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
 * without telling the engine, at tick `at`, or at `at + 1` for the reference kept from tick 1.
 * Audit finds each at that tick; without audit, encodeSnapshot finds it. Each call returns a
 * fresh ruleset with state of its own, so the cases never affect each other.
 */

export const STALE_CHUNK =
  "the chunk changed without writeChunk: its cached term no longer matches it";
export const STALE_GLOBAL =
  "the global value changed without writeGlobal: its cached digest no longer matches it";

/** A case: its name, its ruleset for a bypass at `at`, and the issues that name the bypass. */
export type BarrierCase = [string, (at: number) => StepRuleset, Issue[]];

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

export const BARRIER_CASES: BarrierCase[] = [
  [
    "a write through readChunk",
    (at) =>
      stepRuleset([
        system("sneaky", (ctx) => {
          if (ctx.tick === at) (ctx.readChunk("0,0") as Data).grass = 9;
        }),
      ]),
    [{ path: "/chunks/0,0", message: STALE_CHUNK }],
  ],
  [
    "a reference from writeChunk kept and changed in a later tick",
    hoarder,
    [{ path: "/chunks/1,0", message: STALE_CHUNK }],
  ],
  [
    "a change to the global value without writeGlobal",
    (at) =>
      stepRuleset([
        system("sneaky", (ctx) => {
          if (ctx.tick === at) (ctx.readGlobal() as Data).population = 1;
        }),
      ]),
    [{ path: "/global", message: STALE_GLOBAL }],
  ],
  [
    "a commit-time validator that changes the chunk it checks",
    (at) => ({
      ...writing(0, 0),
      validateChunk: (key, chunk) => {
        if (key === "0,0" && (chunk as Data).grass === at) (chunk as Data).checked = true;
        return [];
      },
    }),
    [{ path: "/chunks/0,0", message: STALE_CHUNK }],
  ],
  [
    "a write through readChunk of a value that is not canonical",
    (at) =>
      stepRuleset([
        system("sneaky", (ctx) => {
          if (ctx.tick === at) (ctx.readChunk("1,0") as Data).grass = Number.NaN;
        }),
      ]),
    [
      {
        path: "/chunks/1,0",
        message:
          "the chunk changed without writeChunk, and it is not canonical: at /grass: NaN is not a safe integer",
      },
    ],
  ],
];

/** The tick at which the case `name` bypasses the barrier, for a ruleset made with `at`. */
export const bypassTick = (name: string, at: number): number =>
  name.includes("later tick") ? at + 1 : at;
