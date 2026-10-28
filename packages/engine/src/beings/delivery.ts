/**
 * The delivery of speech in beings@2 (ADR 0024, docs/architecture/mind.md "Speech" and "The tick
 * of beings@2"), for an act that ends at tick t. Phase 2, at the speaker, from the state at the
 * start of t: its hearer is found among the beings of the chunks its window read for the decision
 * at the end of its act, so finding it reads nothing more; it is `gone` when none of them holds it,
 * and is not heard either beyond `speech.range` (`range`), asleep (`asleep`), or incapacitated
 * (`condition`). Phase 3, after the contests: a hearer that died at t is `gone`; when more
 * messages reach a hearer than its inbox has room for, in its mind at the end of t, its speakers,
 * by increasing id, are ordered by `random.permutation` on `beings.speech`, keyed by the hearer's
 * id, and the first fill the room; the rest are `full`. Phase 4: the messages merge into the
 * hearer's final record, in order of speaker id, growing its exposure; a hearer processed at t
 * carries them in its Work, whose final record wakes it at t + 1 under the rule of a hearer
 * (hearing.ts), and any other hearer's record is rewritten in its chunk with that wake. The
 * outcomes are emitted by hearer, then speaker: `speech.delivered`, with a `mind.provenance` when
 * the message grew the exposure, or `speech.unheard` with its reason. The work grows with the
 * utterances of the tick, never with the beings of the world.
 */
import { compareCodeUnits } from "../canonical/order.ts";
import type { InboxMessage, Mind } from "../mind/index.ts";
import type { ChunkKey } from "../world/chunk.ts";
import type { Work } from "./advance.ts";
import type { Being2 } from "./being.ts";
import { indexOfBeing } from "./chunk.ts";
import { type BeingsEnv, integrity } from "./env.ts";
import { dayOfTick, delivered, hearingWakes } from "./hearing.ts";
import type { Species2 } from "./life2.ts";
import { distance } from "./perception.ts";
import { greatest, least } from "./rates.ts";
import { SPEECH_STREAM } from "./rules.ts";
import type { CoveredChunk } from "./senses.ts";
import type { Utterance } from "./speech.ts";

/** Why an utterance is not heard. */
export type Unheard = "gone" | "range" | "asleep" | "condition" | "full";

/**
 * The hearer of an utterance as phase 2 found it at the start of the tick, with its chunk; or why
 * it does not hear.
 */
export type Addressed =
  | { readonly kind: "found"; readonly hearer: Being2; readonly chunk: ChunkKey }
  | { readonly kind: "unheard"; readonly reason: Unheard };

/**
 * Phase 2 of the delivery of `utterance`, said with a reach of `range` cells: its hearer among the
 * beings of `chunks`, the chunks the speaker's window read at this tick, and whether it may hear.
 */
export function address(
  utterance: Utterance,
  chunks: readonly CoveredChunk[],
  range: number,
): Addressed {
  for (const { coord, chunk } of chunks) {
    const index = indexOfBeing(chunk.beings, utterance.to);
    if (index === undefined) continue;
    // validateChunk accepted every being of beings@2 with its mind; nothing here writes it.
    const hearer = chunk.beings[index] as unknown as Being2;
    if (distance(hearer.cell, utterance.cell) > range) return unheard("range");
    if (hearer.activity.kind === "sleep") return unheard("asleep");
    if (hearer.condition !== "ok") return unheard("condition");
    return { kind: "found", hearer, chunk: `${coord[0]},${coord[1]}` };
  }
  return unheard("gone");
}

function unheard(reason: Unheard): Addressed {
  return { kind: "unheard", reason };
}

/** An utterance of the tick, its speaker, and what phase 2 found of its hearer. */
type Addressing = {
  readonly speaker: number;
  readonly utterance: Utterance;
  readonly addressed: Addressed;
};

/** The record of a hearer the tick did not process, rewritten with what it heard, and its chunk. */
export type Delivered = { readonly being: Being2; readonly chunk: ChunkKey };

/**
 * Phases 3 and 4 of the deliveries of the tick: the utterances of `works`, the Works of the tick by
 * increasing id, grouped by hearer. A hearer processed at this tick gets the messages in its Work;
 * the records of the others are returned, by chunk key and then id, for applyWorks to write. The
 * outcomes are emitted by hearer id, then speaker id.
 */
export function deliver(env: BeingsEnv, works: readonly Work[]): Delivered[] {
  const said: Addressing[] = [];
  for (const work of works) {
    const { spoken, addressed } = work;
    if (spoken !== undefined && addressed !== undefined)
      said.push({ speaker: work.old.id, utterance: spoken, addressed });
  }
  said.sort((a, b) => a.utterance.to - b.utterance.to || a.speaker - b.speaker);
  const records: Delivered[] = [];
  for (let start = 0; start < said.length; ) {
    let end = start + 1;
    while (end < said.length && said[end]?.utterance.to === said[start]?.utterance.to) end += 1;
    const record = deliverTo(env, works, said.slice(start, end));
    if (record !== undefined) records.push(record);
    start = end;
  }
  return records.sort((a, b) => compareCodeUnits(a.chunk, b.chunk) || a.being.id - b.being.id);
}

/** What phase 3 knows of a hearer: its Work, if processed, its record at the start, and its laws. */
type Hearer = {
  readonly work: Work | undefined;
  readonly record: Being2;
  readonly chunk: ChunkKey;
  readonly species: Species2;
};

