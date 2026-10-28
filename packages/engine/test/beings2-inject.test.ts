/**
 * The research injection of beings@2 (ADR 0024, docs/architecture/mind.md "Commands and faults",
 * "Perception", "Provenance and taints", "Events", and "Verification plan"): `mind.inject` is the
 * admin's, finds the being at its cell without searching the world, always carries
 * `human-external`, grows the being's exposure at delivery, and wakes an idle being at t + 1 under
 * the rule of a hearer, without spending its daily wakes. The being hears it as a `tell` with no
 * speaker, may remember it as an `external` episode, and every belief derived from it keeps
 * `human-external`, even when corroborated. A false claim changes nothing in the world.
 */
import { describe, expect, test } from "bun:test";
import {
  beings,
  type CanonicalValue,
  type Command,
  type EngineEvent,
  type mind,
  readView,
  step,
  worldgen,
} from "../src/index.ts";
import {
  baseFood,
  behavior,
  beingOf,
  cumulative,
  findCell,
  runTo,
  walkMs,
  windowAt,
} from "./support/beings-world.ts";
import { type Cell, cellOf, eventsAt, idling, standable } from "./support/beings2-mind.ts";
import {
  being2,
  beings2World,
  brain2,
  chunksOf,
  life2With,
  type Senses2,
} from "./support/beings2-world.ts";
import { engineErrorOf } from "./support/engine-error.ts";

const LONG = 6_000_000;
const SEARCH: Cell = [-128, -128];

/** A cell where a being may stand and where its species finds no food. */
const BARREN: Cell = findCell(SEARCH, 256, {
  food: 0,
  accept: (cell) => standable(cell) && baseFood(cell) === 0,
});

/**
 * A claim of `mind@1`'s namespace, which the test brains do not declare: an injection may name any
 * concept. Food of band 2 at BARREN, which holds none.
 */
const CLAIM: mind.Proposition = { p: "m1.food-at", a: [{ c: [BARREN[0], BARREN[1]] }], v: 2 };
/** The same claim as the test brains believe it, in their namespace. */
const BELIEVED: mind.Proposition = { ...CLAIM, p: "t1.food-at" };

/** The tick of the injections: being 1 decided at tick 1 and idles long by then. */
const T = 5;

/** A command `mind.inject` at `tick` from `origin`. */
function inject(
  tick: number,
  payload: CanonicalValue,
  origin: Command["origin"] = { kind: "admin" },
  seq = 0,
): Command {
  return { applyTick: tick, seq, type: "mind.inject", origin, payload };
}

/** The payload of an injection of CLAIM into being 1 at BARREN, with `taints`. */
const claim = (taints = 0, being = 1, cell: Cell = BARREN): CanonicalValue => ({
  being,
  cell: [cell[0], cell[1]],
  p: CLAIM,
  taints,
});

/** The reasons of the commands the kernel rejected in `events`, with their details. */
const rejections = (events: readonly EngineEvent[]) =>
  events
    .filter(({ type }) => type === "engine.command_rejected")
    .map(({ payload }) => payload as { reason: string; details?: unknown });

/**
 * A world of beings@2 with being 1 alone at `cell`, BARREN by default, deciding with `decide`,
 * whose senses at every decision are recorded in `sensed`; with the laws `life`.
 */
function world(
  decide: (senses: Senses2) => beings.Intention2 = () => idling(LONG),
  life: beings.LifeConfig2 = beings.defaultLife2(),
  cell: Cell = BARREN,
) {
  const sensed: Senses2[] = [];
  const brain = brain2((senses) => {
    if (senses.self.id === 1) sensed.push(senses);
    return decide(senses);
  });
  const made = beings2World({
    controllers: { s1: brain },
    life,
    chunks: chunksOf([being2(1, cell)]),
  });
  return { world: made, sensed };
}

/** The mind of being 1 of `w`. */
const mindOf1 = (w: Parameters<typeof beingOf>[0]) => (beingOf(w, 1) as beings.Being2).mind;

