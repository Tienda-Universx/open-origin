/**
 * The social policy of `mind@1` (ADR 0024, docs/architecture/mind.md "Speech" and "The brain
 * mind@1", plan §7.3): which act of speech a being proposes, to whom, and when it may. Each act has
 * its purpose: greeting a being it meets or meets again, greeting back, asking for food when hungry
 * and knowing none, telling food it believes to a being that asks or that answered it, and saying
 * it does not know. Answers come whatever the being wills; an unprompted act comes when a draw
 * falls below its will to speak, SPEAK_WILL felt through sociability.
 *
 * The brain senses neither the tick nor its daily quota, so it keeps every quota by a budget it
 * can count in its relationships. It starts a new conversation with a being only once the talk
 * window W = max(speech.gap + 1, speech.cooldown) has passed since it last addressed it, and the
 * engine's store never evicts a relationship addressed within W; so every act of the last W
 * seconds is counted in the `turns` of a relationship it holds. It speaks only while those turns
 * sum to less than ⌊perDay / ⌈day / W⌉⌋, so any W seconds hold at most that many acts and any day,
 * which ⌈day / W⌉ windows cover, at most `speech.perDay`. Per pair, an act continues the
 * conversation only within `speech.gap` and below `speech.turns`, so `talk_quota` never refuses
 * one; the hearer is perceived within `speech.range` and not asleep, a tell names a belief the mind
 * holds, and an ask names its species' food, so no other check refuses one either.
 */
import { type beings, type DeepReadonly, floorDiv, type mind } from "@open-origin/engine";
import { felt, greatest } from "../curves.ts";
import { chebyshev, cueAt } from "./cells.ts";
import type { BrainLaws } from "./laws.ts";
import { SEEN_CR, SPEAK_WILL, TELL_FLOOR } from "./parameters.ts";
import { memoryHalfLife, retrieve } from "./retrieval.ts";
import { foodClaim } from "./rules.ts";

type Senses2 = DeepReadonly<beings.Senses2>;
type Relation = Senses2["mind"]["relations"][number];

/** The laws of speech the talk window reads. */
type Pauses = { readonly speech: { readonly gap: number; readonly cooldown: number } };

/** The talk window W: the seconds after an act during which the store keeps the relationship. */
export function talkWindow(laws: Pauses): number {
  return greatest(laws.speech.gap + 1, laws.speech.cooldown);
}

/** The acts a being may say in any talk window: ⌊perDay / ⌈day / W⌉⌋. */
export function speechBudget(
  laws: { readonly speech: Pauses["speech"] & { readonly perDay: number } },
  dayLength: number,
): number {
  const window = talkWindow(laws);
  return floorDiv(laws.speech.perDay, floorDiv(dayLength + window - 1, window));
}

/** Whether the acts of the last talk window, counted in its relationships, leave room for one. */
export function canSpeak(senses: Senses2, laws: BrainLaws): boolean {
  const window = talkWindow(laws);
  let said = 0;
  for (const { talk, turns } of senses.mind.relations)
    if (talk !== undefined && talk < window) said += turns;
  return said < speechBudget(laws, laws.dayLength);
}

/**
 * Whether the being may address the being of `relation` now: never addressed; within its
 * conversation, a pause of at most `speech.gap` and fewer than `speech.turns` acts; or a new
 * conversation, once the talk window has passed.
 */
function addressable(relation: Relation, laws: BrainLaws): boolean {
  const { talk, turns } = relation;
  if (talk === undefined) return true;
  if (talk <= laws.speech.gap) return turns < laws.speech.turns;
  return talk >= talkWindow(laws);
}

/** Whether a draw of the decision falls below the being's will to speak. */
export function willing(senses: Senses2): boolean {
  const draw = (senses.draws[1] ?? 0) % 1000;
  return draw < felt(SPEAK_WILL, senses.self.traits.sociability);
}

/** An act the being proposes: its step, its hearer's index among the perceived, a told belief. */
export type Speaking = {
  readonly step: beings.TalkStep;
  readonly hearer: number;
  readonly keep?: number;
};

/** A being the decision perceives, with its index and the relationship the mind holds with it. */
type Hearer = {
  readonly index: number;
  readonly being: Senses2["perceived"]["beings"][number];
  readonly relation: Relation;
};

/** The being `who` as a hearer: perceived awake within reach of speech, with a relationship. */
function hearerOf(senses: Senses2, laws: BrainLaws, who: number): Hearer | undefined {
  const index = senses.perceived.beings.findIndex((being) => being.id === who);
  const being = senses.perceived.beings[index];
  const relation = senses.mind.relations.find((known) => known.who === who);
  if (being === undefined || relation === undefined || being.activity === "sleep") return undefined;
  if (chebyshev(being.cell, senses.self.cell) > laws.speech.range) return undefined;
  return { index, being, relation };
}

