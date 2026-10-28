/**
 * The memory of `mind@1` on senses built by hand (docs/architecture/mind.md "The brain mind@1"
 * and "Beliefs"): it keeps `utility@1`'s survival as it is and adds mental operations, each
 * proposed through the public decision: a landmark of food it sees, a testimony it hears, and a
 * check of what it believes against what it sees, which revises the belief and, for a testimony,
 * its trust in the speaker. Every belief operation is its rule applied to what it cites, no belief
 * cites nothing, and the operations never exceed the law nor cite a record a full store evicts.
 */
import { describe, expect, test } from "bun:test";
import { beings, type mind } from "@open-origin/engine";
import {
  CONTRADICTED_CR,
  FOOD_W,
  HEARD_W,
  MIND_BEHAVIORS,
  MIND_BRAIN,
  MIND_CONCEPTS,
  RULE_IDS,
  SEEN_CR,
  TRUST_STEP,
} from "../src/brain/mind/parameters.ts";
import { foodAt } from "../src/brain/mind/rules.ts";
import { mindController } from "../src/brain/mind.ts";
import { utilityController } from "../src/index.ts";
import { reformed } from "./support/mind-ablation.ts";
import { ruleProblems } from "./support/mind-rules-check.ts";
import { DAY, relationView, type Senses2, SPECIES2, senses2Of } from "./support/mind-senses.ts";
import { windowOf } from "./support/senses.ts";

const brain = mindController({ species: SPECIES2, dayLength: DAY });
const utility = utilityController();

/** The intention of `mind@1`, checked against its rules: no belief cites nothing. */
function decide(senses: Senses2, controller = brain): beings.Intention2 {
  const { decide: unbound } = controller;
  const intention = unbound(senses);
  expect(ruleProblems(senses, intention)).toEqual([]);
  for (const op of intention.mind?.believe ?? []) expect(op.ev.length).toBeGreaterThan(0);
  return intention;
}

/** The same intention without its mental operations: what `utility@1` decides from the senses. */
function survival(intention: beings.Intention2): beings.Intention2 {
  const { mind: _ops, ...rest } = intention;
  return rest;
}

/** A belief of the view, about food at `cell`, held `u` seconds since it was last used. */
function belief(
  id: number,
  cell: mind.Cell,
  rest: Partial<mind.BeliefView> & { v?: number } = {},
): mind.BeliefView {
  const { v = 2, ...members } = rest;
  return { id, p: foodAt(cell, v), cr: SEEN_CR, src: 1, ev: [], lost: 0, dp: 1, u: 0, ...members };
}

const R = 24;
const window = (cues: readonly (readonly [number, number, number])[] = []) =>
  windowOf({ radius: R, cues });

describe("mind@1 composes utility@1", () => {
  test("declares its version, its behaviors, and its namespace", () => {
    expect(brain.brain).toBe(MIND_BRAIN);
    expect(brain.behaviors).toEqual(MIND_BEHAVIORS);
    expect(brain.concepts).toBe(MIND_CONCEPTS);
    expect(MIND_BEHAVIORS.slice(0, 5)).toEqual(["forage", "eat", "sleep", "explore", "rest"]);
    const ruleset = beings.createBeingsRuleset({ controllers: { s1: brain }, rules: "beings@2" });
    expect(ruleset.versions.brain).toBe(`s1:${MIND_BRAIN}`);
  });

  test("decides what utility@1 decides when nothing is there to remember or say", () => {
    const senses = senses2Of(window());
    const intention = decide(senses);
    expect(intention).toEqual(utility.decide(senses));
    expect(intention.mind).toBeUndefined();
    // Hungry, sleepy at night, and with food to forage: the same plans, the needs first.
    for (const being of [
      { nutrition: 300_000 },
      { rest: 500_000, light: 40 },
      { nutrition: 500_000, behavior: { kind: "forage", heading: 2 } },
    ]) {
      const other = senses2Of(window([[5, 5, 2]]), being);
      expect(survival(decide(other))).toEqual(utility.decide(other));
    }
  });

  test("is a pure function of its senses: the same intention, nothing written, no `this`", () => {
    const senses = senses2Of(window([[3, 0, 2]]), {
      heard: [{ who: 7, cell: [1, 0], act: "tell", p: foodAt([30, 0], 2), band: 2 }],
      mind: { next: 4, relations: [relationView(2, 7)] },
    });
    const before = structuredClone(senses);
    const first = decide(senses);
    expect(decide(senses)).toEqual(first);
    expect(senses).toEqual(before);
    expect(mindController({ species: SPECIES2, dayLength: DAY }).decide(senses)).toEqual(first);
  });
});

