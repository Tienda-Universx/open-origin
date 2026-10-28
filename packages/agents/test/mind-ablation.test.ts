/**
 * The whole-decision ablation (b) of docs/architecture/mind.md ("Evaluation") as a property of
 * `mind@1`, over decisions generated from a fixed seed: whatever the being holds, hears, and sees,
 * each belief operation it proposes is proposed again when it decides with only the records that
 * operation cites, the belief it revises, and every input that is no record. The generator favours
 * what makes operations depend on each other: testimonies of claims the being holds or doubts,
 * cues near what it is told, beliefs inside and beyond its window, and full stores, under the
 * frozen laws.
 */
import { describe, expect, test } from "bun:test";
import { type beings, canonicalize, type mind } from "@open-origin/engine";
import { Sfc32 } from "../../engine/test/support/sfc32.ts";
import { foodAt } from "../src/brain/mind/rules.ts";
import { mindController } from "../src/brain/mind.ts";
import { ablationA, ablationB, reformed } from "./support/mind-ablation.ts";
import { ruleProblems } from "./support/mind-rules-check.ts";
import {
  DAY,
  relationView,
  type Senses2,
  SPECIES2,
  seenBeing,
  senses2Of,
} from "./support/mind-senses.ts";
import { NIGHT, NOON, windowOf } from "./support/senses.ts";

const brain = mindController({ species: SPECIES2, dayLength: DAY });

/** How many decisions the property draws, and the seed they come from. */
const DECISIONS = 250;
const SEED = 0x7e57_a61e;

/** A draw from `random` in [0, n). */
const below = (random: Sfc32, n: number) => random.below(n);

/** An element of `items` drawn from `random`. */
function pick<T>(random: Sfc32, items: readonly T[]): T {
  return items[below(random, items.length)] as T;
}

/** A cell within `reach` cells of `around`. */
function near(random: Sfc32, around: mind.Cell, reach: number): mind.Cell {
  return [
    around[0] + below(random, 2 * reach + 1) - reach,
    around[1] + below(random, 2 * reach + 1) - reach,
  ];
}

/** Food cues in the window: up to six cells of band 1 or 2. */
function cuesOf(random: Sfc32): [number, number, number][] {
  return Array.from({ length: below(random, 7) }, () => {
    const [x, y] = near(random, [0, 0], 24);
    return [x, y, 1 + below(random, 2)];
  });
}

/** The cells the generator speaks of: cues, cells near them, and cells beyond the window. */
function cellOf(random: Sfc32, cues: readonly (readonly number[])[]): mind.Cell {
  const cue = cues.length > 0 ? pick(random, cues) : undefined;
  const roll = below(random, 4);
  if (cue !== undefined && roll === 0) return [cue[0] as number, cue[1] as number];
  if (cue !== undefined && roll === 1)
    return near(random, [cue[0] as number, cue[1] as number], 12);
  return roll === 2 ? near(random, [0, 0], 24) : near(random, [36, 0], 10);
}

/** Held beliefs of food, of every band, confidence, and kind of evidence: up to five, or a full store. */
function beliefsOf(random: Sfc32, cues: readonly (readonly number[])[]): mind.BeliefView[] {
  // A third of the stores are full, so that a belief one operation forms may evict another's.
  const count = below(random, 3) === 0 ? SPECIES2.mind.beliefs : below(random, 6);
  return Array.from({ length: count }, (_, index) => {
    const told = below(random, 2) === 0;
    return {
      id: 20 + index,
      p: foodAt(cellOf(random, cues), below(random, 3)),
      cr: pick(random, [100, 300, 499, 500, 640, 900]),
      src: told ? 2 : 1,
      ...(told ? { who: pick(random, [7, 8]) } : {}),
      ev: [],
      lost: 0,
      dp: 1,
      u: below(random, 4) * 100_000,
    };
  });
}

/** Up to two messages: tells of claims it holds, of cells near its cues, greets, and asks. */
function heardOf(
  random: Sfc32,
  cues: readonly (readonly number[])[],
  held: readonly mind.BeliefView[],
): beings.HeardMessage[] {
  return Array.from({ length: below(random, 3) }, () => {
    const who = pick(random, [7, 8, undefined]);
    const speaker = who === undefined ? {} : { who, cell: [1, 0] as mind.Cell };
    const act = pick(random, ["tell", "tell", "tell", "greet", "ask"] as const);
    if (act !== "tell") return { ...speaker, act };
    const known = held.length > 0 && below(random, 2) === 0 ? pick(random, held) : undefined;
    const p = known?.p ?? foodAt(cellOf(random, cues), 1 + below(random, 2));
    return { ...speaker, act, p, ...(who === undefined ? {} : { band: below(random, 3) }) };
  });
}

