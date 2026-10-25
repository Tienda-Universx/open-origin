/**
 * The second phase of the beings system (ADR 0023): one being, due at this tick, brought to the
 * tick. Its body follows its rates in closed form; physiology may incapacitate it, kill it, or force
 * it to sleep; its activity advances; and when it is free, or a condition its brain asked for holds,
 * its brain decides from its senses and the engine judges the intention. Nothing is written here:
 * the result is a Work that the third phase resolves and applies.
 */
import { copyCanonical } from "../canonical/copy.ts";
import type { ChunkKey } from "../world/chunk.ts";
import type { DeepReadonly } from "../world/contracts.ts";
import { arrivedSteps, bitesDue, idleEnd } from "./activity.ts";
import type {
  Activity,
  Behavior,
  Being,
  Cell,
  Cooldown,
  Outcome,
  PlanStep,
  WakeConditions,
} from "./being.ts";
import { type Body, bodyAt } from "./body.ts";
import { DIRECTIONS, type SensedWindow, type Senses } from "./contracts.ts";
import type { BeingsEnv } from "./env.ts";
import { acceptIntention } from "./intention.ts";
import type { Species } from "./laws.ts";
import { NEED_MAX } from "./rates.ts";
import { senseWindow } from "./senses.ts";

/** How long a being idles after its brain proposed something the engine refused, in ms. */
export const REFUSED_IDLE_MS = 60_000;

/** Units a being claims from the food of its cell at this tick, for the bites that fell due. */
export type Claim = {
  readonly chunk: ChunkKey;
  readonly cell: number;
  readonly units: number;
  readonly bites: number;
};

/** A being being processed: what it was, and what it becomes this tick. */
export type Work = {
  readonly from: ChunkKey;
  readonly old: DeepReadonly<Being>;
  readonly species: Species;
  cell: Cell;
  condition: Being["condition"];
  activity: Activity;
  plan: readonly PlanStep[];
  behavior: Behavior;
  wakeWhen: WakeConditions;
  outcome: Outcome;
  cooldowns: readonly Cooldown[];
  /** The body at this tick; it moves again only when the third phase grants food. */
  body: Body;
  /** Whether the body jumped (a bite), so that it must be anchored at this tick. */
  jumped: boolean;
  claim: Claim | undefined;
  died: boolean;
};

/** A fresh, detached working copy of `being` at `env.tick`. */
function workOf(env: BeingsEnv, from: ChunkKey, being: DeepReadonly<Being>): Work {
  const species = env.species(being.species);
  const plain = copyCanonical(being) as Being;
  const body = bodyAt(species, plain, env.tick, env.sps);
  return {
    from,
    old: being,
    species,
    cell: plain.cell,
    condition: plain.condition,
    activity: plain.activity,
    plan: plain.plan,
    behavior: plain.behavior,
    wakeWhen: plain.wakeWhen,
    outcome: plain.outcome,
    cooldowns: plain.cooldowns,
    body,
    jumped: false,
    claim: undefined,
    died: false,
  };
}

/** Ends the current activity with `result`, idling until the brain decides. */
function finish(env: BeingsEnv, work: Work, result: string, reason = ""): void {
  env.emit("being.finished", { id: work.old.id, activity: work.activity.kind, result, reason });
  work.outcome = { result, tick: env.tick, reason };
  work.activity = { kind: "idle", start: env.tick, ms: 1 };
}

/** Ends the current activity because of `reason`; a walk whose last step arrived is done. */
function interrupt(env: BeingsEnv, work: Work, reason: string): void {
  const activity = work.activity;
  const arrived = activity.kind === "walk" && activity.done === activity.dirs.length;
  finish(env, work, arrived ? "done" : "interrupted", arrived ? "" : reason);
}

/** Applies physiology at this tick: incapacity or death at health 0, recovery, and forced sleep. */
function physiology(env: BeingsEnv, work: Work): void {
  condition(env, work);
  if (work.died || work.body.rest > 0 || work.activity.kind === "sleep") return;
  env.emit("being.exhausted", { id: work.old.id });
  interrupt(env, work, "exhausted");
  work.activity = { kind: "sleep", untilRest: NEED_MAX, forced: true };
  work.plan = [];
  work.wakeWhen = {};
  env.emit("being.started", { id: work.old.id, activity: "sleep" });
}

/** Incapacity or death at health 0, and recovery once health passes `recoverAbove`. */
function condition(env: BeingsEnv, work: Work): void {
  const { body, species } = work;
  if (work.condition === "incapacitated" && body.health > species.health.recoverAbove) {
    work.condition = "ok";
    env.emit("being.recovered", { id: work.old.id });
    return;
  }
  if (body.health > 0 || work.condition !== "ok") return;
  if (env.deathEnabled) {
    work.died = true;
    env.emit("being.died", { id: work.old.id, cell: [...work.cell] });
    return;
  }
  work.condition = "incapacitated";
  env.emit("being.incapacitated", { id: work.old.id });
  if (work.activity.kind === "walk") interrupt(env, work, "incapacitated");
}