describe("mind.inject is refused", () => {
  test("from an inhabitant, as admin_only", () => {
    const { world: w } = world();
    runTo(w, T - 1);
    const before = mindOf1(w);
    const events = runTo(w, T, [inject(T, claim(), { kind: "inhabitant", actor: 1 })]);
    expect(rejections(events).map(({ reason }) => reason)).toEqual(["admin_only"]);
    expect(mindOf1(w)).toEqual(before);
  });

  const invalid: { name: string; payload: CanonicalValue; path: string }[] = [
    {
      name: "a payload missing a member",
      payload: { being: 1, cell: [0, 0], p: CLAIM },
      path: "/taints",
    },
    { name: "an unknown member", payload: { ...(claim() as object), why: "x" }, path: "/why" },
    { name: "a being that is not an entity id", payload: claim(0, 0), path: "/being" },
    { name: "taints beyond the three", payload: claim(8), path: "/taints" },
    { name: "negative taints", payload: claim(-1), path: "/taints" },
    {
      name: "a cell outside the world",
      payload: { ...(claim() as object), cell: [worldgen.MAX_CELL + 1, 0] },
      path: "/cell/0",
    },
    {
      name: "a cell of three coordinates",
      payload: { ...(claim() as object), cell: [0, 0, 0] },
      path: "/cell",
    },
    {
      name: "a proposition that is not one of prop@1",
      payload: { ...(claim() as object), p: { p: "Food", a: [] } },
      path: "/p",
    },
  ];
  for (const { name, payload, path } of invalid) {
    test(`with ${name}, as invalid_inject naming ${path}`, () => {
      const { world: w } = world();
      const [rejected] = rejections(runTo(w, 1, [inject(1, payload)]));
      expect(rejected?.reason).toBe("invalid_inject");
      const details = rejected?.details as { issues: { path: string }[] } | undefined;
      const issues = details?.issues ?? [];
      expect(issues.some((issue) => issue.path.startsWith(path))).toBe(true);
      expect(mindOf1(w).inbox).toEqual([]);
    });
  }

  test("with a payload over the kernel's 8 KiB, before any handler reads it", () => {
    const { world: w } = world();
    const huge = { ...(claim() as object), why: "x".repeat(8192) };
    const error = engineErrorOf(() => step(w, [inject(1, huge)]));
    expect(error.code).toBe("invalid_input");
    expect(readView(w).tick).toBe(0);
  });

  test("for no being with that id at that cell, as not_found: the world is never searched", () => {
    const { world: w } = world();
    const elsewhere: Cell = [BARREN[0] + 1, BARREN[1]];
    const events = runTo(w, 1, [
      inject(1, claim(0, 1, elsewhere)),
      inject(1, claim(0, 2), { kind: "admin" }, 1),
      inject(1, claim(0, 1, [BARREN[0] + 4096, BARREN[1]]), { kind: "admin" }, 2),
    ]);
    expect(rejections(events).map(({ reason }) => reason)).toEqual([
      "not_found",
      "not_found",
      "not_found",
    ]);
    expect(mindOf1(w).inbox).toEqual([]);
  });

  test("for a full inbox, as full, counting the injections of the same tick", () => {
    const one = life2With((species) => ({ ...species, mind: { ...species.mind, inbox: 1 } }));
    const { world: w } = world(undefined, one);
    const events = runTo(w, T, [inject(T, claim()), inject(T, claim(1), { kind: "admin" }, 1)]);
    expect(rejections(events).map(({ reason }) => reason)).toEqual(["full"]);
    expect(mindOf1(w).inbox).toHaveLength(1);
    const none = life2With((species) => ({ ...species, mind: { ...species.mind, inbox: 0 } }));
    const { world: closed } = world(undefined, none);
    expect(rejections(runTo(closed, 1, [inject(1, claim())])).map(({ reason }) => reason)).toEqual([
      "full",
    ]);
  });

  test("under beings@1, which has no such command", () => {
    const ruleset = beings.createBeingsRuleset({
      controllers: { s1: { brain: "b@1", decide: () => idling(LONG) } },
    });
    expect(Object.keys(ruleset.commands)).toEqual(["beings.spawn"]);
  });
});

