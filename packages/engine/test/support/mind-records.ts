/**
 * Builders of minds and records for the tests of the mind layer: each record has typical members,
 * which a test overrides where it matters, and a mind's `next` follows its highest id.
 */
import { mind } from "../../src/index.ts";

type Episode = mind.Episode;
type Belief = mind.Belief;
type Relationship = mind.Relationship;

/** `m1.food-at` at the cell `[x, y]` with the band `band`. */
export function foodAt(x: number, y: number, band = 2): mind.Proposition {
  return { p: "m1.food-at", a: [{ c: [x, y] }], v: band };
}

/** An episode of the being's own experience. */
export function own(
  id: number,
  change: Partial<Extract<Episode, { kind: "food" | "ate" | "failed" }>> = {},
): Episode {
  return { id, kind: "food", t: 0, cell: [0, 0], v: 1, w: 500, r: 0, ...change };
}

/** A perceived being. */
export function seen(
  id: number,
  who: number,
  change: Partial<Extract<Episode, { kind: "being" }>> = {},
): Episode {
  return { id, kind: "being", t: 0, cell: [0, 0], who, v: 0, w: 500, r: 0, ...change };
}

/** A `tell` heard from `who`. */
export function heard(
  id: number,
  who: number,
  change: Partial<Extract<Episode, { kind: "heard" }>> = {},
): Episode {
  return {
    id,
    kind: "heard",
    t: 0,
    cell: [0, 0],
    who,
    act: "tell",
    p: foodAt(1, 1),
    band: 2,
    tn: 0,
    ex: 0,
    w: 500,
    r: 0,
    ...change,
  };
}

/** A research injection. */
export function external(
  id: number,
  change: Partial<Extract<Episode, { kind: "external" }>> = {},
): Episode {
  return { id, kind: "external", t: 0, p: foodAt(2, 2), tn: 2, w: 500, r: 0, ...change };
}

/** A belief about food at `[id, 0]`, from nothing, at depth 1. */
export function belief(id: number, change: Partial<Belief> = {}): Belief {
  return {
    id,
    p: foodAt(id, 0),
    cr: 800,
    src: 1,
    ev: [],
    lost: 0,
    tn: 0,
    ex: 0,
    dp: 1,
    u: 0,
    ...change,
  };
}

/** A relationship with `who`, as a first perception at tick 0 leaves it. */
export function relationship(
  id: number,
  who: number,
  change: Partial<Relationship> = {},
): Relationship {
  return { id, who, f: 0, seen: 0, aff: 0, tr: 500, tn: 0, talk: 0, turns: 0, ...change };
}

/** A mind with `parts`; `next` is one more than its highest id unless `parts` gives it. */
export function mindOf(parts: Partial<mind.Mind> = {}): mind.Mind {
  const ids = [...(parts.episodes ?? []), ...(parts.beliefs ?? []), ...(parts.relations ?? [])].map(
    (record) => record.id,
  );
  const next = Math.max(0, ...ids) + 1;
  return { ...mind.newMind(0), next, ...parts };
}

/** The laws of the tests: the defaults with `change` applied to the part `mind`. */
export function lawsWith(change: Partial<mind.MindLaws["mind"]> = {}): mind.MindLaws {
  const laws = mind.defaultMindLaws();
  return { ...laws, mind: { ...laws.mind, ...change } };
}

/** A context at `tick`, one second per tick, neutral retention, and `laws`. */
export function contextAt(
  tick: number,
  laws: mind.MindLaws = mind.defaultMindLaws(),
  options: { readonly secondsPerTick?: number; readonly retention?: number } = {},
): mind.MindContext {
  const { secondsPerTick = 1, retention = 1000 } = options;
  return { moment: { tick, secondsPerTick }, laws, retention };
}
