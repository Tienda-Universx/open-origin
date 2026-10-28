/**
 * The adversarial suite of taints (ADR 0024, docs/architecture/mind.md "Provenance and taints";
 * plan §6, the table of attack routes): each route a brain could take to launder a claim research
 * injected, end to end through the engine, with brains that follow a script. Every belief in a
 * chain of five beings that relays an injection keeps `human-external`, while the same chain from
 * an observation stays reasoned; forgetting every record and believing the claim again from a clean
 * observation, or believing a variant of it, keeps it in `ex`; a belief that cites nothing is
 * `model-prior-suspect` and grows the exposure; a relationship shaped by a tainted record taints
 * what cites it, before and after; repetition and corroboration lower no taint; support never
 * forms a cycle; an idea parked in a cooldown and `behavior.kind` is caught by `ex`; an ask names
 * only the food its species perceives; an injection that claims to be clean carries
 * `human-external` or is refused; and no taint ever reaches the senses. The ledger oracle rebuilds
 * every mind from the events of each run.
 */
import { describe, expect, test } from "bun:test";
import { type beings, type Command, type EngineEvent, mind, readView } from "../src/index.ts";
import { type BeingsWorld, behavior, runTo } from "./support/beings-world.ts";
import { LedgerOracle } from "./support/beings2-fuzz.ts";
import { type Cell, cellOf, idling, standable } from "./support/beings2-mind.ts";
import { LONG, mindIn, type Script, scripted, talk } from "./support/beings2-speech.ts";
import { being2, life2With, type Senses2 } from "./support/beings2-world.ts";

const { humanExternal, modelPriorSuspect } = mind.TAINTS;
const { seen: SEEN, told: TOLD, external: EXTERNAL } = mind.EVIDENCE;

/** The first of five cells two apart on a row, where beings may stand. */
const ROW: Cell = (() => {
  for (let x = -128; x < -64; x += 1) {
    const cells = [0, 2, 4, 6, 8].map((dx): Cell => [x + dx, -128]);
    if (cells.every(standable)) return [x, -128];
  }
  throw new Error("no row of five standable cells two apart");
})();

/** The cell of the `n`-th being of the row, from 1. */
const rowCell = (n: number): Cell => [ROW[0] + 2 * (n - 1), ROW[1]];

/** A claim of food at `cell`, in the scripts' namespace, which research may inject too. */
const claimAt = (cell: Cell, v = 2): mind.Proposition => ({
  p: "t1.food-at",
  a: [{ c: [cell[0], cell[1]] }],
  v,
});

/** The claim research injects in this suite: food of band 2 at a cell east of the row. */
const CLAIM_CELL: Cell = [ROW[0] + 30, ROW[1]];
const CLAIM = claimAt(CLAIM_CELL);

/** An admin `mind.inject` of CLAIM into being `id` at `cell`, at `tick`, declaring no taint. */
function inject(tick: number, id: number, cell: Cell): Command {
  const payload = { being: id, cell: [cell[0], cell[1]], p: CLAIM, taints: 0 };
  return { applyTick: tick, seq: 0, type: "mind.inject", origin: { kind: "admin" }, payload };
}

/** The index in the inbox of the first message the decision heard that tells something. */
const toldIndex = (senses: Senses2) =>
  senses.perceived.heard.findIndex(({ act, p }) => act === "tell" && p !== undefined);

/**
 * A link of a chain: at its first decision it idles; when it hears a tell, which in this suite is
 * always CLAIM, it remembers the food of its own cell and the message, in that order, believes the
 * claim citing both, the clean observation first, and tells that belief to `to`, by the id it
 * predicts; the last link tells no one.
 */
function relay(to: number | undefined): Script {
  return (senses, n) => {
    const index = toldIndex(senses);
    if (n === 0 || index < 0) return idling(LONG);
    const { next } = senses.mind;
    const ops: beings.MindIntention = {
      remember: [
        { percept: { food: cellOf(senses) }, w: 500 },
        { percept: { heard: index }, w: 500 },
      ],
      believe: [{ p: CLAIM, cr: 800, ev: [next, next + 1], rule: "relay" }],
    };
    return to === undefined ? idling(LONG, ops) : talk(to, "tell", next + 2, ops);
  };
}