describe("a landmark of food the being sees", () => {
  test("remembers the best cue in sight and believes it by seen-food, citing the episode", () => {
    const senses = senses2Of(
      window([
        [3, 0, 2],
        [1, 1, 1],
        [-2, 0, 2],
      ]),
      { mind: { next: 10 } },
    );
    const intention = decide(senses);
    expect(intention.mind).toEqual({
      remember: [{ percept: { food: [-2, 0] }, w: FOOD_W }],
      believe: [{ p: foodAt([-2, 0], 2), cr: SEEN_CR, ev: [10], rule: RULE_IDS.seen }],
    });
    expect(survival(intention)).toEqual(utility.decide(senses));
  });

  test("forms no landmark within LANDMARK_SPACING cells of food it already believes in", () => {
    const held = [belief(3, [-14, 30])];
    const near = senses2Of(window([[-14, 18, 2]]), { mind: { next: 10, beliefs: held } });
    expect(decide(near).mind).toBeUndefined();
    const far = senses2Of(window([[-14, 17, 2]]), { mind: { next: 10, beliefs: held } });
    expect(decide(far).mind?.believe).toEqual([
      { p: foodAt([-14, 17], 2), cr: SEEN_CR, ev: [10], rule: RULE_IDS.seen },
    ]);
    // A belief it doubts, or one of no food, is no landmark.
    for (const doubted of [belief(3, [-14, 30], { cr: 499 }), belief(3, [-14, 30], { v: 0 })]) {
      const senses = senses2Of(window([[-14, 18, 2]]), { mind: { next: 10, beliefs: [doubted] } });
      expect(decide(senses).mind?.remember).toEqual([{ percept: { food: [-14, 18] }, w: FOOD_W }]);
    }
  });

  test("never believes again a proposition it holds, whatever its confidence", () => {
    const held = [belief(3, [2, 0], { cr: 100 })];
    const senses = senses2Of(window([[2, 0, 2]]), { mind: { next: 10, beliefs: held } });
    expect(decide(senses).mind?.believe).toBeUndefined();
  });
});

describe("a check of what the being believes against what it sees", () => {
  test("revises down a belief whose cell shows another band, citing what it sees there", () => {
    for (const cues of [[], [[4, 0, 1]]] as const) {
      const held = [belief(3, [4, 0])];
      const senses = senses2Of(window(cues), { mind: { next: 10, beliefs: held } });
      expect(decide(senses).mind).toEqual({
        remember: [{ percept: { food: [4, 0] }, w: FOOD_W }],
        revise: [{ id: 3, cr: CONTRADICTED_CR, ev: [10] }],
      });
    }
  });

  test("changes its trust in the speaker of a testimony it sees contradicted, or confirmed", () => {
    const told = belief(3, [4, 0], { cr: 640, src: 2, who: 7 });
    const relations = [relationView(2, 7, { tr: 600 })];
    const contradicted = senses2Of(window(), { mind: { next: 10, beliefs: [told], relations } });
    expect(decide(contradicted).mind).toEqual({
      remember: [{ percept: { food: [4, 0] }, w: FOOD_W }],
      revise: [{ id: 3, cr: CONTRADICTED_CR, ev: [10] }],
      relate: [{ who: 7, tr: -TRUST_STEP, because: [3, 10] }],
    });
    const confirmed = senses2Of(window([[4, 0, 2]]), {
      mind: { next: 10, beliefs: [told], relations },
    });
    expect(decide(confirmed).mind).toEqual({
      remember: [{ percept: { food: [4, 0] }, w: FOOD_W }],
      revise: [{ id: 3, cr: SEEN_CR, ev: [10] }],
      relate: [{ who: 7, tr: TRUST_STEP, because: [3, 10] }],
    });
    // A speaker it holds no relationship with is not related.
    const unknown = senses2Of(window(), { mind: { next: 10, beliefs: [told] } });
    expect(decide(unknown).mind?.relate).toBeUndefined();
  });

  test("leaves alone a belief it saw and sees again, and drops one contradicted twice", () => {
    const seen = senses2Of(window([[4, 0, 2]]), {
      mind: { next: 10, beliefs: [belief(3, [4, 0])] },
    });
    expect(decide(seen).mind).toBeUndefined();
    const twice = belief(3, [4, 0], { cr: CONTRADICTED_CR });
    const again = senses2Of(window(), { mind: { next: 10, beliefs: [twice] } });
    expect(decide(again).mind).toEqual({ drop: [3] });
    // Seen with its band again, a doubted belief is confirmed instead.
    const back = senses2Of(window([[4, 0, 2]]), { mind: { next: 10, beliefs: [twice] } });
    expect(decide(back).mind?.revise).toEqual([{ id: 3, cr: SEEN_CR, ev: [10] }]);
  });
});

