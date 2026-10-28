/**
 * The invariants of a mind (src/mind/invariants.ts) that a chunk validator checks without the
 * laws: a valid mind passes, and each broken invariant is reported at its path, every one of them.
 */
import { describe, expect, test } from "bun:test";
import { type Issue, mind } from "../src/index.ts";
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

const { checkMind } = mind;

function issuesOf(subject: mind.Mind): Issue[] {
  const issues: Issue[] = [];
  checkMind(subject, "/mind", { report: (path, message) => issues.push({ path, message }) });
  return issues;
}

const pathsOf = (subject: mind.Mind): string[] => issuesOf(subject).map((issue) => issue.path);

const VALID = mindOf({
  episodes: [
    own(1, { cell: [-5, 7], v: 2 }),
    seen(2, 40),
    own(3, { kind: "ate", v: 25 }),
    own(4, { kind: "failed", v: 3 }),
    heard(5, 41, { tn: 2, ex: 4 }),
    external(6, { tn: 2 }),
  ],
  beliefs: [
    belief(7, { ev: [1, 5], tn: 2, ex: 4, who: 41, src: 3 }),
    belief(8, { ev: [7, 6], dp: 2, tn: 2, ex: 4, src: 12 }),
    belief(9, { ev: [10], tn: 1, src: 4 }),
  ],
  relations: [relationship(10, 41, { tn: 1, f: 7200, seen: 3, aff: -1000, tr: 1000, turns: 8 })],
  inbox: [
    { who: 41, t: 3, cell: [1, 1], act: "tell", p: foodAt(1, 1), band: 1, tn: 2, ex: 4 },
    { t: 3, act: "tell", p: foodAt(2, 2), tn: 2, ex: 0 },
  ],
  exposure: 6,
  quota: { day: 3, said: 64, woken: 64 },
});