/** The beliefs a being may tell `hearer`: food it believes at TELL_FLOOR or more, not from it. */
function tellable(
  senses: Senses2,
  belief: Senses2["mind"]["beliefs"][number],
  hearer: number,
): { readonly v: number } | undefined {
  const claim = foodClaim(belief.p);
  if (claim === undefined || claim.v === 0 || belief.cr < TELL_FLOOR || belief.who === hearer)
    return undefined;
  // A belief the window would check, contradicted or doubted, is checked rather than told.
  const cue = cueAt(senses.window, claim.cell);
  const checked = cue !== undefined && (cue !== claim.v || belief.cr < SEEN_CR);
  return checked ? undefined : claim;
}

/**
 * The belief to tell `hearer`, by retrieval among those it may tell, the higher band the more
 * relevant.
 */
function toTell(senses: Senses2, laws: BrainLaws, hearer: number): number | undefined {
  const halfLife = memoryHalfLife(laws, senses.self.traits.retention);
  const told = retrieve(
    senses.mind.beliefs,
    (belief) => {
      const claim = tellable(senses, belief, hearer);
      if (claim === undefined) return undefined;
      return { id: belief.id, age: belief.u, importance: belief.cr, relevance: 500 * claim.v };
    },
    halfLife,
  );
  return told?.id;
}

/** A talk to `hearer`: an act, and what it is about. */
function talking(hearer: Hearer, act: mind.Act, about?: number | string): Speaking {
  const step: beings.TalkStep = { kind: "talk", to: hearer.being.id, act };
  if (about === undefined) return { step, hearer: hearer.index };
  const speaking = { step: { ...step, about }, hearer: hearer.index };
  return typeof about === "number" ? { ...speaking, keep: about } : speaking;
}

/** A tell of the food it believes most to `hearer`, if it believes any. */
function telling(senses: Senses2, laws: BrainLaws, hearer: Hearer): Speaking | undefined {
  const belief = toTell(senses, laws, hearer.being.id);
  return belief === undefined ? undefined : talking(hearer, "tell", belief);
}

/**
 * Whether an act of `hearer`'s opens a conversation for the being: it never addressed `hearer`, or
 * not within the pause that continues a conversation.
 */
function opens(hearer: Hearer, laws: BrainLaws): boolean {
  const { talk } = hearer.relation;
  return talk === undefined || talk > laws.speech.gap;
}

/**
 * Whether the being tells food in reply to the act `act` of `hearer`, as it wills: a greet that
 * answers its own, or a tell while it has said at most one act of the conversation.
 */
function tellsBack(senses: Senses2, laws: BrainLaws, hearer: Hearer, act: mind.Act): boolean {
  const told = act === "tell" && (opens(hearer, laws) || hearer.relation.turns < 2);
  return (act === "greet" || told) && willing(senses);
}

/**
 * The answer to the act `act` of `hearer`, if the being answers it: an ask with food or "I do not
 * know"; a greet that opens a conversation with a greet; and its own greet answered, or a tell
 * while it has said at most one act of the conversation, with food, as it wills.
 */
function answer(
  senses: Senses2,
  laws: BrainLaws,
  hearer: Hearer,
  act: mind.Act,
): Speaking | undefined {
  if (act === "ask") return telling(senses, laws, hearer) ?? talking(hearer, "unknown");
  if (act === "greet" && opens(hearer, laws)) return talking(hearer, "greet");
  return tellsBack(senses, laws, hearer, act) ? telling(senses, laws, hearer) : undefined;
}

/** A reply to the first message it answers, in the order heard, from a being it may address. */
export function reply(senses: Senses2, laws: BrainLaws): Speaking | undefined {
  for (const message of senses.perceived.heard) {
    if (message.who === undefined) continue;
    const hearer = hearerOf(senses, laws, message.who);
    if (hearer === undefined || !addressable(hearer.relation, laws)) continue;
    const answered = answer(senses, laws, hearer, message.act);
    if (answered !== undefined) return answered;
  }
  return undefined;
}

/** The nearest being it perceives that it may address, and whose relationship `fits`. */
function nearest(
  senses: Senses2,
  laws: BrainLaws,
  fits: (relation: Relation) => boolean,
): Hearer | undefined {
  for (const being of senses.perceived.beings) {
    const hearer = hearerOf(senses, laws, being.id);
    if (hearer !== undefined && addressable(hearer.relation, laws) && fits(hearer.relation))
      return hearer;
  }
  return undefined;
}

/** An ask for food, to the nearest being it may address. */
export function asking(senses: Senses2, laws: BrainLaws): Speaking | undefined {
  const hearer = nearest(senses, laws, () => true);
  return hearer === undefined ? undefined : talking(hearer, "ask", laws.food);
}

/** Whether `relation` is a being met anew: never addressed, or not within the talk window. */
export function metAnew(relation: Relation, laws: Pauses): boolean {
  return relation.talk === undefined || relation.talk >= talkWindow(laws);
}

/** A greet of the nearest being it meets or meets again. */
export function greeting(senses: Senses2, laws: BrainLaws): Speaking | undefined {
  const hearer = nearest(senses, laws, (relation) => metAnew(relation, laws));
  return hearer === undefined ? undefined : talking(hearer, "greet");
}