/** A cell from which a being may walk eight steps east, and the tick its walk from tick 1 arrives. */
const WALK_FROM: Cell = findCell(SEARCH, 256, {
  food: 0,
  accept: (cell, window) => standable(cell) && walkMs(window, "00000000") !== undefined,
});
const WALK_TOTAL_MS = cumulative(walkMs(windowAt(WALK_FROM), "00000000") ?? []).at(-1) ?? 0;
const ARRIVAL = 1 + Math.ceil(WALK_TOTAL_MS / 12_000);

/** A brain that walks eight steps east from WALK_FROM, and idles long anywhere else. */
const walker = (senses: Senses2): beings.Intention2 =>
  cellOf(senses)[0] === WALK_FROM[0]
    ? { steps: [{ kind: "walk", dirs: "00000000" }], wakeWhen: {}, behavior: behavior("travel") }
    : idling(LONG);

describe("an accepted mind.inject", () => {
  test("adds a tell with no speaker and no cell, human-external forced on, and grows the exposure", () => {
    for (const [taints, tn] of [
      [0, 2],
      [2, 2],
      [5, 7],
    ] as const) {
      const { world: w } = world();
      runTo(w, T - 1);
      const events = runTo(w, T, [inject(T, claim(taints))]);
      const held = mindOf1(w);
      expect(held.inbox).toEqual([{ t: T, act: "tell", p: CLAIM, tn, ex: 0 }]);
      expect(held.exposure).toBe(tn);
      expect(eventsAt(events, T)).toEqual([
        ["mind.injected", { id: 1 }],
        ["mind.provenance", { id: 1, records: [], exposure: tn }],
      ]);
    }
  });

  test("wakes the idle being at t + 1, which hears a tell with no speaker, without spending a wake", () => {
    const { world: w, sensed } = world();
    runTo(w, T, [inject(T, claim(4))]);
    expect(sensed).toHaveLength(1);
    const quota = mindOf1(w).quota;
    const events = runTo(w, T + 1);
    expect(eventsAt(events, T + 1).slice(0, 2)).toEqual([
      ["being.finished", { id: 1, activity: "idle", result: "interrupted", reason: "heard" }],
      ["being.started", { id: 1, activity: "idle" }],
    ]);
    expect(sensed).toHaveLength(2);
    expect(sensed[1]?.perceived.heard).toEqual([{ act: "tell", p: CLAIM }]);
    expect(JSON.stringify(sensed[1])).not.toContain('"tn"');
    // The decision consumed the inbox; the quota of wakes is as it was.
    expect(mindOf1(w).inbox).toEqual([]);
    expect(mindOf1(w).quota).toEqual(quota);
    expect(mindOf1(w).exposure).toBe(6);
  });

  test("leaves a being that is not woken asleep to it: no decision without an injection", () => {
    const { world: w, sensed } = world();
    runTo(w, T + 3);
    expect(sensed).toHaveLength(1);
  });

  test("does not wake a being whose species allows no wake by hearing: the rule of a hearer", () => {
    const deaf = life2With((species) => ({
      ...species,
      speech: { ...species.speech, wakesPerDay: 0 },
    }));
    const { world: w, sensed } = world(undefined, deaf);
    runTo(w, T + 3, [inject(T, claim())]);
    expect(sensed).toHaveLength(1);
    expect(mindOf1(w).inbox).toHaveLength(1);
  });

  test("leaves a walking being walking: it hears the message at its next decision", () => {
    const { world: w, sensed } = world(walker, undefined, WALK_FROM);
    runTo(w, 1);
    expect(beingOf(w, 1).activity.kind).toBe("walk");
    const events = runTo(w, ARRIVAL, [inject(2, claim())]);
    // Not woken at tick 3, it decided only when its walk ended, and heard the message then.
    expect(ARRIVAL).toBeGreaterThan(3);
    expect(eventsAt(events, 3)).toEqual([]);
    expect(sensed).toHaveLength(2);
    expect(eventsAt(events, ARRIVAL)[0]).toEqual([
      "being.finished",
      { id: 1, activity: "walk", result: "done", reason: "" },
    ]);
    expect(sensed[1]?.perceived.heard).toEqual([{ act: "tell", p: CLAIM }]);
    expect(mindOf1(w).inbox).toEqual([]);
  });
});

