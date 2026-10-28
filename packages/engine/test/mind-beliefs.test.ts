/**
 * The belief operations (docs/architecture/mind.md, "Beliefs"): what `believe`, `revise`, and
 * `drop` change, the reasons of the table, atomicity, the lower-id rule for beliefs only, depth, and
 * what each operation reports for the ledger.
 */
import { describe, expect, test } from "bun:test";
import { mind } from "../src/index.ts";
import { admitBelief } from "../src/mind/store.ts";
import {
  belief,
  contextAt,
  external,
  foodAt,
  heard,
  lawsWith,
  mindOf,
  own,
  relationship,
  seen,
} from "./support/mind-records.ts";

const { applyBeliefs, EVIDENCE, INT31_MAX, LIVE_MANIFEST, TAINTS } = mind;

/** The mind after `operations` at `tick`, failing the test when they are refused. */
function applied(
  subject: mind.Mind,
  operations: mind.BeliefOperations,
  ctx = contextAt(100),
): mind.BeliefsApplied {
  const outcome = applyBeliefs(subject, operations, ctx, LIVE_MANIFEST);
  if (outcome.kind !== "applied") throw new Error(`refused: ${outcome.reason}`);
  return outcome;
}

/** The reason `operations` are refused for, or "applied". */
function reasonOf(subject: mind.Mind, operations: mind.BeliefOperations, ctx = contextAt(100)) {
  const outcome = applyBeliefs(subject, operations, ctx, LIVE_MANIFEST);
  return outcome.kind === "rejected" ? outcome.reason : "applied";
}

const believe = (ev: number[], p = foodAt(5, 5), cr = 700): mind.BelieveOperation => ({
  p,
  cr,
  ev,
  rule: "m1.seen-food",
});

const SOURCES = mindOf({
  episodes: [
    own(1, { cell: [5, 5], v: 2 }),
    seen(2, 40),
    heard(3, 41, { tn: 2, ex: 4 }),
    external(4, { tn: 2 | 4 }),
  ],
  relations: [relationship(5, 41)],
  exposure: 6,
});

