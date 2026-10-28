/**
 * The classification registry of beings@2 (ADR 0008, ADR 0024; docs/architecture/mind.md
 * "Classification"): the class of every member of a being, nested ones included, the records of
 * its mind among them, of every event the beings layer emits, and of every command it handles. C0
 * is what an observer inside the world could see, C1 what is internal to an inhabitant and may
 * reach the inhabitant itself, and C3 what only operations and research may read: taints,
 * exposure, the kind `external`, and reference truth. Nothing classified C3 ever reaches a brain.
 *
 * The senses of beings@2 are built from it by allowlist: `copySensed` copies only the members it
 * marks as sensed, and below them only what it classifies and does not classify C3, so a member
 * this registry does not name never reaches a brain. T6 builds its projections on it.
 */

/** A data class of ADR 0008, among those a being's data takes. */
export type DataClass = "C0" | "C1" | "C3";

/**
 * The class of a value, and of what it holds: the members of a record, the entries of a list, or
 * the members of a record by its `kind`. A leaf, a number, a string, a boolean, or a cell, has
 * only its class.
 */
export type ClassNode = {
  readonly class: DataClass;
  readonly members?: readonly ClassMember[];
  readonly each?: ClassNode;
  readonly kinds?: readonly ClassKind[];
};

/** A member of a record: its name, its class, and whether the senses of beings@2 copy it. */
export type ClassMember = {
  readonly name: string;
  readonly node: ClassNode;
  readonly sensed: boolean;
};

/** The members of a record of one kind. */
export type ClassKind = { readonly kind: string; readonly node: ClassNode };

/** A leaf of `cls`. */
function leaf(cls: DataClass): ClassNode {
  return Object.freeze({ class: cls });
}

const C0 = leaf("C0");
const C1 = leaf("C1");
const C3 = leaf("C3");

/** A record of class `cls` whose members are `members`, each a name and its class. */
function record(cls: DataClass, members: readonly (readonly [string, ClassNode])[]): ClassNode {
  return Object.freeze({
    class: cls,
    members: Object.freeze(
      members.map(([name, node]) => Object.freeze({ name, node, sensed: false })),
    ),
  });
}

/** A record of class C1 whose members are all leaves of class C1. */
function internal(names: readonly string[]): ClassNode {
  return record(
    "C1",
    names.map((name) => [name, C1]),
  );
}

/** A list of class `cls` whose entries are `each`. */
function list(cls: DataClass, each: ClassNode): ClassNode {
  return Object.freeze({ class: cls, each });
}

/** A record of class `cls` whose members depend on its `kind`. */
function kinds(cls: DataClass, byKind: readonly (readonly [string, ClassNode])[]): ClassNode {
  return Object.freeze({
    class: cls,
    kinds: Object.freeze(byKind.map(([kind, node]) => Object.freeze({ kind, node }))),
  });
}

/** A proposition of prop@1 of class `cls`: its concept, terms, value, and negation. */
function proposition(cls: DataClass): ClassNode {
  const of = leaf(cls);
  return record(cls, [
    [
      "a",
      list(
        cls,
        record(cls, [
          ["c", of],
          ["e", of],
          ["n", of],
        ]),
      ),
    ],
    ["neg", of],
    ["p", of],
    ["v", of],
  ]);
}

/** What a talk under way captured to say: C3, so that no sense ever copies it (mind.md). */
const CAPTURED = record("C3", [
  ["band", C3],
  ["ex", C3],
  ["p", proposition("C3")],
  ["tn", C3],
]);

/**
 * The activity: its kind is C0, as the direction of the current step of a walk, which observers
 * derive from `dirs` and `done`, and the hearer and act of a talk; the remaining route, its
 * schedule, and the targets are C1; what a talk captured to say is C3.
 */
const ACTIVITY = kinds("C0", [
  [
    "eat",
    record("C0", [
      ["bites", C1],
      ["kind", C0],
      ["start", C1],
      ["untilNutrition", C1],
    ]),
  ],
  [
    "idle",
    record("C0", [
      ["kind", C0],
      ["ms", C1],
      ["start", C1],
    ]),
  ],
  [
    "sleep",
    record("C0", [
      ["forced", C1],
      ["kind", C0],
      ["untilRest", C1],
    ]),
  ],
  [
    "talk",
    record("C0", [
      ["act", C0],
      ["captured", CAPTURED],
      ["kind", C0],
      ["start", C1],
      ["to", C0],
    ]),
  ],
  [
    "walk",
    record("C0", [
      ["dirs", C1],
      ["done", C1],
      ["kind", C0],
      ["ms", C1],
      ["start", C1],
    ]),
  ],
]);