describe("an injected claim", () => {
  /**
   * A brain that remembers what it hears and believes it, citing the new episode; and, hearing
   * again, sees the food of its own cell and revises its belief with that clean observation.
   */
  const credulous = (senses: Senses2): beings.Intention2 => {
    if (senses.perceived.heard.length === 0) return idling(LONG);
    const { next, beliefs } = senses.mind;
    const [held] = beliefs;
    if (held === undefined)
      return idling(LONG, {
        remember: [{ percept: { heard: 0 }, w: 500 }],
        believe: [{ p: BELIEVED, cr: 900, ev: [next], rule: "told" }],
      });
    return idling(LONG, {
      remember: [{ percept: { food: cellOf(senses) }, w: 500 }],
      revise: [{ id: held.id, cr: 100, ev: [next] }],
    });
  };

  test("is an external episode with its taints, seen as heard, and a belief from it keeps human-external", () => {
    const { world: w, sensed } = world(credulous);
    runTo(w, T + 1, [inject(T, claim(4))]);
    const held = mindOf1(w);
    expect(held.episodes).toEqual([
      // The belief that cites it refreshed it, as any citation does: 500 + the recall of 200.
      { id: 1, kind: "external", t: T + 1, p: CLAIM, tn: 6, w: 700, r: T + 1 },
    ]);
    expect(held.beliefs).toEqual([
      { id: 2, p: BELIEVED, cr: 900, src: 8, ev: [1], lost: 0, tn: 6, ex: 6, dp: 1, u: T + 1 },
    ]);
    // At its next decision the view shows the episode as a tell heard with no speaker, src as told.
    runTo(w, T + 3, [inject(T + 2, claim())]);
    const view = sensed[2]?.mind;
    expect(view?.episodes[0]).toEqual({
      id: 1,
      kind: "heard",
      t: 24,
      p: CLAIM,
      act: "tell",
      w: 700,
      r: 24,
    });
    expect(view?.beliefs[0]?.src).toBe(2);
  });

  test("corroborated by a clean observation stays tainted: revision never lowers a taint", () => {
    const { world: w } = world(credulous);
    runTo(w, T + 4, [inject(T, claim()), inject(T + 3, claim())]);
    const [held] = mindOf1(w).beliefs;
    expect(held).toMatchObject({ id: 2, cr: 100, src: 9, ev: [1, 3], tn: 2 });
    expect(mindOf1(w).episodes.find(({ id }) => id === 3)).toMatchObject({ kind: "food", v: 0 });
  });

  test("changes nothing in the world: the food stays as it was, and the belief stays a belief", () => {
    const told = world(credulous);
    const untold = world(credulous);
    runTo(told.world, 40, [inject(T, claim())]);
    runTo(untold.world, 40);
    const chunks = (w: Parameters<typeof beingOf>[0]) => {
      const view = readView(w);
      return view.chunkKeys().map((key) => view.readChunk(key)?.depletion);
    };
    expect(chunks(told.world)).toEqual(chunks(untold.world));
    expect(baseFood(BARREN)).toBe(0);
    expect(mindOf1(told.world).beliefs).toHaveLength(1);
    expect(mindOf1(untold.world).beliefs).toEqual([]);
  });
});
