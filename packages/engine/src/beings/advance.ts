/**
 * The second phase of the beings system (ADR 0023): one being, due at this tick, brought to the
 * tick. Its body follows its rates in closed form; physiology may incapacitate it, kill it, or force
 * it to sleep; its activity advances; and when it is free, or a condition its brain asked for holds,
 * its brain decides from its senses and the engine judges the intention (judgment.ts), which under
 * beings@2 may change its mind; those changes are emitted last among the being's events of this
 * phase, but for the utterance of a talk that ended, which follows them. Forced sleep, incapacity,
 * and death cut a talk short; nothing else interrupts it, not even a wake condition or a message.
 * Nothing is written here: the result is a Work that the third phase resolves and applies.
 */
import { copyCanonical } from "../canonical/copy.ts";
import type { Mind } from "../mind/index.ts";
import type { ChunkKey } from "../world/chunk.ts";
import type { DeepReadonly } from "../world/contracts.ts";
import { arrivedSteps, bitesDue, idleEnd, talkEnd } from "./activity.ts";
import {
  type Activity,
  BEING_BOUNDS,
  type Behavior,
  type Being,
  type Being2,
  type Cell,
  type Cooldown,
  type CooldownRequest,
  MAX_TICK,
  type Outcome,
  type PlanStep,
  type WakeConditions,
} from "./being.ts";
import { type Body, bodyAt } from "./body.ts";
import { DIRECTIONS } from "./contracts.ts";
import type { BeingsEnv } from "./env.ts";
import { dayOfTick, type Hearing, hearingWakes, wokenBy } from "./hearing.ts";
import { judge, judge2 } from "./judgment.ts";
import type { Species } from "./laws.ts";
import type { Species2 } from "./life2.ts";
import { type MindLedger, mindChanged, mindProvenance } from "./mental.ts";
import { ceilDiv, least, NEED_MAX } from "./rates.ts";
import { type Talk, type Utterance, utteranceOf, utteredPayload } from "./speech.ts";

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
  /**
   * The mind of a being of beings@2 at the start of the tick, the very value its chunk holds,
   * which the engine reads and never writes.
   */
  readonly held: Mind | undefined;
  /**
   * The mind the tick writes: `held` itself, never copied at a wake, unless the being decided and
   * its mind changed, so that an unchanged mind is the same value in the record the tick writes.
   */
  mind: Mind | undefined;
  /** What the being's decision at this tick changed in its mind, for the ledger. */
  ledger: MindLedger | undefined;
  /** What the being said, when a talk of its ended at this tick without being cut short. */
  spoken: Utterance | undefined;
};

/** The members of `being` but its mind, which a wake never copies. */
function withoutMind(being: Being2): object {
  const { mind: _shared, ...body } = being;
  return body;
}

/** A fresh, detached working copy of `being` at `env.tick`; a mind stays the state's value. */
function workOf(env: BeingsEnv, from: ChunkKey, being: DeepReadonly<Being>): Work {
  const species = env.species(being.species);
  // validateChunk accepted every being of beings@2 with its mind, which no one writes.
  const mindful = env.rules.minds ? (being as unknown as Being2) : undefined;
  const plain = copyCanonical(mindful === undefined ? being : withoutMind(mindful)) as Being;
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
    held: mindful?.mind,
    mind: mindful?.mind,
    ledger: undefined,
    spoken: undefined,
  };
}

/** Ends the current activity with `result`, idling until the brain decides. */
function finish(env: BeingsEnv, work: Work, result: string, reason = ""): void {
  env.emit("being.finished", { id: work.old.id, activity: work.activity.kind, result, reason });
  // A meal ended here took only whole bites: a short one ends it in the third phase instead.
  const eaten =
    work.activity.kind === "eat" ? work.activity.bites * work.species.diet.biteUnits : 0;
  work.outcome = outcomeOf(env, work, { result, tick: env.tick, reason }, eaten);
  work.activity = { kind: "idle", start: env.tick, ms: 1 };
}

