/**
 * The C0 records of the public protocol (ADR 0026): a being, an item of local speech, and an item
 * of the feed, with the values every message shares. Each is an explicit allowlist, a strict
 * object whose bounds are the engine's: an extra key, a fraction, or an unsafe integer is
 * rejected. The projections of T6-5 map each field from the engine's registry of classes.
 */
import { z } from "zod";
import {
  ACTS,
  DIRECTION_COUNT,
  MAX_CELL,
  MAX_CHUNK,
  MIN_CELL,
  MIN_CHUNK,
  STAGES,
} from "./constants.ts";
import { PlainText } from "./text.ts";

/** A tick: a safe integer from 0. */
export const Tick = z.int().min(0);

/** The id of an entity: a safe integer from 1. */
export const EntityId = z.int().min(1);

/** A chunk coordinate of the world. */
const ChunkAxis = z.int().min(MIN_CHUNK).max(MAX_CHUNK);

/** A chunk of the world, `[x, y]`. */
export const ChunkCoord = z.tuple([ChunkAxis, ChunkAxis]);
export type ChunkCoord = z.output<typeof ChunkCoord>;

/** A cell coordinate of the world. */
const CellAxis = z.int().min(MIN_CELL).max(MAX_CELL);

/** A cell of the world, `[x, y]`. */
export const Cell = z.tuple([CellAxis, CellAxis]);

/**
 * An identifier, such as a species: 1 to 32 characters, a lowercase letter first, then lowercase
 * letters, digits, `.`, `_`, or `-`, as the engine's identifiers are.
 */
export const Identifier = z.string().regex(/^[a-z][a-z0-9._-]{0,31}$/);

/** An act of speech. */
export const Act = z.enum(ACTS);

/** A direction, by its index (DIRECTION_COUNT). */
const Direction = z
  .int()
  .min(0)
  .max(DIRECTION_COUNT - 1);

/**
 * What a being is doing, as an observer sees it: its kind; for a talk, the hearer and the act; for
 * a walk, the direction of its current step, from 0 to 7 (DIRECTION_COUNT).
 */
export const ActivityPublic = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("eat") }),
  z.strictObject({ kind: z.literal("idle") }),
  z.strictObject({ kind: z.literal("sleep") }),
  z.strictObject({ kind: z.literal("talk"), to: EntityId, act: Act }),
  z.strictObject({ kind: z.literal("walk"), dir: Direction }),
]);
export type ActivityPublic = z.output<typeof ActivityPublic>;

/**
 * A being as the public sees it: the C0 members of the engine's registry (`id`, `species`,
 * `stage`, `born`, `cell`, and of `activity` its kind, hearer, act, and direction). Its largest
 * valid record encodes to at most MAX_BEING_RECORD_BYTES of JSON (dto.test.ts).
 */
export const BeingPublic = z.strictObject({
  id: EntityId,
  species: Identifier,
  stage: z.enum(STAGES),
  born: Tick,
  cell: Cell,
  activity: ActivityPublic,
});
export type BeingPublic = z.output<typeof BeingPublic>;

/** An act of local speech, heard in the speaker's chunk: when, who, to whom, which act, and its text. */
export const Speech = z.strictObject({
  tick: Tick,
  speaker: EntityId,
  to: EntityId,
  act: Act,
  text: PlainText,
});
export type Speech = z.output<typeof Speech>;

/**
 * An item of the feed, which reaches every client and carries no text: a being arrived, a being
 * died, or one being greeted another (every `greet` act), each with the tick and the chunk where it
 * happened. A transaction covers several ticks, so each item says its own.
 */
export const FeedItem = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("arrival"),
    tick: Tick,
    being: EntityId,
    species: Identifier,
    chunk: ChunkCoord,
  }),
  z.strictObject({ kind: z.literal("death"), tick: Tick, being: EntityId, chunk: ChunkCoord }),
  z.strictObject({
    kind: z.literal("greeting"),
    tick: Tick,
    from: EntityId,
    to: EntityId,
    chunk: ChunkCoord,
  }),
]);
export type FeedItem = z.output<typeof FeedItem>;