describe("believe", () => {
  test("forms a belief from what it cites, with the next id, now as u, and its depth", () => {
    const { mind: after, changes } = applied(SOURCES, { believe: [believe([1, 2])] });
    expect(after.next).toBe(7);
    expect(after.beliefs).toEqual([
      {
        id: 6,
        p: foodAt(5, 5),
        cr: 700,
        src: EVIDENCE.seen,
        ev: [1, 2],
        lost: 0,
        tn: 0,
        ex: 6,
        dp: 1,
        u: 100,
      },
    ]);
    expect(changes).toEqual({
      formed: [{ id: 6, rule: "m1.seen-food" }],
      revised: [],
      dropped: [],
      unlinked: [],
      uncited: [],
      tainted: [],
    });
  });

  test("records every kind of evidence and the last speaker it came from", () => {
    const first = applied(SOURCES, { believe: [believe([1, 3, 4])] }).mind;
    const told = first.beliefs[0];
    expect(told?.src).toBe(EVIDENCE.seen | EVIDENCE.told | EVIDENCE.external);
    expect(told?.who).toBe(41);
    const inferred = applied(first, { believe: [believe([6, 5], foodAt(6, 6))] }).mind.beliefs[1];
    // A belief and a relationship are both inferred evidence, and neither is a speaker.
    expect(inferred?.src).toBe(EVIDENCE.inferred);
    expect(inferred?.who).toBeUndefined();
    expect(inferred?.dp).toBe(2);
  });

  test("a belief that cites nothing is model-prior-suspect, and the exposure takes it", () => {
    const { mind: after } = applied(mindOf(), { believe: [believe([])] });
    expect(after.beliefs[0]).toMatchObject({ src: 0, tn: TAINTS.modelPriorSuspect, dp: 1, ev: [] });
    expect(after.exposure).toBe(TAINTS.modelPriorSuspect);
  });

  test("the exposure grows with the lineage of every belief formed", () => {
    const { mind: after } = applied(mindOf({ episodes: [heard(1, 9, { tn: 4, ex: 2 })] }), {
      believe: [believe([1])],
    });
    expect(after.beliefs[0]).toMatchObject({ tn: 4, ex: 2 });
    expect(after.exposure).toBe(4);
  });

  test("cites records created earlier in the same decision by the ids it predicts from next", () => {
    const { mind: after, changes } = applied(SOURCES, {
      believe: [believe([1]), believe([6], foodAt(6, 6)), believe([6, 7], foodAt(7, 7))],
    });
    expect(after.beliefs.map((held) => [held.id, held.dp])).toEqual([
      [6, 1],
      [7, 2],
      [8, 3],
    ]);
    expect(changes.formed.map((formed) => formed.id)).toEqual([6, 7, 8]);
  });

  test("refreshes the episodes it cites as a recall, and the beliefs it cites to now", () => {
    const subject = mindOf({
      episodes: [own(1, { w: 400, r: 0 })],
      beliefs: [belief(2, { u: 3 })],
    });
    // One half-life after r: salience 200, plus the recall of 200.
    const ctx = contextAt(75_600);
    const { mind: after } = applied(subject, { believe: [believe([1, 2])] }, ctx);
    expect(after.episodes[0]).toMatchObject({ w: 400, r: 75_600 });
    expect(after.beliefs[0]?.u).toBe(75_600);
  });

  test("refuses to adopt a proposition already held while citing nothing new", () => {
    const subject = mindOf({
      episodes: [own(1)],
      beliefs: [belief(2, { p: foodAt(5, 5), ev: [1] })],
    });
    expect(reasonOf(subject, { believe: [believe([1], foodAt(5, 5))] })).toBe("premise_order");
    expect(reasonOf(subject, { believe: [believe([], foodAt(5, 5))] })).toBe("premise_order");
  });

  test("adopting a proposition already held revises the belief that holds it", () => {
    const subject = mindOf({
      episodes: [own(1), own(2)],
      beliefs: [belief(3, { p: foodAt(5, 5), ev: [1] })],
    });
    const reordered = { v: 2, a: [{ c: [5, 5] }], p: "m1.food-at" } as const;
    const { mind: after, changes } = applied(subject, {
      believe: [{ p: reordered, cr: 950, ev: [2], rule: "again" }],
    });
    expect(after.next).toBe(4);
    expect(after.beliefs).toEqual([
      { ...belief(3, { p: foodAt(5, 5) }), cr: 950, ev: [1, 2], u: 100 },
    ]);
    expect(changes.formed).toEqual([]);
    // The adoption carries the rule of the believe that made it.
    expect(changes.revised).toEqual([{ id: 3, rule: "again" }]);
  });

  test("stores a copy of the proposition it is given", () => {
    const p = foodAt(5, 5);
    const { mind: after } = applied(SOURCES, { believe: [believe([1], p)] });
    expect(after.beliefs[0]?.p).toEqual(p);
    expect(after.beliefs[0]?.p).not.toBe(p);
  });

  test.each([
    ["a citation of a record the mind does not hold", [99], "unknown_record"],
    ["a citation of the id it is about to take", [6], "unknown_record"],
    ["the same record cited twice", [1, 1], "mind_malformed"],
  ] as const)("refuses %s", (_name, ev, reason) => {
    expect(reasonOf(SOURCES, { believe: [believe([...ev])] })).toBe(reason);
  });

  test("takes no new record once ids have run out", () => {
    const full = { ...SOURCES, next: INT31_MAX };
    expect(mind.freeId(full)).toBeUndefined();
    expect(mind.freeId({ ...SOURCES, next: INT31_MAX - 1 })).toBe(INT31_MAX - 1);
    expect(reasonOf(full, { believe: [believe([1])] })).toBe("mind_malformed");
    const last = applied({ ...SOURCES, next: INT31_MAX - 1 }, { believe: [believe([1])] }).mind;
    expect(last.beliefs[0]?.id).toBe(INT31_MAX - 1);
    expect(last.next).toBe(INT31_MAX);
  });

  test("allows a depth of mind.depth and refuses one deeper", () => {
    const chain = mindOf({
      beliefs: [
        belief(1),
        belief(2, { ev: [1], dp: 2, src: 4 }),
        belief(3, { ev: [2], dp: 3, src: 4 }),
      ],
    });
    const ctx = (depth: number) => contextAt(100, lawsWith({ depth }));
    expect(applied(chain, { believe: [believe([3])] }, ctx(4)).mind.beliefs.at(-1)?.dp).toBe(4);
    expect(reasonOf(chain, { believe: [believe([3])] }, ctx(3))).toBe("depth_exceeded");
  });
});

