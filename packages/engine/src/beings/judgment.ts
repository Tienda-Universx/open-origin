/**
 * The judgment of a decision in the second phase (ADR 0023, ADR 0024): the senses the being's brain
 * decides on, fresh copies that share nothing with the world, and the engine's judgment of what it
 * proposes. Under beings@2 the senses add the beings the being perceives and the view of its mind.
 */
import { copyCanonical } from "../canonical/copy.ts";
import { type Mind, viewOf } from "../mind/index.ts";
import type { Work } from "./advance.ts";
import type { Traits2 } from "./being.ts";
import { copySensed } from "./classes.ts";
import type { SensedWindow, Senses, Senses2 } from "./contracts.ts";
import type { BeingsEnv } from "./env.ts";
import { type Accepted, acceptIntention, type Refused } from "./intention.ts";
import type { Species2 } from "./life2.ts";
import { perceiveBeings, sightOf } from "./perception.ts";
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

/**
 * The senses of the being of beings@2 at this tick (mind.md, "Perception"), as fresh as those of
 * beings@1: `self` by the allowlist of classes.ts; the beings it perceives, from the chunks its
 * window read; and the view of its mind at this tick. Nothing here writes the mind.
 */
function sensesOf2(env: BeingsEnv, work: Work): Sensed {
  // validateGlobal accepted laws of life@2, and validateChunk the being's six traits and mind.
  const species = work.species as Species2;
  const traits = work.old.traits as Traits2;
  const held = work.mind as Mind;
  const { window, chunks } = senseWindowAndChunks(senseInput(env, work));
  const light = env.light();
  const limits = {
    sight: sightOf(species.perception, light),
    attention: species.perception.attention,
  };
  const beings = perceiveBeings(chunks, { id: work.old.id, cell: work.cell }, limits);
  const moment = { tick: env.tick, secondsPerTick: env.sps };
  const laws = { mind: species.mind, relations: species.relations };
  const senses: Senses2 = {
    self: copySensed(selfOf(work)) as Senses2["self"],
    light,
    window: copyWindow(window),
    draws: env.draws(work.old.id),
    perceived: { beings, heard: [] },
    mind: viewOf(held, { moment, laws, retention: traits.retention }),
  };
  return { window, senses };
}

/** The brain decides on the being's senses at this tick, and the engine judges what it proposed. */
export function judge(env: BeingsEnv, work: Work): Accepted | Refused {
  const { window, senses } = env.rules.minds ? sensesOf2(env, work) : sensesOf(env, work);
  const brain = env.controller(work.species.id);
  return acceptIntention(brain.decide(senses), {
    tick: env.tick,
    window,
    activities: env.rules.activities,
    behaviors: brain.behaviors,
  });
}