/**
 * Delivers to one hearer the utterances `group` addressed to it, by increasing speaker id; returns
 * its rewritten record when the tick did not process it and a message reached it.
 */
function deliverTo(
  env: BeingsEnv,
  works: readonly Work[],
  group: readonly Addressing[],
): Delivered | undefined {
  const reached = group.find((entry) => entry.addressed.kind === "found")?.addressed;
  if (reached === undefined || reached.kind !== "found") {
    for (const entry of group) emitUnheard(env, entry);
    return undefined;
  }
  const work = workWith(works, reached.hearer.id);
  // validateGlobal accepted laws of life@2 for every being's species.
  const species = (work?.species ?? env.species(reached.hearer.species)) as Species2;
  const hearer: Hearer = { work, record: reached.hearer, chunk: reached.chunk, species };
  // A Work of beings@2 holds its being's mind.
  const held = work === undefined ? reached.hearer.mind : (work.mind as Mind);
  const mind = merge(env, hearer, group, held);
  if (mind === held) return undefined;
  if (work !== undefined) {
    work.mind = mind;
    return undefined;
  }
  return { being: rewritten(env, hearer, mind), chunk: hearer.chunk };
}

/**
 * `held`, the hearer's mind at the end of the tick, with the messages of `group` that reach it, in
 * order of speaker id, each outcome emitted as it is decided.
 */
function merge(env: BeingsEnv, hearer: Hearer, group: readonly Addressing[], held: Mind): Mind {
  const died = hearer.work?.died === true;
  const reaching = died ? 0 : group.filter((entry) => entry.addressed.kind === "found").length;
  const room = greatest(hearer.species.mind.inbox - held.inbox.length, 0);
  const admitted = admit(env, hearer, reaching, room);
  let mind = held;
  let index = 0;
  for (const entry of group) {
    // Phase 2 judged first: a hearer that died at t is gone only for the acts that reached it.
    if (entry.addressed.kind !== "found" || died) {
      emitUnheard(env, entry, entry.addressed.kind === "found" ? "gone" : undefined);
      continue;
    }
    const heard = admitted[index] === true;
    index += 1;
    if (!heard) {
      emitUnheard(env, entry, "full");
      continue;
    }
    const exposure = mind.exposure;
    mind = delivered(mind, messageOf(entry, env.tick));
    env.emit("speech.delivered", { id: entry.speaker, to: entry.utterance.to });
    if (mind.exposure !== exposure)
      env.emit("mind.provenance", { id: entry.utterance.to, records: [], exposure: mind.exposure });
  }
  return mind;
}

/**
 * Which of the `count` messages reaching `hearer`, by increasing speaker id, its inbox admits with
 * `room` places: all of them when they fit; otherwise the first `room` of the order a permutation
 * on `beings.speech`, keyed by the hearer's id, gives them, and none without a draw when there is
 * no room.
 */
function admit(env: BeingsEnv, hearer: Hearer, count: number, room: number): boolean[] {
  if (count <= room) return Array.from({ length: count }, () => true);
  const admitted = Array.from({ length: count }, () => false);
  if (room === 0) return admitted;
  const order = env.ctx.random.permutation(SPEECH_STREAM, hearer.record.id, count);
  for (const index of order.slice(0, room)) admitted[index] = true;
  return admitted;
}

/** The message `entry` leaves in its hearer's inbox at `tick`: what its speaker captured. */
function messageOf(entry: Addressing, tick: number): InboxMessage {
  const { act, captured, cell } = entry.utterance;
  const { p, band, tn, ex } = captured;
  return {
    who: entry.speaker,
    t: tick,
    cell: [cell[0], cell[1]],
    act,
    ...(p === undefined ? {} : { p }),
    ...(band === undefined ? {} : { band }),
    tn,
    ex,
  };
}

/** Emits that `entry` was not heard, for `reason` or the one phase 2 found. */
function emitUnheard(env: BeingsEnv, entry: Addressing, reason?: Unheard): void {
  const why = reason ?? (entry.addressed.kind === "unheard" ? entry.addressed.reason : undefined);
  if (why === undefined) throw integrity(`the utterance of ${entry.speaker} reached its hearer`);
  env.emit("speech.unheard", { id: entry.speaker, to: entry.utterance.to, reason: why });
}

/**
 * The record of a hearer the tick did not process, with `mind`, and woken at the next tick when
 * the messages that reached it now wake it, as a delivery at its tick does (hearing.ts).
 */
function rewritten(env: BeingsEnv, hearer: Hearer, mind: Mind): Being2 {
  const { record, species } = hearer;
  const day = dayOfTick(env.tick, env.sps, env.dayLength);
  const hearing = { at: env.tick, day, wakesPerDay: species.speech.wakesPerDay };
  const wakes = hearingWakes(mind, record.activity, hearing);
  const wake = wakes ? least(record.wake, env.tick + 1) : record.wake;
  // The record the state held, with the mind it now holds: a new value, as a command's write is.
  return { ...record, mind, wake };
}

/** The Work of the being `id` among `works`, sorted by id, by binary search; undefined if none. */
function workWith(works: readonly Work[], id: number): Work | undefined {
  let low = 0;
  let high = works.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((works[middle]?.old.id ?? id) < id) low = middle + 1;
    else high = middle;
  }
  const found = works[low];
  return found?.old.id === id ? found : undefined;
}