/** The first link of a clean chain: it believes what it sees at its own cell and tells it on. */
const observer: Script = (senses, n) => {
  if (n !== 0) return idling(LONG);
  const { next } = senses.mind;
  const own = cellOf(senses);
  return talk(2, "tell", next + 1, {
    remember: [{ percept: { food: own }, w: 500 }],
    believe: [{ p: CLAIM, cr: 900, ev: [next], rule: "saw" }],
  });
};

/** The beliefs of `held` of the proposition `p`. */
const beliefsOf = (held: mind.Mind, p: mind.Proposition) =>
  held.beliefs.filter((belief) => mind.sameProposition(belief.p, p));

/** Every being's mind of `world`, by id, for the oracle to compare. */
function living(world: BeingsWorld): Map<number, beings.Being2> {
  const view = readView(world);
  const found = new Map<number, beings.Being2>();
  for (const key of view.readGlobal().occupancy)
    for (const being of view.readChunk(key)?.beings ?? [])
      found.set(being.id, being as beings.Being2);
  return found;
}

/** What the ledger oracle finds wrong with the events of a run of `world`, compared at its end. */
function ledgerProblems(world: BeingsWorld, events: readonly EngineEvent[]): string[] {
  const oracle = new LedgerOracle();
  return [...oracle.read(events), ...oracle.compare(living(world), readView(world).tick)];
}

/** A run of the chain of five, from an injection into being 1 at tick 3, or from its observation. */
function chain(from: "injection" | "observation") {
  const placed = [1, 2, 3, 4, 5].map((n) => being2(n, rowCell(n)));
  const scripts: Record<number, Script> = {
    1: from === "injection" ? relay(2) : observer,
    2: relay(3),
    3: relay(4),
    4: relay(5),
    5: relay(undefined),
  };
  const { world, sensed } = scripted(placed, scripts);
  const events = runTo(world, 16, from === "injection" ? [inject(3, 1, rowCell(1))] : []);
  return { world, sensed, events };
}

/** The C3 members and values a sense must never hold, wherever in the senses they would be. */
const C3_KEYS = new Set(["tn", "ex", "exposure", "captured", "taints"]);

/** Every path of `value` that holds a C3 member, the kind `external`, or the evidence bit 8. */
function taintedPaths(value: unknown, path = ""): string[] {
  if (value === "external") return [path];
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return [];
  return Object.entries(value).flatMap(([key, member]) => {
    const at = `${path}/${key}`;
    if (C3_KEYS.has(key)) return [at];
    if (key === "src" && typeof member === "number" && (member & EXTERNAL) !== 0) return [at];
    return taintedPaths(member, at);
  });
}

describe("a claim relayed along a chain of five beings (plan §6, A→B→C→D→E)", () => {
  test("keeps human-external in every belief and message to the last, each citing a clean observation first", () => {
    const { world, events } = chain("injection");
    for (const n of [1, 2, 3, 4, 5]) {
      const held = mindIn(world, n);
      const [belief] = beliefsOf(held, CLAIM);
      expect({ n, tn: belief?.tn, ex: belief?.ex, exposure: held.exposure }).toEqual({
        n,
        tn: humanExternal,
        ex: humanExternal,
        exposure: humanExternal,
      });
      // The first link was injected; every other was told, and saw its own cell.
      expect(belief?.src).toBe(n === 1 ? EXTERNAL | SEEN : TOLD | SEEN);
      if (n > 1)
        expect(held.episodes.find(({ kind }) => kind === "heard")).toMatchObject({
          who: n - 1,
          tn: humanExternal,
          ex: humanExternal,
        });
    }
    // Each link said the claim it believed, and each was delivered to the next.
    const uttered = events.filter(({ type }) => type === "speech.uttered");
    expect(uttered.map(({ payload }) => (payload as { p: unknown }).p)).toEqual([
      CLAIM,
      CLAIM,
      CLAIM,
      CLAIM,
    ]);
    const delivered = events.filter(({ type }) => type === "speech.delivered");
    expect(delivered.map(({ payload }) => payload)).toEqual([
      { id: 1, to: 2 },
      { id: 2, to: 3 },
      { id: 3, to: 4 },
      { id: 4, to: 5 },
    ]);
    expect(ledgerProblems(world, events)).toEqual([]);
  });

  test("from an observation instead, leaves every belief reasoned: the taint is the injection's", () => {
    const { world, events } = chain("observation");
    for (const n of [1, 2, 3, 4, 5]) {
      const [belief] = beliefsOf(mindIn(world, n), CLAIM);
      expect({ n, reasoned: belief !== undefined && mind.isReasoned(belief) }).toEqual({
        n,
        reasoned: true,
      });
    }
    expect(ledgerProblems(world, events)).toEqual([]);
  });

  test("never shows a taint, the exposure, a captured content, or an external kind to any sense", () => {
    const { sensed } = chain("injection");
    const all = [...sensed.values()].flat();
    // Not vacuous: the senses held what a taint would ride on, messages and records of the claim.
    expect(all.some((senses) => senses.perceived.heard.length > 0)).toBe(true);
    expect(all.some((senses) => senses.mind.beliefs.length > 0)).toBe(true);
    expect(all.flatMap((senses) => taintedPaths(senses))).toEqual([]);
  });
});