/** Moves the being along the steps of its walk that arrived by this tick; true when it ended. */
function walk(env: BeingsEnv, work: Work, activity: Extract<Activity, { kind: "walk" }>): boolean {
  const arrived = arrivedSteps(activity, env.tick, env.sps);
  let [x, y] = work.cell;
  for (let step = activity.done; step < arrived; step += 1) {
    const [dx, dy] = DIRECTIONS[activity.dirs.charCodeAt(step) - 48] as readonly [number, number];
    x += dx;
    y += dy;
  }
  work.cell = [x, y];
  work.activity = { ...activity, done: arrived };
  return arrived === activity.dirs.length;
}

/** Whether a wake condition the brain asked for holds at this tick. */
function wakeConditionHolds(env: BeingsEnv, work: Work): boolean {
  if (work.activity.kind === "sleep" && work.activity.forced) return false;
  const { nutritionBelow, restBelow } = work.wakeWhen;
  if (nutritionBelow !== undefined && work.body.nutrition <= nutritionBelow) return true;
  if (restBelow !== undefined && work.body.rest <= restBelow) return true;
  return lightConditionHolds(env, work.wakeWhen);
}

/** Whether the light reached a threshold of `conditions`; the light is read only if one is set. */
function lightConditionHolds(env: BeingsEnv, conditions: WakeConditions): boolean {
  const { lightBelow, lightAbove } = conditions;
  if (lightBelow === undefined && lightAbove === undefined) return false;
  const light = env.light();
  if (lightBelow !== undefined && light <= lightBelow) return true;
  return lightAbove !== undefined && light >= lightAbove;
}

/**
 * Advances the activity to this tick: steps arrive, bites fall due as a claim on the cell's food,
 * sleep and rest end. True when the activity ended and the being is free.
 */
function progress(env: BeingsEnv, work: Work): boolean {
  const activity = work.activity;
  if (activity.kind === "walk") return walk(env, work, activity);
  if (activity.kind === "idle") return idleEnd(activity, env.sps) <= env.tick;
  if (activity.kind === "sleep") return work.body.rest >= activity.untilRest;
  const due = bitesDue(activity, env.tick, {
    simSecondsPerTick: env.sps,
    biteMs: work.species.diet.biteMs,
  });
  const pending = due - activity.bites;
  if (pending > 0) {
    const { chunk, cell } = env.place(work.cell);
    work.claim = { chunk, cell, units: pending * work.species.diet.biteUnits, bites: pending };
  }
  return false;
}

/** Starts `step` at this tick, if its preconditions hold; otherwise the being stays free. */
function start(env: BeingsEnv, work: Work, step: PlanStep, arrivals: readonly number[]): boolean {
  if (step.kind === "walk" && work.condition === "incapacitated")
    return refuse(env, work, "incapacitated");
  if (step.kind === "eat" && env.foodAt(work.cell, work.species) <= 0)
    return fail(env, work, "no_food");
  if (step.kind === "walk")
    work.activity = { kind: "walk", start: env.tick, dirs: step.dirs, ms: [...arrivals], done: 0 };
  else if (step.kind === "eat")
    work.activity = { kind: "eat", start: env.tick, untilNutrition: step.untilNutrition, bites: 0 };
  else if (step.kind === "sleep")
    work.activity = { kind: "sleep", untilRest: step.untilRest, forced: false };
  else work.activity = { kind: "idle", start: env.tick, ms: step.ms };
  env.emit("being.started", { id: work.old.id, activity: work.activity.kind });
  return true;
}

/** The step could not start: the being idles briefly and its outcome says why. */
function fail(env: BeingsEnv, work: Work, reason: string): boolean {
  work.outcome = { result: "failed", tick: env.tick, reason };
  work.activity = { kind: "idle", start: env.tick, ms: REFUSED_IDLE_MS };
  work.plan = [];
  return false;
}

/** The engine refused the intention: the being idles briefly and its outcome says why. */
function refuse(env: BeingsEnv, work: Work, reason: string): boolean {
  env.emit("being.intention_rejected", { id: work.old.id, reason });
  work.outcome = { result: "rejected", tick: env.tick, reason };
  work.activity = { kind: "idle", start: env.tick, ms: REFUSED_IDLE_MS };
  work.plan = [];
  work.wakeWhen = {};
  return false;
}