describe("a testimony the being hears", () => {
  const tell = (band?: number, who?: number): beings.HeardMessage => ({
    ...(who === undefined ? {} : { who, cell: [1, 0] as mind.Cell }),
    act: "tell",
    p: foodAt([30, 0], 2),
    ...(band === undefined ? {} : { band }),
  });

  test("believes it by told-food, citing the message and the relationship with the speaker", () => {
    const senses = senses2Of(window(), {
      heard: [tell(2, 7)],
      mind: { next: 10, relations: [relationView(2, 7, { tr: 700 })] },
    });
    expect(decide(senses).mind).toEqual({
      remember: [{ percept: { heard: 0 }, w: HEARD_W }],
      believe: [{ p: foodAt([30, 0], 2), cr: 960, ev: [10, 2], rule: RULE_IDS.told }],
    });
  });

  test("weighs a speaker it holds no relationship with, and one it cannot see, as strangers", () => {
    const stranger = senses2Of(window(), { heard: [tell(2, 7)], mind: { next: 10 } });
    expect(decide(stranger).mind?.believe).toEqual([
      { p: foodAt([30, 0], 2), cr: 800, ev: [10], rule: RULE_IDS.told },
    ]);
    const unseen = senses2Of(window(), { heard: [tell()], mind: { next: 10 } });
    expect(decide(unseen).mind?.believe).toEqual([
      { p: foodAt([30, 0], 2), cr: 600, ev: [10], rule: RULE_IDS.told },
    ]);
  });

  test("believes only what its credulity lets pass the floor, and nothing it holds already", () => {
    const doubting = senses2Of(window(), {
      heard: [tell(1, 7)],
      social: { credulity: 800 },
      mind: { next: 10 },
    });
    expect(decide(doubting).mind).toBeUndefined();
    const credulous = senses2Of(window(), {
      heard: [tell(1, 7)],
      social: { credulity: 900 },
      mind: { next: 10 },
    });
    expect(decide(credulous).mind?.believe?.[0]?.cr).toBe(540);
    const held = senses2Of(window(), {
      heard: [tell(2, 7)],
      mind: { next: 10, beliefs: [belief(3, [30, 0], { cr: 300 })] },
    });
    expect(decide(held).mind).toBeUndefined();
  });

  test("never believes a message that tells no food claim", () => {
    const greet: beings.HeardMessage = { who: 7, cell: [1, 0], act: "greet" };
    const other: beings.HeardMessage = { ...tell(2, 7), p: { p: "m1.other", a: [{ n: 1 }] } };
    const senses = senses2Of(window(), { heard: [greet, other], mind: { next: 10 } });
    expect(decide(senses).mind).toBeUndefined();
  });
});