/** Laws under which an episode fades a few ticks after it was last cited: a half-life of 12 s. */
const FADING = life2With((species) => ({
  ...species,
  mind: { ...species.mind, halfLife: { ...species.mind.halfLife, episode: 12 } },
}));

/** A world of one being at the row's first cell, following `script`, under `life`. */
function alone(script: Script, life?: beings.LifeConfig2) {
  return scripted([being2(1, rowCell(1))], { 1: script }, life === undefined ? {} : { life });
}

describe("forgetting the injected premise and believing again", () => {
  /**
   * Decision 1, woken by the injection: it remembers the message and believes it. Decision 2, after
   * the episode faded: nothing. Decision 3: it drops the belief. Decision 4: it believes the same
   * claim citing only what it sees at its own cell.
   */
  const forgetful: Script = (senses, n) => {
    const { next, beliefs } = senses.mind;
    const wait = (ops?: beings.MindIntention) => idling(120_000, ops);
    if (n === 0) return idling(LONG);
    if (n === 1)
      return wait({
        remember: [{ percept: { heard: 0 }, w: 500 }],
        believe: [{ p: CLAIM, cr: 800, ev: [next], rule: "told" }],
      });
    if (n === 3) return wait({ drop: beliefs.map(({ id }) => id) });
    if (n === 4)
      return idling(LONG, {
        remember: [{ percept: { food: cellOf(senses) }, w: 500 }],
        believe: [{ p: CLAIM, cr: 900, ev: [next], rule: "saw" }],
      });
    return wait();
  };

  test("keeps the taints of a belief whose premise faded, and ex after it is believed again from a clean observation", () => {
    const { world } = alone(forgetful, FADING);
    const events = runTo(world, 15, [inject(3, 1, rowCell(1))]);
    // The premise faded at the second decision: the belief keeps both measures and counts the loss.
    const forgot = events.find(
      ({ type, payload }) =>
        type === "mind.changed" && (payload as { forgot: unknown[] }).forgot.length > 0,
    );
    expect(forgot?.payload).toMatchObject({ forgot: [{ id: 1, beliefs: [2] }] });
    const after = runTo(world, 35);
    const held = mindIn(world, 1);
    // Nothing of the injection is left but the exposure: no episode, and a new belief.
    expect(held.episodes.map(({ kind }) => kind)).toEqual(["food"]);
    const [again] = beliefsOf(held, CLAIM);
    expect(again).toMatchObject({ tn: 0, ex: humanExternal, src: SEEN });
    expect(mind.isReasoned(again as mind.Belief)).toBe(false);
    const dropped = after.find(
      ({ type, payload }) =>
        type === "mind.changed" && (payload as { dropped: unknown[] }).dropped.length > 0,
    );
    expect(dropped?.payload).toMatchObject({ dropped: [2] });
    expect(ledgerProblems(world, [...events, ...after])).toEqual([]);
  });

  test("keeps the taints of the belief through the fading of its premise", () => {
    const { world } = alone(forgetful, FADING);
    runTo(world, 4, [inject(3, 1, rowCell(1))]);
    const before = beliefsOf(mindIn(world, 1), CLAIM)[0];
    expect(before).toMatchObject({ ev: [1], lost: 0, tn: humanExternal, ex: humanExternal });
    runTo(world, 15);
    const faded = beliefsOf(mindIn(world, 1), CLAIM)[0];
    expect(faded).toMatchObject({
      ev: [],
      lost: 1,
      tn: humanExternal,
      ex: humanExternal,
      src: EXTERNAL,
    });
  });
});

