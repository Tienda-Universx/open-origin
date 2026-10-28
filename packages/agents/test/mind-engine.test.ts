/**
 * `mind@1` against the engine that applies its decisions (docs/architecture/mind.md "Beliefs" and
 * "How mind@1 decides"): the brain predicts how the engine fills a store, so that it never cites,
 * revises, or tells a belief the store evicts first. A decision whose testimony and landmark form
 * one claim is the case to get right: the landmark adopts the testimony's belief only when that
 * belief is still held; in a full store the testimony may leave at once, and the landmark then
 * forms a belief of its own, which takes room. The verifier's world pins the three cases, and
 * decisions drawn from a seed, with full stores among them, run through a world of beings@2.
 */
import { describe, expect, test } from "bun:test";
import { type beings, canonicalize, type EngineEvent, type mind, step } from "@open-origin/engine";
import { behavior, findCell, windowAt } from "../../engine/test/support/beings-world.ts";
import { standable } from "../../engine/test/support/beings2-mind.ts";
import { mindIn } from "../../engine/test/support/beings2-speech.ts";
import {
  being2,
  beings2World,
  chunksOf,
  type Senses2,
  SPECIES2,
} from "../../engine/test/support/beings2-world.ts";
import { Sfc32 } from "../../engine/test/support/sfc32.ts";
import { brainLaws } from "../src/brain/mind/laws.ts";
import { afterBelieves } from "../src/brain/mind/operations.ts";
import { foodAt } from "../src/brain/mind/rules.ts";
import { mindController } from "../src/brain/mind.ts";

/** The day of the engine's test genesis, in seconds: 100 ticks of 12 seconds. */
const DAY = 1200;
const LONG = 6_000_000;
const A = 1;
const C = 2;

/** A cell with food where A stands, and C two cells east of it, both standable. */
const CELL_A = findCell([-128, -128], 256, {
  food: SPECIES2.diet.cue.some,
  accept: (cell) => standable(cell) && standable([cell[0] + 2, cell[1]]),
});
const CELL_C: [number, number] = [CELL_A[0] + 2, CELL_A[1]];

const idle = (ms: number, ops?: beings.MindIntention): beings.Intention2 => ({
  steps: [{ kind: "idle", ms }],
  wakeWhen: {},
  behavior: behavior("rest"),
  ...(ops === undefined ? {} : { mind: ops }),
});

/** The window's best cue, as a landmark of mind@1 picks it: highest band, then nearest, then index. */
function bestCue(window: beings.SensedWindow, self: mind.Cell): { cell: mind.Cell; v: number } {
  const { origin, side, foodCue } = window;
  let best: { cell: mind.Cell; v: number; d: number } | undefined;
  for (let index = 0; index < side * side; index += 1) {
    const v = foodCue[index] as number;
    if (v === 0) continue;
    const cell: mind.Cell = [
      (origin[0] as number) + (index % side),
      (origin[1] as number) + Math.floor(index / side),
    ];
    const d = Math.max(Math.abs(cell[0] - self[0]), Math.abs(cell[1] - self[1]));
    if (best === undefined || v > best.v || (v === best.v && d < best.d)) best = { cell, v, d };
  }
  if (best === undefined) throw new Error("A's window cues no food");
  return best;
}

/** A belief of food of a crafted mind. */
const held = (id: number, cell: mind.Cell, cr: number, v = 2): mind.Belief => ({
  id,
  p: foodAt(cell, v),
  cr,
  src: 1,
  ev: [],
  lost: 0,
  tn: 0,
  ex: 0,
  dp: 1,
  u: 0,
});

/** A crafted mind holding `beliefs`, an inbox, and possibly a relationship with C. */
function mindOf(
  beliefs: readonly mind.Belief[],
  inbox: readonly mind.InboxMessage[] = [],
  relations: readonly mind.Relationship[] = [],
): mind.Mind {
  return {
    next: 50,
    episodes: [],
    beliefs,
    relations,
    inbox,
    exposure: 0,
    quota: { day: 0, said: 0, woken: 0 },
  };
}

/**
 * C's `n`-th decision: an idle until A wakes; the cue `target` of A's window remembered and
 * believed, as the belief `told` it will tell; the tell; then a long idle.
 */
function scriptOfC(
  n: number,
  senses: Senses2,
  target: { readonly cell: mind.Cell; readonly v: number },
  told: number,
): beings.Intention2 {
  if (n === 0) return idle(24_000);
  if (n === 2)
    return {
      steps: [{ kind: "talk", to: A, act: "tell", about: told }],
      wakeWhen: {},
      behavior: behavior("talk"),
    };
  if (n !== 1) return idle(LONG);
  const [x = 0, y = 0] = senses.self.cell;
  return idle(12_000, {
    remember: [{ percept: { food: [x, y] }, w: 500 }],
    believe: [
      { p: foodAt(target.cell, target.v), cr: 900, ev: [senses.mind.next], rule: "seen-food" },
    ],
  });
}

