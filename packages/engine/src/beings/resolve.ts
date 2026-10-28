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
import { idleEnd, nextArrival, nextBite, talkEnd } from "./activity.ts";
import { hearingOf, outcomeOf, type Work } from "./advance.ts";
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
import { type BeingsChunk, dueOf, indexOfBeing } from "./chunk.ts";
import { type BeingsEnv, CONTEST_STREAM, integrity } from "./env.ts";
import type { Depletion } from "./food.ts";
import { takenAt } from "./food.ts";
import { hearingWakes } from "./hearing.ts";
import type { Species2 } from "./life2.ts";
import { nextLightTick } from "./light.ts";
import { isOccupied, mergeOccupied, pruneOccupancy } from "./occupancy.ts";
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
  if (claim === undefined) return;
  // Only a meal claims food; anything else would take food that nobody eats.
  if (work.activity.kind !== "eat")
    throw integrity(`the being ${work.old.id} claims food without eating`);
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
    // Every earlier bite of the meal was whole, since a short one ends it: this one is the last.
    const eaten = (work.activity.bites - claim.bites) * work.species.diet.biteUnits + units;
    const outcome = { result, tick: env.tick, reason: sated ? "" : "food_gone" };
    work.outcome = outcomeOf(env, work, outcome, eaten);
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

/**
 * Resolves every claim of the tick in canonical order; returns the food taken, cell by cell, in that
 * order: by chunk key, then cell index, which applyWorks relies on.
 */
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

/**
 * The levels of `work` beyond those of every being, which its body must not pass unseen: the health
 * at which an incapacitated being recovers, the target of its sleep, and its wake conditions.
 */