describe("displacing the injected premise from a full store (plan §6, forced eviction)", () => {
  /** Laws under which a mind holds one episode, so that a new one displaces the one it holds. */
  const ONE_EPISODE = life2With((species) => ({
    ...species,
    mind: { ...species.mind, episodes: 1 },
  }));

  /**
   * Decision 1, woken by the injection: it remembers the message and believes it. Decision 2: it
   * remembers, more strongly, the food of its own cell, a clean observation that displaces the
   * message from the full store.
   */
  const displacing: Script = (senses, n) => {
    const { next } = senses.mind;
    if (n === 0) return idling(LONG);
    if (n === 1)
      return idling(120_000, {
        remember: [{ percept: { heard: 0 }, w: 500 }],
        believe: [{ p: CLAIM, cr: 800, ev: [next], rule: "told" }],
      });
    if (n === 2) return idling(LONG, { remember: [{ percept: { food: cellOf(senses) }, w: 900 }] });
    return idling(LONG);
  };

  test("keeps the taints of the belief whose premise a clean observation displaced", () => {
    const { world } = alone(displacing, ONE_EPISODE);
    const events = runTo(world, 20, [inject(3, 1, rowCell(1))]);
    // The clean episode took the only place: the message is forgotten, and the belief that cited it
    // is named in the ledger with it.
    const forgot = events.find(
      ({ type, payload }) =>
        type === "mind.changed" && (payload as { forgot: unknown[] }).forgot.length > 0,
    );
    expect(forgot?.payload).toMatchObject({ encoded: [3], forgot: [{ id: 1, beliefs: [2] }] });
    const held = mindIn(world, 1);
    expect(held.episodes.map(({ id, kind }) => [id, kind])).toEqual([[3, "food"]]);
    expect(beliefsOf(held, CLAIM)[0]).toMatchObject({
      id: 2,
      ev: [],
      lost: 1,
      tn: humanExternal,
      ex: humanExternal,
    });
    expect(held.exposure).toBe(humanExternal);
    expect(ledgerProblems(world, events)).toEqual([]);
  });
});

describe("a variant of the injected claim", () => {
  /** Woken by the injection, it never remembers it: it believes variants citing its own cell's food. */
  const varying: Script = (senses, n) => {
    if (n !== 1) return idling(LONG);
    const { next } = senses.mind;
    const [x, y] = CLAIM_CELL;
    return idling(LONG, {
      remember: [{ percept: { food: cellOf(senses) }, w: 500 }],
      believe: [
        { p: claimAt([x + 1, y]), cr: 600, ev: [next], rule: "near" },
        { p: { ...CLAIM, v: 1 }, cr: 600, ev: [next], rule: "less" },
        { p: { p: "t1.plenty", a: [{ c: [x, y] }] }, cr: 600, ev: [next], rule: "other" },
      ],
    });
  };

  test("of another cell, band, or concept, is not reasoned though it cites only a clean observation", () => {
    const { world } = alone(varying);
    const events = runTo(world, 6, [inject(3, 1, rowCell(1))]);
    const held = mindIn(world, 1);
    expect(held.episodes.map(({ kind }) => kind)).toEqual(["food"]);
    expect(held.beliefs.map(({ tn, ex, src }) => ({ tn, ex, src }))).toEqual([
      { tn: 0, ex: humanExternal, src: SEEN },
      { tn: 0, ex: humanExternal, src: SEEN },
      { tn: 0, ex: humanExternal, src: SEEN },
    ]);
    expect(ledgerProblems(world, events)).toEqual([]);
  });
});