/** A step a brain planned. */
const PLAN_STEP = kinds("C1", [
  ["eat", internal(["kind", "untilNutrition"])],
  ["idle", internal(["kind", "ms"])],
  ["sleep", internal(["kind", "untilRest"])],
  ["walk", internal(["dirs", "kind"])],
]);

/** A proposition of prop@1 a mind holds, of the class of the record holding it. */
const PROPOSITION = proposition("C1");

/** What an episode of every kind holds; its taints, of a message, are C3. */
const EPISODE = kinds("C1", [
  ["ate", internal(["cell", "id", "kind", "r", "t", "v", "w"])],
  ["being", internal(["cell", "id", "kind", "r", "t", "v", "w", "who"])],
  ["failed", internal(["cell", "id", "kind", "r", "t", "v", "w"])],
  ["food", internal(["cell", "id", "kind", "r", "t", "v", "w"])],
  [
    "heard",
    record("C1", [
      ["act", C1],
      ["band", C1],
      ["cell", C1],
      ["ex", C3],
      ["id", C1],
      ["kind", C1],
      ["p", PROPOSITION],
      ["r", C1],
      ["t", C1],
      ["tn", C3],
      ["w", C1],
      ["who", C1],
    ]),
  ],
  // A research injection: the kind is C3, and a view shows it as a tell heard with no speaker.
  [
    "external",
    record("C1", [
      ["id", C1],
      ["kind", C3],
      ["p", PROPOSITION],
      ["r", C1],
      ["t", C1],
      ["tn", C3],
      ["w", C1],
    ]),
  ],
]);

/**
 * A belief without its taints is C1; its `src` is C1 but for the evidence bit 8, external, which is
 * C3 and which a view shows as told (mind/view.ts).
 */
const BELIEF = record("C1", [
  ["cr", C1],
  ["dp", C1],
  ["ev", C1],
  ["ex", C3],
  ["id", C1],
  ["lost", C1],
  ["p", PROPOSITION],
  ["src", C1],
  ["tn", C3],
  ["u", C1],
  ["who", C1],
]);

const RELATIONSHIP = record("C1", [
  ["aff", C1],
  ["f", C1],
  ["id", C1],
  ["seen", C1],
  ["talk", C1],
  ["tn", C3],
  ["tr", C1],
  ["turns", C1],
  ["who", C1],
]);

/**
 * A message in the inbox, and what a brain hears of it at a decision, the members marked sensed:
 * all but its tick, which a brain never senses, and its taints, which are C3.
 */
const MESSAGE_MEMBERS: readonly (readonly [string, ClassNode, boolean])[] = Object.freeze([
  ["act", C1, true],
  ["band", C1, true],
  ["cell", C1, true],
  ["ex", C3, false],
  ["p", PROPOSITION, true],
  ["t", C1, false],
  ["tn", C3, false],
  ["who", C1, true],
]);
const MESSAGE: ClassNode = Object.freeze({
  class: "C1",
  members: Object.freeze(
    MESSAGE_MEMBERS.map(([name, node, sensed]) => Object.freeze({ name, node, sensed })),
  ),
});

/** The mind of a being: C1, but for the taints of its records and its exposure. */
const MIND = record("C1", [
  ["beliefs", list("C1", BELIEF)],
  ["episodes", list("C1", EPISODE)],
  ["exposure", C3],
  ["inbox", list("C1", MESSAGE)],
  ["next", C1],
  ["quota", internal(["day", "said", "woken"])],
  ["relations", list("C1", RELATIONSHIP)],
]);

/** The members of a being of beings@2, and those the senses copy, in the order of their names. */
const BEING_MEMBERS: readonly (readonly [string, ClassNode, boolean])[] = Object.freeze([
  ["activity", ACTIVITY, true],
  ["anchor", C1, false],
  ["behavior", internal(["heading", "kind", "since"]), true],
  ["born", C0, false],
  ["cell", C0, true],
  ["condition", C1, true],
  ["cooldowns", list("C1", internal(["cell", "until"])), true],
  ["health", C1, true],
  ["id", C0, true],
  ["mind", MIND, false],
  ["needs", internal(["nutrition", "rest"]), true],
  ["outcome", internal(["reason", "result", "tick", "units"]), true],
  ["plan", list("C1", PLAN_STEP), false],
  ["species", C0, true],
  ["stage", C0, false],
  [
    "traits",
    internal(["appetite", "credulity", "curiosity", "retention", "sleepiness", "sociability"]),
    true,
  ],
  ["wake", C1, false],
  ["wakeWhen", internal(["lightAbove", "lightBelow", "nutritionBelow", "restBelow"]), false],
]);

