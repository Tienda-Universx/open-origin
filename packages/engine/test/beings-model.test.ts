/**
 * The state of the beings layer (ADR 0023, docs/architecture/beings.md): a being, a materialized
 * chunk with its beings, food taken, and due tick, and the occupancy index of the global value.
 * Validators report every problem at once, at its path, and never throw.
 */
import { describe, expect, test } from "bun:test";
import { beings, copyCanonical, type Issue } from "../src/index.ts";

const {
  MAX_TICK,
  beingIssues,
  beingsChunkIssues,
  insertOccupied,
  occupancyIssues,
  pruneOccupancy,
} = beings;

/** A valid being at `cell`, waking at `wake`. */
function being(id: number, cell: [number, number], wake = 10): { [key: string]: unknown } {
  return {
    id,
    species: "s1",
    stage: "adult",
    born: 0,
    cell,
    needs: { nutrition: 800_000, rest: 700_000 },
    health: 1_000_000,
    anchor: 0,
    traits: { appetite: 1000, sleepiness: 900, curiosity: 1100 },
    condition: "ok",
    activity: {
      kind: "walk",
      start: 0,
      dirs: "0127",
      ms: [45_000, 108_630, 153_630, 217_260],
      done: 1,
    },
    plan: [{ kind: "eat", untilNutrition: 950_000 }],
    behavior: { kind: "forage", since: 0, heading: 2 },
    wakeWhen: { nutritionBelow: 150_000, lightBelow: 100 },
    wake,
    outcome: { result: "none", tick: 0, reason: "" },
    cooldowns: [{ cell: [3, 4], until: 300 }],
  };
}

/** Every issue of `value` as a being, at paths under `/being`. */
function issuesOf(value: unknown): Issue[] {
  return beingIssues(value, "/being");
}

/** A copy of `value` with the member at the pointer `path` (under the being) set or deleted. */
function edited(value: unknown, path: string, member: unknown): { [key: string]: unknown } {
  const copy = copyCanonical(value) as { [key: string]: unknown };
  const parts = path.split("/").slice(1);
  const name = parts.pop() ?? "";
  let parent: { [key: string]: unknown } = copy;
  for (const part of parts) parent = parent[part] as { [key: string]: unknown };
  if (member === undefined) delete parent[name];
  else parent[name] = member;
  return copy;
}

