/**
 * The judgment of a decision in the second phase (ADR 0023, ADR 0024): the senses the being's brain
 * decides on, fresh copies that share nothing with the world, and the engine's judgment of what it
 * proposes. Under beings@2 a decision first perceives the beings in sight, then applies step 1, a
 * law: it forgets what has faded by now, updates familiarity and creates relationships, and
 * consumes the inbox; the senses add the beings it perceives, the messages it hears, and the view
 * of its mind after that step; the mental operations of an accepted intention apply (mental.ts),
 * atomic with the rest of it; and a talk is judged last, against the mind they leave (speech.ts).
 * The new mind and the decision's ledger are left in the Work, which the third phase writes.
 */
import { copyCanonical } from "../canonical/copy.ts";
import { type Mind, type MindContext, viewOf } from "../mind/index.ts";
import { observableCatalog } from "../worldgen/index.ts";
import type { Work } from "./advance.ts";
import type { Traits2 } from "./being.ts";
import type { Brain } from "./capture.ts";
import { copySensed } from "./classes.ts";
import type { SensedWindow, Senses, Senses2 } from "./contracts.ts";
import { type BeingsEnv, integrity } from "./env.ts";
import { heardMessage } from "./hearing.ts";
import { type Accepted, acceptIntention, type Refused, type Talking } from "./intention.ts";
import type { Species2 } from "./life2.ts";
import { applyOperations, type Percepts, type StepOne, stepOne } from "./mental.ts";
import { type MindGrammar, NO_OPERATIONS } from "./operations.ts";
import { copyPerceived, type PerceivedBeing, perceiveBeings, sightOf } from "./perception.ts";
import { greatest } from "./rates.ts";
import {
  type CoveredChunk,
  copyWindow,
  type SenseInput,
  senseWindow,
  senseWindowAndChunks,
} from "./senses.ts";
import { type Speaking, speak } from "./speech.ts";

/** What sensing the window of the being at this tick needs. */
function senseInput(env: BeingsEnv, work: Work): SenseInput {
  return {
    prepared: env.prepared(),
    species: work.species,
    center: work.cell,
    view: env.view,
    nowSeconds: env.now,
    simSecondsPerTick: env.sps,
  };
}

/** The being as it senses itself at this tick: its record, with its body and activity now. */
function selfOf(work: Work) {
  return {
    id: work.old.id,
    species: work.species.id,
    cell: work.cell,
    needs: { nutrition: work.body.nutrition, rest: work.body.rest },
    health: work.body.health,
    condition: work.condition,
    traits: work.old.traits,
    activity: work.activity,
    behavior: work.behavior,
    outcome: work.outcome,
    cooldowns: work.cooldowns,
  };
}

/** What the being senses at a decision, and the window the engine keeps to judge the intention. */
type Sensed = { readonly window: SensedWindow; readonly senses: Senses | Senses2 };

/**
 * The senses of the being of beings@1 at this tick: fresh copies that share nothing with the
 * world, nor with the window, so that a brain that writes to its senses changes nothing the engine
 * judges by.
 */
function sensesOf(env: BeingsEnv, work: Work): Sensed {
  const window = senseWindow(senseInput(env, work));
  const self = copyCanonical(selfOf(work)) as Senses["self"];
  const senses = {
    self,
    light: env.light(),
    window: copyWindow(window),
    draws: env.draws(work.old.id),
  };
  return { window, senses };
}

/**
 * The context the mind layer works in for the being of `work` at this tick: a full store keeps the
 * relationship of a being it addressed within `max(speech.gap + 1, speech.cooldown)` seconds, which
 * holds the quotas of the pair.
 */
function mindContext(env: BeingsEnv, work: Work): MindContext {
  // validateGlobal accepted laws of life@2, and validateChunk the being's six traits.
  const species = work.species as Species2;
  const traits = work.old.traits as Traits2;
  const { gap, cooldown } = species.speech;
  return {
    moment: { tick: env.tick, secondsPerTick: env.sps },
    laws: { mind: species.mind, relations: species.relations },
    retention: traits.retention,
    // A pause of at most `gap` continues a conversation, and one of less than `cooldown` cools it.
    talkWindow: greatest(gap + 1, cooldown),
  };
}

/**
 * What the being of beings@2 perceives of the world at a decision: its window, the chunks it read,
 * and the beings.
 */
type Perceived = {
  readonly window: SensedWindow;
  readonly chunks: readonly CoveredChunk[];
  readonly beings: readonly PerceivedBeing[];
};

/**
 * The window of the being of beings@2 at this tick, the chunks that window read, and the beings it
 * perceives from them, the nearest its attention keeps, in that order.
 */
function perceivedBy(env: BeingsEnv, work: Work): Perceived {
  // validateGlobal accepted laws of life@2.
  const species = work.species as Species2;
  const { window, chunks } = senseWindowAndChunks(senseInput(env, work));
  const limits = {
    sight: sightOf(species.perception, env.light()),
    attention: species.perception.attention,
  };
  const beings = perceiveBeings(chunks, { id: work.old.id, cell: work.cell }, limits);
  return { window, chunks, beings };
}

/**
 * The senses of the being of beings@2 at this tick (mind.md, "Perception"), as fresh as those of
 * beings@1: `self` by the allowlist of classes.ts; copies of the beings it perceives; the messages
 * it hears, without their taints; and the view of its mind after step 1 at this tick. The engine
 * keeps its own percepts of the decision apart, which a brain that writes to its senses cannot
 * reach.
 */