/**
 * The verifier's world: A holds belief 1 at 900, and with `others` seven more, at 100 or one of
 * them at 600; C sees A's best cue, believes it, and tells it to A, who answers with a tell of
 * belief 1 and believes the testimony and, by its landmark, the same claim.
 */
function told(others: "none" | "full" | "survive") {
  const far = (i: number): mind.Cell => [CELL_A[0] + 100 + 3 * i, CELL_A[1] + 100];
  const beliefs = [held(1, far(0), 900)];
  if (others !== "none")
    for (let id = 2; id <= 8; id += 1)
      beliefs.push(held(id, far(id), others === "survive" && id === 8 ? 600 : 100));
  const brain = mindController({ species: SPECIES2, dayLength: DAY });
  const target = bestCue(windowAt(CELL_A), CELL_A);
  const decisions = new Map<number, number>();
  let decidedAt: number | undefined;
  let tick = 0;
  let toldId = 0;
  const controller: beings.Controller2 = {
    ...brain,
    decide: (senses) => {
      const id = senses.self.id;
      const n = decisions.get(id) ?? 0;
      decisions.set(id, n + 1);
      if (id === A && n === 0) return idle(LONG);
      if (id === A) {
        decidedAt ??= tick;
        return brain.decide(senses);
      }
      if (n === 1) toldId = senses.mind.next + 1;
      return scriptOfC(n, senses, target, toldId);
    },
  };
  const placed = [being2(A, CELL_A, { mind: mindOf(beliefs) }), being2(C, CELL_C)];
  const world = beings2World({
    controllers: { s1: controller },
    chunks: chunksOf(placed),
    audit: true,
  });
  const events: EngineEvent[] = [];
  const minds: mind.Mind[] = [];
  for (tick = 1; tick <= 8; tick += 1) {
    events.push(...step(world, []).events);
    minds.push(mindIn(world, A));
  }
  return { events, minds, decidedAt, target };
}

/** The ids of the beliefs of `held`. */
const ids = (held: mind.Mind) => held.beliefs.map(({ id }) => id);

describe("a testimony and a landmark of one claim, through the engine", () => {
  test.each(["none", "survive", "full"] as const)(
    "never cost the belief A tells, whatever room its store has (%s)",
    (others) => {
      const { events, minds, decidedAt, target } = told(others);
      expect(decidedAt).toBe(6);
      const rejected = events.filter(({ type }) => type === "being.intention_rejected");
      expect(rejected).toEqual([]);
      const after = minds[5] as mind.Mind;
      expect(ids(after)).toContain(1);
      // A's tell of belief 1 ends and reaches C at tick 7.
      const told1 = after.beliefs.find(({ id }) => id === 1) as mind.Belief;
      const uttered = events.filter(
        ({ type, payload }) => type === "speech.uttered" && (payload as { id: number }).id === A,
      );
      expect(
        uttered.map(({ tick, payload }) => [
          tick,
          canonicalize((payload as { p: mind.Proposition }).p),
        ]),
      ).toEqual([[7, canonicalize(told1.p)]]);
      const delivered = events.filter(
        ({ type, payload }) => type === "speech.delivered" && (payload as { id: number }).id === A,
      );
      expect(delivered.map(({ tick }) => tick)).toEqual([7]);
      // With room, or once the testimony stays, the landmark adopts the testimony's belief.
      const claim = canonicalize(foodAt(target.cell, target.v));
      const formed = after.beliefs.filter(({ p }) => canonicalize(p) === claim);
      expect(formed.map(({ cr }) => cr)).toEqual(others === "full" ? [] : [900]);
    },
  );
});

/** How many decisions the engine-level property draws, and their seed. */
const CASES = 60;
const SEED = 0x0ad0_97ed;

