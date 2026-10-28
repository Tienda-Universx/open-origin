/**
 * The classification registry of beings@2 (ADR 0008, ADR 0024; docs/architecture/mind.md
 * "Classification"): every member of a being, nested ones included, the records of its mind among
 * them, has a class; so do every event the beings layer emits and every command it handles; the
 * taints, the exposure, and the kind `external` are C3; and the senses copy only what the registry
 * marks as sensed, never a C3 member nor one it does not name.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  ACTIVITY_MEMBERS,
  BEHAVIOR_MEMBERS,
  CAPTURED_MEMBERS,
  COOLDOWN_MEMBERS,
  NEEDS_MEMBERS,
  OUTCOME_MEMBERS,
  STEP_MEMBERS,
  WAKE_MEMBERS,
} from "../src/beings/being.ts";
import { copyAllowed, copyHeard, copySensed } from "../src/beings/classes.ts";
import { MIND_SHAPES } from "../src/beings/minds.ts";
import { perceiveBeings } from "../src/beings/perception.ts";
import { BEINGS2_RULES } from "../src/beings/rules.ts";
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
    outcome: { result: "done", tick: 1, reason: "", units: 25 },
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
  {
    ...being2(5, [0, 0]),
    activity: {
      kind: "talk",
      start: 1,
      to: 4,
      act: "tell",
      captured: {
        p: { p: "t1.food", a: [{ c: [1, 2] }, { e: 3 }], v: 2, neg: true },
        band: 1,
        tn: 2,
        ex: 5,
      },
    },
  },
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

  test("classifies a talk's hearer and act as C0, and what it captured to say as C3, all of it", () => {
    // A talk shows its hearer and its act, which an observer sees said (mind.md, "Classification").
    const activity = memberOf(BEING_CLASSES, "activity") as ClassNode;
    const talk = (activity.kinds ?? []).find(({ kind }) => kind === "talk")?.node as ClassNode;
    expect(["to", "act"].map((name) => memberOf(talk, name)?.class)).toEqual(["C0", "C0"]);
    const talking = FULL_BEINGS[4];
    const paths = secretPaths(BEING_CLASSES, talking).filter((path) =>
      path.startsWith("/activity"),
    );
    expect(paths.sort()).toEqual([
      "/activity/captured",
      "/activity/captured/band",
      "/activity/captured/ex",
      "/activity/captured/p",
      "/activity/captured/p/a",
      "/activity/captured/p/a/0",
      "/activity/captured/p/a/0/c",
      "/activity/captured/p/a/1",
      "/activity/captured/p/a/1/e",
      "/activity/captured/p/neg",
      "/activity/captured/p/p",
      "/activity/captured/p/v",
      "/activity/captured/tn",
    ]);
  });

  test("classifies as C0 the identity, cell, and kind of activity that others perceive", () => {
    for (const name of ["id", "species", "stage", "born", "cell"])
      expect(memberOf(BEING_CLASSES, name)?.class).toBe("C0");
    const activity = memberOf(BEING_CLASSES, "activity");
    for (const kind of activity?.kinds ?? []) expect(memberOf(kind.node, "kind")?.class).toBe("C0");
    expect(activity?.kinds?.map(({ kind }) => kind)).toEqual([
      "eat",
      "idle",
      "sleep",
      "talk",
      "walk",
    ]);
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
    // A talk under way: the senses copy its hearer and act, never what it captured.
    const talking = { ...self, activity: (FULL_BEINGS[4] as beings.Being2).activity };
    expect(copySensed(talking).activity).toEqual({ kind: "talk", start: 1, to: 4, act: "tell" });
  });

  test("lets a brain hear of a message its sensed members, as a copy that shares nothing with it", () => {
    const message = {
      who: 4,
      t: 9,
      cell: [2, 3],
      act: "tell",
      p: { p: "t1.food", a: [{ c: [5, 6] }, { e: 7 }, { n: 8 }], v: 1, neg: true },
      band: 2,
      tn: 2,
      ex: 1,
    };
    const heard = copyHeard(message);
    // Neither the tick nor the taints: what the brain hears never tells it when or how tainted.
    expect(heard).toEqual({
      who: 4,
      cell: [2, 3],
      act: "tell",
      p: { p: "t1.food", a: [{ c: [5, 6] }, { e: 7 }, { n: 8 }], v: 1, neg: true },
      band: 2,
    });
    const shared = (copy: unknown, held: unknown): boolean =>
      typeof copy === "object" &&
      copy !== null &&
      (copy === held ||
        Object.entries(copy).some(([name, member]) =>
          shared(member, (held as Record<string, unknown>)[name]),
        ));
    expect(shared(heard, message)).toBe(false);
    expect(shared(message, message)).toBe(true);
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

  test("classifies every member the validators of beings@2 accept, optional ones included", () => {
    const node = (name: string) => memberOf(BEING_CLASSES, name) as ClassNode;
    const missing: string[] = [];
    const expectIn = (where: ClassNode | undefined, names: readonly string[], at: string) => {
      for (const name of names)
        if (memberOf(where ?? { class: "C1" }, name) === undefined) missing.push(`${at}/${name}`);
    };
    const kindOf = (where: ClassNode, kind: string) =>
      where.kinds?.find((entry) => entry.kind === kind)?.node;
    expectIn(BEING_CLASSES, BEINGS2_RULES.members, "");
    expectIn(node("traits"), BEINGS2_RULES.traitMembers, "/traits");
    for (const [kind, names] of Object.entries(ACTIVITY_MEMBERS))
      expectIn(kindOf(node("activity"), kind), names, `/activity(${kind})`);
    const talk = kindOf(node("activity"), "talk");
    expectIn(
      talk === undefined ? undefined : memberOf(talk, "captured"),
      [...CAPTURED_MEMBERS.required, ...CAPTURED_MEMBERS.optional],
      "/activity(talk)/captured",
    );
    for (const [kind, names] of Object.entries(STEP_MEMBERS))
      expectIn(kindOf(node("plan").each as ClassNode, kind), names, `/plan(${kind})`);
    expectIn(
      node("outcome"),
      [...OUTCOME_MEMBERS.required, ...OUTCOME_MEMBERS.optional],
      "/outcome",
    );
    expectIn(node("wakeWhen"), [...WAKE_MEMBERS.required, ...WAKE_MEMBERS.optional], "/wakeWhen");
    expectIn(node("behavior"), BEHAVIOR_MEMBERS, "/behavior");
    expectIn(node("needs"), NEEDS_MEMBERS, "/needs");
    expectIn(node("cooldowns").each, COOLDOWN_MEMBERS, "/cooldowns");
    const held = node("mind");
    const store = (name: string) => memberOf(held, name)?.each as ClassNode;
    const all = (shape: { required: readonly string[]; optional: readonly string[] }) => [
      ...shape.required,
      ...shape.optional,
    ];
    expectIn(held, all(MIND_SHAPES.mind), "/mind");
    for (const [kind, shape] of Object.entries(MIND_SHAPES.episodes))
      expectIn(kindOf(store("episodes"), kind), all(shape), `/mind/episodes(${kind})`);
    expectIn(store("beliefs"), all(MIND_SHAPES.belief), "/mind/beliefs");
    expectIn(store("relations"), all(MIND_SHAPES.relationship), "/mind/relations");
    expectIn(store("inbox"), all(MIND_SHAPES.message), "/mind/inbox");
    expectIn(memberOf(held, "quota"), all(MIND_SHAPES.quota), "/mind/quota");
    expect(missing).toEqual([]);
    // Not vacuous: every kind of activity, step, and episode was cross-checked.
    expect(Object.keys(ACTIVITY_MEMBERS).sort()).toEqual(["eat", "idle", "sleep", "talk", "walk"]);
    expect(Object.keys(MIND_SHAPES.episodes).length).toBe(6);
  });

  test("lets the view of a mind hold only what the registry classes below C3", () => {
    const view = mind.viewOf(FULL_MIND, {
      moment: { tick: 9, secondsPerTick: 12 },
      laws: mind.defaultMindLaws(),
      retention: 1000,
    });
    const node = memberOf(BEING_CLASSES, "mind") as ClassNode;
    // The view's transforms keep the registry's names: ticks become ages, familiarity is shown as
    // it stands, the kind external is shown as heard, and src loses the evidence bit 8.
    expect(unclassified(node, view)).toEqual([]);
    expect(secretPaths(node, view)).toEqual([]);
    expect(view.episodes.map(({ kind }) => kind)).not.toContain("external");
    expect(view.beliefs.every(({ src }) => (src & 8) === 0)).toBe(true);
  });

  test("lets a perceived being hold only members the registry classes C0", () => {
    const walking = {
      ...being2(2, [1, 0]),
      activity: { kind: "walk" as const, start: 1, dirs: "02", ms: [10, 20], done: 1 },
    };
    const chunk = {
      beings: [being2(1, [0, 0]), walking, being2(3, [0, 1])],
      depletion: [],
      due: 1,
    };
    const seen = perceiveBeings(
      [{ coord: [0, 0], chunk }],
      { id: 1, cell: [0, 0] },
      { sight: 4, attention: 8 },
    );
    expect(seen.length).toBe(2);
    for (const perceived of seen) {
      for (const name of Object.keys(perceived)) {
        // activity is the kind of the activity, and direction the step of a walk it is on: both C0
        // by beings.md, the one a member of every kind, the other derived from dirs and done.
        if (name === "activity" || name === "direction") continue;
        expect([name, memberOf(BEING_CLASSES, name)?.class]).toEqual([name, "C0"]);
      }
    }
    const activity = memberOf(BEING_CLASSES, "activity") as ClassNode;
    for (const { node } of activity.kinds ?? []) expect(memberOf(node, "kind")?.class).toBe("C0");
    expect(seen.map((perceived) => Object.keys(perceived).sort())).toEqual([
      ["activity", "cell", "direction", "id", "species"],
      ["activity", "cell", "id", "species"],
    ]);
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