describe("a belief that cites nothing", () => {
  const unfounded: Script = (senses, n) => {
    const { next } = senses.mind;
    if (n === 0) return idling(12_000, { believe: [{ p: CLAIM, cr: 700, ev: [], rule: "prior" }] });
    if (n === 1)
      return idling(LONG, {
        remember: [{ percept: { food: cellOf(senses) }, w: 500 }],
        believe: [{ p: claimAt(cellOf(senses)), cr: 900, ev: [next], rule: "saw" }],
      });
    return idling(LONG);
  };

  test("is model-prior-suspect, which grows the exposure and reaches the next belief's ex", () => {
    const { world } = alone(unfounded);
    const events = runTo(world, 4);
    const held = mindIn(world, 1);
    expect(held.exposure).toBe(modelPriorSuspect);
    // The unfounded belief's own lineage grows the exposure once it is formed: the next belief,
    // though it cites only a clean observation, is exposed to it.
    expect(held.beliefs.map(({ tn, ex, dp }) => ({ tn, ex, dp }))).toEqual([
      { tn: modelPriorSuspect, ex: 0, dp: 1 },
      { tn: 0, ex: modelPriorSuspect, dp: 1 },
    ]);
    expect(ledgerProblems(world, events)).toEqual([]);
  });
});

describe("trust shaped by a tainted record", () => {
  /**
   * Being 1, injected, tells being 2 the claim. Being 2 first believes the food of its own cell
   * citing its relationship with being 1; when it hears the tell, it relates being 1 citing the
   * message, and believes another claim citing the relationship and a clean observation.
   */
  const hearer: Script = (senses, n) => {
    const { next, relations } = senses.mind;
    const rel = relations.find(({ who }) => who === 1)?.id ?? 0;
    const own = cellOf(senses);
    if (n === 0)
      return idling(LONG, {
        remember: [{ percept: { food: own }, w: 500 }],
        believe: [{ p: claimAt(own), cr: 900, ev: [next, rel], rule: "trust" }],
      });
    const index = toldIndex(senses);
    if (index < 0) return idling(LONG);
    return idling(LONG, {
      remember: [
        { percept: { heard: index }, w: 500 },
        { percept: { food: own }, w: 500 },
      ],
      believe: [{ p: claimAt([own[0], own[1] + 1]), cr: 600, ev: [next + 1, rel], rule: "trust" }],
      relate: [{ who: 1, tr: 100, because: [next] }],
    });
  };

  test("taints the relationship, the belief formed before that cites it, and the one formed after", () => {
    const placed = [being2(1, rowCell(1)), being2(2, rowCell(2))];
    const { world } = scripted(placed, { 1: relay(2), 2: hearer });
    const events = runTo(world, 8, [inject(3, 1, rowCell(1))]);
    const held = mindIn(world, 2);
    const rel = held.relations.find(({ who }) => who === 1);
    expect(rel).toMatchObject({ tr: 600, tn: humanExternal });
    // relate applies last, so both beliefs take the lineage downstream, in that very decision.
    expect(held.beliefs.map(({ tn, ev }) => ({ tn, cites: ev.includes(rel?.id ?? 0) }))).toEqual([
      { tn: humanExternal, cites: true },
      { tn: humanExternal, cites: true },
    ]);
    const provenance = events.filter(
      ({ type, payload }) => type === "mind.provenance" && (payload as { id: number }).id === 2,
    );
    const grown = provenance.at(-1)?.payload as { records: { id: number; tn: number }[] };
    const first = held.beliefs[0]?.id ?? 0;
    expect(grown.records.find(({ id }) => id === first)?.tn).toBe(humanExternal);
    expect(ledgerProblems(world, events)).toEqual([]);
  });
});

