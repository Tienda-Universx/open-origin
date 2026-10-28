/**
 * The brains of beings@2 (ADR 0024, docs/architecture/mind.md "Beliefs" and "Versions and
 * compatibility"): the capture refuses a brain without its behaviors and the namespace of its
 * concepts; `decide` is called without `this`; a result that is not a plain record, a promise
 * among them, is a code error that poisons the world; and a `behavior.kind` the brain did not
 * declare, or an intention with a member of later batches, is rejected as malformed.
 */
import { describe, expect, test } from "bun:test";
import { beings, type Issue, step, worldStatus } from "../src/index.ts";
import { behavior, beingOf, beingsWorld, brain, runTo, spawn } from "./support/beings-world.ts";
import { beings2World, brain2, CONCEPTS, idler2, type Senses2 } from "./support/beings2-world.ts";
import { engineErrorOf } from "./support/engine-error.ts";

/** The issues, by path, of the ruleset of beings@2 over `controllers`. */
function captureIssues(controllers: unknown): Issue[] {
  const error = engineErrorOf(() =>
    beings.createBeingsRuleset({ controllers, rules: "beings@2" } as never),
  );
  expect(error.code).toBe("invalid_ruleset");
  return error.issues.map(({ path, message }) => ({ path, message }));
}

const idle = (): beings.Intention => ({
  steps: [{ kind: "idle", ms: 60_000 }],
  wakeWhen: {},
  behavior: behavior("rest"),
});

describe("the capture of a brain of beings@2", () => {
  test("refuses a brain without behaviors or concepts, with every problem", () => {
    expect(
      captureIssues({
        s1: { brain: "a@1", decide: idle },
        s2: { brain: "b@1", decide: idle, behaviors: ["rest"] },
      }),
    ).toEqual([
      {
        path: "/controllers/s1/behaviors",
        message: "a brain of beings@2 declares its behaviors: 1 to 16 identifiers",
      },
      {
        path: "/controllers/s1/concepts",
        message: "a brain of beings@2 declares the namespace of its concepts",
      },
      {
        path: "/controllers/s2/concepts",
        message: "a brain of beings@2 declares the namespace of its concepts",
      },
    ]);
  });

  test.each([
    [[], "/controllers/s1/behaviors", "the array has 0 entries: it must have from 1 to 16"],
    [
      Array.from({ length: 17 }, (_, n) => `b${n}`),
      "/controllers/s1/behaviors",
      "the array has 17 entries: it must have from 1 to 16",
    ],
    [
      ["rest", "Eat"],
      "/controllers/s1/behaviors/1",
      'a value of type string is not an identifier: 1 to 32 characters, a lowercase letter first, then lowercase letters, digits, ".", "_", or "-"',
    ],
    ["rest", "/controllers/s1/behaviors", "the value must be an array, not a string"],
  ])("refuses behaviors %p", (behaviors, path, message) => {
    expect(
      captureIssues({ s1: { brain: "a@1", decide: idle, behaviors, concepts: "a1" } }),
    ).toEqual([{ path, message }]);
  });

  test.each([["M1"], ["m1.food"], [""], ["1m"], [3], ["m".repeat(47)]])(
    "refuses the namespace of concepts %p",
    (concepts) => {
      expect(
        captureIssues({ s1: { brain: "a@1", decide: idle, behaviors: ["rest"], concepts } }),
      ).toEqual([
        {
          path: "/controllers/s1/concepts",
          message:
            "a namespace of concepts is a lowercase letter, then lowercase letters and digits, at most 46 characters: the first segment of a concept id",
        },
      ]);
    },
  );

  test("accepts 1 and 16 behaviors, and a namespace of 46 characters", () => {
    const sixteen = Array.from({ length: 16 }, (_, n) => `b${n}`);
    for (const behaviors of [["rest"], sixteen]) {
      const ruleset = beings.createBeingsRuleset({
        controllers: { s1: { brain: "a@1", decide: idle, behaviors, concepts: "m".repeat(46) } },
        rules: "beings@2",
      });
      expect(ruleset.versions.brain).toBe("s1:a@1");
    }
  });

  test("keeps the behaviors it captured, whatever the host changes later", () => {
    const behaviors = ["rest"];
    const world = beings2World({
      controllers: { s1: { brain: "a@1", decide: idle, behaviors, concepts: CONCEPTS } },
    });
    behaviors[0] = "eat";
    runTo(world, 2, [spawn(1, { species: "s1", cell: [5, 5] })]);
    expect(beingOf(world, 1).behavior.kind).toBe("rest");
  });
});

