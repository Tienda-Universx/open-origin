/**
 * Server to client (ADR 0026): ten types, each a strict object with `type`, `seq`, and `tick`.
 * `seq` starts at 0 with `hello` and grows by exactly 1 per message. The parts of a transaction
 * (`delta`, `snapshot`, `events`) and its `commit` or `abort` carry the transaction's target tick;
 * every other message carries the client's visible tick when it is sent. No message carries the
 * tick rate or the simulated seconds per tick, which are C3: the server sends the clock itself.
 */
import { z } from "zod";
import {
  AUDIENCE,
  CLIENT_LIMITS,
  DURABILITIES,
  ERROR_CODES,
  MAX_CHUNK_BEINGS,
  MAX_NONCE,
  MAX_VIEW_CHUNKS,
  PROTOCOL_ID,
  RING_ITEMS,
  WORLD_STATES,
} from "./constants.ts";
import {
  BeingPublic,
  ChunkCoord,
  distinctChunks,
  EntityId,
  FeedItem,
  Speech,
  Tick,
} from "./dto.ts";
import { TerrainPublic } from "./terrain.ts";
import { PlainText } from "./text.ts";

/** A count of something: a safe integer from 1. */
const Count = z.int().min(1);

/** The id of a transaction, unique within a connection. */
const Txn = z.int().min(0);

/** The members every message has, but `type`. */
const HEADER = { seq: z.int().min(0), tick: Tick };

/**
 * The authoritative clock of a tick, computed by the server with worldgen's calendar: the tick,
 * its day, counted from 0, and its position in the day, in permille. A client shows it as it is,
 * and never extrapolates it.
 */
export const Clock = z.strictObject({
  tick: Tick,
  day: z.int().min(0),
  dayPermille: z.int().min(0).max(999),
});
export type Clock = z.output<typeof Clock>;

/**
 * The limits on one client, exactly the members CLIENT_LIMITS names: none on the world's rate.
 * The three a parser enforces are fixed; the server's own policy sets the others.
 */
export const Limits = z.strictObject({
  maxChunks: z.literal(CLIENT_LIMITS.maxChunks),
  maxFollowChunks: z.literal(CLIENT_LIMITS.maxFollowChunks),
  maxMessageBytes: z.literal(CLIENT_LIMITS.maxMessageBytes),
  messagesPerSecond: Count,
  burst: Count,
  newChunksPer2s: Count,
  maxViewBytes: Count,
});

/** The state of the world, the same for every client. */
export const WorldState = z.enum(WORLD_STATES);

/** Whether the clock's tick is the message's own. */
function clockAtTick({ tick, clock }: { tick: number; clock: Clock }): boolean {
  return clock.tick === tick;
}
const CLOCK_AT_TICK = { message: "the clock must be the clock of the message's tick" };

/**
 * The first message of every connection, with `seq` 0: the protocol, the world's random id (32
 * lowercase hexadecimal digits, never derived from the seed, a label, or the genesis), whether it
 * is durable, its state, the clock of the tick it carries, and the client's limits.
 */
export const HelloMessage = z
  .strictObject({
    type: z.literal("hello"),
    seq: z.literal(0),
    tick: Tick,
    protocol: z.literal(PROTOCOL_ID),
    audience: z.literal(AUDIENCE),
    world: z.strictObject({ id: z.string().regex(/^[0-9a-f]{32}$/) }),
    durability: z.enum(DURABILITIES),
    state: WorldState,
    clock: Clock,
    limits: Limits,
  })
  .refine(clockAtTick, CLOCK_AT_TICK);

/** Whether every chunk's version `v` is at most the message's tick. */
function versionsAtMost({ tick, chunks }: { tick: number; chunks: { v: number }[] }): boolean {
  return chunks.every(({ v }) => v <= tick);
}
const VERSIONS_AT_MOST = { message: "a chunk's version cannot follow the transaction's tick" };

/**
 * The differences of one visible chunk between the versions at the client's tick and at the
 * transaction's: the ids that left it, the records that entered or changed, the local speech of
 * those ticks, and how many speech items were missed, when any were. A dense chunk's differences
 * may span several parts.
 */
const DeltaChunk = z.strictObject({
  at: ChunkCoord,
  v: Tick,
  gone: z.array(EntityId).max(MAX_CHUNK_BEINGS),
  upsert: z.array(BeingPublic).max(MAX_CHUNK_BEINGS),
  speech: z.array(Speech).max(RING_ITEMS),
  speechMissed: Count.optional(),
});

/** A part of a transaction: chunks that leave the view (`drop`) and differences of visible ones. */
export const DeltaMessage = z
  .strictObject({
    type: z.literal("delta"),
    ...HEADER,
    txn: Txn,
    chunks: z.array(DeltaChunk).max(MAX_VIEW_CHUNKS),
    drop: z.array(ChunkCoord).max(MAX_VIEW_CHUNKS),
  })
  .refine(versionsAtMost, VERSIONS_AT_MOST)
  .refine(({ chunks, drop }) => distinctChunks([...chunks.map(({ at }) => at), ...drop]), {
    message: "a chunk appears once, in chunks or in drop",
  })
  .refine(
    ({ tick, chunks }) => chunks.every((chunk) => chunk.speech.every((s) => s.tick <= tick)),
    {
      message: "speech cannot follow the transaction's tick",
    },
  );