/** A decision drawn from `random`. */
function decisionOf(random: Sfc32): Senses2 {
  const cues = cuesOf(random);
  const beliefs = beliefsOf(random, cues);
  const relations = [7, 8]
    .filter(() => below(random, 3) > 0)
    .map((who, index) => relationView(10 + index, who, { tr: pick(random, [200, 500, 800]) }));
  return senses2Of(windowOf({ radius: 24, cues }), {
    nutrition: pick(random, [900_000, 550_000, 300_000]),
    light: pick(random, [NOON, NOON, NIGHT]),
    behavior: {
      kind: pick(random, ["rest", "explore", "talk", "wait"]),
      heading: below(random, 8),
    },
    draws: [random.next(), random.next()],
    seen: [7, 8]
      .filter(() => below(random, 2) === 0)
      .map((id) => seenBeing(id, near(random, [0, 0], 4))),
    heard: heardOf(random, cues, beliefs),
    mind: { next: 50, beliefs, relations },
  });
}

describe("the ablation of the decisions of mind@1", () => {
  test("proposes again every belief operation from only the records it cites", () => {
    const random = new Sfc32(SEED);
    const misses: string[] = [];
    let checked = 0;
    for (let decision = 0; decision < DECISIONS; decision += 1) {
      const senses = decisionOf(random);
      const decide = (ablation: Senses2) => {
        const intention = brain.decide(ablation);
        expect(ruleProblems(ablation, intention)).toEqual([]);
        return intention;
      };
      for (const { op, again } of reformed(senses, decide)) {
        checked += 1;
        if (!again.some((other) => JSON.stringify(other) === JSON.stringify(op)))
          misses.push(
            `decision ${decision}: ${JSON.stringify(op)} not in ${JSON.stringify(again)}`,
          );
      }
    }
    expect(misses.slice(0, 3)).toEqual([]);
    // Not vacuous: the decisions formed and revised many beliefs.
    expect(checked).toBeGreaterThan(DECISIONS / 2);
  });
});

/**
 * A decision `mind@1` makes a landmark of: food of band 2 two cells east of the being, a belief
 * of food beyond its window, id 20, and nothing heard.
 */
const LANDMARK = senses2Of(windowOf({ radius: 24, cues: [[2, 0, 2]] }), {
  light: NOON,
  mind: {
    next: 50,
    beliefs: [{ id: 20, p: foodAt([60, 0], 2), cr: 900, src: 1, ev: [], lost: 0, dp: 1, u: 0 }],
  },
});

/**
 * `mind@1`, plus a defect: a belief that the food of the cell of belief 20 is of band 1, citing
 * `cites`, which a decision that holds belief 20 forms and one that does not never does.
 */
const hiding =
  (cites: (senses: Senses2) => number[]) =>
  (senses: Senses2): beings.Intention2 => {
    const intention = brain.decide(senses);
    if (!senses.mind.beliefs.some(({ id }) => id === 20)) return intention;
    const ops = intention.mind ?? {};
    const hidden = { p: foodAt([60, 0], 1), cr: 500, ev: cites(senses), rule: "seen-food" };
    return { ...intention, mind: { ...ops, believe: [...(ops.believe ?? []), hidden] } };
  };

describe("the ablations of a recorded decision (a) and (b)", () => {
  test("hold for mind@1, which forms its landmark from the cue it cites", () => {
    const intention = brain.decide(LANDMARK);
    expect(intention.mind?.believe?.map(({ rule }) => rule)).toEqual(["seen-food"]);
    const decide = (senses: Senses2) => brain.decide(senses);
    expect(ablationA(LANDMARK, intention, decide).misses).toEqual([]);
    expect(ablationB(LANDMARK, intention, decide)).toEqual([]);
  });

  test("(b) finds a belief whose premise the brain read but did not cite", () => {
    // The hidden belief cites the landmark's new episode: decided with only that, it is gone.
    const decide = hiding((senses) => [senses.mind.next]);
    const misses = ablationB(LANDMARK, decide(LANDMARK), decide);
    expect(misses.map(({ op }) => op.p)).toEqual([canonicalize(foodAt([60, 0], 1))]);
  });

  test("(a) finds a belief that the brain forms without the record it cites", () => {
    // The hidden belief cites belief 20 itself, then reads it from nowhere: removed, it cites
    // nothing, and the proposition comes back with no evidence.
    const decide = (senses: Senses2) => {
      const made = hiding(({ mind }) =>
        mind.beliefs.filter(({ id }) => id === 20).map(({ id }) => id),
      )(senses);
      if (senses.mind.beliefs.some(({ id }) => id === 20)) return made;
      const ops = made.mind ?? {};
      const unfounded = { p: foodAt([60, 0], 1), cr: 500, ev: [], rule: "seen-food" };
      return { ...made, mind: { ...ops, believe: [...(ops.believe ?? []), unfounded] } };
    };
    const { misses, removable } = ablationA(LANDMARK, decide(LANDMARK), decide);
    expect(removable).toBe(1);
    expect(misses.map(({ op }) => op.p)).toEqual([canonicalize(foodAt([60, 0], 1))]);
  });
});