/**
 * The class of a being of beings@2 and of each of its members. A being is C0: that it exists, and
 * its identity and cell, are what an observer could see.
 */
export const BEING_CLASSES: ClassNode = Object.freeze({
  class: "C0",
  members: Object.freeze(
    BEING_MEMBERS.map(([name, node, sensed]) => Object.freeze({ name, node, sensed })),
  ),
});

/**
 * The class of every event the beings layer emits: C0 what an observer could see happen, C1 the
 * being's own experience and body, and C3 what only operations and research may read: the
 * provenance of a mind, its taints and exposure. The class of an event is that of its payload.
 */
export const EVENT_CLASSES: readonly { readonly type: string; readonly class: DataClass }[] =
  Object.freeze(
    (
      [
        ["being.ate", "C1"],
        ["being.contested", "C1"],
        ["being.died", "C0"],
        ["being.exhausted", "C1"],
        ["being.finished", "C1"],
        ["being.incapacitated", "C1"],
        ["being.intention_rejected", "C1"],
        ["being.recovered", "C1"],
        ["being.spawned", "C0"],
        ["being.started", "C0"],
        ["mind.changed", "C1"],
        ["mind.injected", "C3"],
        ["mind.provenance", "C3"],
        ["speech.uttered", "C0"],
      ] as const
    ).map(([type, cls]) => Object.freeze({ type, class: cls })),
  );

/** The class of every command the beings ruleset handles: the admin plane's are operations. */
export const COMMAND_CLASSES: readonly { readonly type: string; readonly class: DataClass }[] =
  Object.freeze([
    Object.freeze({ type: "beings.spawn", class: "C3" as const }),
    Object.freeze({ type: "mind.inject", class: "C3" as const }),
  ]);

/** A record whose members are read by name: values the engine built, never a host's. */
type Members = { readonly [name: string]: unknown };

/**
 * A copy of the leaf `value`: a number, a string, a boolean, or a cell, whose numbers it copies.
 */
function copyLeaf(value: unknown): unknown {
  return Array.isArray(value) ? value.map((entry: unknown) => entry) : value;
}

/**
 * A copy of what `node` allows of `value`, a value the engine built: never a member classified C3,
 * nor one it does not name.
 */
export function copyAllowed(node: ClassNode, value: unknown): unknown {
  if (node.kinds !== undefined) {
    const kind = (value as Members).kind;
    const of = node.kinds.find((entry) => entry.kind === kind);
    return of === undefined ? undefined : copyAllowed(of.node, value);
  }
  if (node.members !== undefined) return copyMembers(node.members, value as Members, false);
  const each = node.each;
  if (each !== undefined)
    return (value as readonly unknown[]).map((entry) => copyAllowed(each, entry));
  return copyLeaf(value);
}

/**
 * The members of `value` that `members` allow, each copied by its node: every member not
 * classified C3, or only those marked sensed when `sensedOnly` is set.
 */
function copyMembers(
  members: readonly ClassMember[],
  value: Members,
  sensedOnly: boolean,
): Members {
  const copy: { [name: string]: unknown } = {};
  for (const { name, node, sensed } of members) {
    const member = value[name];
    if (member === undefined || node.class === "C3" || (sensedOnly && !sensed)) continue;
    const allowed = copyAllowed(node, member);
    if (allowed !== undefined) copy[name] = allowed;
  }
  return copy;
}

/**
 * What a brain of beings@2 senses of `self`, the being's own record as the engine holds it at the
 * decision: its members that BEING_CLASSES marks as sensed, copied by allowlist, so that the copy
 * shares nothing with `self` and holds nothing classified C3 or not classified at all.
 */
export function copySensed(self: Members): Members {
  // BEING_CLASSES is a record node: it always has members.
  return copyMembers(BEING_CLASSES.members as readonly ClassMember[], self, true);
}

/**
 * What a brain of beings@2 hears of `message`, a message of its inbox as the engine holds it: the
 * members the registry marks as sensed, copied by allowlist, never its tick or its taints.
 */
export function copyHeard(message: Members): Members {
  // MESSAGE is a record node: it always has members.
  return copyMembers(MESSAGE.members as readonly ClassMember[], message, true);
}