/** Fragment `i` of `n` of a chunk's full content, counted from 0. */
const Fragment = z
  .strictObject({
    i: z.int().min(0),
    n: z
      .int()
      .min(1)
      .max(MAX_CHUNK_BEINGS + 1),
  })
  .refine(({ i, n }) => i < n, { message: "a fragment's index must be below its count" });

/** A fragment of a chunk's full content: its version, its terrain in one fragment, and beings. */
const SnapshotChunk = z.strictObject({
  at: ChunkCoord,
  v: Tick,
  terrain: TerrainPublic.optional(),
  beings: z.array(BeingPublic).max(MAX_CHUNK_BEINGS),
  frag: Fragment,
});

/**
 * A part of a transaction: the full content of chunks that enter the view, or, with `reset`, of the
 * whole view, which replaces the old one at the commit; and `followed`, the followed being's
 * record, even while its chunk is not shown (trimmed, or waiting for terrain), or null when it is
 * gone.
 */
export const SnapshotMessage = z
  .strictObject({
    type: z.literal("snapshot"),
    ...HEADER,
    txn: Txn,
    reset: z.boolean(),
    chunks: z.array(SnapshotChunk).max(MAX_VIEW_CHUNKS),
    followed: BeingPublic.nullable().optional(),
  })
  .refine(versionsAtMost, VERSIONS_AT_MOST);

/** A part of a transaction: the feed of its ticks, and how many items were missed, if any. */
export const EventsMessage = z
  .strictObject({
    type: z.literal("events"),
    ...HEADER,
    txn: Txn,
    items: z.array(FeedItem).max(RING_ITEMS),
    missed: Count.optional(),
  })
  .refine(({ tick, items }) => items.every((item) => item.tick <= tick), {
    message: "a feed item cannot follow the transaction's tick",
  });

/** Closes a transaction: the client applies it whole, and shows this clock. */
export const CommitMessage = z
  .strictObject({ type: z.literal("commit"), ...HEADER, txn: Txn, clock: Clock })
  .refine(clockAtTick, CLOCK_AT_TICK);

/** Cancels a transaction: the client discards its parts. */
export const AbortMessage = z.strictObject({ type: z.literal("abort"), ...HEADER, txn: Txn });

/**
 * The view limit trimmed the interest: these chunks are left out; none when nothing is left out
 * any more.
 */
export const NoticeMessage = z.strictObject({
  type: z.literal("notice"),
  ...HEADER,
  code: z.literal("interest_trimmed"),
  chunks: z
    .array(ChunkCoord)
    .max(MAX_VIEW_CHUNKS)
    .refine(distinctChunks, { message: "each chunk is listed once" }),
});

/** The answer to a `ping`, with its nonce. */
export const PongMessage = z.strictObject({
  type: z.literal("pong"),
  ...HEADER,
  nonce: z.int().min(0).max(MAX_NONCE),
});

/** The world stopped or resumed, for everyone, with a reason when there is one. */
export const StatusMessage = z.strictObject({
  type: z.literal("status"),
  ...HEADER,
  state: WorldState,
  reason: PlainText.optional(),
});

/** A client message was rejected, with the code of why; the input is never echoed. */
export const ErrorMessage = z.strictObject({
  type: z.literal("error"),
  ...HEADER,
  code: z.enum(ERROR_CODES),
});

/** The ten types the server sends, in this order. */
export const SERVER_MESSAGE_TYPES = Object.freeze([
  "hello",
  "delta",
  "snapshot",
  "events",
  "commit",
  "abort",
  "notice",
  "pong",
  "status",
  "error",
] as const);

/** A message the server may send. */
export const ServerMessage = z.discriminatedUnion("type", [
  HelloMessage,
  DeltaMessage,
  SnapshotMessage,
  EventsMessage,
  CommitMessage,
  AbortMessage,
  NoticeMessage,
  PongMessage,
  StatusMessage,
  ErrorMessage,
]);
export type ServerMessage = z.output<typeof ServerMessage>;
export type HelloMessage = z.output<typeof HelloMessage>;
export type DeltaMessage = z.output<typeof DeltaMessage>;
export type SnapshotMessage = z.output<typeof SnapshotMessage>;
export type EventsMessage = z.output<typeof EventsMessage>;
export type CommitMessage = z.output<typeof CommitMessage>;

/** What parseServerMessage read: a message, or why it is rejected. */
export type ServerParse =
  | { readonly ok: true; readonly message: ServerMessage }
  | { readonly ok: false; readonly code: "bad_json" | "bad_message" };

/** The server message `text` holds, or why it is rejected; it never throws. */
export function parseServerMessage(text: string): ServerParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "bad_json" };
  }
  const result = ServerMessage.safeParse(value);
  return result.success ? { ok: true, message: result.data } : { ok: false, code: "bad_message" };
}
