/**
 * Provenance and taints (docs/architecture/mind.md, "Provenance and taints"): the masks, the rules
 * of the table for each record, the growth of exposure, and the downstream flow, checked against an
 * oracle that rebuilds every belief's taints by walking the graph of what it cites, which shares no
 * code with the engine's single pass by increasing id.
 */
import { describe, expect, test } from "bun:test";
import { mind } from "../src/index.ts";
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
import { Sfc32 } from "./support/sfc32.ts";

const {
  applyBeliefs,
  exposureAfterBelief,
  exposureAfterMessage,
  formedTaints,
  isReasoned,
  LIVE_MANIFEST,
  recordOf,
  revisedTaints,
  TAINTS,
  taintsOf,
} = mind;

/** The live records of `subject` with the ids `ids`, in order. */
function records(subject: mind.Mind, ids: readonly number[]): mind.MindRecord[] {
  return ids.map((id) => {
    const found = recordOf(subject, id);
    if (found === undefined) throw new Error(`no record ${id}`);
    return found;
  });
}

const SOURCES = mindOf({
  episodes: [
    own(1),
    seen(2, 40),
    own(3, { kind: "ate" }),
    own(4, { kind: "failed", v: 0 }),
    heard(5, 41, { tn: 1, ex: 4 }),
    heard(6, 42, { act: "greet", tn: 0, ex: 0 }),
    external(7, { tn: 2 | 4 }),
  ],
  beliefs: [belief(8, { tn: 4, ex: 2 })],
  relations: [relationship(9, 41, { tn: 1 })],
});

describe("taint masks and the records' own taints", () => {
  test("name the three taints by their bits", () => {
    expect(TAINTS).toEqual({ modelPriorSuspect: 1, humanExternal: 2, implementationLeak: 4 });
  });

  test("give each record the lineage and exposure of the table", () => {
    const taints = records(SOURCES, [1, 2, 3, 4, 5, 6, 7, 8, 9]).map(taintsOf);
    expect(taints).toEqual([
      { tn: 0, ex: 0 },
      { tn: 0, ex: 0 },
      { tn: 0, ex: 0 },
      { tn: 0, ex: 0 },
      { tn: 1, ex: 4 },
      { tn: 0, ex: 0 },
      // An injection's lineage, with no exposure; a relationship has no exposure of its own.
      { tn: 6, ex: 0 },
      { tn: 4, ex: 2 },
      { tn: 1, ex: 0 },
    ]);
  });
});

describe("the taints of a new and of a revised belief", () => {
  test("a new belief takes the union of what it cites, and the being's exposure", () => {
    expect(formedTaints(records(SOURCES, [5, 7, 9]), 0)).toEqual({ tn: 7, ex: 4 });
    expect(formedTaints(records(SOURCES, [9, 5]), 2)).toEqual({ tn: 1, ex: 6 });
    // Every premise counts, not the first only.
    expect(formedTaints(records(SOURCES, [1, 8]), 0)).toEqual({ tn: 4, ex: 2 });
  });

  test("a new belief that cites nothing is model-prior-suspect; one from observations is not", () => {
    expect(formedTaints([], 0)).toEqual({ tn: TAINTS.modelPriorSuspect, ex: 0 });
    expect(formedTaints([], 4)).toEqual({ tn: 1, ex: 4 });
    expect(formedTaints(records(SOURCES, [1, 2, 3]), 0)).toEqual({ tn: 0, ex: 0 });
  });

  test("a revision keeps its own taints and adds the new evidence's and the exposure", () => {
    expect(revisedTaints({ tn: 2, ex: 1 }, records(SOURCES, [5]), 0)).toEqual({ tn: 3, ex: 5 });
    expect(revisedTaints({ tn: 4, ex: 0 }, records(SOURCES, [1]), 2)).toEqual({ tn: 4, ex: 2 });
    expect(revisedTaints({ tn: 7, ex: 7 }, [], 0)).toEqual({ tn: 7, ex: 7 });
  });

  test("a belief is reasoned only when neither measure holds a taint", () => {
    expect(isReasoned({ tn: 0, ex: 0 })).toBe(true);
    expect(isReasoned({ tn: 0, ex: 2 })).toBe(false);
    expect(isReasoned({ tn: 4, ex: 0 })).toBe(false);
  });
});

