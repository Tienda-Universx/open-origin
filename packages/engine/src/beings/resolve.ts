/**
 * The third phase of the beings system (ADR 0023): contests over food, the anchor and the next wake
 * of every processed being, and the writes. Claimed cells are resolved in canonical order (chunk key
 * by UTF-16 code units, then cell index); when the food does not cover every claim, a permutation on
 * the stream `beings.contest`, keyed by the lowest claimant id, orders the claimants. Then each
 * being is written to the chunk of its cell, chunks get their due tick, the occupancy index gains the
 * chunks that received a being, and once per simulated day it loses those left empty.
 */
import { compareCodeUnits } from "../canonical/order.ts";
import { simSeconds, type Tick } from "../time/tick.ts";
import type { ChunkKey } from "../world/chunk.ts";
import { idleEnd, nextArrival, nextBite } from "./activity.ts";
import type { Work } from "./advance.ts";
import type { Being } from "./being.ts";
import {
  type Course,
  type Level,
  levelsOf,
  nextLevelTick,
  ratesOf,
  sameRates,
  storedBody,
} from "./body.ts";
import { type BeingsChunk, dueOf } from "./chunk.ts";
import { type BeingsEnv, CONTEST_STREAM, integrity } from "./env.ts";
import type { Depletion } from "./food.ts";
import { takenAt } from "./food.ts";
import { nextLightTick } from "./light.ts";
import { insertOccupied, pruneOccupancy } from "./occupancy.ts";
import { ceilDiv, least, NEED_MAX } from "./rates.ts";

/** Food taken from one cell at this tick. */
type Take = { readonly chunk: ChunkKey; readonly cell: number; readonly units: number };

/** The order of claims: by chunk key, then cell index, then being id. */
function byPlace(a: Work, b: Work): number {
  const [ca, cb] = [a.claim, b.claim];
  if (ca === undefined || cb === undefined) return 0;
  return compareCodeUnits(ca.chunk, cb.chunk) || ca.cell - cb.cell || a.old.id - b.old.id;
}

/** Grants `units` of food to `work`: nutrition, bites, and the end of a meal the cell cannot feed. */
function grant(env: BeingsEnv, work: Work, units: number, contested: boolean): void {
  const claim = work.claim;
  if (claim === undefined || work.activity.kind !== "eat") return;
  const nutrition = least(
    work.body.nutrition + units * work.species.diet.nutritionPerUnit,
    NEED_MAX,
  );
  work.body = { ...work.body, nutrition };
  // Only food moves the body; a bite that found nothing leaves it on its anchor.
  if (units > 0) work.jumped = true;
  work.activity = { ...work.activity, bites: work.activity.bites + claim.bites };
  if (units > 0) env.emit("being.ate", { id: work.old.id, units });
  if (contested)
    env.emit("being.contested", { id: work.old.id, claimed: claim.units, granted: units });
  const sated = work.body.nutrition >= work.activity.untilNutrition;
  if (units < claim.units || sated) {
    const result = mealResult(units, contested);
    env.emit("being.finished", {
      id: work.old.id,
      activity: "eat",
      result,
      reason: sated ? "" : "food_gone",
    });
    work.outcome = { result, tick: env.tick, reason: sated ? "" : "food_gone" };
    work.activity = { kind: "idle", start: env.tick, ms: 1 };
  }
}

/** How a meal that ends at this tick ends: it ate something, lost a contest, or found nothing left. */
function mealResult(units: number, contested: boolean): string {
  if (units > 0) return "done";
  return contested ? "lost" : "failed";
}

/** Resolves the claims on one cell, all of them by beings standing in it; returns what was taken. */
function contest(env: BeingsEnv, claimants: Work[]): Take | undefined {
  const [first] = claimants;
  if (first?.claim === undefined) return undefined;
  const available = env.foodAt(first.cell, first.species);
  const wanted = claimants.reduce((sum, work) => sum + (work.claim?.units ?? 0), 0);
  // A contest needs rivals: a being alone at a cell takes what there is, without a draw.
  const contested = claimants.length > 1 && wanted > available;
  // The claimants are sorted by id, so the first has the lowest one.
  const order = contested
    ? env.ctx.random
        .permutation(CONTEST_STREAM, first.old.id, claimants.length)
        .map((i) => claimants[i] as Work)
    : claimants;
  let left = available;
  for (const work of order) {
    const units = least(work.claim?.units ?? 0, left);
    left -= units;
    grant(env, work, units, contested);
  }
  return { chunk: first.claim.chunk, cell: first.claim.cell, units: available - left };
}