describe("the operations of one decision", () => {
  /** A decision with a testimony, a told belief contradicted, and food in sight. */
  const busy = senses2Of(window([[-9, 0, 2]]), {
    heard: [{ who: 7, cell: [1, 0], act: "tell", p: foodAt([30, 0], 2), band: 2 }],
    mind: {
      next: 10,
      beliefs: [belief(3, [4, 0], { cr: 640, src: 2, who: 7 })],
      relations: [relationView(2, 7)],
    },
  });

  test("keep within the law, by priority: a check, a testimony, then a landmark", () => {
    const lawOf = (ops: number) =>
      mindController({ species: { ...SPECIES2, mind: { ...SPECIES2.mind, ops } }, dayLength: DAY });
    // All three, when the law allows them: the episodes take their ids in that order.
    expect(decide(busy, lawOf(8)).mind).toEqual({
      remember: [
        { percept: { food: [4, 0] }, w: FOOD_W },
        { percept: { heard: 0 }, w: HEARD_W },
        { percept: { food: [-9, 0] }, w: FOOD_W },
      ],
      believe: [
        { p: foodAt([30, 0], 2), cr: 800, ev: [11, 2], rule: RULE_IDS.told },
        { p: foodAt([-9, 0], 2), cr: SEEN_CR, ev: [12], rule: RULE_IDS.seen },
      ],
      revise: [{ id: 3, cr: CONTRADICTED_CR, ev: [10] }],
      relate: [{ who: 7, tr: -TRUST_STEP, because: [3, 10] }],
    });
    // The check takes three of the four the default law allows; neither of the others fits.
    expect(decide(busy).mind).toEqual({
      remember: [{ percept: { food: [4, 0] }, w: FOOD_W }],
      revise: [{ id: 3, cr: CONTRADICTED_CR, ev: [10] }],
      relate: [{ who: 7, tr: -TRUST_STEP, because: [3, 10] }],
    });
    expect(decide(busy, lawOf(2)).mind).toEqual({
      remember: [{ percept: { heard: 0 }, w: HEARD_W }],
      believe: [{ p: foodAt([30, 0], 2), cr: 800, ev: [10, 2], rule: RULE_IDS.told }],
    });
    expect(decide(busy, lawOf(0)).mind).toBeUndefined();
  });

  test("judge a landmark new against what the mind holds, never against the decision's testimony", () => {
    // The verifier's case: food at (30, 0) it believed, saw contradicted once, and hears told again.
    const senses = senses2Of(window([[20, 0, 2]]), {
      heard: [{ who: 7, cell: [1, 0], act: "tell", p: foodAt([30, 0], 2), band: 2 }],
      mind: {
        next: 10,
        beliefs: [belief(3, [30, 0], { cr: CONTRADICTED_CR })],
        relations: [relationView(2, 7)],
      },
    });
    const landmark = { p: foodAt([20, 0], 2), cr: SEEN_CR, ev: [10], rule: RULE_IDS.seen };
    expect(decide(senses).mind).toEqual({
      remember: [{ percept: { food: [20, 0] }, w: FOOD_W }],
      believe: [landmark],
    });
    // Decided again with none of its records, it believes the testimony and still the landmark,
    // though the testimony's food lies 10 cells from it.
    const bare = { ...senses, mind: { ...senses.mind, beliefs: [], relations: [] } };
    expect(decide(bare).mind).toEqual({
      remember: [
        { percept: { heard: 0 }, w: HEARD_W },
        { percept: { food: [20, 0] }, w: FOOD_W },
      ],
      believe: [
        { p: foodAt([30, 0], 2), cr: 800, ev: [10], rule: RULE_IDS.told },
        { ...landmark, ev: [11] },
      ],
    });
  });

  test("let a landmark adopt the claim a testimony of the same decision believes", () => {
    // Told what it sees: the testimony forms the belief, and the landmark revises it by adopting
    // it, which takes no id and enters no store.
    const told = senses2Of(window([[20, 0, 2]]), {
      heard: [{ who: 7, cell: [1, 0], act: "tell", p: foodAt([20, 0], 2), band: 2 }],
      mind: { next: 10 },
    });
    expect(decide(told).mind).toEqual({
      remember: [
        { percept: { heard: 0 }, w: HEARD_W },
        { percept: { food: [20, 0] }, w: FOOD_W },
      ],
      believe: [
        { p: foodAt([20, 0], 2), cr: 800, ev: [10], rule: RULE_IDS.told },
        { p: foodAt([20, 0], 2), cr: SEEN_CR, ev: [11], rule: RULE_IDS.seen },
      ],
    });
  });

  test("count no room for a landmark that adopts, in a store full of what it needs", () => {
    // Seven beliefs: an old one at (4, 0), which the window contradicts, the least salient, and six
    // fresh ones far away. The testimony fills the store; the landmark adopts its claim and evicts
    // nothing, so the belief the check revises stays.
    const old = belief(1, [4, 0], { u: 10 * DAY });
    const fresh = Array.from({ length: 6 }, (_, index) => belief(index + 2, [40 + index, 40]));
    const senses = senses2Of(window([[20, 0, 2]]), {
      heard: [{ who: 7, cell: [1, 0], act: "tell", p: foodAt([20, 0], 2), band: 2 }],
      mind: { next: 20, beliefs: [old, ...fresh] },
    });
    const wide = mindController({
      species: { ...SPECIES2, mind: { ...SPECIES2.mind, ops: 8 } },
      dayLength: DAY,
    });
    expect(decide(senses, wide).mind).toEqual({
      remember: [
        { percept: { food: [4, 0] }, w: FOOD_W },
        { percept: { heard: 0 }, w: HEARD_W },
        { percept: { food: [20, 0] }, w: FOOD_W },
      ],
      believe: [
        { p: foodAt([20, 0], 2), cr: 800, ev: [21], rule: RULE_IDS.told },
        { p: foodAt([20, 0], 2), cr: SEEN_CR, ev: [22], rule: RULE_IDS.seen },
      ],
      revise: [{ id: 1, cr: CONTRADICTED_CR, ev: [20] }],
    });
  });

  test("form each belief again from its citations alone: the ablation of the decision", () => {
    // Decided again with only the records an operation cites, the belief it revises, and every
    // input that is no record, the decision still proposes it (mind.md, "Evaluation").
    const law = mindController({
      species: { ...SPECIES2, mind: { ...SPECIES2.mind, ops: 8 } },
      dayLength: DAY,
    });
    const known = senses2Of(
      window([
        [-9, 0, 2],
        [-3, 1, 2],
        [2, 2, 1],
      ]),
      {
        heard: [
          { who: 7, cell: [1, 0], act: "tell", p: foodAt([40, 0], 1), band: 1 },
          { who: 7, cell: [1, 0], act: "tell", p: foodAt([30, 0], 2), band: 2 },
        ],
        mind: {
          next: 10,
          beliefs: [
            belief(3, [4, 0], { cr: 640, src: 2, who: 7 }),
            belief(4, [-3, 12]),
            belief(5, [40, 0], { v: 1, cr: 300 }),
          ],
          relations: [relationView(2, 7)],
        },
      },
    );
    // The best cue in sight lies within 12 cells of food it believes in, beyond its window.
    const novel = senses2Of(
      window([
        [0, 20, 2],
        [5, -5, 1],
      ]),
      {
        mind: { next: 10, beliefs: [belief(3, [0, 30])] },
      },
    );
    const checks = [busy, known, novel].flatMap((senses) =>
      [brain, law].flatMap((controller) =>
        reformed(senses, (ablation) => decide(ablation, controller)),
      ),
    );
    for (const { op, again } of checks) expect(again).toContainEqual(op);
    const checked = checks.length;
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  test("never cite a new episode its full store would evict at once", () => {
    // Eight recent episodes of importance 800: a cue remembered at FOOD_W would leave at once.
    const episodes = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      kind: "being" as const,
      t: 0,
      cell: [0, 0] as mind.Cell,
      who: 50 + index,
      v: 1,
      w: 800,
      r: 0,
    }));
    const senses = senses2Of(window([[3, 0, 2]]), { mind: { next: 20, episodes } });
    expect(decide(senses).mind).toBeUndefined();
    // With one old episode among them, the cue takes its place and is believed.
    const faded = episodes.map((episode, index) =>
      index === 0 ? { ...episode, w: 100 } : episode,
    );
    const room = senses2Of(window([[3, 0, 2]]), { mind: { next: 20, episodes: faded } });
    expect(decide(room).mind?.believe?.[0]?.ev).toEqual([20]);
  });

  test("never form a belief that would evict one they revise", () => {
    // Seven fresh beliefs far away, and an old one at (4, 0), which the window contradicts.
    const old = belief(1, [4, 0], { u: 10 * DAY });
    const fresh = Array.from({ length: 7 }, (_, index) => belief(index + 2, [40 + index, 40]));
    const senses = senses2Of(window([[-9, 0, 2]]), {
      mind: { next: 20, beliefs: [old, ...fresh] },
    });
    expect(decide(senses).mind).toEqual({
      remember: [{ percept: { food: [4, 0] }, w: FOOD_W }],
      revise: [{ id: 1, cr: CONTRADICTED_CR, ev: [20] }],
    });
  });
});