describe("beingIssues", () => {
  test("accepts a valid being in each activity, with or without wake conditions", () => {
    expect(issuesOf(being(1, [0, 0]))).toEqual([]);
    const activities = [
      { kind: "idle", start: 5, ms: 60_000 },
      { kind: "eat", start: 5, untilNutrition: 950_000, bites: 0 },
      { kind: "sleep", untilRest: 950_000, forced: true },
    ];
    for (const activity of activities) {
      expect(issuesOf(edited(being(1, [0, 0]), "/activity", activity))).toEqual([]);
    }
    expect(issuesOf(edited(being(1, [0, 0]), "/wakeWhen", {}))).toEqual([]);
    expect(issuesOf(edited(being(1, [0, 0]), "/plan", []))).toEqual([]);
  });

  test("reports every problem at once, each at its path", () => {
    const broken = edited(
      edited(edited(being(0, [0, 0]), "/needs/rest", 1_000_001), "/condition", "asleep"),
      "/extra",
      true,
    );
    expect(issuesOf(edited(broken, "/born", undefined))).toEqual([
      {
        path: "/being/extra",
        message:
          "unknown member: the members here are activity, anchor, behavior, born, cell, condition, cooldowns, health, id, needs, outcome, plan, species, stage, traits, wake, wakeWhen",
      },
      { path: "/being/born", message: "the member is missing" },
      { path: "/being/id", message: "0 is out of bounds: it must be from 1 to 9007199254740991" },
      {
        path: "/being/needs/rest",
        message: "1000001 is out of bounds: it must be from 0 to 1000000",
      },
      {
        path: "/being/condition",
        message: "a value of type string is not one of ok, incapacitated",
      },
    ]);
  });

  test.each([
    ["/cell/0", -0x8000_0000, -0x8000_0001],
    ["/cell/1", 0x7fff_ffff, 0x8000_0000],
    ["/traits/appetite", 10_000, 10_001],
    ["/behavior/heading", 7, 8],
    ["/wakeWhen/lightAbove", 0x10_0000, 0x10_0001],
  ])("bounds %s", (path, ok, bad) => {
    expect(issuesOf(edited(being(1, [0, 0]), path, ok))).toEqual([]);
    expect(issuesOf(edited(being(1, [0, 0]), path, bad))[0]?.path).toBe(`/being${path}`);
  });

  test("checks a walk's route: directions 0 to 7, one arrival per step, rising, and a step not yet done", () => {
    const walk = (activity: unknown) => issuesOf(edited(being(1, [0, 0]), "/activity", activity));
    const base = { kind: "walk", start: 0, dirs: "01", ms: [10, 20], done: 0 };
    expect(walk(base)).toEqual([]);
    expect(walk({ ...base, dirs: "08" })).toEqual([
      {
        path: "/being/activity/dirs",
        message: "a walk is 1 to 64 directions, each a digit from 0 to 7",
      },
    ]);
    expect(walk({ ...base, dirs: "" })[0]?.path).toBe("/being/activity/dirs");
    expect(walk({ ...base, dirs: "0".repeat(65), ms: [] })[0]?.path).toBe("/being/activity/dirs");
    expect(walk({ ...base, ms: [10] })).toEqual([
      { path: "/being/activity/ms", message: "a walk has one arrival per direction: 2, not 1" },
    ]);
    expect(walk({ ...base, ms: [20, 20] })).toEqual([
      { path: "/being/activity/ms/1", message: "arrivals rise strictly: 20 must exceed 20" },
    ]);
    expect(walk({ ...base, done: 2 })).toEqual([
      { path: "/being/activity/done", message: "2 is out of bounds: it must be from 0 to 1" },
    ]);
  });

  test("bounds the plan, the cooldowns, and the outcome's reason", () => {
    const steps = [
      { kind: "idle", ms: 1 },
      { kind: "sleep", untilRest: 1 },
      { kind: "walk", dirs: "3" },
    ];
    expect(issuesOf(edited(being(1, [0, 0]), "/plan", steps))).toEqual([
      { path: "/being/plan", message: "the array has 3 entries: it must have from 0 to 2" },
    ]);
    const cooldowns = Array.from({ length: 5 }, () => ({ cell: [0, 0], until: 1 }));
    expect(issuesOf(edited(being(1, [0, 0]), "/cooldowns", cooldowns))[0]?.path).toBe(
      "/being/cooldowns",
    );
    expect(issuesOf(edited(being(1, [0, 0]), "/outcome/reason", "x".repeat(65)))).toEqual([
      { path: "/being/outcome/reason", message: "a reason has at most 64 characters, not 65" },
    ]);
  });

  test("never throws on values that are not records", () => {
    for (const value of [undefined, null, 7, "being", []])
      expect(() => issuesOf(value)).not.toThrow();
    expect(issuesOf([])).toEqual([
      {
        path: "/being",
        message:
          "the value must be a record { activity, anchor, behavior, born, cell, condition, cooldowns, health, id, needs, outcome, plan, species, stage, traits, wake, wakeWhen }, not an array",
      },
    ]);
  });
});

