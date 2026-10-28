/**
 * The view of a mind a brain decides on (ADR 0024, docs/architecture/mind.md "Perception"): its
 * episodes, beliefs, and relationships, and `next`, so that a brain can cite a record it creates in
 * the same decision. It is a pure function of the mind and the moment: what would be forgotten by
 * now is already gone from it, ticks become ages in simulated seconds, saturating at 2^31 − 1, and
 * familiarity is shown as it stands now, so the view is the same whether the being was processed
 * often or seldom. It is built by allowlist: `tn`, `ex`, and `exposure` never reach it, an
 * `external` episode shows as a `tell` heard with no speaker, and the evidence bit 8 shows as told.
 * Every value is a fresh copy, so a brain that keeps or changes the view cannot reach the state.
 */
import { ageAt, type MindContext, type Moment } from "./context.ts";
import { familiarity } from "./familiarity.ts";
import { forget } from "./forget.ts";
import { copyProposition, type Proposition } from "./prop.ts";
import type { Mind } from "./records.ts";
import {
  type Act,
  type Belief,
  type Cell,
  type Episode,
  EVIDENCE,
  type LocalId,
  NEVER_SEEN,
  type Relationship,
} from "./records.ts";

/** An episode as a brain sees it: `t` and `r` are ages in seconds. */
export type EpisodeView = {
  readonly id: LocalId;
  readonly kind: "food" | "being" | "ate" | "failed" | "heard";
  readonly t: number;
  readonly cell?: Cell;
  readonly who?: number;
  readonly v?: number;
  readonly p?: Proposition;
  readonly act?: Act;
  readonly band?: number;
  readonly w: number;
  readonly r: number;
};

/** A belief as a brain sees it, without its taints: `u` is an age in seconds. */
export type BeliefView = Omit<Belief, "tn" | "ex">;

/**
 * A relationship as a brain sees it: `f` is its familiarity now, from 0 to 1000; `seen` the age of
 * its last perception, absent when its being was only heard; and `talk` the age of the last act the
 * being addressed to it, absent when it never did.
 */
export type RelationshipView = Omit<Relationship, "tn" | "seen" | "talk"> & {
  readonly seen?: number;
  readonly talk?: number;
};

export type MindView = {
  readonly next: LocalId;
  readonly episodes: readonly EpisodeView[];
  readonly beliefs: readonly BeliefView[];
  readonly relations: readonly RelationshipView[];
};

function copyCell(cell: Cell): Cell {
  return [cell[0], cell[1]];
}

/** The members an episode of `kind` holds beyond its id, ticks, and importance. */
function contentOf(episode: Episode): Omit<EpisodeView, "id" | "kind" | "t" | "w" | "r"> {
  switch (episode.kind) {
    case "external":
      return { p: copyProposition(episode.p), act: "tell" };
    case "heard":
      return {
        cell: copyCell(episode.cell),
        who: episode.who,
        ...(episode.p === undefined ? {} : { p: copyProposition(episode.p) }),
        act: episode.act,
        ...(episode.band === undefined ? {} : { band: episode.band }),
      };
    case "being":
      return { cell: copyCell(episode.cell), who: episode.who, v: episode.v };
    default:
      return { cell: copyCell(episode.cell), v: episode.v };
  }
}

function episodeView(episode: Episode, moment: Moment): EpisodeView {
  return {
    id: episode.id,
    kind: episode.kind === "external" ? "heard" : episode.kind,
    t: ageAt(episode.t, moment),
    ...contentOf(episode),
    w: episode.w,
    r: ageAt(episode.r, moment),
  };
}

/** `src` with the C3 bit of external evidence shown as told. */
function shownEvidence(src: number): number {
  const external = (src & EVIDENCE.external) === 0 ? 0 : EVIDENCE.told;
  return (src & ~EVIDENCE.external) | external;
}

function beliefView(belief: Belief, moment: Moment): BeliefView {
  return {
    id: belief.id,
    p: copyProposition(belief.p),
    cr: belief.cr,
    src: shownEvidence(belief.src),
    ...(belief.who === undefined ? {} : { who: belief.who }),
    ev: [...belief.ev],
    lost: belief.lost,
    dp: belief.dp,
    u: ageAt(belief.u, moment),
  };
}

function relationshipView(relationship: Relationship, ctx: MindContext): RelationshipView {
  return {
    id: relationship.id,
    who: relationship.who,
    f: familiarity(relationship, ctx),
    ...(relationship.seen === NEVER_SEEN ? {} : { seen: ageAt(relationship.seen, ctx.moment) }),
    aff: relationship.aff,
    tr: relationship.tr,
    ...(relationship.talk === 0 ? {} : { talk: ageAt(relationship.talk, ctx.moment) }),
    turns: relationship.turns,
  };
}

/** The view of `mind` at the context's moment. */
export function viewOf(mind: Mind, ctx: MindContext): MindView {
  const current = forget(mind, ctx).mind;
  return {
    next: current.next,
    episodes: current.episodes.map((episode) => episodeView(episode, ctx.moment)),
    beliefs: current.beliefs.map((belief) => beliefView(belief, ctx.moment)),
    relations: current.relations.map((relationship) => relationshipView(relationship, ctx)),
  };
}
