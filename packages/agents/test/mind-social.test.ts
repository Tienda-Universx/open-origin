/**
 * The social policy of `mind@1` on senses built by hand (docs/architecture/mind.md "Speech" and
 * "The brain mind@1", plan §7.3): each act has its purpose, and the needs come first. It greets a
 * being it meets or meets again, as its sociability wills; greets back; asks for food when hungry
 * and knowing none; tells food it believes to a being that asks or that answered it, or says it
 * does not know; waits a moment, idle, for an answer; walks to food it believes in when none is
 * in sight; and walks toward a being to greet it. Every act it proposes passes the engine's checks
 * of speech, and its acts stay within a budget that keeps every daily quota.
 */
import { describe, expect, test } from "bun:test";
import type { beings, mind } from "@open-origin/engine";
import { BEING_W, SEEN_CR, SPEAK_WILL, WAIT_MS } from "../src/brain/mind/parameters.ts";
import { foodAt } from "../src/brain/mind/rules.ts";
import { speechBudget, talkWindow } from "../src/brain/mind/social.ts";
import { mindController } from "../src/brain/mind.ts";
import { utilityController } from "../src/index.ts";
import { ruleProblems } from "./support/mind-rules-check.ts";
import {
  type Being2,
  DAY,
  relationView,
  type Senses2,
  SPECIES2,
  seenBeing,
  senses2Of,
} from "./support/mind-senses.ts";
import { type Offset, windowOf } from "./support/senses.ts";

const brain = mindController({ species: SPECIES2, dayLength: DAY });
const utility = utilityController();
const { speech } = SPECIES2;
const W = talkWindow(SPECIES2);

/** The intention of `mind@1`, checked against its rules. */
function decide(senses: Senses2, controller = brain): beings.Intention2 {
  const { decide: unbound } = controller;
  const intention = unbound(senses);
  expect(ruleProblems(senses, intention)).toEqual([]);
  return intention;
}

const R = 24;
const window = (
  walls: readonly Offset[] = [],
  cues: readonly (readonly [number, number, number])[] = [],
) => windowOf({ radius: R, walls, cues });

/** A belief of the view about food at `cell`. */
function belief(id: number, cell: mind.Cell, rest: Partial<mind.BeliefView> & { v?: number } = {}) {
  const { v = 2, ...members } = rest;
  return { id, p: foodAt(cell, v), cr: SEEN_CR, src: 1, ev: [], lost: 0, dp: 1, u: 0, ...members };
}

/** A sated, rested being at noon that perceives being 5 at `cell`, which it knows as `relation`. */
function meeting(
  cell: readonly [number, number] = [2, 0],
  relation: Partial<mind.RelationshipView> = {},
  being: Being2 = {},
): Senses2 {
  return senses2Of(window(), {
    seen: [seenBeing(5, cell)],
    mind: { next: 10, relations: [relationView(2, 5, relation)] },
    draws: [0, 0],
    ...being,
  });
}

const talk = (to: number, act: mind.Act, about?: number | string): beings.TalkStep => ({
  kind: "talk",
  to,
  act,
  ...(about === undefined ? {} : { about }),
});

const behavior = (kind: string) => ({ kind, since: 0, heading: 0 });

describe("the budget of speech", () => {
  test("keeps every daily quota: at most perDay acts in any day, counted over the talk window", () => {
    expect(W).toBe(Math.max(speech.gap + 1, speech.cooldown));
    // ⌊perDay / ⌈day / W⌉⌋: ten acts a day, a day of four windows, two acts a window.
    expect(speechBudget(SPECIES2, DAY)).toBe(2);
    expect(speechBudget(SPECIES2, W)).toBe(speech.perDay);
    expect(speechBudget(SPECIES2, W + 1)).toBe(Math.floor(speech.perDay / 2));
    expect(speechBudget({ ...SPECIES2, speech: { ...speech, perDay: 0 } }, DAY)).toBe(0);
  });

  test("says nothing, unprompted or in reply, once the acts of the window fill it", () => {
    const relations = [relationView(2, 5), relationView(3, 6, { talk: W - 1, turns: 2 })];
    const full = senses2Of(window(), {
      seen: [seenBeing(5, [2, 0])],
      heard: [{ who: 5, cell: [2, 0], act: "ask" }],
      mind: { next: 10, relations },
      draws: [0, 0],
    });
    expect(decide(full)).toEqual(utility.decide(full));
    const past = relations.map((relation) =>
      relation.who === 6 ? { ...relation, talk: W } : relation,
    );
    const room = senses2Of(window(), {
      seen: [seenBeing(5, [2, 0])],
      heard: [{ who: 5, cell: [2, 0], act: "ask" }],
      mind: { next: 10, relations: past },
      draws: [0, 0],
    });
    expect(decide(room).steps).toEqual([talk(5, "unknown")]);
  });
});