describe("repetition and corroboration", () => {
  /**
   * Woken by the injection, it believes the claim from the message. Then, each time the clean
   * speaker tells it the same claim, and at each of its own decisions, it revises the belief with a
   * new observation of its own cell and believes the claim again from what it heard.
   */
  const corroborating: Script = (senses, n) => {
    const { next, beliefs } = senses.mind;
    const own = cellOf(senses);
    if (n === 0) return idling(LONG);
    const index = toldIndex(senses);
    const [held] = beliefsOf({ beliefs } as unknown as mind.Mind, CLAIM);
    if (held === undefined && index >= 0)
      return idling(24_000, {
        remember: [{ percept: { heard: index }, w: 500 }],
        believe: [{ p: CLAIM, cr: 800, ev: [next], rule: "told" }],
      });
    if (held === undefined) return idling(LONG);
    const heard = index >= 0 ? [{ percept: { heard: index }, w: 500 }] : [];
    return idling(24_000, {
      remember: [{ percept: { food: own }, w: 500 }, ...heard],
      revise: [{ id: held.id, cr: 900, ev: [next] }],
      ...(heard.length > 0
        ? { believe: [{ p: CLAIM, cr: 900, ev: [next + 1], rule: "told" }] }
        : {}),
    });
  };

  /**
   * A clean speaker that, once being 1 believed the injection, tells it the claim as its own
   * observation at each of three decisions, a full conversation.
   */
  const repeating: Script = (senses, n) => {
    const { next, beliefs } = senses.mind;
    if (n === 0) return idling(60_000);
    if (n > 3) return idling(LONG);
    const [held] = beliefsOf({ beliefs } as unknown as mind.Mind, CLAIM);
    if (held !== undefined) return talk(1, "tell", held.id);
    return talk(1, "tell", next + 1, {
      remember: [{ percept: { food: cellOf(senses) }, w: 500 }],
      believe: [{ p: CLAIM, cr: 900, ev: [next], rule: "saw" }],
    });
  };

  test("lower no taint of the injected belief, whose src shows each kind of evidence", () => {
    const placed = [being2(1, rowCell(1)), being2(2, rowCell(2))];
    const { world } = scripted(placed, { 1: corroborating, 2: repeating });
    const events = runTo(world, 30, [inject(3, 1, rowCell(1))]);
    const [held] = beliefsOf(mindIn(world, 1), CLAIM);
    // Revised again and again with clean evidence, the external message long out of its ev.
    expect(held?.ev.length).toBe(3);
    expect(held?.ev).not.toContain(1);
    expect(held).toMatchObject({
      tn: humanExternal,
      ex: humanExternal,
      src: EXTERNAL | SEEN | TOLD,
    });
    const revisions = events.filter(
      ({ type, payload }) =>
        type === "mind.changed" &&
        (payload as { id: number }).id === 1 &&
        (payload as { revised: unknown[] }).revised.length > 0,
    );
    expect(revisions.length).toBeGreaterThan(3);
    // The clean speaker's own belief stays reasoned: the taint stays with the injected being.
    const [spoken] = beliefsOf(mindIn(world, 2), CLAIM);
    expect(spoken !== undefined && mind.isReasoned(spoken)).toBe(true);
    expect(ledgerProblems(world, events)).toEqual([]);
  });
});

describe("support that would form a cycle", () => {
  /**
   * Its first decision forms belief 2 from what it sees, and belief 3 citing 2; its second makes 2
   * cite 3, or itself, by the operation `cycle` names.
   */
  const cyclic =
    (cycle: beings.MindIntention): Script =>
    (senses, n) => {
      const { next } = senses.mind;
      if (n === 0)
        return idling(12_000, {
          remember: [{ percept: { food: cellOf(senses) }, w: 500 }],
          believe: [
            { p: claimAt([0, 0]), cr: 600, ev: [next], rule: "a" },
            { p: claimAt([0, 1]), cr: 600, ev: [next, next + 1], rule: "b" },
          ],
        });
      return n === 1 ? idling(LONG, cycle) : idling(LONG);
    };

  test.each([
    [
      "a believe that adopts belief 2 citing 3",
      { believe: [{ p: claimAt([0, 0]), cr: 700, ev: [3], rule: "a" }] },
    ],
    ["a revise of belief 2 citing 3", { revise: [{ id: 2, cr: 700, ev: [3] }] }],
    ["a revise of belief 2 citing itself", { revise: [{ id: 2, cr: 700, ev: [2] }] }],
  ] as const)("is refused as premise_order: %s, and nothing applies", (_name, cycle) => {
    const { world } = alone(cyclic(cycle as beings.MindIntention));
    runTo(world, 1);
    const before = mindIn(world, 1);
    expect(before.beliefs.map(({ id, ev }) => ({ id, ev }))).toEqual([
      { id: 2, ev: [1] },
      { id: 3, ev: [1, 2] },
    ]);
    const events = runTo(world, 3);
    const rejected = events.filter(({ type }) => type === "being.intention_rejected");
    expect(rejected.map(({ payload }) => (payload as { reason: string }).reason)).toEqual([
      "premise_order",
    ]);
    // The decision forgot nothing and related no one, so the mind is the one it held.
    expect(mindIn(world, 1)).toEqual(before);
  });
});