/** Resolves every claim of the tick in canonical order; returns the food taken, cell by cell. */
export function resolveClaims(env: BeingsEnv, works: readonly Work[]): Take[] {
  const claims = works.filter((work) => work.claim !== undefined).sort(byPlace);
  const takes: Take[] = [];
  for (let start = 0; start < claims.length; ) {
    let end = start + 1;
    while (end < claims.length && sameCell(claims[start] as Work, claims[end] as Work)) end += 1;
    const take = contest(env, claims.slice(start, end));
    if (take !== undefined && take.units > 0) takes.push(take);
    start = end;
  }
  return takes;
}

/** Whether two claims are on the same cell. */
function sameCell(a: Work, b: Work): boolean {
  return a.claim?.chunk === b.claim?.chunk && a.claim?.cell === b.claim?.cell;
}

/** The wake conditions and activity targets of `work`, as levels its body must not pass unseen. */
function extraLevels(work: Work): Level[] {
  const levels: Level[] = [];
  if (work.activity.kind === "sleep") levels.push({ of: "rest", at: work.activity.untilRest });
  if (work.activity.kind === "sleep" && work.activity.forced) return levels;
  if (work.wakeWhen.nutritionBelow !== undefined)
    levels.push({ of: "nutrition", at: work.wakeWhen.nutritionBelow });
  if (work.wakeWhen.restBelow !== undefined)
    levels.push({ of: "rest", at: work.wakeWhen.restBelow });
  return levels;
}

/** The tick at which the current activity of `work` next needs the being. */
function activityTick(env: BeingsEnv, work: Work): Tick | undefined {
  const activity = work.activity;
  if (activity.kind === "walk") return nextArrival(activity, env.sps);
  if (activity.kind === "eat")
    return nextBite(activity, { simSecondsPerTick: env.sps, biteMs: work.species.diet.biteMs });
  if (activity.kind === "idle") return idleEnd(activity, env.sps);
  return undefined;
}

/** The next ticks at which the light reaches the levels the brain asked for. */
function lightTicks(env: BeingsEnv, work: Work): (Tick | undefined)[] {
  if (work.activity.kind === "sleep" && work.activity.forced) return [];
  const { lightBelow, lightAbove } = work.wakeWhen;
  const clock = {
    prepared: env.prepared(),
    day: env.ctx.readGlobal().genesis.laws.day,
    simSecondsPerTick: env.sps,
  };
  const ticks: (Tick | undefined)[] = [];
  if (lightBelow !== undefined)
    ticks.push(nextLightTick(clock, env.tick, { threshold: lightBelow, direction: "below" }));
  if (lightAbove !== undefined)
    ticks.push(nextLightTick(clock, env.tick, { threshold: lightAbove, direction: "above" }));
  return ticks;
}

/**
 * The record of `work` after this tick: anchored at this tick when its body jumped or its rates
 * changed, and kept on its old anchor otherwise, so that its values never depend on how often it
 * was processed; with its next wake, at least the next tick and at most a day away.
 */
export function finalBeing(env: BeingsEnv, work: Work): Being {
  const old = work.old;
  const rates = ratesOf(work.species, work.activity.kind, work.body);
  const before = ratesOf(work.species, old.activity.kind, storedBody(old as Being));
  const anchorNow = work.jumped || !sameRates(rates, before);
  const anchored = anchorNow ? work.body : storedBody(old as Being);
  const anchor = anchorNow ? env.tick : old.anchor;
  const course: Course = { anchor, anchored, now: work.body, rates };
  const clock = { tick: env.tick, simSecondsPerTick: env.sps };
  const candidates = [
    nextLevelTick(course, levelsOf(work.species, extraLevels(work)), clock),
    activityTick(env, work),
    ...lightTicks(env, work),
    env.tick + ceilDiv(env.dayLength, env.sps),
  ];
  let wake = Number.MAX_SAFE_INTEGER;
  for (const candidate of candidates)
    if (candidate !== undefined && candidate < wake) wake = candidate;
  return {
    id: old.id,
    species: old.species,
    stage: old.stage,
    born: old.born,
    cell: work.cell,
    needs: { nutrition: anchored.nutrition, rest: anchored.rest },
    health: anchored.health,
    anchor,
    traits: { ...old.traits },
    condition: work.condition,
    activity: work.activity,
    plan: work.plan,
    behavior: work.behavior,
    wakeWhen: work.wakeWhen,
    wake: wake > env.tick ? wake : env.tick + 1,
    outcome: work.outcome,
    cooldowns: work.cooldowns,
  };
}