describe("greeting", () => {
  test("greets a being it meets within reach of speech, and remembers it", () => {
    const senses = meeting();
    expect(decide(senses)).toEqual({
      steps: [talk(5, "greet")],
      wakeWhen: {},
      behavior: behavior("talk"),
      mind: { remember: [{ percept: { being: 0 }, w: BEING_W }] },
    });
  });

  test("greets as its sociability wills: a draw below its will to speak", () => {
    // The will to speak is SPEAK_WILL felt through sociability: 640 at 800, 800 at 1000.
    const will = (sociability: number) => Math.floor((SPEAK_WILL * sociability) / 1000);
    const at = (sociability: number, draw: number) =>
      decide(meeting([2, 0], {}, { social: { sociability }, draws: [0, draw] })).steps;
    expect(at(800, will(800) - 1)).toEqual([talk(5, "greet")]);
    expect(at(800, will(800))).toEqual(utility.decide(meeting()).steps);
    expect(at(1000, will(800))).toEqual([talk(5, "greet")]);
    expect(at(1200, 1000 + will(1200) - 1)).toEqual([talk(5, "greet")]);
  });

  test("greets no sleeping being, none it holds no relationship with, and none beyond speech", () => {
    const base = utility.decide(meeting()).steps;
    expect(decide(meeting([2, 0], {}, { seen: [seenBeing(5, [2, 0], "sleep")] })).steps).toEqual(
      base,
    );
    expect(decide(meeting([2, 0], {}, { mind: { next: 10 } })).steps).toEqual(base);
    expect(decide(meeting([2, 3])).steps).toEqual([talk(5, "greet")]);
    expect(decide(meeting([2, 4], {}, { social: { sociability: 400 } })).steps).toEqual(base);
  });

  test("greets again only after the talk window, never in the pause of a past conversation", () => {
    const base = utility.decide(meeting()).steps;
    expect(decide(meeting([2, 0], { talk: speech.gap + 1, turns: 1 })).steps).toEqual(base);
    expect(decide(meeting([2, 0], { talk: W - 1, turns: 3 })).steps).toEqual(base);
    expect(decide(meeting([2, 0], { talk: W, turns: 3 })).steps).toEqual([talk(5, "greet")]);
    // Nor in reply: a greet or an ask heard in that pause opens no new conversation.
    for (const act of ["greet", "ask"] as const) {
      const heard = meeting([2, 0], { talk: speech.gap + 1, turns: 1 }, {
        heard: [{ who: 5, cell: [2, 0], act }],
      });
      expect(decide(heard).steps).toEqual(base);
    }
  });

  test("greets back a being that greets it, whatever its will", () => {
    const senses = meeting(
      [2, 0],
      {},
      {
        heard: [{ who: 5, cell: [2, 0], act: "greet" }],
        draws: [0, 999],
      },
    );
    expect(decide(senses).steps).toEqual([talk(5, "greet")]);
  });
});

describe("telling and asking", () => {
  const beliefs = [belief(3, [40, 0], { u: 600 }), belief(4, [40, 10], { v: 1 })];

  test("answers an ask with the food it believes most, by retrieval, or says it does not know", () => {
    const asked = (held: readonly mind.BeliefView[]) =>
      meeting(
        [2, 0],
        {},
        {
          heard: [{ who: 5, cell: [2, 0], act: "ask" }],
          mind: { next: 10, beliefs: held, relations: [relationView(2, 5)] },
          draws: [0, 999],
        },
      );
    expect(decide(asked(beliefs))).toEqual({
      steps: [talk(5, "tell", 3)],
      wakeWhen: {},
      behavior: behavior("talk"),
      mind: { remember: [{ percept: { being: 0 }, w: BEING_W }] },
    });
    expect(decide(asked([])).steps).toEqual([talk(5, "unknown")]);
    // Nothing doubted, nothing of no food, and nothing that being told it.
    const untold = [
      belief(3, [40, 0], { cr: 499 }),
      belief(4, [40, 10], { v: 0 }),
      belief(5, [40, 20], { src: 2, who: 5 }),
    ];
    expect(decide(asked(untold)).steps).toEqual([talk(5, "unknown")]);
  });

  test("tells a being that answered its greet the food it believes, as it wills", () => {
    const answered = (draw: number) =>
      meeting(
        [2, 0],
        { talk: 24, turns: 1 },
        {
          heard: [{ who: 5, cell: [2, 0], act: "greet" }],
          mind: { next: 10, beliefs, relations: [relationView(2, 5, { talk: 24, turns: 1 })] },
          draws: [0, draw],
        },
      );
    expect(decide(answered(0)).steps).toEqual([talk(5, "tell", 3)]);
    expect(decide(answered(999)).steps).toEqual(utility.decide(answered(999)).steps);
  });

  test("asks for food when hungry with none in sight and none it believes in", () => {
    const hungry = meeting([2, 0], {}, { nutrition: 500_000, draws: [0, 999] });
    expect(utility.decide(hungry).behavior.kind).toBe("explore");
    expect(decide(hungry).steps).toEqual([talk(5, "ask", `obs.deposit.${SPECIES2.diet.deposit}`)]);
  });

  test("never lets an operation evict the belief it tells", () => {
    // A full store: the told belief, old, is the least salient; a landmark in sight would evict it.
    const told = belief(1, [40, 0], { u: 10 * DAY });
    // The fresh ones, doubted at 500 and of band 1, rank below it for telling: 256.5M against 250M.
    const fresh = Array.from({ length: 7 }, (_, index) =>
      belief(index + 2, [40 + index, 40], { cr: 500, v: 1 }),
    );
    const senses = senses2Of(window([], [[-9, 0, 2]]), {
      seen: [seenBeing(5, [2, 0])],
      heard: [{ who: 5, cell: [2, 0], act: "ask" }],
      mind: { next: 20, beliefs: [told, ...fresh], relations: [relationView(2, 5)] },
    });
    const intention = decide(senses);
    expect(intention.steps).toEqual([talk(5, "tell", 1)]);
    expect(intention.mind?.believe).toBeUndefined();
  });
});

