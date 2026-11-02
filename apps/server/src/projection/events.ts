/**
 * Local speech and the feed of one tick (ADR 0026, "The feed"; ADR 0022): what the C0 events of the
 * beings layer show. Every `speech.uttered` becomes an item of speech in its speaker's chunk, with
 * the text speech@1 renders; every `being.spawned` an arrival, every `being.died` a death, and every
 * `greet` a greeting in the feed, which carries no text. A text that is not plain text is left out
 * and counted, never sent. Each payload is read through a schema of the members it uses, so no
 * other member of it can reach a client.
 */
import type { UtteredAct } from "@open-origin/agents";
import { type CanonicalValue, type EngineEvent, mind, worldgen } from "@open-origin/engine";
import {
  Act,
  Cell,
  type ChunkCoord,
  EntityId,
  FeedItem,
  Identifier,
  type LocalSpeech,
  plainTextProblem,
  Speech,
} from "@open-origin/protocol/public";
import { z } from "zod";

/** Renders an act of speech as text: speech@1's renderAct, unless a test replaces it. */
export type Render = (uttered: UtteredAct) => string;

/** The local speech and the feed of a tick, and how many items of speech were left out. */
export type ProjectedEvents = {
  readonly speech: LocalSpeech[];
  readonly feed: FeedItem[];
  omitted: number;
};

/** Projects the payload of an event of the tick `tick` into `into`. */
type Project = (
  tick: number,
  payload: CanonicalValue,
  into: ProjectedEvents,
  render: Render,
) => void;

/** What the projection does with an event type the registry classifies C0, and why. */
export type EventDecision =
  | { readonly decision: "projected"; readonly reason: string; readonly project: Project }
  | { readonly decision: "excluded"; readonly reason: string };

/** The members of a payload the projection reads; any other member is never read. */
const Spawned = z.object({ id: EntityId, species: Identifier, cell: Cell });
const Died = z.object({ id: EntityId, cell: Cell });
const Uttered = z.object({
  id: EntityId,
  to: EntityId,
  act: Act,
  band: z.int().min(0).optional(),
  cell: Cell,
  // A tell's proposition, which prop@1's own checker reads.
  p: z.unknown().optional(),
});

/** The chunk of the cell `[x, y]`. */
function chunkOf([x, y]: readonly [number, number]): ChunkCoord {
  return [worldgen.chunkOfCell(x), worldgen.chunkOfCell(y)];
}

/**
 * The act a `speech.uttered` reports, as speech@1 renders it: its speaker, hearer, act, cell, and,
 * when present, a tell's band and proposition. Throws when the payload holds no such act.
 */
function utteredOf(payload: CanonicalValue): UtteredAct {
  const { id, to, act, band, cell, p } = Uttered.parse(payload);
  if (p === undefined) return { id, to, act, cell, ...(band === undefined ? {} : { band }) };
  if (!mind.checkProposition(p, "/p", { report: () => undefined })) {
    throw new Error(`the act of speech of the being ${id} holds no valid proposition`);
  }
  return { id, to, act, cell, ...(band === undefined ? {} : { band }), p };
}

/** An arrival: the being, its species, and the chunk it appeared in. */
const arrival: Project = (tick, payload, into) => {
  const { id, species, cell } = Spawned.parse(payload);
  into.feed.push(
    FeedItem.parse({ kind: "arrival", tick, being: id, species, chunk: chunkOf(cell) }),
  );
};

/** A death: the being and the chunk it died in. */
const death: Project = (tick, payload, into) => {
  const { id, cell } = Died.parse(payload);
  into.feed.push(FeedItem.parse({ kind: "death", tick, being: id, chunk: chunkOf(cell) }));
};

/**
 * An act of speech: an item in the speaker's chunk unless its text is not plain text, which is
 * counted instead; and, for a greet, a greeting in the feed, which carries no text.
 */
const utterance: Project = (tick, payload, into, render) => {
  const uttered = utteredOf(payload);
  const at = chunkOf(uttered.cell);
  const text = render(uttered);
  if (plainTextProblem(text) === undefined) {
    const item = { tick, speaker: uttered.id, to: uttered.to, act: uttered.act, text };
    into.speech.push({ at, speech: Speech.parse(item) });
  } else into.omitted += 1;
  if (uttered.act !== "greet") return;
  const greeting = { kind: "greeting", tick, from: uttered.id, to: uttered.to, chunk: at };
  into.feed.push(FeedItem.parse(greeting));
};

/**
 * Every event type EVENT_CLASSES classifies C0, with what the projection does with it. Events of
 * any other type are never read.
 */
export const C0_EVENT_DECISIONS: Readonly<Record<string, EventDecision>> = Object.freeze({
  "being.died": { decision: "projected", reason: "a death in the feed", project: death },
  "being.spawned": { decision: "projected", reason: "an arrival in the feed", project: arrival },
  "being.started": {
    decision: "excluded",
    reason: "the kind of activity it reports is in the being's own record, in its chunk",
  },
  "speech.uttered": {
    decision: "projected",
    reason: "speech in the speaker's chunk, and a greeting in the feed for every greet",
    project: utterance,
  },
});

/** The local speech and the feed of `events`, the events of the tick `tick`, in their order. */
export function projectEvents(
  tick: number,
  events: readonly EngineEvent[],
  render: Render,
): ProjectedEvents {
  const into: ProjectedEvents = { speech: [], feed: [], omitted: 0 };
  for (const { type, payload } of events) {
    const decision = Object.hasOwn(C0_EVENT_DECISIONS, type) ? C0_EVENT_DECISIONS[type] : undefined;
    if (decision?.decision === "projected") decision.project(tick, payload, into, render);
  }
  return into;
}