/** The live value of chunk `key`, created empty if it is not materialized yet. */
function liveChunk(env: BeingsEnv, key: ChunkKey): BeingsChunk {
  if (env.ctx.readChunk(key) === undefined)
    env.ctx.createChunk(key, { beings: [], depletion: [], due: Number.MAX_SAFE_INTEGER });
  return env.ctx.writeChunk(key);
}

/**
 * `entries` with what was taken at this tick added and re-anchored now, and the entries that fully
 * regrew dropped; untouched entries keep their anchor, so their regrowth never depends on when the
 * chunk was written.
 */
function deplete(
  env: BeingsEnv,
  entries: readonly Depletion[],
  takes: readonly Take[],
): Depletion[] {
  const result: Depletion[] = [];
  const cells = [...entries.map((entry) => entry.cell), ...takes.map((take) => take.cell)].sort(
    (a, b) => a - b,
  );
  let previous = -1;
  for (const cell of cells) {
    if (cell === previous) continue;
    previous = cell;
    const entry = entries.find((candidate) => candidate.cell === cell);
    const since = entry === undefined ? env.now : simSeconds(entry.since, env.sps);
    const missing = entry === undefined ? 0 : takenAt(entry, env.regrowth(), env.now - since);
    const taken =
      missing +
      takes.filter((take) => take.cell === cell).reduce((sum, take) => sum + take.units, 0);
    if (taken === 0) continue;
    const changed = takes.some((take) => take.cell === cell);
    result.push(changed || entry === undefined ? { cell, taken, since: env.tick } : entry);
  }
  return result;
}

/** The keys of every chunk this tick writes: where beings were, where they are, and where food went. */
function touched(
  works: readonly Work[],
  finals: readonly (Being | undefined)[],
  env: BeingsEnv,
  takes: readonly Take[],
): ChunkKey[] {
  const keys = [
    ...works.map((work) => work.from),
    ...finals.flatMap((being) => (being === undefined ? [] : [env.place(being.cell).chunk])),
    ...takes.map((take) => take.chunk),
  ].sort(compareCodeUnits);
  return keys.filter((key, index) => index === 0 || key !== keys[index - 1]);
}

/** Writes every processed being and every take, then the occupancy index. */
export function applyWorks(env: BeingsEnv, works: readonly Work[], takes: readonly Take[]): void {
  const finals = works.map((work) => (work.died ? undefined : finalBeing(env, work)));
  const leaving = works.map((work) => work.old.id);
  const arrived: ChunkKey[] = [];
  for (const key of touched(works, finals, env, takes)) {
    const chunk = liveChunk(env, key);
    const staying = chunk.beings.filter((being) => !leaving.includes(being.id));
    const coming = finals.filter(
      (being): being is Being => being !== undefined && env.place(being.cell).chunk === key,
    );
    chunk.beings = [...staying, ...coming].sort((a, b) => a.id - b.id);
    chunk.depletion = deplete(
      env,
      chunk.depletion,
      takes.filter((take) => take.chunk === key),
    );
    chunk.due = dueOf(chunk.beings);
    if (coming.length > 0) arrived.push(key);
  }
  updateOccupancy(env, arrived);
}

/** Adds the chunks that received a being to the occupancy index, and prunes it once a day. */
function updateOccupancy(env: BeingsEnv, arrived: readonly ChunkKey[]): void {
  const global = env.ctx.readGlobal();
  const missing = arrived.filter((key) => !global.occupancy.includes(key));
  const day = (env.now - (env.now % env.dayLength)) / env.dayLength;
  if (missing.length === 0 && day <= global.prunedDay) return;
  const writable = env.ctx.writeGlobal();
  for (const key of missing) insertOccupied(writable.occupancy, key);
  if (day > writable.prunedDay) {
    writable.occupancy = pruneOccupancy(
      writable.occupancy,
      (key) => env.ctx.readChunk(key)?.beings.length === 0,
    );
    writable.prunedDay = day;
  }
}

/** Phase 1: the beings due at this tick, sorted by id, with the chunk each one is in. */
export function collectDue(env: BeingsEnv): { readonly key: ChunkKey; readonly being: Being }[] {
  const due: { key: ChunkKey; being: Being }[] = [];
  for (const key of env.ctx.readGlobal().occupancy) {
    const chunk = env.ctx.readChunk(key);
    if (chunk === undefined)
      throw integrity(`the occupancy index lists the chunk ${key}, which is not materialized`);
    if (chunk.due > env.tick) continue;
    for (const being of chunk.beings)
      if (being.wake <= env.tick) due.push({ key, being: being as Being });
  }
  return due.sort((a, b) => a.being.id - b.being.id);
}