describe("checkMind", () => {
  test("accepts a mind the engine could have written", () => {
    expect(issuesOf(VALID)).toEqual([]);
    expect(issuesOf(mind.newMind(0))).toEqual([]);
  });

  test("keeps every id below next, unique, and each store in increasing id", () => {
    expect(issuesOf({ ...VALID, next: 10 })).toEqual([
      { path: "/mind/relations/0/id", message: "must be an integer from 1 to 9" },
    ]);
    const repeated = { ...VALID, relations: [relationship(5, 41)] };
    expect(issuesOf(repeated)).toContainEqual({
      path: "/mind/relations/0/id",
      message: "5 is the id of another record: local ids are unique in a mind",
    });
    const unordered = { ...VALID, episodes: [own(2), own(1)], beliefs: [], relations: [] };
    expect(issuesOf(unordered)).toEqual([
      {
        path: "/mind/episodes/1/id",
        message: "1 must be above 2: a store keeps its records in increasing id",
      },
    ]);
  });

  test("reports a citation that is missing, repeated, or of a belief that is not lower", () => {
    const broken = {
      ...VALID,
      beliefs: [
        belief(7, { ev: [99, 1, 1], src: 1 }),
        belief(8, { ev: [9], dp: 2, src: 4 }),
        belief(9, { ev: [1, 2, 3, 4], src: 1 }),
      ],
    };
    expect(issuesOf(broken)).toEqual([
      { path: "/mind/beliefs/0/ev/0", message: "99 is not a record the mind holds" },
      { path: "/mind/beliefs/0/ev/2", message: "1 is cited twice" },
      {
        path: "/mind/beliefs/1/ev/0",
        message: "belief 8 cites belief 9: a belief cites only beliefs of a lower id",
      },
      {
        path: "/mind/beliefs/1/dp",
        message: "the depth must be 1: one more than its deepest cited belief's",
      },
      { path: "/mind/beliefs/2/ev", message: "a belief cites at most 3 records" },
    ]);
  });

  test("reports a depth that does not follow from what a belief cites", () => {
    const shallow = {
      ...VALID,
      beliefs: [VALID.beliefs[0] as mind.Belief, belief(8, { ev: [7], dp: 1, tn: 2, ex: 4 })],
      relations: [],
    };
    expect(pathsOf(shallow)).toEqual(["/mind/beliefs/1/dp"]);
  });

  test("reports taints that do not contain those of what a belief cites", () => {
    const unclosed = {
      ...VALID,
      beliefs: [belief(7, { ev: [1, 5], tn: 2, ex: 0, who: 41, src: 3 })],
      relations: [],
    };
    expect(issuesOf(unclosed)).toEqual([
      {
        path: "/mind/beliefs/0",
        message: "the taints tn 2 and ex 0 must contain those of what it cites, tn 2 and ex 4",
      },
    ]);
    // A relationship passes its lineage, and an injection its lineage only.
    const relation = { ...VALID, beliefs: [belief(7, { ev: [10, 6], tn: 2, src: 12 })] };
    expect(pathsOf(relation)).toEqual(["/mind/beliefs/0"]);
  });

  test("reports one relationship per being", () => {
    const twice = { ...VALID, relations: [...VALID.relations, relationship(11, 41)], next: 12 };
    expect(issuesOf(twice)).toEqual([
      { path: "/mind/relations/1/who", message: "the mind already holds a relationship with 41" },
    ]);
  });

  test("reports familiarity with a being never perceived: seen 0 holds f 0", () => {
    // A relationship a message created records no perception (mind.md, "Relationships").
    const heard = { ...VALID, relations: [relationship(10, 41, { tn: 1 })] };
    expect(issuesOf(heard)).toEqual([]);
    const familiar = { ...VALID, relations: [relationship(10, 41, { tn: 1, f: 1 })] };
    expect(issuesOf(familiar)).toEqual([
      {
        path: "/mind/relations/0/f",
        message: "a being never perceived (seen 0) has no familiarity: f must be 0, not 1",
      },
    ]);
  });

  test.each<[string, Partial<mind.Mind>, string[]]>([
    ["next above 2^31 − 1", { next: 0x8000_0000 }, ["/mind/next"]],
    ["an exposure beyond the taints", { exposure: 8 }, ["/mind/exposure"]],
    ["a negative day", { quota: { day: -1, said: 0, woken: 0 } }, ["/mind/quota/day"]],
    [
      "too many acts",
      { quota: { day: 0, said: 65, woken: 65 } },
      ["/mind/quota/said", "/mind/quota/woken"],
    ],
  ])("bounds %s", (_name, change, expected) => {
    expect(pathsOf({ ...VALID, ...change })).toEqual(expected);
  });

  test("reports an injection without human-external, and a message without content that is tainted", () => {
    const episodes = [
      external(1, { tn: 4 }),
      heard(2, 41, { act: "greet", tn: 0, ex: 2 }),
      heard(3, 41, { act: "ask", tn: 1, ex: 0 }),
    ];
    expect(issuesOf({ ...VALID, episodes, beliefs: [], relations: [], next: 4 })).toEqual([
      { path: "/mind/episodes/0/tn", message: "an injection always carries human-external (2)" },
      {
        path: "/mind/episodes/1",
        message: "the act greet carries no content, so it carries no taint",
      },
      {
        path: "/mind/episodes/2",
        message: "the act ask carries no content, so it carries no taint",
      },
    ]);
    const inbox: mind.InboxMessage[] = [
      { who: 41, t: 0, act: "greet", tn: 0, ex: 0 },
      { t: 0, cell: [1, 1], act: "tell", tn: 2, ex: 0 },
      { t: 0, act: "greet", tn: 2, ex: 0 },
      { t: 0, act: "tell", p: foodAt(1, 1), tn: 4, ex: 0 },
    ];
    expect(pathsOf({ ...VALID, inbox })).toEqual([
      "/mind/inbox/0/cell",
      "/mind/inbox/1/who",
      "/mind/inbox/2/act",
      "/mind/inbox/3/tn",
    ]);
    // An injection's message is a tell of a proposition: an external episode holds one.
    const empty: mind.InboxMessage = { t: 0, act: "tell", tn: 2, ex: 0 };
    expect(pathsOf({ ...VALID, inbox: [empty] })).toEqual(["/mind/inbox/0/p"]);
    const silent: mind.InboxMessage = { who: 41, t: 0, cell: [1, 1], act: "unknown", tn: 0, ex: 4 };
    expect(issuesOf({ ...VALID, inbox: [silent] })).toEqual([
      {
        path: "/mind/inbox/0",
        message: "the act unknown carries no content, so it carries no taint",
      },
    ]);
  });

  test("bounds a failed episode's value by the reasons it indexes", () => {
    expect(mind.FAILURES).toEqual(["no_food", "food_gone", "incapacitated", "crowded"]);
    expect(mind.MIND_BOUNDS.failure).toEqual({ min: 0, max: mind.FAILURES.length - 1 });
  });

  test("bounds every member of an episode by its kind", () => {
    const episodes: mind.Episode[] = [
      own(1, { v: 3, w: 1001, t: -1 }),
      seen(2, 0, { v: -1, cell: [0, 0x8000_0000] }),
      own(3, { kind: "ate", v: 0x10_0001, r: -1 }),
      own(4, { kind: "failed", v: 4 }),
      heard(5, 41, { act: "shout" as mind.Act, band: 3, tn: 8, ex: -1 }),
      external(6, { tn: 9 }),
    ];
    const beliefs = [belief(7, { ev: [1], tn: 7, ex: 7 })];
    expect(pathsOf({ ...VALID, episodes, beliefs, relations: [], next: 8 })).toEqual([
      "/mind/episodes/0/t",
      "/mind/episodes/0/w",
      "/mind/episodes/0/v",
      "/mind/episodes/1/cell/1",
      "/mind/episodes/1/v",
      "/mind/episodes/1/who",
      "/mind/episodes/2/r",
      "/mind/episodes/2/v",
      "/mind/episodes/3/v",
      "/mind/episodes/4/act",
      "/mind/episodes/4/band",
      "/mind/episodes/4/tn",
      "/mind/episodes/4/ex",
      "/mind/episodes/5/tn",
    ]);
  });

  test("bounds every member of a belief, a relationship, and a message", () => {
    const subject = {
      ...VALID,
      episodes: [],
      beliefs: [belief(1, { cr: 1001, src: 16, who: 0, lost: -1, tn: 8, ex: 8, dp: 9, u: -1 })],
      relations: [
        relationship(2, 0, {
          f: 0x40_0001,
          seen: -1,
          aff: -1001,
          tr: 1001,
          tn: 8,
          talk: -1,
          turns: 9,
        }),
      ],
      inbox: [
        {
          who: 0,
          t: -1,
          cell: [0x8000_0000, 0] as const,
          act: "x" as mind.Act,
          band: 3,
          tn: 8,
          ex: 8,
        },
      ],
      next: 3,
    };
    expect(pathsOf(subject)).toEqual([
      "/mind/beliefs/0/cr",
      "/mind/beliefs/0/src",
      "/mind/beliefs/0/who",
      "/mind/beliefs/0/lost",
      "/mind/beliefs/0/tn",
      "/mind/beliefs/0/ex",
      "/mind/beliefs/0/dp",
      "/mind/beliefs/0/u",
      "/mind/beliefs/0/dp",
      "/mind/relations/0/who",
      "/mind/relations/0/f",
      "/mind/relations/0/seen",
      "/mind/relations/0/aff",
      "/mind/relations/0/tr",
      "/mind/relations/0/tn",
      "/mind/relations/0/talk",
      "/mind/relations/0/turns",
      "/mind/inbox/0/who",
      "/mind/inbox/0/t",
      "/mind/inbox/0/cell/0",
      "/mind/inbox/0/act",
      "/mind/inbox/0/band",
      "/mind/inbox/0/tn",
      "/mind/inbox/0/ex",
    ]);
  });

  test("bounds each store by the largest capacity a law allows", () => {
    const episodes = Array.from({ length: 17 }, (_, index) => own(index + 1));
    const inbox = Array.from({ length: 5 }, () => ({
      t: 0,
      act: "tell" as const,
      p: foodAt(1, 1),
      tn: 2,
      ex: 0,
    }));
    expect(pathsOf({ ...mindOf({ episodes }), inbox })).toEqual(["/mind/episodes", "/mind/inbox"]);
    expect(issuesOf({ ...mindOf({ episodes }) })[0]?.message).toBe(
      "a store holds at most 16 records, not 17",
    );
  });
});