/** A decision of A at tick 1, with a crafted mind drawn from `random`. */
function crafted(random: Sfc32, cue: { cell: mind.Cell; v: number }): mind.Mind {
  const pick = <T>(items: readonly T[]) => items[random.below(items.length)] as T;
  const near = (): mind.Cell => [
    CELL_A[0] + random.below(41) - 20,
    CELL_A[1] + random.below(41) - 20,
  ];
  const far = (): mind.Cell => [CELL_A[0] + 40 + random.below(20), CELL_A[1] + random.below(20)];
  const count = random.below(2) === 0 ? 8 : random.below(8);
  const beliefs = Array.from({ length: count }, (_, index) => {
    const told = random.below(3) === 0;
    const cell = pick([cue.cell, near(), far(), far()]);
    const belief = held(index + 1, cell, pick([100, 100, 300, 600, 900, 900]), pick([0, 1, 2, 2]));
    return told ? { ...belief, src: 2, who: C } : belief;
  });
  // No two beliefs of one claim: a store never holds one twice.
  const unique = beliefs.filter(
    (belief, index) =>
      beliefs.findIndex(({ p }) => JSON.stringify(p) === JSON.stringify(belief.p)) === index,
  );
  const claim =
    random.below(2) === 0
      ? foodAt(cue.cell, cue.v)
      : foodAt(pick([near(), far()]), 1 + random.below(2));
  const tell: mind.InboxMessage = {
    who: C,
    t: 0,
    cell: [CELL_C[0], CELL_C[1]],
    act: "tell",
    p: claim,
    band: random.below(3),
    tn: 0,
    ex: 0,
  };
  const ask: mind.InboxMessage = {
    who: C,
    t: 0,
    cell: [CELL_C[0], CELL_C[1]],
    act: "ask",
    tn: 0,
    ex: 0,
  };
  const inbox = pick([[tell], [ask], [tell, ask], [ask, tell], []]);
  const relation: mind.Relationship = {
    id: 40,
    who: C,
    f: 0,
    seen: 0,
    aff: 0,
    tr: pick([200, 500, 800]),
    tn: 0,
    talk: 0,
    turns: 0,
  };
  return mindOf(unique, inbox, random.below(4) === 0 ? [] : [relation]);
}

/** The beliefs `intention` relies on: the one it tells, those it revises, and those it relates by. */
function reliedOn(senses: Senses2, intention: beings.Intention2): number[] {
  const ops = intention.mind ?? {};
  const [first] = intention.steps;
  const about = first?.kind === "talk" && first.act === "tell" ? [first.about as number] : [];
  const beliefIds = senses.mind.beliefs.map(({ id }) => id);
  const cited = (ops.relate ?? []).flatMap(({ because }) => because);
  return [
    ...about,
    ...(ops.revise ?? []).map(({ id }) => id),
    ...cited.filter((id) => beliefIds.includes(id)),
  ];
}

/** Every problem of A's decision at tick 1 of a world where it holds `held`. */
function problemsOf(held: mind.Mind, seed: number): string[] {
  const brain = mindController({ species: SPECIES2, dayLength: DAY });
  const laws = brainLaws(SPECIES2, DAY);
  let predicted: { held: readonly number[]; next: number } | undefined;
  let relied: number[] = [];
  let dropped: readonly number[] = [];
  const controller: beings.Controller2 = {
    ...brain,
    decide: (senses) => {
      if (senses.self.id !== A) return idle(LONG);
      const intention = brain.decide(senses);
      const ops = intention.mind ?? {};
      predicted = afterBelieves(
        { senses, laws, keep: [] },
        ops.remember?.length ?? 0,
        ops.believe ?? [],
      );
      relied = reliedOn(senses, intention);
      dropped = ops.drop ?? [];
      return intention;
    },
  };
  const placed = [being2(A, CELL_A, { mind: held }), being2(C, CELL_C)];
  const world = beings2World({
    controllers: { s1: controller },
    chunks: chunksOf(placed),
    seed: [seed, 7],
    audit: false,
  });
  const { events } = step(world, []);
  const after = mindIn(world, A);
  const problems = events
    .filter(
      ({ type, payload }) =>
        type === "being.intention_rejected" && (payload as { id: number }).id === A,
    )
    .map(({ payload }) => `rejected: ${JSON.stringify(payload)}`);
  if (predicted === undefined) return [...problems, "A did not decide"];
  if (after.next !== predicted.next)
    problems.push(`next ${after.next}, predicted ${predicted.next}`);
  const kept = ids(after);
  for (const id of relied)
    if (!kept.includes(id)) problems.push(`belief ${id} relied on, not held`);
  const expected = predicted.held.filter((id) => !dropped.includes(id));
  if (
    problems.length === 0 &&
    JSON.stringify(kept) !== JSON.stringify([...expected].sort((a, b) => a - b))
  )
    problems.push(`beliefs ${kept}, predicted ${expected}`);
  return problems;
}

describe("the store mind@1 predicts, against the engine", () => {
  test("is the store the engine leaves, for decisions drawn with full stores among them", () => {
    const random = new Sfc32(SEED);
    const cue = bestCue(windowAt(CELL_A), CELL_A);
    const problems: string[] = [];
    let full = 0;
    for (let index = 0; index < CASES; index += 1) {
      const mindHeld = crafted(random, cue);
      if (mindHeld.beliefs.length === 8) full += 1;
      for (const problem of problemsOf(mindHeld, index + 1))
        problems.push(`case ${index}: ${problem}`);
    }
    expect(problems.slice(0, 4)).toEqual([]);
    expect(full).toBeGreaterThan(CASES / 4);
  });
});