/**
 * `outcome`, the end of the current activity of `work`; under beings@2, the end of a meal also
 * holds `eaten`, the units it ate in total (mind.md, "Perception": the being's own experience).
 */
export function outcomeOf(env: BeingsEnv, work: Work, outcome: Outcome, eaten: number): Outcome {
  return env.rules.minds && work.activity.kind === "eat" ? { ...outcome, units: eaten } : outcome;
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
  const { kind } = work.activity;
  if (kind === "walk" || kind === "talk") interrupt(env, work, "incapacitated");
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

/** Whether a wake condition the brain asked for holds at this tick; none interrupts a talk. */
function wakeConditionHolds(env: BeingsEnv, work: Work): boolean {
  if (work.activity.kind === "sleep" && work.activity.forced) return false;
  if (work.activity.kind === "talk") return false;
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
  if (activity.kind === "talk") return talkEnd(activity, actMsOf(work), env.sps) <= env.tick;
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
  // Preconditions are checked when a step starts: failing one is no refusal of the intention.
  if (step.kind === "walk" && work.condition === "incapacitated")
    return fail(env, work, "incapacitated");
  if (step.kind === "eat" && env.foodAt(work.cell, work.species) <= 0)
    return fail(env, work, "no_food");
  if (step.kind === "walk")
    begin(env, work, {
      kind: "walk",
      start: env.tick,
      dirs: step.dirs,
      ms: [...arrivals],
      done: 0,
    });
  else if (step.kind === "eat")
    begin(env, work, {
      kind: "eat",
      start: env.tick,
      untilNutrition: step.untilNutrition,
      bites: 0,
    });
  else if (step.kind === "sleep")
    begin(env, work, { kind: "sleep", untilRest: step.untilRest, forced: false });
  else begin(env, work, { kind: "idle", start: env.tick, ms: step.ms });
  return true;
}

/** Starts `activity` at this tick. */
function begin(env: BeingsEnv, work: Work, activity: Activity): void {
  work.activity = activity;
  env.emit("being.started", { id: work.old.id, activity: activity.kind });
}

/** How long an act of speech of the being of `work` lasts, in milliseconds. */
function actMsOf(work: Work): number {
  // Only a being of beings@2 talks, and validateGlobal accepted laws of life@2 for it.
  return (work.species as Species2).speech.actMs;
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

/** The cooldowns that still hold at this tick: those whose tick has not come yet. */
function activeCooldowns(env: BeingsEnv, cooldowns: readonly Cooldown[]): Cooldown[] {
  return cooldowns.filter((cooldown) => cooldown.until > env.tick);
}

/**
 * `kept` with the cooldowns a brain added, in order: each ends ⌈ms / (simSecondsPerTick·1000)⌉
 * ticks after this one, replaces an earlier cooldown on its cell, and the newest four are kept.
 */
function addCooldowns(
  env: BeingsEnv,
  kept: readonly Cooldown[],
  added: readonly CooldownRequest[],
): Cooldown[] {
  let cooldowns = [...kept];
  for (const { cell, ms } of added) {
    cooldowns = cooldowns.filter((old) => old.cell[0] !== cell[0] || old.cell[1] !== cell[1]);
    const until = least(env.tick + ceilDiv(ms, env.sps * 1000), MAX_TICK);
    cooldowns.push({ cell: [cell[0], cell[1]], until });
  }
  const most = BEING_BOUNDS.cooldowns.max;
  return cooldowns.length > most ? cooldowns.slice(cooldowns.length - most) : cooldowns;
}

/**
 * Asks the being's brain, judges what it proposes, and starts the accepted first step. Cooldowns
 * whose tick has come are dropped before the brain senses them, since it does not sense the tick.
 */
function decide(env: BeingsEnv, work: Work): void {
  work.cooldowns = activeCooldowns(env, work.cooldowns);
  const judged = env.rules.minds ? judge2(env, work) : judge(env, work);
  if (judged.kind === "rejected") {
    refuse(env, work, judged.reason);
    return;
  }
  // The brain does not sense the tick: the engine stamps when a behavior of a new kind began.
  const kept = judged.behavior.kind === work.behavior.kind;
  work.behavior = { ...judged.behavior, since: kept ? work.behavior.since : env.tick };
  work.wakeWhen = pending(env, work, judged.wakeWhen);
  if (judged.cooldowns !== undefined)
    work.cooldowns = addCooldowns(env, work.cooldowns, judged.cooldowns);
  if (judged.activity.kind === "talk") {
    // A talk is the only step of its intention, and starts with no precondition.
    work.plan = [];
    begin(env, work, judged.activity);
    return;
  }
  const [first, ...rest] = [stepOf(judged.activity), ...judged.plan];
  work.plan = rest;
  if (first !== undefined)
    start(env, work, first, judged.activity.kind === "walk" ? judged.activity.ms : []);
}

/** The planned step an accepted activity other than a talk came from. */
function stepOf(activity: Exclude<Activity, Talk>): PlanStep {
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
  // A forced sleep that began now leaves nothing else to do at this tick.
  if (!work.died && (work.activity.kind !== "sleep" || before === "sleep")) carryOn(env, work);
  emitMind(env, work);
  if (work.spoken !== undefined)
    env.emit("speech.uttered", utteredPayload(work.old.id, work.spoken));
  return work;
}

/**
 * Emits the ledger of the being's decision at this tick when it changed the mind, after the
 * being's other events of this phase: `mind.changed`, then `mind.provenance`.
 */
function emitMind(env: BeingsEnv, work: Work): void {
  const { ledger, mind } = work;
  if (ledger === undefined || mind === undefined || mind === work.held) return;
  env.emit("mind.changed", mindChanged(work.old.id, ledger));
  env.emit("mind.provenance", mindProvenance(work.old.id, ledger, mind));
}

/**
 * What decides whether messages that reached the inbox of the being of `work` at the tick `at` wake
 * it (hearing.ts): the day of that tick, the delivery's, and its species' `speech.wakesPerDay`.
 */
export function hearingOf(env: BeingsEnv, work: Work, at: number): Hearing {
  // validateGlobal accepted laws of life@2 for a world whose beings hold minds.
  const { speech } = work.species as Species2;
  return { at, day: dayOfTick(at, env.sps, env.dayLength), wakesPerDay: speech.wakesPerDay };
}

/**
 * Whether hearing wakes the being of beings@2 at this tick: it is idle, and messages that reached
 * its inbox at the previous tick wake it (hearing.ts). Under beings@1, never.
 */
function heardNow(env: BeingsEnv, work: Work): boolean {
  if (!env.rules.minds || work.mind === undefined) return false;
  return hearingWakes(work.mind, work.activity, hearingOf(env, work, env.tick - 1));
}

/**
 * Advances the activity, then asks the brain when the activity ended with nothing planned, or when
 * a wake condition holds or hearing woke the idle being, even at the tick the activity ends; the
 * brain's intention replaces the plan. A condition that interrupts a meal drops the bite due at
 * this tick.
 */
function carryOn(env: BeingsEnv, work: Work): void {
  // Read before the activity advances: hearing wakes only a being that was idle.
  const heard = heardNow(env, work);
  const ended = progress(env, work);
  if (ended) end(env, work);
  const woken = wakeConditionHolds(env, work);
  const wakes = woken || heard;
  if (wakes && !ended) {
    work.claim = undefined;
    finish(env, work, "interrupted", woken ? "wake_condition" : "heard");
    // Hearing woke the being: the wake counts in the day of the delivery, at the previous tick.
    if (!woken) work.mind = wokenBy(work.mind as Mind, hearingOf(env, work, env.tick - 1));
  }
  if (wakes) decide(env, work);
  else if (ended) next(env, work);
}

/**
 * Ends the activity that reached its end at this tick; an idle has nothing to end. A talk says what
 * it captured first; the being then decides, as at the end of any activity.
 */
function end(env: BeingsEnv, work: Work): void {
  if (work.activity.kind === "talk") work.spoken = utteranceOf(work.activity, work.cell);
  if (work.activity.kind !== "idle") finish(env, work, "done");
}
