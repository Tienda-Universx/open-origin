/**
 * Speech of beings@2 at the speaker (ADR 0024, docs/architecture/mind.md "Speech" and
 * "Relationships"): a talk is judged at the decision that proposes it, after its mental operations
 * applied, against what the being perceived in that decision and the mind those operations left.
 * The hearer must have been perceived (`talk_unseen`), stand within `speech.range`
 * (`talk_out_of_range`), and not sleep (`talk_asleep`); a tell names a belief the mind holds
 * (`talk_unheld`), whose proposition, confidence band, lineage, and exposure with the speaker's the
 * engine captures then; an ask names the concept of its species' food (`ask_concept`); and the act
 * fits the quotas (`talk_quota`): `speech.perDay` acts in the day of the decision, and per hearer,
 * whose relationship holds them, `speech.turns` acts in a conversation, which a pause longer than
 * `speech.gap` ends, and `speech.cooldown` after a full one. The first that fails is the reason.
 * An accepted act counts in the day's quota and in the relationship at once, and its talk lasts
 * `speech.actMs`. When it ends without being cut short, the being says what it captured: its
 * utterance, which `speech.uttered` reports without taints.
 */
import type { CanonicalValue } from "../canonical/value.ts";
import { copyProposition, type Mind, type Relationship } from "../mind/index.ts";
import type { Tick } from "../time/tick.ts";
import type { Activity, Captured, Cell, TalkStep } from "./being.ts";
import { dayOf, quotaOf } from "./hearing.ts";
import type { Species } from "./laws.ts";
import type { Species2 } from "./life2.ts";
import { distance, type PerceivedBeing } from "./perception.ts";
import { greatest } from "./rates.ts";

/** A talk under way. */
export type Talk = Extract<Activity, { kind: "talk" }>;

/** Why a talk is refused at its decision. */
export type SpeechReason =
  | "talk_unseen"
  | "talk_out_of_range"
  | "talk_asleep"
  | "talk_unheld"
  | "ask_concept"
  | "talk_quota";

/** Where and when a talk is judged: the speaker, its species, and what it perceived then. */
export type Speaking = {
  readonly cell: Cell;
  readonly tick: Tick;
  /** The simulated second of the tick, whose day the quota counts. */
  readonly seconds: number;
  readonly secondsPerTick: number;
  readonly dayLength: number;
  readonly species: Species2;
  /** The beings the speaker perceived in this decision. */
  readonly perceived: readonly PerceivedBeing[];
};

/** A talk that starts, and the mind that counts it. */
export type Spoken = { readonly activity: Talk; readonly mind: Mind };

/** The concept a species perceives and may ask about: the observable of its food deposit. */
export function perceivedConcept(species: Species): string {
  return `obs.deposit.${species.diet.deposit}`;
}

/** The band of a confidence: 2 from 800, 1 from 500, and 0 below. */
export function bandOf(confidence: number): number {
  if (confidence >= 800) return 2;
  return confidence >= 500 ? 1 : 0;
}

/**
 * The talk `step` starts at `at`, with `mind`, the mind after the decision's operations, counting
 * it; or why it is refused.
 */
export function speak(step: TalkStep, mind: Mind, at: Speaking): Spoken | SpeechReason {
  const hearer = at.perceived.find((being) => being.id === step.to);
  if (hearer === undefined) return "talk_unseen";
  if (distance(hearer.cell, at.cell) > at.species.speech.range) return "talk_out_of_range";
  if (hearer.activity === "sleep") return "talk_asleep";
  const captured = capture(step, mind, at.species);
  if (typeof captured === "string") return captured;
  const counted = countAct(mind, step.to, at);
  if (counted === undefined) return "talk_quota";
  const { to, act } = step;
  return { activity: { kind: "talk", start: at.tick, to, act, captured }, mind: counted };
}

/**
 * What the act of `step` carries, captured from `mind` at the decision: for a tell, the belief's
 * proposition, band, and lineage, and its exposure united with the speaker's; nothing for the other
 * acts, an ask's concept being the one its species perceives.
 */
function capture(step: TalkStep, mind: Mind, species: Species): Captured | SpeechReason {
  if (step.act === "tell") {
    const told = mind.beliefs.find((belief) => belief.id === step.about);
    if (told === undefined) return "talk_unheld";
    const { p, cr, tn, ex } = told;
    return { p: copyProposition(p), band: bandOf(cr), tn, ex: ex | mind.exposure };
  }
  if (step.act === "ask" && step.about !== perceivedConcept(species)) return "ask_concept";
  return { tn: 0, ex: 0 };
}

/**
 * `mind` with an act to the being `to` counted: one more in the day's quota, and the relationship
 * addressed now, in the conversation the pause since its last act continues or starts. Undefined
 * when a quota refuses it, or the mind holds no relationship to keep the quotas of the pair in.
 */
function countAct(mind: Mind, to: number, at: Speaking): Mind | undefined {
  const index = mind.relations.findIndex((relationship) => relationship.who === to);
  const addressed = mind.relations[index];
  if (addressed === undefined) return undefined;
  const quota = quotaOf(mind.quota, dayOf(at.seconds, at.dayLength));
  if (quota.said >= at.species.speech.perDay) return undefined;
  const turns = turnsAfter(addressed, at);
  if (turns === undefined) return undefined;
  const relations = mind.relations.with(index, { ...addressed, talk: at.tick, turns });
  return { ...mind, relations, quota: { ...quota, said: quota.said + 1 } };
}

/**
 * The acts addressed to the being of `relationship` in its conversation once one more is: the
 * first of a new one when it was never addressed, after a pause longer than `speech.gap`, or after
 * `speech.cooldown` past a full conversation; the next of the same one otherwise; undefined while
 * a full conversation cools down.
 */
function turnsAfter(relationship: Relationship, at: Speaking): number | undefined {
  const { turns, gap, cooldown } = at.species.speech;
  // `talk` 0 is no act: the first tick a world computes is 1.
  if (relationship.talk === 0) return 1;
  const pause = greatest(at.tick - relationship.talk, 0) * at.secondsPerTick;
  if (relationship.turns >= turns) return pause >= cooldown ? 1 : undefined;
  return pause > gap ? 1 : relationship.turns + 1;
}

/** What a talk said when it ended without being cut short: its act and content, and where. */
export type Utterance = {
  readonly to: number;
  readonly act: Talk["act"];
  readonly captured: Captured;
  readonly cell: Cell;
};

/** The utterance of `talk`, said from `cell`. */
export function utteranceOf(talk: Talk, cell: Cell): Utterance {
  return { to: talk.to, act: talk.act, captured: talk.captured, cell };
}

/**
 * The payload of `speech.uttered` (C0) for the utterance of the being `id`: the hearer, the act,
 * for a tell its proposition and band, and the cell, never a taint.
 */
export function utteredPayload(id: number, utterance: Utterance): CanonicalValue {
  const { p, band } = utterance.captured;
  return {
    id,
    to: utterance.to,
    act: utterance.act,
    ...(p === undefined ? {} : { p: copyProposition(p) }),
    ...(band === undefined ? {} : { band }),
    cell: [utterance.cell[0], utterance.cell[1]],
  };
}