describe("exposure", () => {
  test("grows with a message's lineage and exposure, and with a belief's lineage only", () => {
    expect(exposureAfterMessage(0, { tn: 1, ex: 4 })).toBe(5);
    expect(exposureAfterMessage(2, { tn: 0, ex: 0 })).toBe(2);
    expect(exposureAfterBelief(0, { tn: 4, ex: 2 })).toBe(4);
  });

  test("never shrinks", () => {
    for (let exposure = 0; exposure < 8; exposure += 1) {
      for (let taints = 0; taints < 8; taints += 1) {
        const grown = exposureAfterMessage(exposure, { tn: taints, ex: 0 });
        expect(grown & exposure).toBe(exposure);
        expect(exposureAfterBelief(exposure, { tn: taints, ex: taints }) & exposure).toBe(exposure);
      }
    }
  });
});

/** The oracle's record of one belief: what it cites now, and what it took when formed or revised. */
type Modeled = { prior: number; exposures: number; ev: number[] };

/**
 * The oracle: a mind's sources with fixed taints, and its beliefs as they were formed and revised,
 * each belief's taints rebuilt by a depth-first walk of what it cites.
 */
class Oracle {
  readonly sources = new Map<number, mind.Taints>();
  readonly beliefs = new Map<number, Modeled>();
  exposure: number;

  constructor(subject: mind.Mind) {
    for (const record of [...subject.episodes, ...subject.relations]) {
      const found = recordOf(subject, record.id);
      if (found !== undefined) this.sources.set(record.id, taintsOf(found));
    }
    this.exposure = subject.exposure;
  }

  taints(id: number): mind.Taints {
    const source = this.sources.get(id);
    if (source !== undefined) return source;
    const modeled = this.beliefs.get(id);
    if (modeled === undefined) throw new Error(`the oracle holds no record ${id}`);
    let tn = modeled.prior;
    let ex = modeled.exposures;
    for (const cited of modeled.ev) {
      const taints = this.taints(cited);
      tn |= taints.tn;
      ex |= taints.ex;
    }
    return { tn, ex };
  }

  depth(id: number): number {
    const modeled = this.beliefs.get(id);
    if (modeled === undefined) return 0;
    return 1 + Math.max(0, ...modeled.ev.map((cited) => this.depth(cited)));
  }

  /** Records a formation or a revision; false, with nothing changed, when it is too deep. */
  apply(id: number, ev: readonly number[], formed: boolean): boolean {
    const before = this.beliefs.get(id);
    const modeled: Modeled = before
      ? {
          prior: before.prior,
          exposures: before.exposures | this.exposure,
          ev: [...before.ev, ...ev],
        }
      : { prior: ev.length === 0 ? 1 : 0, exposures: this.exposure, ev: [...ev] };
    this.beliefs.set(id, modeled);
    const tooDeep = [...this.beliefs.keys()].some((belief) => this.depth(belief) > 8);
    if (tooDeep) {
      if (before === undefined) this.beliefs.delete(id);
      else this.beliefs.set(id, before);
      return false;
    }
    this.exposure |= this.taints(id).tn;
    return formed || before !== undefined;
  }
}

/**
 * A random mind of sources: own, heard, and external episodes, and relationships. Half the minds
 * start with no exposure, so that what flows into a belief's `ex` is not already there.
 */
function randomSources(random: Sfc32): mind.Mind {
  const episodes = Array.from({ length: 8 }, (_, index) => {
    const id = index + 1;
    const kind = random.below(3);
    if (kind === 0) return own(id);
    if (kind === 1) return heard(id, 100 + id, { tn: random.below(8), ex: random.below(8) });
    return external(id, { tn: 2 | random.below(8) });
  });
  const relations = [9, 10, 11].map((id) => relationship(id, 200 + id, { tn: random.below(8) }));
  const exposure = random.below(2) === 0 ? 0 : random.below(8);
  return mindOf({ episodes, relations, exposure });
}

/** `count` distinct ids drawn from `pool`. */
function draw(random: Sfc32, pool: readonly number[], count: number): number[] {
  const left = [...pool];
  const drawn: number[] = [];
  while (drawn.length < count && left.length > 0) {
    drawn.push(...left.splice(random.below(left.length), 1));
  }
  return drawn;
}

/** The ids of every live record of `subject`. */
function liveIds(subject: mind.Mind): number[] {
  return [...subject.episodes, ...subject.relations, ...subject.beliefs].map((record) => record.id);
}

/** One random operation for `subject`, recorded in `oracle`: whether the oracle accepted it. */
type Step = { readonly operations: mind.BeliefOperations; readonly accepted: boolean };