describe("a full store of beliefs", () => {
  const laws = lawsWith({ beliefs: 2 });
  const old = mindOf({
    episodes: [own(1)],
    beliefs: [belief(2, { cr: 900, u: 100 }), belief(3, { cr: 700, ev: [1], u: 100 })],
  });

  test("evicts the belief of lowest salience, and the beliefs that cited it lose it", () => {
    const subject = mindOf({
      beliefs: [
        belief(2, { cr: 600, u: 100 }),
        belief(3, { cr: 900, ev: [2], dp: 2, src: 4, u: 100 }),
      ],
    });
    // Saliences 600, 900, and 950 for the new belief: belief 2 leaves, and belief 3 loses it.
    const { mind: after, changes } = applied(
      subject,
      { believe: [believe([], foodAt(9, 9), 950)] },
      contextAt(100, laws),
    );
    expect(after.beliefs.map((held) => held.id)).toEqual([3, 4]);
    expect(after.beliefs[0]).toMatchObject({ ev: [], lost: 1, dp: 1 });
    expect(changes.unlinked).toEqual([{ id: 2, beliefs: [3] }]);
  });

  test("evicts the new belief itself when its salience is the lowest", () => {
    const { mind: after, changes } = applied(
      old,
      { believe: [believe([1], foodAt(9, 9), 600)] },
      contextAt(100, laws),
    );
    expect(after.beliefs.map((held) => held.id)).toEqual([2, 3]);
    // The id was taken, so a brain's predictions from next still hold.
    expect(after.next).toBe(5);
    expect(changes.formed).toEqual([{ id: 4, rule: "m1.seen-food" }]);
    expect(changes.unlinked).toEqual([{ id: 4, beliefs: [] }]);
  });

  test("evicts the oldest, then the lowest id, among equal saliences", () => {
    const tied = mindOf({
      beliefs: [belief(1, { cr: 800, u: 100 }), belief(2, { cr: 200, u: 100 })],
    });
    const byId = applied(tied, { believe: [believe([], foodAt(9, 9), 800)] }, contextAt(100, laws));
    expect(byId.mind.beliefs.map((held) => held.id)).toEqual([2, 3]);
    // Belief 2 was cited a second earlier, which leaves its salience at 800.
    const older = mindOf({
      beliefs: [belief(1, { cr: 800, u: 100 }), belief(2, { cr: 800, u: 99 })],
    });
    const byAge = applied(
      older,
      { believe: [believe([], foodAt(9, 9), 800)] },
      contextAt(100, laws),
    );
    expect(byAge.mind.beliefs.map((held) => held.id)).toEqual([1, 3]);
  });
});