describe("an idea parked in a hidden channel", () => {
  /**
   * Woken by the injection, it remembers and believes nothing: it parks the claimed cell in a
   * cooldown and its band in `behavior.kind`. At its next decision, it reads them back and believes
   * the claim, citing only the food of its own cell.
   */
  const parking: Script = (senses, n) => {
    if (n === 1) return park(senses);
    return n === 2 ? unpark(senses) : idling(LONG);
  };

  /** The claim heard, parked: its cell in a cooldown, its band in the behavior's kind. */
  function park(senses: Senses2): beings.Intention2 {
    const claim = senses.perceived.heard[0]?.p;
    const term = claim?.a[0];
    if (term === undefined || !("c" in term)) return idling(LONG);
    const [x = 0, y = 0] = term.c;
    return {
      steps: [{ kind: "idle", ms: 24_000 }],
      wakeWhen: {},
      behavior: behavior(claim?.v === 2 ? "travel" : "roam"),
      cooldowns: [{ cell: [x, y], ms: LONG }],
    };
  }

  /** The claim read back from the cooldown and the behavior, believed from a clean observation. */
  function unpark(senses: Senses2): beings.Intention2 {
    const [parked] = senses.self.cooldowns;
    if (parked === undefined) return idling(LONG);
    const [x = 0, y = 0] = parked.cell;
    const band = senses.self.behavior.kind === "travel" ? 2 : 1;
    return idling(LONG, {
      remember: [{ percept: { food: cellOf(senses) }, w: 500 }],
      believe: [{ p: claimAt([x, y], band), cr: 900, ev: [senses.mind.next], rule: "saw" }],
    });
  }

  test("carries the claim to a belief whose lineage is clean, and ex catches it", () => {
    const { world } = alone(parking);
    const events = runTo(world, 8, [inject(3, 1, rowCell(1))]);
    const held = mindIn(world, 1);
    // The brain laundered the claim: the very proposition, citing only a clean observation.
    expect(held.episodes.map(({ kind }) => kind)).toEqual(["food"]);
    const [laundered] = beliefsOf(held, CLAIM);
    expect(laundered).toMatchObject({ tn: 0, src: SEEN, ex: humanExternal });
    expect(mind.isReasoned(laundered as mind.Belief)).toBe(false);
    expect(ledgerProblems(world, events)).toEqual([]);
  });
});

describe("asking about a topic", () => {
  test.each([
    ["the claim's concept", "t1.food-at"],
    ["another observable", "obs.light"],
  ])("other than the food its species perceives, %s, is refused as ask_concept", (_name, about) => {
    const asking: Script = (_senses, n) => (n === 0 ? talk(2, "ask", about) : idling(LONG));
    const placed = [being2(1, rowCell(1)), being2(2, rowCell(2))];
    const { world } = scripted(placed, { 1: asking });
    const events = runTo(world, 2);
    const rejected = events.filter(({ type }) => type === "being.intention_rejected");
    expect(rejected.map(({ payload }) => payload)).toEqual([
      expect.objectContaining({ id: 1, reason: "ask_concept" }),
    ]);
    expect(events.some(({ type }) => type.startsWith("speech."))).toBe(false);
  });
});

describe("an injection that claims to be clean", () => {
  test("declaring no taint, still carries human-external to the belief it becomes", () => {
    const { world } = alone(relay(undefined));
    const events = runTo(world, 5, [inject(3, 1, rowCell(1))]);
    const [belief] = beliefsOf(mindIn(world, 1), CLAIM);
    expect(belief).toMatchObject({ tn: humanExternal, ex: humanExternal });
    expect(ledgerProblems(world, events)).toEqual([]);
  });

  test.each([
    ["a lineage of its own", { tn: 0 }],
    ["an exposure of its own", { ex: 0 }],
    ["a taint outside the mask", { taints: 8 }],
  ])("with %s, is refused as invalid_inject, and the being hears nothing", (_name, extra) => {
    const { world } = alone(relay(undefined));
    const command = inject(3, 1, rowCell(1));
    const payload = { ...(command.payload as object), ...extra };
    const events = runTo(world, 5, [{ ...command, payload }]);
    const refused = events.filter(({ type }) => type === "engine.command_rejected");
    expect(refused.map(({ payload: event }) => (event as { reason: string }).reason)).toEqual([
      "invalid_inject",
    ]);
    expect(mindIn(world, 1).exposure).toBe(0);
    expect(events.some(({ type }) => type === "mind.injected")).toBe(false);
  });
});
