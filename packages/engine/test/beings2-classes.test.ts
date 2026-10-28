/**
 * The classification registry of beings@2 (ADR 0008, ADR 0024; docs/architecture/mind.md
 * "Classification"): every member of a being, nested ones included, the records of its mind among
 * them, has a class; so do every event the beings layer emits and every command it handles; the
 * taints, the exposure, and the kind `external` are C3; and the senses copy only what the registry
 * marks as sensed, never a C3 member nor one it does not name.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { copyAllowed, copySensed } from "../src/beings/classes.ts";
import { beings, mind } from "../src/index.ts";
import { being2, gateMind, idler2 } from "./support/beings2-world.ts";
import {
  belief,
  external,
  foodAt,
  heard,
  mindOf,
  own,
  relationship,
  seen,
} from "./support/mind-records.ts";

const { BEING_CLASSES, COMMAND_CLASSES, EVENT_CLASSES } = beings;
type ClassNode = beings.ClassNode;

/** The node of the member `name` of the record node `node`, if it names one. */
function memberOf(node: ClassNode, name: string): ClassNode | undefined {
  return node.members?.find((member) => member.name === name)?.node;
}

/** A value below another that a node classifies, with its node, if any names it, and its path. */
type Visit = {
  readonly node: ClassNode | undefined;
  readonly value: unknown;
  readonly path: string;
};

/** The members or entries of `value` at `path`, each with the node `node` gives it, if any. */
function inside(node: ClassNode, value: unknown, path: string): Visit[] {
  if (node.kinds !== undefined) {
    const kind = (value as { kind: string }).kind;
    const of = node.kinds.find((entry) => entry.kind === kind)?.node;
    return of === undefined
      ? [{ node: undefined, value, path: `${path}/kind` }]
      : inside(of, value, path);
  }
  const each = node.each;
  if (each !== undefined && Array.isArray(value))
    return value.map((entry, index) => ({ node: each, value: entry, path: `${path}/${index}` }));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value).map(([name, member]) => ({
    node: memberOf(node, name),
    value: member,
    path: `${path}/${name}`,
  }));
}

/**
 * The paths of every member of `value`, at any depth, that `node` does not classify: the registry
 * must name each one. Lists follow `each`, records of several kinds their `kind`.
 */
function unclassified(node: ClassNode, value: unknown, path = ""): string[] {
  return inside(node, value, path).flatMap((visit) =>
    visit.node === undefined ? [visit.path] : unclassified(visit.node, visit.value, visit.path),
  );
}

/** Every path below `value` whose class in `node` is C3. */
function secretPaths(node: ClassNode, value: unknown, path = ""): string[] {
  return inside(node, value, path).flatMap(({ node: inner, value: member, path: at }) => {
    if (inner === undefined) return [];
    return [...(inner.class === "C3" ? [at] : []), ...secretPaths(inner, member, at)];
  });
}

/** A mind holding every kind of record with every optional member. */
const FULL_MIND = mindOf({
  episodes: [
    own(1, { cell: [-5, 7], v: 2 }),
    seen(2, 40),
    own(3, { kind: "ate", v: 25 }),
    own(4, { kind: "failed", v: 3 }),
    heard(5, 41, { tn: 2, ex: 4 }),
    external(6, { tn: 2, p: { p: "m1.food-at", a: [{ c: [1, 2] }, { e: 3 }], v: 2, neg: true } }),
  ],
  beliefs: [
    belief(7, { ev: [1, 5], tn: 2, ex: 4, who: 41, src: 3, p: { p: "obs.x", a: [{ n: 4 }] } }),
  ],
  relations: [relationship(8, 41, { tn: 1, talk: 5, turns: 2 })],
  inbox: [
    { who: 41, t: 3, cell: [1, 1], act: "tell", p: foodAt(1, 1), band: 1, tn: 2, ex: 4 },
    { t: 3, act: "tell", p: foodAt(2, 2), tn: 2, ex: 0 },
  ],
  exposure: 6,
  quota: { day: 3, said: 4, woken: 1 },
});

/** Beings of beings@2 with every kind of activity and planned step and every optional member. */
const FULL_BEINGS: beings.Being2[] = [
  {
    ...being2(1, [0, 0], { mind: FULL_MIND }),
    activity: { kind: "walk", start: 1, dirs: "02", ms: [10, 20], done: 1 },
    plan: [
      { kind: "eat", untilNutrition: 5 },
      { kind: "idle", ms: 5 },
    ],
    wakeWhen: { nutritionBelow: 1, restBelow: 1, lightBelow: 1, lightAbove: 2 },
    cooldowns: [{ cell: [1, 1], until: 9 }],
  },
  {
    ...being2(2, [0, 0]),
    activity: { kind: "eat", start: 1, untilNutrition: 9, bites: 2 },
    plan: [{ kind: "sleep", untilRest: 5 }],
  },
  {
    ...being2(3, [0, 0]),
    activity: { kind: "sleep", untilRest: 9, forced: true },
    plan: [{ kind: "walk", dirs: "1" }],
  },
  { ...being2(4, [0, 0], { mind: gateMind() }) },
];

