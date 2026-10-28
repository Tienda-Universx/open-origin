/**
 * The records of a mind (ADR 0024, docs/architecture/mind.md "The mind of a being"): episodes,
 * beliefs, relationships, and inbox messages, each with exactly the members the specification
 * lists, and the mind that holds them. Every record has a local id taken from `next`, unique across
 * the three stores, and each store keeps its records in increasing id, because records are only
 * appended with new ids and removed. Ticks and entity ids are plain numbers here: the layer may not
 * import the kernel's time or contracts.
 */
import { INT31_MAX } from "./bounds.ts";
import type { Proposition } from "./prop.ts";

/** A record's id inside one mind: from 1, below `next`, never reused. */
export type LocalId = number;
/** A taint mask (taints.ts): any union of 1, 2, and 4. */
export type TaintMask = number;
/** An absolute cell, `[x, y]`. */
export type Cell = readonly [number, number];

/** The acts of speech (docs/architecture/mind.md, "Speech"). */
export type Act = "greet" | "ask" | "tell" | "unknown";
export const ACTS: readonly Act[] = Object.freeze(["greet", "ask", "tell", "unknown"]);

/** The reasons a `failed` episode indexes, in this order. */
export const FAILURES: readonly string[] = Object.freeze([
  "no_food",
  "food_gone",
  "incapacitated",
  "crowded",
]);

/**
 * The kinds of evidence a belief's `src` records: 1 seen, 2 told, 4 inferred, and 8 external. The
 * bit 8 is C3: a view shows it as told.
 */
export const EVIDENCE = Object.freeze({ seen: 1, told: 2, inferred: 4, external: 8 });

/** The members every episode has: its id, the tick it happened, its importance, and its anchor. */
type EpisodeBase = {
  readonly id: LocalId;
  readonly t: number;
  readonly w: number;
  readonly r: number;
};

/** An episode of the being's own experience: a food cue, its last bite, or its last failure. */
export type OwnEpisode = EpisodeBase & {
  readonly kind: "food" | "ate" | "failed";
  readonly cell: Cell;
  readonly v: number;
};

/** A perceived being, `who`, and the index of its activity. */
export type BeingEpisode = EpisodeBase & {
  readonly kind: "being";
  readonly cell: Cell;
  readonly who: number;
  readonly v: number;
};

/** A message from a known speaker; a `tell` carries a proposition and a band. */
export type HeardEpisode = EpisodeBase & {
  readonly kind: "heard";
  readonly cell: Cell;
  readonly who: number;
  readonly act: Act;
  readonly p?: Proposition;
  readonly band?: number;
  readonly tn: TaintMask;
  readonly ex: TaintMask;
};

/** A research injection (C3): no speaker and no cell; a view shows it as heard. */
export type ExternalEpisode = EpisodeBase & {
  readonly kind: "external";
  readonly p: Proposition;
  readonly tn: TaintMask;
};

export type Episode = OwnEpisode | BeingEpisode | HeardEpisode | ExternalEpisode;

export type Belief = {
  readonly id: LocalId;
  readonly p: Proposition;
  /** Confidence, from 0 to 1000. */
  readonly cr: number;
  /** The kinds of evidence that ever supported it (EVIDENCE); it only grows. */
  readonly src: number;
  /** The last speaker it came from. */
  readonly who?: number;
  /** The live records it cites, at most 3, the most recent last. */
  readonly ev: readonly LocalId[];
  /** How many cited records it has lost, up to 2^31 − 1. */
  readonly lost: number;
  readonly tn: TaintMask;
  readonly ex: TaintMask;
  /** One more than the depth of the deepest belief it cites; 1 when it cites none. */
  readonly dp: number;
  /** The tick it was last formed, revised, or cited. */
  readonly u: number;
};

export type Relationship = {
  readonly id: LocalId;
  readonly who: number;
  /** Familiarity, as seconds of co-presence as of `seen`, decayed by absences. */
  readonly f: number;
  /** The tick `who` was last perceived; NEVER_SEEN when it was only heard. */
  readonly seen: number;
  readonly aff: number;
  readonly tr: number;
  readonly tn: TaintMask;
  /** The tick the being last addressed `who`; 0 when it never did. */
  readonly talk: number;
  /** The acts addressed to `who` in the current conversation. */
  readonly turns: number;
};

/**
 * The `seen` of a relationship whose being was heard and never perceived: tick 0, which no
 * perception can be, since the first tick a world computes is 1. Its `f` is 0.
 */
export const NEVER_SEEN = 0;

/** A message waiting for the being's next decision; an injection's has no `who` and no `cell`. */
export type InboxMessage = {
  readonly who?: number;
  readonly t: number;
  readonly cell?: Cell;
  readonly act: Act;
  readonly p?: Proposition;
  readonly band?: number;
  readonly tn: TaintMask;
  readonly ex: TaintMask;
};

/** Acts said and wakes by hearing in the simulated day `day`. */
export type Quota = { readonly day: number; readonly said: number; readonly woken: number };

export type Mind = {
  readonly next: LocalId;
  readonly episodes: readonly Episode[];
  readonly beliefs: readonly Belief[];
  readonly relations: readonly Relationship[];
  readonly inbox: readonly InboxMessage[];
  /** The being's lifetime exposure (C3): a taint mask that never shrinks. */
  readonly exposure: TaintMask;
  readonly quota: Quota;
};

/** The mind of a newborn being in the simulated day `day`: no records, no exposure. */
export function newMind(day: number): Mind {
  return {
    next: 1,
    episodes: [],
    beliefs: [],
    relations: [],
    inbox: [],
    exposure: 0,
    quota: { day, said: 0, woken: 0 },
  };
}

/** A live record of a mind, with the store that holds it. */
export type MindRecord =
  | { readonly store: "episodes"; readonly record: Episode }
  | { readonly store: "beliefs"; readonly record: Belief }
  | { readonly store: "relations"; readonly record: Relationship };

/** The live record of `mind` whose local id is `id`; undefined when the mind holds none. */
export function recordOf(mind: Mind, id: LocalId): MindRecord | undefined {
  const episode = mind.episodes.find((record) => record.id === id);
  if (episode !== undefined) return { store: "episodes", record: episode };
  const belief = mind.beliefs.find((record) => record.id === id);
  if (belief !== undefined) return { store: "beliefs", record: belief };
  const relationship = mind.relations.find((record) => record.id === id);
  return relationship === undefined ? undefined : { store: "relations", record: relationship };
}

/**
 * The id the next new record of `mind` takes, or undefined when ids have run out: `next` stays at
 * most 2^31 − 1, so the last id a record takes is 2^31 − 2.
 */
export function freeId(mind: Mind): LocalId | undefined {
  return mind.next < INT31_MAX ? mind.next : undefined;
}