function sensesOf2(
  env: BeingsEnv,
  work: Work,
  perceived: Perceived,
  step1: StepOne,
): Sensed & { readonly percepts: Percepts } {
  const { window, beings } = perceived;
  const senses: Senses2 = {
    self: copySensed(selfOf(work)) as Senses2["self"],
    light: env.light(),
    window: copyWindow(window),
    draws: env.draws(work.old.id),
    perceived: { beings: beings.map(copyPerceived), heard: step1.heard.map(heardMessage) },
    mind: viewOf(step1.mind, mindContext(env, work)),
  };
  const { cell, outcome } = work;
  const percepts: Percepts = {
    tick: env.tick,
    cell,
    outcome,
    beings,
    heard: step1.heard,
    window,
    activities: env.rules.activities,
  };
  return { window, senses, percepts };
}

/**
 * The grammar of the mental operations of the brain `brain` for the being of `work`: its species'
 * `mind.ops` and `relations.delta`, the brain's namespace of concepts, and the observables of the
 * world's catalog.
 */
function grammarOf(env: BeingsEnv, work: Work, brain: Brain): MindGrammar {
  // validateGlobal accepted laws of life@2, and the capture of beings@2 a namespace of concepts.
  const species = work.species as Species2;
  return {
    ops: species.mind.ops,
    delta: species.relations.delta,
    concepts: brain.concepts as string,
    observable: (id) => observableCatalog(env.prepared()).some((entry) => entry.id === id),
  };
}

/** The brain of beings@1 decides on its senses, and the engine judges what it proposed. */
export function judge(env: BeingsEnv, work: Work): Accepted | Refused {
  const { window, senses } = sensesOf(env, work);
  const brain = env.controller(work.species.id);
  const judged = acceptIntention(brain.decide(senses), {
    tick: env.tick,
    window,
    activities: env.rules.activities,
    behaviors: brain.behaviors,
  });
  // The kinds of activity of beings@1 are T4's, which no talk is among, so none is accepted.
  return judged.kind === "talk" ? { kind: "rejected", reason: "malformed" } : judged;
}

/** Where and when the being of `work` judges a talk at this tick, having perceived `beings`. */
function speakingOf(env: BeingsEnv, work: Work, beings: readonly PerceivedBeing[]): Speaking {
  return {
    cell: work.cell,
    tick: env.tick,
    seconds: env.now,
    secondsPerTick: env.sps,
    dayLength: env.dayLength,
    // validateGlobal accepted laws of life@2.
    species: work.species as Species2,
    perceived: beings,
  };
}

/**
 * The talk `judged` proposed, judged against `mind`, the mind its operations left: an accepted
 * intention that starts it, with that mind counting it, or the reason it is refused.
 */
function judgeTalk(
  env: BeingsEnv,
  work: Work,
  judged: Talking,
  decided: { readonly mind: Mind; readonly beings: readonly PerceivedBeing[] },
): Decided | Refused {
  const spoken = speak(judged.talk, decided.mind, speakingOf(env, work, decided.beings));
  if (typeof spoken === "string") return { kind: "rejected", reason: spoken };
  const { talk: _proposed, kind: _talking, ...rest } = judged;
  const accepted: Accepted = { ...rest, kind: "accepted", activity: spoken.activity, plan: [] };
  return { kind: "decided", accepted, mind: spoken.mind };
}

/** An accepted intention, and the mind the decision leaves. */
type Decided = { readonly kind: "decided"; readonly accepted: Accepted; readonly mind: Mind };

/**
 * A decision of beings@2 (mind.md, "Beliefs"): step 1 forgets what has faded by now, updates
 * familiarity with the beings perceived, creating relationships, and consumes the inbox, a law
 * that stays whatever the brain proposes; the brain decides on the view of that mind; and the
 * mental operations of an accepted intention apply, atomic with the rest of it, so that a failing
 * one rejects the whole intention. The new mind and the decision's ledger are left in `work`.
 */
export function judge2(env: BeingsEnv, work: Work): Accepted | Refused {
  // A being decides at most once a tick: a second decision would replace the first one's ledger.
  if (work.ledger !== undefined)
    throw integrity(`the being ${work.old.id} decided twice at the tick ${env.tick}`);
  const ctx = mindContext(env, work);
  const perceived = perceivedBy(env, work);
  // The chunks the window read: where the hearer of a talk that ended at this tick stands.
  work.covered = perceived.chunks;
  const met = perceived.beings.map((being) => being.id);
  // validateChunk accepted the mind of every being of beings@2.
  const step1 = stepOne(work.mind as Mind, met, ctx);
  work.mind = step1.mind;
  work.ledger = step1.ledger;
  const { window, senses, percepts } = sensesOf2(env, work, perceived, step1);
  const brain = env.controller(work.species.id);
  const judged = acceptIntention(brain.decide(senses), {
    tick: env.tick,
    window,
    activities: env.rules.activities,
    behaviors: brain.behaviors,
    mind: grammarOf(env, work, brain),
  });
  if (judged.kind === "rejected") return judged;
  const applied = applyOperations(step1, judged.mind ?? NO_OPERATIONS, percepts, ctx);
  if (applied.kind === "rejected") return applied;
  const talked: Decided | Refused =
    judged.kind === "talk"
      ? judgeTalk(env, work, judged, { mind: applied.mind, beings: perceived.beings })
      : { kind: "decided", accepted: judged, mind: applied.mind };
  if (talked.kind === "rejected") return talked;
  work.mind = talked.mind;
  work.ledger = applied.ledger;
  return talked.accepted;
}
