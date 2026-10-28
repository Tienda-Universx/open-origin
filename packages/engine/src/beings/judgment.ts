/**
 * The judgment of a decision in the second phase (ADR 0023, ADR 0024): the senses the being's brain
 * decides on, fresh copies that share nothing with the world, and the engine's judgment of what it
 * proposes. Under beings@2 a decision first forgets what has faded by now, a law; the senses add
 * the beings the being perceives and the view of its mind after that step; and the mental
 * operations of an accepted intention apply (mental.ts), atomic with the rest of it. The new mind
 * and the decision's ledger are left in the Work, which the third phase writes.
 */
import { copyCanonical } from "../canonical/copy.ts";
import { type Mind, type MindContext, viewOf } from "../mind/index.ts";
import { observableCatalog } from "../worldgen/index.ts";
import type { Work } from "./advance.ts";
import type { Traits2 } from "./being.ts";
import type { Brain } from "./capture.ts";
import { copySensed } from "./classes.ts";
import type { SensedWindow, Senses, Senses2 } from "./contracts.ts";
import type { BeingsEnv } from "./env.ts";
import { type Accepted, acceptIntention, type Refused } from "./intention.ts";
import type { Species2 } from "./life2.ts";
import { applyOperations, forgetAtDecision, type Percepts } from "./mental.ts";
import { type MindGrammar, NO_OPERATIONS } from "./operations.ts";
import { copyPerceived, perceiveBeings, sightOf } from "./perception.ts";
import { copyWindow, type SenseInput, senseWindow, senseWindowAndChunks } from "./senses.ts";

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

/** The context the mind layer works in for the being of `work` at this tick. */
function mindContext(env: BeingsEnv, work: Work): MindContext {
  // validateGlobal accepted laws of life@2, and validateChunk the being's six traits.
  const species = work.species as Species2;
  const traits = work.old.traits as Traits2;
  return {
    moment: { tick: env.tick, secondsPerTick: env.sps },
    laws: { mind: species.mind, relations: species.relations },
    retention: traits.retention,
  };
}

/**
 * The senses of the being of beings@2 at this tick (mind.md, "Perception"), as fresh as those of
 * beings@1: `self` by the allowlist of classes.ts; copies of the beings it perceives, from the
 * chunks its window read; and the view of `mind` at this tick. The engine keeps its own percepts
 * of the decision apart, which a brain that writes to its senses cannot reach.
 */
function sensesOf2(
  env: BeingsEnv,
  work: Work,
  mind: Mind,
  ctx: MindContext,
): Sensed & { readonly percepts: Percepts } {
  // validateGlobal accepted laws of life@2.
  const species = work.species as Species2;
  const { window, chunks } = senseWindowAndChunks(senseInput(env, work));
  const light = env.light();
  const limits = {
    sight: sightOf(species.perception, light),
    attention: species.perception.attention,
  };
  const beings = perceiveBeings(chunks, { id: work.old.id, cell: work.cell }, limits);
  const senses: Senses2 = {
    self: copySensed(selfOf(work)) as Senses2["self"],
    light,
    window: copyWindow(window),
    draws: env.draws(work.old.id),
    perceived: { beings: beings.map(copyPerceived), heard: [] },
    mind: viewOf(mind, ctx),
  };
  const { cell, outcome } = work;
  const percepts: Percepts = {
    tick: env.tick,
    cell,
    outcome,
    beings,
    window,
    activities: env.rules.activities,
  };
  return { window, senses, percepts };
}

/**
 * The grammar of the mental operations of the brain `brain` for the being of `work`: its species'
 * `mind.ops`, the brain's namespace of concepts, and the observables of the world's catalog.
 */
function grammarOf(env: BeingsEnv, work: Work, brain: Brain): MindGrammar {
  // validateGlobal accepted laws of life@2, and the capture of beings@2 a namespace of concepts.
  const species = work.species as Species2;
  return {
    ops: species.mind.ops,
    concepts: brain.concepts as string,
    observable: (id) => observableCatalog(env.prepared()).some((entry) => entry.id === id),
  };
}

/** The brain of beings@1 decides on its senses, and the engine judges what it proposed. */
export function judge(env: BeingsEnv, work: Work): Accepted | Refused {
  const { window, senses } = sensesOf(env, work);
  const brain = env.controller(work.species.id);
  return acceptIntention(brain.decide(senses), {
    tick: env.tick,
    window,
    activities: env.rules.activities,
    behaviors: brain.behaviors,
  });
}

/**
 * A decision of beings@2 (mind.md, "Beliefs"): step 1 forgets what has faded by now, a law that
 * stays whatever the brain proposes; the brain decides on the view of that mind; and the mental
 * operations of an accepted intention apply, atomic with the rest of it, so that a failing one
 * rejects the whole intention. The new mind and the decision's ledger are left in `work`.
 */
export function judge2(env: BeingsEnv, work: Work): Accepted | Refused {
  const ctx = mindContext(env, work);
  // validateChunk accepted the mind of every being of beings@2.
  const step1 = forgetAtDecision(work.mind as Mind, ctx);
  work.mind = step1.mind;
  work.ledger = step1.ledger;
  const { window, senses, percepts } = sensesOf2(env, work, step1.mind, ctx);
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
  work.mind = applied.mind;
  work.ledger = applied.ledger;
  return judged;
}