function extraLevels(work: Work): Level[] {
  const levels: Level[] = [];
  const { recoverAbove } = work.species.health;
  if (work.condition === "incapacitated" && recoverAbove < NEED_MAX)
    levels.push({ of: "health", at: recoverAbove + 1 });
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
  // Only a being of beings@2 talks, and validateGlobal accepted laws of life@2 for it.
  if (activity.kind === "talk")
    return talkEnd(activity, (work.species as Species2).speech.actMs, env.sps);
  // A sleep whose target rest already holds ends at the next tick; otherwise its level ends it.
  return work.body.rest >= activity.untilRest ? env.tick + 1 : undefined;
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
 * The next tick, when messages that reached the inbox of the being of beings@2 at this tick wake
 * it (hearing.ts): its activity at the end of the tick is idle, as a hearer's at a delivery.
 */
function hearingTick(env: BeingsEnv, work: Work): Tick | undefined {
  if (!env.rules.minds || work.mind === undefined) return undefined;
  return hearingWakes(work.mind, work.activity, hearingOf(env, work, env.tick))
    ? env.tick + 1
    : undefined;
}

/**
 * The record of `work` after this tick: anchored at this tick when its body jumped or its rates
 * changed, and kept on its old anchor otherwise, so that its values never depend on how often it
 * was processed; with its next wake, at least the next tick and at most a day away, or the next
 * tick when hearing wakes it; and, under beings@2, with its mind.
 */
function finalBeing(env: BeingsEnv, work: Work): Being {
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
    hearingTick(env, work),
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
    // A mind of beings@2 that did not change is the very value the chunk held, not a copy.
    ...(work.mind === undefined ? {} : { mind: work.mind }),
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
 * chunk was written. Both lists are in cell order, the entries by the chunk's invariant and the
 * takes by resolveClaims, so one merge pass visits each cell once (tracker L53).
 */
function deplete(
  env: BeingsEnv,
  entries: readonly Depletion[],
  takes: readonly Take[],
): Depletion[] {
  if (!inCellOrder(entries) || !inCellOrder(takes))
    throw integrity("the depletion or the takes of a chunk are not in the order of their cells");
  const result: Depletion[] = [];
  let next = 0;
  let at = 0;
  while (next < entries.length || at < takes.length) {
    const cell = firstCell(entries[next], takes[at]);
    const entry = entries[next]?.cell === cell ? entries[next] : undefined;
    if (entry !== undefined) next += 1;
    const run = takesOn(takes, at, cell);
    at = run.end;
    const kept = depleted(env, cell, entry, run);
    if (kept !== undefined) result.push(kept);
  }
  return result;
}

/** The takes on `cell` from index `start` on: the units they took, and the index after them. */
type TakeRun = { readonly units: number; readonly any: boolean; readonly end: number };

/** The run of takes on `cell` that starts at index `start` of `takes`. */
function takesOn(takes: readonly Take[], start: number, cell: number): TakeRun {
  let end = start;
  let units = 0;
  for (let take = takes[end]; take?.cell === cell; take = takes[end]) {
    units += take.units;
    end += 1;
  }
  return { units, any: end > start, end };
}

/**
 * The entry of `cell` after this tick: re-anchored now when something was taken from it or it is
 * new, `entry` itself otherwise, and undefined when nothing is missing from the cell.
 */
function depleted(
  env: BeingsEnv,
  cell: number,
  entry: Depletion | undefined,
  run: TakeRun,
): Depletion | undefined {
  const since = entry === undefined ? env.now : simSeconds(entry.since, env.sps);
  const missing = entry === undefined ? 0 : takenAt(entry, env.regrowth(), env.now - since);
  const taken = missing + run.units;
  if (taken === 0) return undefined;
  return run.any || entry === undefined ? { cell, taken, since: env.tick } : entry;
}

/** Whether the cells of `items` never decrease. */
function inCellOrder(items: readonly { readonly cell: number }[]): boolean {
  return items.every((item, index) => index === 0 || (items[index - 1]?.cell ?? 0) <= item.cell);
}

/** The lower of the cells of `entry` and `take`, whichever are defined; one of them always is. */
function firstCell(entry: Depletion | undefined, take: Take | undefined): number {
  if (entry === undefined) return take?.cell ?? 0;
  if (take === undefined) return entry.cell;
  return least(entry.cell, take.cell);
}

/** A being's record after this tick, with the key of the chunk it ends the tick in. */
type Placed = { readonly being: Being; readonly chunk: ChunkKey };

/**
 * The keys of every chunk this tick writes: where beings were, where they are, where food went,
 * and where a hearer the tick did not process heard something.
 */
function touched(
  works: readonly Work[],
  placed: readonly Placed[],
  takes: readonly Take[],
  heard: readonly Placed[],
): ChunkKey[] {
  const keys = [
    ...works.map((work) => work.from),
    ...placed.map(({ chunk }) => chunk),
    ...takes.map((take) => take.chunk),
    ...heard.map(({ chunk }) => chunk),
  ].sort(compareCodeUnits);
  return keys.filter((key, index) => index === 0 || key !== keys[index - 1]);
}

/**
 * The record of every processed being that did not die, each with its chunk computed once, in the
 * order touched() walks the chunks: by chunk key (UTF-16 code units), then by id.
 */
function placedBeings(env: BeingsEnv, works: readonly Work[]): Placed[] {
  const placed: Placed[] = [];
  for (const work of works) {
    if (work.died) continue;
    const being = finalBeing(env, work);
    placed.push({ being, chunk: env.place(being.cell).chunk });
  }
  return placed.sort((a, b) => compareCodeUnits(a.chunk, b.chunk) || a.being.id - b.being.id);
}

/** Whether the ascending `ids` hold `id`, by binary search. */
export function hasId(ids: readonly number[], id: number): boolean {
  let low = 0;
  let high = ids.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const found = ids[middle] as number;
    if (found === id) return true;
    if (found < id) low = middle + 1;
    else high = middle;
  }
  return false;
}

/** A position in a list sorted by chunk key, which the walk over the touched chunks advances. */
type Cursor = { at: number };

/** The items of `sorted` from `cursor` on whose chunk is `key`, with the cursor moved past them. */
function runAt<T extends { readonly chunk: ChunkKey }>(
  sorted: readonly T[],
  cursor: Cursor,
  key: ChunkKey,
): T[] {
  const start = cursor.at;
  while (cursor.at < sorted.length && (sorted[cursor.at] as T).chunk === key) cursor.at += 1;
  return sorted.slice(start, cursor.at);
}

/**
 * Writes every processed being and every take, then the occupancy index. Its work grows with the
 * beings processed, the takes, the hearers of the tick, and the chunks touched, never with their
 * products: the beings, sorted by chunk once, the takes, which resolveClaims returns in that order,
 * and `heard`, the records of hearers the tick did not process, in that order too, are read in step
 * with the touched chunks, and the beings that leave their chunks, or that heard, are found by
 * binary search.
 */
export function applyWorks(
  env: BeingsEnv,
  works: readonly Work[],
  takes: readonly Take[],
  heard: readonly Placed[] = [],
): void {
  const placed = placedBeings(env, works);
  const leaving = works.map((work) => work.old.id).sort((a, b) => a - b);
  const [beingAt, takeAt, heardAt]: [Cursor, Cursor, Cursor] = [{ at: 0 }, { at: 0 }, { at: 0 }];
  const arrived: ChunkKey[] = [];
  for (const key of touched(works, placed, takes, heard)) {
    const chunk = liveChunk(env, key);
    const kept = chunk.beings.filter((being) => !hasId(leaving, being.id));
    const staying = withHeard(kept, runAt(heard, heardAt, key));
    const coming = runAt(placed, beingAt, key).map(({ being }) => being);
    chunk.beings = [...staying, ...coming].sort((a, b) => a.id - b.id);
    chunk.depletion = deplete(env, chunk.depletion, runAt(takes, takeAt, key));
    chunk.due = dueOf(chunk.beings);
    if (coming.length > 0) arrived.push(key);
  }
  // touched() holds the chunk of every placed being, every take, and every hearer, so the walks
  // reach their ends unless one of the lists left the order of chunk keys.
  if (beingAt.at !== placed.length || takeAt.at !== takes.length || heardAt.at !== heard.length)
    throw integrity(
      "the beings, takes, or hearers of the tick are not in the order of their chunks",
    );
  updateOccupancy(env, arrived);
}

/**
 * `beings`, a chunk's beings the tick did not process, by id, with the records of those of them
 * that heard something at this tick, `heard`, put in their place.
 */
function withHeard(beings: readonly Being[], heard: readonly Placed[]): Being[] {
  let current = [...beings];
  for (const { being } of heard) {
    const index = indexOfBeing(current, being.id);
    if (index === undefined) throw integrity(`the hearer ${being.id} is not in its chunk`);
    current = current.with(index, being);
  }
  return current;
}

/**
 * Adds the chunks that received a being to the occupancy index, and prunes it once a day. `arrived`
 * is in the index's order, so the chunks it lacks are found by binary search and merged in one pass.
 */
function updateOccupancy(env: BeingsEnv, arrived: readonly ChunkKey[]): void {
  const global = env.ctx.readGlobal();
  const missing = arrived.filter((key) => !isOccupied(global.occupancy, key));
  const day = (env.now - (env.now % env.dayLength)) / env.dayLength;
  if (missing.length === 0 && day <= global.prunedDay) return;
  const writable = env.ctx.writeGlobal();
  if (missing.length > 0) writable.occupancy = mergeOccupied(writable.occupancy, missing);
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