/** The window the being senses at this tick, which the engine keeps to judge the intention. */
function windowOf(env: BeingsEnv, work: Work): SensedWindow {
  return senseWindow({
    prepared: env.prepared(),
    species: work.species,
    center: work.cell,
    view: env.view,
    nowSeconds: env.now,
    simSecondsPerTick: env.sps,
  });
}

/**
 * The senses of the being at this tick: fresh copies that share nothing with the world, nor with
 * `window`, so that a brain that writes to its senses changes nothing the engine judges by.
 */
function sensesOf(env: BeingsEnv, work: Work, window: SensedWindow): Senses {
  const copy: SensedWindow = {
    origin: [window.origin[0], window.origin[1]],
    side: window.side,
    edgeMs: window.edgeMs.slice(),
    foodCue: window.foodCue.slice(),
  };
  const self = copyCanonical({
    id: work.old.id,
    species: work.species.id,
    cell: [...work.cell],
    needs: { nutrition: work.body.nutrition, rest: work.body.rest },
    health: work.body.health,
    condition: work.condition,
    traits: copyCanonical(work.old.traits),
    activity: copyCanonical(work.activity),
    behavior: copyCanonical(work.behavior),
    outcome: copyCanonical(work.outcome),
    cooldowns: copyCanonical(work.cooldowns),
  }) as Senses["self"];
  return { self, light: env.light(), window: copy, draws: env.draws(work.old.id) };
}

/** Drops the wake conditions that already hold, so that each can only fire on a transition. */
function pending(env: BeingsEnv, work: Work, conditions: WakeConditions): WakeConditions {
  const light = env.light();
  const kept: { [name: string]: number } = {};
  const { nutritionBelow, restBelow, lightBelow, lightAbove } = conditions;
  if (nutritionBelow !== undefined && work.body.nutrition > nutritionBelow)
    kept.nutritionBelow = nutritionBelow;
  if (restBelow !== undefined && work.body.rest > restBelow) kept.restBelow = restBelow;
  if (lightBelow !== undefined && light > lightBelow) kept.lightBelow = lightBelow;
  if (lightAbove !== undefined && light < lightAbove) kept.lightAbove = lightAbove;
  return kept;
}

/** Asks the being's brain, judges what it proposes, and starts the accepted first step. */
function decide(env: BeingsEnv, work: Work): void {
  const window = windowOf(env, work);
  const proposal = env.controller(work.species.id).decide(sensesOf(env, work, window));
  const judged = acceptIntention(proposal, { tick: env.tick, window });
  if (judged.kind === "rejected") {
    refuse(env, work, judged.reason);
    return;
  }
  // The brain does not sense the tick: the engine stamps when a behavior of a new kind began.
  const kept = judged.behavior.kind === work.behavior.kind;
  work.behavior = { ...judged.behavior, since: kept ? work.behavior.since : env.tick };
  work.wakeWhen = pending(env, work, judged.wakeWhen);
  const [first, ...rest] = [stepOf(judged.activity), ...judged.plan];
  work.plan = rest;
  if (first !== undefined)
    start(env, work, first, judged.activity.kind === "walk" ? judged.activity.ms : []);
}

/** The planned step an accepted activity came from. */
function stepOf(activity: Activity): PlanStep {
  if (activity.kind === "walk") return { kind: "walk", dirs: activity.dirs };
  if (activity.kind === "eat") return { kind: "eat", untilNutrition: activity.untilNutrition };
  if (activity.kind === "sleep") return { kind: "sleep", untilRest: activity.untilRest };
  return { kind: "idle", ms: activity.ms };
}

/** When the activity ended: the next planned step starts, or the brain decides. */
function next(env: BeingsEnv, work: Work): void {
  const [step, ...rest] = work.plan;
  if (step === undefined || step.kind === "walk") {
    decide(env, work);
    return;
  }
  work.plan = rest;
  if (!start(env, work, step, [])) decide(env, work);
}

/** Phase 2 for one due being: its Work at this tick, decisions included. */
export function advance(env: BeingsEnv, from: ChunkKey, being: DeepReadonly<Being>): Work {
  const work = workOf(env, from, being);
  // The steps due by this tick arrived before anything physiology does at it.
  if (work.activity.kind === "walk") walk(env, work, work.activity);
  const before = work.activity.kind;
  physiology(env, work);
  if (work.died) return work;
  const forced = work.activity.kind === "sleep" && before !== "sleep";
  const ended = !forced && progress(env, work);
  if (ended && work.activity.kind !== "idle") finish(env, work, "done");
  if (ended) next(env, work);
  else if (!forced && wakeConditionHolds(env, work)) {
    // The brain decides anew, which replaces the plan; a meal takes no bite at this tick.
    work.claim = undefined;
    finish(env, work, "interrupted", "wake_condition");
    decide(env, work);
  }
  return work;
}