describe("the check that every belief operation is its rule", () => {
  // A told belief of (4, 0) that the window contradicts, the cue the decision remembers of it,
  // and the relationship with its speaker: the operations of a check, written by hand.
  const told = belief(3, [4, 0], { cr: 640, src: 2, who: 7 });
  const senses = senses2Of(window(), {
    mind: { next: 10, beliefs: [told], relations: [relationView(2, 7)] },
  });
  const checked = (ops: beings.MindIntention) =>
    ruleProblems(senses, { ...utility.decide(senses), mind: ops });
  const remember = [{ percept: { food: [4, 0] as const }, w: FOOD_W }];

  test("accepts a relate that is the trust change of the testimony it checks", () => {
    expect(checked({ remember, relate: [{ who: 7, tr: -TRUST_STEP, because: [3, 10] }] })).toEqual(
      [],
    );
  });

  test.each([
    { name: "the wrong sign", relate: { who: 7, tr: TRUST_STEP, because: [3, 10] } },
    { name: "the wrong size", relate: { who: 7, tr: -1, because: [3, 10] } },
    { name: "another being", relate: { who: 8, tr: -TRUST_STEP, because: [3, 10] } },
    { name: "an affinity", relate: { who: 7, aff: 5, tr: -TRUST_STEP, because: [3, 10] } },
    { name: "no cue", relate: { who: 7, tr: -TRUST_STEP, because: [3] } },
  ])("refuses a relate with $name", ({ relate }) => {
    expect(checked({ remember, relate: [relate] })).toHaveLength(1);
  });

  test("refuses a relate of a belief the being was not told", () => {
    const seen = senses2Of(window(), {
      mind: {
        next: 10,
        beliefs: [belief(3, [4, 0], { cr: 640 })],
        relations: [relationView(2, 7)],
      },
    });
    const ops = { remember, relate: [{ who: 7, tr: -TRUST_STEP, because: [3, 10] }] };
    expect(ruleProblems(seen, { ...utility.decide(seen), mind: ops })).toHaveLength(1);
  });

  test("accepts a drop of a belief contradicted again, or of food beyond its window, only", () => {
    const twice = belief(3, [4, 0], { cr: CONTRADICTED_CR });
    const beyond = belief(4, [40, 0]);
    const held = senses2Of(window([[5, 0, 2]]), {
      mind: { next: 10, beliefs: [twice, beyond, belief(5, [5, 0]), belief(6, [4, 0], { v: 0 })] },
    });
    const dropped = (id: number) =>
      ruleProblems(held, { ...utility.decide(held), mind: { drop: [id] } });
    expect(dropped(3)).toEqual([]);
    expect(dropped(4)).toEqual([]);
    // Seen as it believes it, or seen as it is: no drop.
    expect(dropped(5)).toHaveLength(1);
    expect(dropped(6)).toHaveLength(1);
    expect(dropped(99)).toHaveLength(1);
  });
});