describe("waiting, seeking, and approaching", () => {
  test("waits a moment, idle, for an answer after it spoke, unless a need wins", () => {
    const spoke = meeting(
      [2, 0],
      { talk: 12, turns: 1 },
      { behavior: { kind: "talk", heading: 3 } },
    );
    const base = utility.decide(spoke);
    expect(decide(spoke)).toEqual({
      steps: [{ kind: "idle", ms: WAIT_MS }],
      wakeWhen: base.wakeWhen,
      behavior: { kind: "wait", since: 0, heading: 3 },
    });
    // Never longer than the pause that continues a conversation.
    const brief = { ...SPECIES2, speech: { ...speech, gap: 30 } };
    const briefly = decide(spoke, mindController({ species: brief, dayLength: DAY }));
    expect(briefly.steps).toEqual([{ kind: "idle", ms: 30_000 }]);
    const hungry = senses2Of(window([], [[3, 3, 2]]), {
      nutrition: 300_000,
      behavior: { kind: "talk", heading: 3 },
    });
    expect(decide(hungry).steps).toEqual(utility.decide(hungry).steps);
  });

  test("walks toward food it believes in when hungry with none in sight", () => {
    const senses = senses2Of(window(), {
      nutrition: 500_000,
      mind: { next: 10, beliefs: [belief(3, [40, 0])] },
    });
    const base = utility.decide(senses);
    expect(decide(senses)).toEqual({
      ...base,
      steps: [{ kind: "walk", dirs: "0".repeat(R) }],
      behavior: { ...base.behavior, kind: "seek" },
    });
  });

  test("seeks no food it doubts, none of band 0, and none it cools", () => {
    const hungry = (held: mind.BeliefView, being: Being2 = {}) =>
      senses2Of(window(), { nutrition: 500_000, mind: { next: 10, beliefs: [held] }, ...being });
    for (const senses of [
      hungry(belief(3, [40, 0], { cr: 499 })),
      hungry(belief(3, [40, 0], { v: 0 })),
      hungry(belief(3, [40, 0]), { cooldowns: [{ cell: [40, 0], until: 999 }] }),
    ])
      expect(decide(senses).steps).toEqual(utility.decide(senses).steps);
  });

  test("forgets food it cannot get any nearer to, and searches instead", () => {
    const wall: Offset[] = Array.from({ length: 2 * R + 1 }, (_, index) => [1, index - R]);
    const senses = senses2Of(window(wall), {
      nutrition: 500_000,
      mind: { next: 10, beliefs: [belief(3, [40, 0])] },
    });
    expect(decide(senses)).toEqual({ ...utility.decide(senses), mind: { drop: [3] } });
  });

  test("walks toward a being it would greet, within the reach its sociability gives", () => {
    const far = meeting([6, 0]);
    expect(decide(far)).toEqual({
      ...utility.decide(far),
      steps: [{ kind: "walk", dirs: "000" }],
      behavior: behavior("approach"),
    });
    // The reach is APPROACH_REACH felt through sociability: 6 cells at 800, 9 at 1200.
    expect(decide(meeting([7, 0], {}, { social: { sociability: 800 } })).behavior.kind).toBe(
      "rest",
    );
    expect(decide(meeting([9, 0], {}, { social: { sociability: 1200 } })).behavior.kind).toBe(
      "approach",
    );
  });

  test("approaches no being that walks or sleeps, and never twice in a row", () => {
    for (const senses of [
      meeting([6, 0], {}, { seen: [seenBeing(5, [6, 0], "walk")] }),
      meeting([6, 0], {}, { seen: [seenBeing(5, [6, 0], "sleep")] }),
      meeting([6, 0], {}, { behavior: { kind: "approach", heading: 0 } }),
    ])
      expect(decide(senses).steps).toEqual(utility.decide(senses).steps);
  });

  test("leaves every act when a need wins: a hungry being forages, whatever it hears", () => {
    const senses = senses2Of(window([], [[3, 3, 2]]), {
      nutrition: 300_000,
      seen: [seenBeing(5, [2, 0])],
      heard: [{ who: 5, cell: [2, 0], act: "ask" }],
      mind: { next: 10, relations: [relationView(2, 5)] },
    });
    const intention = decide(senses);
    expect(intention.behavior.kind).toBe("forage");
    expect(intention.steps).toEqual(utility.decide(senses).steps);
  });
});