describe("admitBelief", () => {
  const ctx = contextAt(100, lawsWith({ beliefs: 2 }));
  const idsOf = (subject: mind.Mind) => subject.beliefs.map((held) => held.id);

  test("evicts the lowest salience, the new belief included", () => {
    const subject = mindOf({
      beliefs: [belief(1, { cr: 900, u: 100 }), belief(2, { cr: 700, u: 100 })],
    });
    const weakest = admitBelief(subject, belief(3, { cr: 600, u: 100 }), ctx);
    expect(idsOf(weakest.mind)).toEqual([1, 2]);
    expect(weakest.displaced).toEqual([{ id: 3, beliefs: [] }]);
    // Certainty either way: cr 150 weighs 850, more than belief 2's 700.
    expect(idsOf(admitBelief(subject, belief(3, { cr: 150, u: 100 }), ctx).mind)).toEqual([1, 3]);
  });

  test("evicts the oldest u, then the lowest id, among equal saliences", () => {
    // Belief 2 was cited a second earlier, which leaves its salience at 800.
    const older = mindOf({
      beliefs: [belief(1, { cr: 800, u: 100 }), belief(2, { cr: 800, u: 99 })],
    });
    expect(idsOf(admitBelief(older, belief(3, { cr: 800, u: 100 }), ctx).mind)).toEqual([1, 3]);
    const even = mindOf({
      beliefs: [belief(1, { cr: 800, u: 100 }), belief(2, { cr: 200, u: 100 })],
    });
    expect(idsOf(admitBelief(even, belief(3, { cr: 800, u: 100 }), ctx).mind)).toEqual([2, 3]);
  });

  test("takes an evicted belief out of the beliefs that cite it, and reports the link", () => {
    const subject = mindOf({
      episodes: [own(1)],
      beliefs: [
        belief(2, { cr: 600, u: 100 }),
        belief(3, { cr: 900, ev: [2, 1], dp: 2, src: 5, lost: 4, u: 100 }),
      ],
    });
    const { mind: after, displaced } = admitBelief(subject, belief(4, { cr: 950, u: 100 }), ctx);
    expect(idsOf(after)).toEqual([3, 4]);
    expect(after.beliefs[0]).toMatchObject({ ev: [1], lost: 5 });
    expect(displaced).toEqual([{ id: 2, beliefs: [3] }]);
  });

  test("admits without evicting while the store has room", () => {
    const subject = mindOf({ beliefs: [belief(1)] });
    expect(admitBelief(subject, belief(2, { cr: 0 }), ctx)).toEqual({
      mind: { ...subject, beliefs: [belief(1), belief(2, { cr: 0 })] },
      displaced: [],
    });
  });
});