/** A new belief citing up to three random live records. */
function randomBelief(
  random: Sfc32,
  subject: mind.Mind,
  oracle: Oracle,
  p: mind.Proposition,
): Step {
  const ev = draw(random, liveIds(subject), random.below(4));
  const accepted = oracle.apply(subject.next, ev, true);
  return { operations: { believe: [{ p, cr: 600, ev, rule: "test" }] }, accepted };
}

/**
 * A revision that adds new evidence to a belief with room for it, most often one that other
 * beliefs cite, so that its new taints must flow downstream; undefined when nothing is left to add.
 */
function randomRevision(random: Sfc32, subject: mind.Mind, oracle: Oracle): Step | undefined {
  const open = subject.beliefs.filter((record) => record.ev.length < 3);
  const cited = open.filter((record) =>
    subject.beliefs.some((other) => other.ev.includes(record.id)),
  );
  const target = random.pick(cited.length > 0 && random.below(4) > 0 ? cited : open);
  const isBelief = (id: number) => subject.beliefs.some((record) => record.id === id);
  const pool = liveIds(subject).filter(
    (id) => !target.ev.includes(id) && (!isBelief(id) || id < target.id),
  );
  const ev = draw(random, pool, 1 + random.below(3 - target.ev.length));
  if (ev.length === 0) return undefined;
  const accepted = oracle.apply(target.id, ev, false);
  return { operations: { revise: [{ id: target.id, cr: 400, ev }] }, accepted };
}

/** Checks every belief of `subject`, and its exposure, against `oracle`. */
function expectOracle(subject: mind.Mind, oracle: Oracle): void {
  for (const held of subject.beliefs) {
    expect({ id: held.id, tn: held.tn, ex: held.ex, dp: held.dp }).toEqual({
      id: held.id,
      ...oracle.taints(held.id),
      dp: oracle.depth(held.id),
    });
  }
  expect(subject.exposure).toBe(oracle.exposure);
}

/** One round of random operations on random sources; how many taint growths flowed in it. */
function randomRound(random: Sfc32, round: number): number {
  const laws = lawsWith({ beliefs: 16, episodes: 16, depth: 8 });
  let subject = randomSources(random);
  const oracle = new Oracle(subject);
  let flowed = 0;
  for (let step = 0; step < 14; step += 1) {
    const believe =
      !subject.beliefs.some((record) => record.ev.length < 3) || random.below(3) === 0;
    const chosen = believe
      ? randomBelief(random, subject, oracle, foodAt(round, step))
      : randomRevision(random, subject, oracle);
    if (chosen === undefined) continue;
    const outcome = applyBeliefs(
      subject,
      chosen.operations,
      contextAt(step + 1, laws),
      LIVE_MANIFEST,
    );
    if (!chosen.accepted) {
      expect(outcome).toEqual({ kind: "rejected", reason: "depth_exceeded" });
      continue;
    }
    if (outcome.kind !== "applied") throw new Error(`rejected: ${outcome.reason}`);
    flowed += outcome.changes.tainted.length;
    subject = outcome.mind;
    expectOracle(subject, oracle);
  }
  return flowed;
}

describe("downstream flow", () => {
  test("a belief's taints are its lineage's union on random graphs, after every operation", () => {
    const random = new Sfc32(5301);
    let flowed = 0;
    for (let round = 0; round < 200; round += 1) flowed += randomRound(random, round);
    // The flow itself was exercised (44 growths with this seed), not only the rules of a new belief.
    expect(flowed).toBeGreaterThan(20);
  });

  test("a revision's new taints reach every belief that cites it, directly or not", () => {
    const subject = mindOf({
      episodes: [own(1), heard(2, 9, { tn: 4, ex: 2 })],
      beliefs: [
        belief(3, { ev: [1], dp: 1 }),
        belief(4, { ev: [3], dp: 2, src: 4 }),
        belief(5, { ev: [4], dp: 3, src: 4 }),
        belief(6, { ev: [1], dp: 1 }),
      ],
      exposure: 6,
    });
    const outcome = applyBeliefs(
      subject,
      { revise: [{ id: 3, cr: 300, ev: [2] }] },
      contextAt(10),
      LIVE_MANIFEST,
    );
    if (outcome.kind !== "applied") throw new Error(outcome.reason);
    const taints = outcome.mind.beliefs.map(({ id, tn, ex }) => ({ id, tn, ex }));
    expect(taints).toEqual([
      { id: 3, tn: 4, ex: 6 },
      { id: 4, tn: 4, ex: 6 },
      { id: 5, tn: 4, ex: 6 },
      { id: 6, tn: 0, ex: 0 },
    ]);
    expect(outcome.changes.tainted).toEqual([4, 5]);
  });
});