describe("the classification registry", () => {
  test("classifies every member of a being of beings@2, the records of its mind included", () => {
    for (const being of FULL_BEINGS) expect(beings.beingIssues(being, "", "beings@2")).toEqual([]);
    expect(FULL_BEINGS.flatMap((being) => unclassified(BEING_CLASSES, being))).toEqual([]);
  });

  test("reports a member it does not name, so that a member added without a class fails here", () => {
    const added = { ...being2(1, [0, 0]), mood: 3, mind: { ...mind.newMind(0), secret: 1 } };
    expect(unclassified(BEING_CLASSES, added).sort()).toEqual(["/mind/secret", "/mood"]);
    const dream = { ...mind.newMind(0), next: 2, episodes: [{ ...own(1), kind: "dream" }] };
    expect(unclassified(BEING_CLASSES, { ...being2(1, [0, 0]), mind: dream })).toEqual([
      "/mind/episodes/0/kind",
    ]);
  });

  test("classifies the taints, the exposure, and the kind external as C3, and nothing else", () => {
    const [full] = FULL_BEINGS;
    expect(secretPaths(BEING_CLASSES, full).sort()).toEqual([
      "/mind/beliefs/0/ex",
      "/mind/beliefs/0/tn",
      "/mind/episodes/4/ex",
      "/mind/episodes/4/tn",
      "/mind/episodes/5/kind",
      "/mind/episodes/5/tn",
      "/mind/exposure",
      "/mind/inbox/0/ex",
      "/mind/inbox/0/tn",
      "/mind/inbox/1/ex",
      "/mind/inbox/1/tn",
      "/mind/relations/0/tn",
    ]);
  });

  test("classifies as C0 the identity, cell, and kind of activity that others perceive", () => {
    for (const name of ["id", "species", "stage", "born", "cell"])
      expect(memberOf(BEING_CLASSES, name)?.class).toBe("C0");
    const activity = memberOf(BEING_CLASSES, "activity");
    for (const kind of activity?.kinds ?? []) expect(memberOf(kind.node, "kind")?.class).toBe("C0");
    expect(activity?.kinds?.map(({ kind }) => kind)).toEqual(["eat", "idle", "sleep", "walk"]);
  });

  test("marks as sensed exactly the members of the senses of T4, none of them C3", () => {
    const sensed = (BEING_CLASSES.members ?? []).filter((member) => member.sensed);
    expect(sensed.map(({ name }) => name)).toEqual([
      "activity",
      "behavior",
      "cell",
      "condition",
      "cooldowns",
      "health",
      "id",
      "needs",
      "outcome",
      "species",
      "traits",
    ]);
    expect(sensed.every(({ node }) => node.class !== "C3")).toBe(true);
  });

  test("lets the senses copy only what it allows: no member it does not name, nor a C3 one", () => {
    const self = {
      id: 1,
      species: "s1",
      cell: [2, 3],
      mind: FULL_MIND,
      stage: "adult",
      secret: 7,
      activity: { kind: "walk", start: 1, dirs: "0", ms: [1], done: 0, hidden: 1 },
      outcome: { result: "none", tick: 0, reason: "" },
    };
    const copy = copySensed(self);
    expect(copy).toEqual({
      id: 1,
      species: "s1",
      cell: [2, 3],
      activity: { kind: "walk", start: 1, dirs: "0", ms: [1], done: 0 },
      outcome: { result: "none", tick: 0, reason: "" },
    });
    expect(copy.cell).not.toBe(self.cell);
  });

  test("lets an allowlist copy of a mind hold no taint, exposure, or C3 kind, and all the rest", () => {
    const node = memberOf(BEING_CLASSES, "mind") as ClassNode;
    const copy = copyAllowed(node, FULL_MIND) as mind.Mind;
    expect(secretPaths(node, FULL_MIND).length).toBeGreaterThan(5);
    expect(secretPaths(node, copy)).toEqual([]);
    // Everything else is there: only the C3 members are missing, the kind external among them.
    const { tn: _tn, ex: _ex, ...untainted } = FULL_MIND.beliefs[0] as mind.Belief;
    expect(copy.beliefs[0] as unknown).toEqual(untainted);
    expect(Object.keys(copy).sort()).toEqual([
      "beliefs",
      "episodes",
      "inbox",
      "next",
      "quota",
      "relations",
    ]);
    expect(copy.episodes[5]).not.toHaveProperty("kind");
    expect(copy.inbox[0] as unknown).toEqual({
      who: 41,
      t: 3,
      cell: [1, 1],
      act: "tell",
      p: foodAt(1, 1),
      band: 1,
    });
  });

  test("classifies every event the beings layer emits, and no event it does not", () => {
    const directory = new URL("../src/beings/", import.meta.url);
    const emitted = new Set<string>();
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(new URL(file, directory), "utf8");
      for (const match of text.matchAll(/\bemit\(\s*"([a-z_.]+)"/g))
        emitted.add(match[1] as string);
    }
    expect(emitted.size).toBeGreaterThan(5);
    expect(EVENT_CLASSES.map(({ type }) => type).sort()).toEqual([...emitted].sort());
  });

  test("classifies every command of the ruleset beings@2", () => {
    const ruleset = beings.createBeingsRuleset({
      controllers: { s1: idler2(1) },
      rules: "beings@2",
    });
    expect(COMMAND_CLASSES.map(({ type }) => type)).toEqual(Object.keys(ruleset.commands).sort());
  });
});