describe("revise", () => {
  const subject = mindOf({
    episodes: [own(1), own(2), heard(3, 41, { tn: 2, ex: 1 }), own(4), own(10)],
    beliefs: [
      belief(5, { ev: [1, 2], tn: 4, ex: 4, src: EVIDENCE.seen, u: 7 }),
      belief(6, { ev: [5], dp: 2, src: EVIDENCE.inferred, tn: 4, ex: 4 }),
    ],
  });

  test("sets the confidence, adds the new evidence, and keeps every taint and source", () => {
    const { mind: after, changes } = applied(subject, { revise: [{ id: 5, cr: 200, ev: [3] }] });
    expect(after.beliefs[0]).toEqual({
      ...(subject.beliefs[0] as mind.Belief),
      cr: 200,
      src: EVIDENCE.seen | EVIDENCE.told,
      who: 41,
      ev: [1, 2, 3],
      tn: 4 | 2,
      ex: 4 | 1,
      u: 100,
    });
    expect(changes.revised).toEqual([{ id: 5 }]);
    // Belief 6 cites 5, so it takes the new taints.
    expect(after.beliefs[1]).toMatchObject({ tn: 6, ex: 5 });
    expect(changes.tainted).toEqual([6]);
  });

  test("keeps the three most recent citations and reports the ones it pushes out", () => {
    const { mind: after, changes } = applied(subject, {
      revise: [{ id: 5, cr: 200, ev: [1, 3, 4] }],
    });
    // Citing 1 again makes it recent: 2 leaves, and the belief keeps what 2 brought.
    expect(after.beliefs[0]?.ev).toEqual([1, 3, 4]);
    expect(after.beliefs[0]?.lost).toBe(0);
    expect(changes.uncited).toEqual([{ belief: 5, records: [2] }]);
  });

  test("keeps the last speaker when the new evidence holds none", () => {
    const told = { ...subject, beliefs: [belief(5, { ev: [1], who: 77 })] };
    expect(applied(told, { revise: [{ id: 5, cr: 1, ev: [4] }] }).mind.beliefs[0]?.who).toBe(77);
  });

  test("may cite an episode of a higher id: the lower-id rule binds beliefs only", () => {
    const { mind: after } = applied(subject, { revise: [{ id: 5, cr: 200, ev: [10] }] });
    expect(after.beliefs[0]?.ev).toEqual([1, 2, 10]);
  });

  test("may revise a belief formed earlier in the same decision", () => {
    const { mind: after } = applied(subject, {
      believe: [believe([1], foodAt(8, 8))],
      revise: [{ id: 11, cr: 50, ev: [4] }],
    });
    expect(after.beliefs.at(-1)).toMatchObject({ id: 11, cr: 50, ev: [1, 4] });
  });

  test.each([
    ["a belief the mind does not hold", { id: 99, cr: 1, ev: [3] }, "unknown_record"],
    ["an episode as its target", { id: 1, cr: 1, ev: [3] }, "unknown_record"],
    ["a citation of a record the mind does not hold", { id: 5, cr: 1, ev: [99] }, "unknown_record"],
    ["a citation repeated", { id: 5, cr: 1, ev: [3, 3] }, "mind_malformed"],
    ["nothing new", { id: 5, cr: 1, ev: [1, 2] }, "premise_order"],
    ["no evidence at all", { id: 5, cr: 1, ev: [] }, "premise_order"],
    ["a citation of a belief of a higher id", { id: 5, cr: 1, ev: [6] }, "premise_order"],
    ["a citation of itself", { id: 5, cr: 1, ev: [5] }, "premise_order"],
  ] as const)("refuses %s", (_name, op, reason) => {
    expect(reasonOf(subject, { revise: [op] })).toBe(reason);
  });

  test("refuses a revision that makes a belief that cites it too deep", () => {
    const deep = mindOf({
      beliefs: [
        belief(1),
        belief(2),
        belief(3, { ev: [2], dp: 2, src: 4 }),
        belief(4, { ev: [1], dp: 2, src: 4 }),
      ],
    });
    const ctx = contextAt(100, lawsWith({ depth: 2 }));
    // Belief 2 citing 1 has depth 2, and belief 3, which cites 2, would reach 3.
    expect(reasonOf(deep, { revise: [{ id: 2, cr: 1, ev: [1] }] }, ctx)).toBe("depth_exceeded");
    expect(
      applied(deep, { revise: [{ id: 2, cr: 1, ev: [1] }] }, contextAt(100, lawsWith({ depth: 3 })))
        .mind.beliefs[2]?.dp,
    ).toBe(3);
  });
});