describe("beingsChunkIssues", () => {
  const chunk = (beingsList: unknown[], depletion: unknown[] = [], due?: number) => ({
    beings: beingsList,
    depletion,
    due: due ?? Math.min(MAX_TICK, ...beingsList.map((b) => (b as { wake: number }).wake)),
  });

  test("accepts a chunk of beings in its cells, ordered by id, with its due tick", () => {
    // The earliest wake is not the last being's, so due must be the minimum, not the last wake.
    expect(beingsChunkIssues("0,0", chunk([being(1, [0, 0], 5), being(3, [31, 31], 7)]))).toEqual(
      [],
    );
    expect(beingsChunkIssues("-1,-1", chunk([being(2, [-1, -1]), being(4, [-32, -32])]))).toEqual(
      [],
    );
    expect(
      beingsChunkIssues("5,-3", chunk([], [{ cell: 0, taken: 1, since: 0 }], MAX_TICK)),
    ).toEqual([]);
  });

  test("reports a being whose cell lies in another chunk, on either axis", () => {
    expect(beingsChunkIssues("0,0", chunk([being(1, [32, 0]), being(2, [0, -1])]))).toEqual([
      {
        path: "/beings/0/cell",
        message: "the cell (32, 0) lies in chunk 1,0, not in this chunk 0,0",
      },
      {
        path: "/beings/1/cell",
        message: "the cell (0, -1) lies in chunk 0,-1, not in this chunk 0,0",
      },
    ]);
  });

  test("requires ids rising strictly and due equal to the earliest wake", () => {
    expect(beingsChunkIssues("0,0", chunk([being(2, [0, 0]), being(2, [1, 1])]))).toEqual([
      { path: "/beings/1/id", message: "ids rise strictly: 2 must exceed 2" },
    ]);
    expect(beingsChunkIssues("0,0", chunk([being(1, [0, 0], 9)], [], 8))).toEqual([
      { path: "/due", message: "due is 8, but the earliest wake of the chunk's beings is 9" },
    ]);
    expect(beingsChunkIssues("0,0", chunk([], [], 5))).toEqual([
      { path: "/due", message: `due is 5, but a chunk without beings has due ${MAX_TICK}` },
    ]);
  });

  test("requires depletion ordered by cell, within the chunk, with something taken", () => {
    const depletion = [
      { cell: 5, taken: 3, since: 0 },
      { cell: 5, taken: 1, since: 0 },
      { cell: 1024, taken: 1, since: 0 },
      { cell: 6, taken: 0, since: 0 },
    ];
    expect(beingsChunkIssues("0,0", chunk([], depletion, MAX_TICK))).toEqual([
      { path: "/depletion/1/cell", message: "cells rise strictly: 5 must exceed 5" },
      { path: "/depletion/2/cell", message: "1024 is out of bounds: it must be from 0 to 1023" },
      { path: "/depletion/3/taken", message: "0 is out of bounds: it must be from 1 to 1048576" },
    ]);
  });

  test("reports each being's own problems under its index", () => {
    const broken = edited(being(1, [0, 0]), "/health", -1);
    expect(beingsChunkIssues("0,0", chunk([broken]))).toEqual([
      { path: "/beings/0/health", message: "-1 is out of bounds: it must be from 0 to 1000000" },
    ]);
  });
});

describe("occupancy", () => {
  test("accepts keys in the kernel's order without repeats, inside the world", () => {
    expect(occupancyIssues(["-1,0", "0,0", "10,2", "9,9"], "/occupancy")).toEqual([]);
    expect(occupancyIssues([], "/occupancy")).toEqual([]);
  });

  test("reports keys out of order, repeated, malformed, or outside the world", () => {
    expect(occupancyIssues(["0,0", "-1,0", "-1,0", "0,x", "67108864,0"], "/occupancy")).toEqual([
      {
        path: "/occupancy/1",
        message: 'keys rise strictly in UTF-16 order: "-1,0" must come after "0,0"',
      },
      {
        path: "/occupancy/2",
        message: 'keys rise strictly in UTF-16 order: "-1,0" must come after "-1,0"',
      },
      expect.objectContaining({ path: "/occupancy/3" }),
      expect.objectContaining({ path: "/occupancy/4" }),
    ]);
  });

  test("insertOccupied keeps the order and adds a key once", () => {
    const keys = ["-1,0", "10,2"];
    expect(insertOccupied(keys, "0,0")).toBe(true);
    expect(insertOccupied(keys, "0,0")).toBe(false);
    expect(insertOccupied(keys, "9,9")).toBe(true);
    expect(insertOccupied(keys, "-2,5")).toBe(true);
    expect(keys).toEqual(["-1,0", "-2,5", "0,0", "10,2", "9,9"]);
    expect(occupancyIssues(keys, "")).toEqual([]);
  });

  test("pruneOccupancy drops exactly the keys whose chunk holds no being, keeping the order", () => {
    const keys = ["-1,0", "0,0", "10,2", "9,9"];
    const empty = new Set(["0,0", "9,9"]);
    expect(pruneOccupancy(keys, (key) => empty.has(key))).toEqual(["-1,0", "10,2"]);
    expect(keys).toEqual(["-1,0", "0,0", "10,2", "9,9"]);
  });
});