describe("the capture of a brain of beings@1", () => {
  test("reports every problem of a brain at once: a bad version and an async decide both", () => {
    const error = engineErrorOf(() =>
      beings.createBeingsRuleset({
        controllers: { s1: { brain: "", decide: async () => idle() } },
      } as never),
    );
    expect(error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: "/controllers/s1/brain", message: "a brain's version must be a non-empty string" },
      {
        path: "/controllers/s1/decide",
        message:
          "a brain's decide must be an ordinary function: an async function or a generator returns a promise or an iterator, never an intention",
      },
    ]);
  });
});

describe("a decision of beings@2", () => {
  test("calls decide without this, where beings@1 calls it on its brain", () => {
    const seen: unknown[] = [];
    function decide(this: unknown): beings.Intention {
      seen.push(this);
      return idle();
    }
    const two = { brain: "a@1", behaviors: ["rest"], concepts: CONCEPTS, decide };
    runTo(beings2World({ controllers: { s1: two } }), 2, [
      spawn(1, { species: "s1", cell: [5, 5] }),
    ]);
    const one = { brain: "a@1", decide };
    runTo(beingsWorldOf(one), 2, [spawn(1, { species: "s1", cell: [5, 5] })]);
    expect(seen).toEqual([undefined, one]);
  });

  test.each([
    ["a promise", () => Promise.resolve(idle())],
    ["an instance of a class", () => new (class Plan {})()],
    ["an array", () => []],
    ["undefined", () => undefined],
    ["a number", () => 7],
    ["a function", () => idle],
  ])("poisons the world when decide returns %s", (_name, decide) => {
    const world = beings2World({ controllers: { s1: brain2(decide as never) } });
    step(world, [spawn(1, { species: "s1", cell: [5, 5] })]);
    const error = engineErrorOf(() => step(world, []));
    expect(error.code).toBe("system_fault");
    expect(error.issues[0]?.message).toContain(
      "the brain of the species s1 returned a value that is not a plain record",
    );
    expect(worldStatus(world).kind).toBe("faulted");
  });

  test("leaves a promise malformed under beings@1, as T4 does", () => {
    const world = beingsWorldOf(brain(() => Promise.resolve(idle()) as never));
    const events = runTo(world, 2, [spawn(1, { species: "s1", cell: [5, 5] })]);
    expect(events.filter(({ type }) => type === "being.intention_rejected")).toHaveLength(1);
  });

  test("accepts a record with no prototype, and rejects a revoked Proxy as malformed", () => {
    const bare = brain2(() => Object.assign(Object.create(null), idle()));
    const world = beings2World({ controllers: { s1: bare } });
    runTo(world, 2, [spawn(1, { species: "s1", cell: [5, 5] })]);
    expect(beingOf(world, 1).outcome.result).toBe("none");
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const proxied = beings2World({ controllers: { s1: brain2(() => revoked.proxy as never) } });
    runTo(proxied, 2, [spawn(1, { species: "s1", cell: [5, 5] })]);
    expect(beingOf(proxied, 1).outcome).toEqual({
      result: "rejected",
      tick: 2,
      reason: "malformed",
    });
  });

  test("rejects as malformed a behavior the brain did not declare, and accepts one it did", () => {
    const lost = brain2(() => ({ ...idle(), behavior: behavior("wander") }));
    const world = beings2World({ controllers: { s1: lost } });
    const events = runTo(world, 2, [spawn(1, { species: "s1", cell: [5, 5] })]);
    expect(
      events
        .filter(({ type }) => type === "being.intention_rejected")
        .map(({ payload }) => payload),
    ).toEqual([{ id: 1, reason: "malformed" }]);
    const declared = beings2World({ controllers: { s1: idler2(60_000) } });
    runTo(declared, 2, [spawn(1, { species: "s1", cell: [5, 5] })]);
    expect(beingOf(declared, 1).behavior).toEqual({ kind: "rest", since: 2, heading: 0 });
  });

  test("rejects as malformed an intention with a mind member, which arrives in a later batch", () => {
    const early = brain2(() => ({ ...idle(), mind: { remember: [] } }) as never);
    const world = beings2World({ controllers: { s1: early } });
    runTo(world, 2, [spawn(1, { species: "s1", cell: [5, 5] })]);
    expect(beingOf(world, 1).outcome).toEqual({ result: "rejected", tick: 2, reason: "malformed" });
  });

  test("gives the brain senses it may keep: writing to them changes nothing", () => {
    let kept: Senses2 | undefined;
    const keeper = brain2((senses) => {
      kept ??= senses;
      return idle();
    });
    const world = beings2World({ controllers: { s1: keeper } });
    runTo(world, 2, [spawn(1, { species: "s1", cell: [5, 5] })]);
    (kept?.self.traits as { retention: number }).retention = 1;
    expect((beingOf(world, 1) as beings.Being2).traits.retention).toBe(1000);
  });
});

/** A world of beings@1 over the test genesis with `controller` for the species s1. */
function beingsWorldOf(controller: beings.Controller) {
  return beingsWorld({ controllers: { s1: controller } });
}