describe("the depth limit", () => {
  // A full store of three: beliefs 1 to 3 at depths 1 to 3, the limit of 3.
  const chain = (premise: number) =>
    mindOf({
      beliefs: [
        belief(1, { cr: 1000, u: 100 }),
        belief(2, { cr: 1000, ev: [1], dp: 2, src: 4, u: 100 }),
        belief(3, { cr: premise, ev: [2], dp: 3, src: 4, u: 100 }),
      ],
    });
  const full = contextAt(100, lawsWith({ beliefs: 3, depth: 3 }));

  test("judges a new belief as formed, even when its full store would evict it at once", () => {
    // Salience 500 is the lowest, so the store would drop the new belief and keep the rest.
    const weak = believe([3], foodAt(9, 9), 500);
    expect(reasonOf(chain(1000), { believe: [weak] }, full)).toBe("depth_exceeded");
    expect(reasonOf(chain(1000), { believe: [weak] }, contextAt(100, lawsWith({ depth: 3 })))).toBe(
      "depth_exceeded",
    );
  });

  test("judges a new belief as formed, even when admitting it would evict its own premise", () => {
    // Belief 3 has the lowest salience, 500: admitting the new belief would evict it, leaving the
    // new one at depth 1.
    const strong = believe([3], foodAt(9, 9), 900);
    expect(reasonOf(chain(500), { believe: [strong] }, full)).toBe("depth_exceeded");
  });

  // Beliefs 2 and 3 are already deeper than a limit of 1.
  const beyond = mindOf({
    episodes: [own(1), own(5)],
    beliefs: [
      belief(2),
      belief(3, { ev: [2], dp: 2, src: 4 }),
      belief(4, { ev: [3], dp: 3, src: 4 }),
    ],
  });
  const ctx = contextAt(100, lawsWith({ depth: 1 }));

  test("refuses an operation that makes a belief deeper, and above mind.depth", () => {
    // A new belief citing belief 4 would have depth 4, and one citing belief 2 depth 2.
    expect(reasonOf(beyond, { believe: [believe([4], foodAt(9, 9))] }, ctx)).toBe("depth_exceeded");
    expect(reasonOf(beyond, { believe: [believe([2], foodAt(9, 9))] }, ctx)).toBe("depth_exceeded");
  });

  test("lets a mind already beyond the limit drop and revise without deepening", () => {
    const dropped = applied(beyond, { drop: [2] }, ctx).mind;
    expect(dropped.beliefs.map((held) => [held.id, held.dp])).toEqual([
      [3, 1],
      [4, 2],
    ]);
    const revised = applied(beyond, { revise: [{ id: 4, cr: 1, ev: [5] }] }, ctx).mind;
    expect(revised.beliefs.at(-1)).toMatchObject({ id: 4, dp: 3, ev: [3, 5] });
    expect(
      applied(beyond, { believe: [believe([1], foodAt(9, 9))] }, ctx).mind.beliefs.at(-1)?.dp,
    ).toBe(1);
  });
});

describe("drop", () => {
  const subject = mindOf({
    episodes: [own(1)],
    beliefs: [
      belief(2, { ev: [1] }),
      belief(3, { ev: [2, 1], dp: 2, src: 5, lost: 4 }),
      belief(4, { ev: [3], dp: 3, src: 4 }),
    ],
  });

  test("removes the belief; the beliefs that cited it lose it and their depth follows", () => {
    const { mind: after, changes } = applied(subject, { drop: [2] });
    expect(after.beliefs).toEqual([
      belief(3, { ev: [1], dp: 1, src: 5, lost: 5 }),
      belief(4, { ev: [3], dp: 2, src: 4 }),
    ]);
    expect(changes.dropped).toEqual([2]);
    expect(changes.unlinked).toEqual([{ id: 2, beliefs: [3] }]);
  });

  test.each([
    ["a belief the mind does not hold", 99],
    ["an episode", 1],
  ])("refuses %s", (_name, id) => {
    expect(reasonOf(subject, { drop: [id] })).toBe("unknown_record");
  });

  test("refuses a second drop of the same belief", () => {
    expect(reasonOf(subject, { drop: [4, 4] })).toBe("unknown_record");
  });
});

describe("a decision's operations", () => {
  test("apply believe, then revise, then drop, and are atomic", () => {
    const subject = mindOf({ episodes: [own(1), own(2)], beliefs: [belief(3, { ev: [1] })] });
    const before = structuredClone(subject);
    // The drop fails after a belief was formed and another revised: nothing applies.
    const outcome = applyBeliefs(
      subject,
      { believe: [believe([1])], revise: [{ id: 3, cr: 1, ev: [2] }], drop: [99] },
      contextAt(100),
      LIVE_MANIFEST,
    );
    expect(outcome).toEqual({ kind: "rejected", reason: "unknown_record" });
    expect(subject).toEqual(before);
  });

  test("give the reason of the first operation that fails", () => {
    const subject = mindOf({ episodes: [own(1)] });
    const operations = { believe: [believe([1, 1])], revise: [{ id: 99, cr: 1, ev: [1] }] };
    expect(reasonOf(subject, operations)).toBe("mind_malformed");
  });

  test("leave the same mind when there are none", () => {
    expect(applied(SOURCES, {}).mind).toBe(SOURCES);
  });
});
