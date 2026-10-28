/**
 * A false claim (docs/architecture/mind.md, "Verification plan"; plan §11.2, test 6): research tells
 * a hungry being of `mind@1`, with no food in sight, that food of band 2 lies at a cell X beyond
 * its window, where its species finds none. The injection changes nothing in the world but the
 * being's mind. The being believes the claim by told-food, walks toward X to seek it, sees X hold
 * nothing, revises the belief down to the confidence of a contradiction, and later drops it; the
 * belief and everything its exposure touches keep `human-external`. The world is a hand-built one:
 * a corner of the engine's test genesis without food for 24 cells around the being, nor at X.
 */
import { describe, expect, test } from "bun:test";
import {
  type beings,
  type Command,
  canonicalize,
  type EngineEvent,
  mind,
  readView,
  step,
} from "@open-origin/engine";
import { type BeingsWorld, baseFood, windowAt } from "../../engine/test/support/beings-world.ts";
import { mindIn } from "../../engine/test/support/beings2-speech.ts";
import {
  being2,
  beings2World,
  chunksOf,
  SPECIES2,
} from "../../engine/test/support/beings2-world.ts";
import { CONTRADICTED_CR } from "../src/brain/mind/parameters.ts";
import { foodAt } from "../src/brain/mind/rules.ts";
import { mindController } from "../src/index.ts";
import { MindObserver } from "./support/mind-metrics.ts";

/** Where the being stands, hungry: no cell within its window holds food. */
const START: mind.Cell = [-40, -488];
/** The cell the claim names: 50 cells east, beyond the window, with no food. */
const X: mind.Cell = [START[0] + 50, START[1]];
const CLAIM = foodAt(X, 2);
const DAY = 1200;
const TICKS = 300;
/** The tick of the injection: the being, which decided at tick 1, walks its first leg then. */
const INJECTED_AT = 2;

const INJECT: Command = {
  applyTick: INJECTED_AT,
  seq: 0,
  type: "mind.inject",
  origin: { kind: "admin" },
  payload: { being: 1, cell: [START[0], START[1]], p: CLAIM, taints: 0 },
};

/** A decision of the being: the tick, where it stood, and what it proposed. */
type Decision = {
  readonly tick: number;
  readonly cell: mind.Cell;
  readonly intention: beings.Intention2;
};

/**
 * A world of the being alone at START, hungry and rested, deciding with `mind@1` through `observer`,
 * whose decisions are kept in `decisions` with the tick `clock` holds.
 */
function world(observer: MindObserver, decisions: Decision[], clock: { tick: number }) {
  const brain = observer.controller(mindController({ species: SPECIES2, dayLength: DAY }));
  const controller: beings.Controller2 = {
    ...brain,
    decide: (senses) => {
      const intention = brain.decide(senses);
      const [x = 0, y = 0] = senses.self.cell;
      decisions.push({ tick: clock.tick, cell: [x, y], intention });
      return intention;
    },
  };
  const placed = being2(1, START, { needs: { nutrition: 330_000, rest: 900_000 } });
  const made = beings2World({
    controllers: { s1: controller },
    chunks: chunksOf([placed]),
    audit: false,
  });
  observer.start(made, [1]);
  return made;
}

/** The chunks of `w` as canonical text, with the being's mind left out. */
function withoutMind(w: BeingsWorld): string {
  const view = readView(w);
  const chunks = view.chunkKeys().map((key) => {
    const chunk = view.readChunk(key) as beings.BeingsChunk;
    const bodies = (chunk.beings as beings.Being2[]).map(({ mind: _mind, ...body }) => body);
    return [key, { ...chunk, beings: bodies }];
  });
  return canonicalize({ global: view.readGlobal(), chunks } as never);
}

/** The Chebyshev distance from `cell` to X. */
const toX = (cell: mind.Cell) => Math.max(Math.abs(cell[0] - X[0]), Math.abs(cell[1] - X[1]));

/** The first event of the being of `type` whose payload `holds`. */
function firstOf(events: readonly EngineEvent[], type: string, holds: (payload: never) => boolean) {
  return events.find((event) => event.type === type && holds(event.payload as never));
}

describe("a false claim injected into a being of mind@1 (plan §11.2, test 6)", () => {
  test("its world holds no food in the being's window nor at X, which lies beyond the window", () => {
    const window = windowAt(START, SPECIES2);
    expect(window.foodCue.every((cue) => cue === 0)).toBe(true);
    expect(baseFood(X)).toBe(0);
    expect(toX(START)).toBeGreaterThan(SPECIES2.senses.radius);
  });

  test("changes nothing in the world but the being's mind, which holds the message", () => {
    const { sameWorld, untold } = run();
    // The being walks its first leg at the injection, and the world without it walks the same.
    expect(sameWorld).toEqual([true, true]);
    expect(untold).toMatchObject({ inbox: [], exposure: 0 });
  });

  test("is believed by told-food, as a stranger's at band 1, and the being walks to seek X", () => {
    const { believed, seek } = landmarks();
    // 600 at a credulity of 1000, citing the episode of the message.
    expect(believed?.intention.mind?.believe).toEqual([
      { p: CLAIM, cr: 600, ev: [1], rule: "told-food" },
    ]);
    expect(seek?.tick).toBeGreaterThan(believed?.tick ?? TICKS);
    expect(seek?.intention.steps.map(({ kind }) => kind)).toEqual(["walk"]);
  });

  test("is revised down once the being sees X hold nothing, nearer than it sought from, then dropped", () => {
    const { seek, check, dropped } = landmarks();
    expect(toX(check?.cell ?? START)).toBeLessThan(toX(seek?.cell ?? START));
    expect(toX(check?.cell ?? X)).toBeLessThanOrEqual(SPECIES2.senses.radius);
    expect(check?.intention.mind).toMatchObject({
      remember: [{ percept: { food: X } }],
      revise: [{ id: 2, cr: CONTRADICTED_CR }],
    });
    expect(dropped).toBeGreaterThan(check?.tick ?? TICKS);
    const { held } = run();
    expect(held.beliefs.some(({ p }) => mind.sameProposition(p, CLAIM))).toBe(false);
    // What it remembered of X is the band its species finds there: none. The claim moved no food.
    expect(held.episodes.find(({ id }) => id === 3)).toMatchObject({ kind: "food", cell: X, v: 0 });
    expect(baseFood(X)).toBe(0);
  });

  test("keeps human-external in the belief and the exposure; every operation is its rule", () => {
    const { events, held, ruleProblems } = run();
    const lineage = events
      .filter(({ type }) => type === "mind.provenance")
      .flatMap(({ payload }) => (payload as { records: { id: number; tn: number }[] }).records)
      .filter(({ id }) => id === 2)
      .map(({ tn }) => tn);
    expect(new Set(lineage)).toEqual(new Set([mind.TAINTS.humanExternal]));
    expect(held.exposure).toBe(mind.TAINTS.humanExternal);
    expect(ruleProblems).toEqual([]);
  });
});

/** What the run with the false claim gave, computed once. */
type Run = {
  readonly events: readonly EngineEvent[];
  readonly decisions: readonly Decision[];
  /** At each tick to the injection's, whether the world equals the world without it but for the mind. */
  readonly sameWorld: readonly boolean[];
  readonly untold: mind.Mind;
  readonly held: mind.Mind;
  readonly ruleProblems: readonly string[];
};

let ran: Run | undefined;
function run(): Run {
  if (ran !== undefined) return ran;
  const observer = new MindObserver();
  const decisions: Decision[] = [];
  const clock = { tick: 0 };
  const told = world(observer, decisions, clock);
  const untold = world(new MindObserver(), [], { tick: 0 });
  const events: EngineEvent[] = [];
  const sameWorld: boolean[] = [];
  for (clock.tick = 1; clock.tick <= TICKS; clock.tick += 1) {
    const result = step(told, clock.tick === INJECTED_AT ? [INJECT] : []);
    events.push(...result.events);
    observer.observe(result);
    if (clock.tick > INJECTED_AT) continue;
    step(untold, []);
    sameWorld.push(withoutMind(told) === withoutMind(untold));
  }
  const { ruleProblems } = observer.finish(TICKS);
  ran = {
    events,
    decisions,
    sameWorld,
    untold: mindIn(untold, 1),
    held: mindIn(told, 1),
    ruleProblems,
  };
  return ran;
}

/** The decisions of the run that believed the claim, sought X, and checked it, and when it dropped. */
function landmarks() {
  const { events, decisions } = run();
  const at = (tick: number | undefined) => decisions.find((decision) => decision.tick === tick);
  const formed = firstOf(events, "mind.changed", (p: { formed: unknown[] }) => p.formed.length > 0);
  const believed = at(formed?.tick);
  const seek = decisions.find(
    ({ tick, intention }) => tick > (formed?.tick ?? TICKS) && intention.behavior.kind === "seek",
  );
  const revised = firstOf(
    events,
    "mind.changed",
    (p: { revised: unknown[] }) => p.revised.length > 0,
  );
  const dropped = firstOf(events, "mind.changed", (p: { dropped: number[] }) =>
    p.dropped.includes(2),
  );
  return { believed, seek, check: at(revised?.tick), dropped: dropped?.tick };
}
