/**
 * The constants of the public protocol v1 (ADR 0026): its identity, the world's bounds a message
 * may name, the client's limits, the server's sizes, and the fixed codes. The world's bounds and
 * vocabularies repeat the engine's, because this package imports nothing from the domain; a parity
 * test holds them equal (test/engine-parity.test.ts). Nothing here carries the tick rate or the
 * simulated seconds per tick: both are C3 (ADR 0026, the authoritative clock).
 */

/** The WebSocket subprotocol a client asks for; anything else is refused before the upgrade. */
export const PROTOCOL_ID = "open-origin.public.v1";

/** The audience this protocol serves. */
export const AUDIENCE = "public";

/** How many cells a chunk has along each axis, and in all. */
export const CHUNK_CELLS = 32;
export const CHUNK_AREA = CHUNK_CELLS * CHUNK_CELLS;

/** The world's chunk coordinates, from −2^26 to 2^26 − 1 (worldgen's space). */
export const MIN_CHUNK = -0x400_0000;
export const MAX_CHUNK = 0x3ff_ffff;

/** The world's cell coordinates, from −2^31 to 2^31 − 1 (worldgen's space). */
export const MIN_CELL = -0x8000_0000;
export const MAX_CELL = 0x7fff_ffff;

/** The most beings a chunk holds: 65,536 under beings@1, the largest of any version. */
export const MAX_CHUNK_BEINGS = 0x1_0000;

/** The stages of life a being may be in. */
export const STAGES = Object.freeze(["adult"] as const);

/** What a being may be doing. */
export const ACTIVITY_KINDS = Object.freeze(["eat", "idle", "sleep", "talk", "walk"] as const);

/** The acts of speech. */
export const ACTS = Object.freeze(["greet", "ask", "tell", "unknown"] as const);

/**
 * How many directions a walk steps in. A direction is its index: 0 E, 1 NE, 2 N, 3 NW, 4 W, 5 SW,
 * 6 S, 7 SE, counterclockwise from east, with +x east and +y north.
 */
export const DIRECTION_COUNT = 8;

/**
 * The substrate codes a cell may hold, in order: a substrate is a category with no name, no unit,
 * and no order, and a world has from 1 to 16 of them (ADR 0021).
 */
export const SUBSTRATE_CODES = Object.freeze([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
] as const);

/** A client that hears nothing for this long reconnects with backoff. */
export const STALE_AFTER_MS = 3000;

/** A client may ask for a resync at most once in this many milliseconds. */
export const RESYNC_INTERVAL_MS = 2000;

/** The largest nonce of a ping: 2^31 − 1. */
export const MAX_NONCE = 0x7fff_ffff;

/** The longest plain text, in code points. */
export const MAX_TEXT_LENGTH = 280;

/** The most bytes of one server message, a part of a transaction or any other: 64 KiB. */
export const MAX_PART_BYTES = 0x1_0000;

/** The most bytes of one being record, encoded as JSON. */
export const MAX_BEING_RECORD_BYTES = 256;

/** The rings of local speech and of the feed: H ticks, and at most this many items. */
export const RING_TICKS = 300;
export const RING_ITEMS = 2048;

/** The most feed items that go out for one tick; the rest are counted in `missed`. */
export const MAX_FEED_ITEMS_PER_TICK = 64;

/**
 * The limits on one client, which `hello` announces: none of them is a rate of the world.
 *
 * - `maxChunks`: the most chunks of a camera (`subscribe`);
 * - `maxFollowChunks`: the most chunks of the follow window, the followed being's chunk ± 1;
 * - `maxMessageBytes`: the largest message a client may send, 4 KiB;
 * - `messagesPerSecond` and `burst`: the token bucket of a client's messages;
 * - `newChunksPer2s`: the most chunks that may enter the interest every 2 s;
 * - `maxViewBytes`: the largest view, encoded, 32 MiB.
 */
export const CLIENT_LIMITS = Object.freeze({
  maxChunks: 64,
  maxFollowChunks: 9,
  maxMessageBytes: 4096,
  messagesPerSecond: 10,
  burst: 20,
  newChunksPer2s: 64,
  maxViewBytes: 32 * 1024 * 1024,
} as const);

/** The most chunks a view holds: a full camera and a full follow window. */
export const MAX_VIEW_CHUNKS = CLIENT_LIMITS.maxChunks + CLIENT_LIMITS.maxFollowChunks;

/**
 * The most parts of one transaction: a full view of 32 MiB in parts of 64 KiB takes 512, and this
 * is twice that. A client discards a transaction with more as malformed, so a faulty or hostile
 * server cannot make it keep parts without bound.
 */
export const MAX_TRANSACTION_PARTS = 1024;

/** The WebSocket close codes the server uses, by reason. */
export const CLOSE_CODES = Object.freeze({
  /** The server is shutting down. */
  shutdown: 1001,
  /** The client sent a binary frame. */
  binaryFrame: 1003,
  /** The client earned too many strikes. */
  strikes: 1008,
  /** A message was too large. */
  tooLarge: 1009,
  /** The client was too slow for its interest. */
  tooSlow: 1013,
} as const);

/** The codes of `error`: the input is never echoed. */
export const ERROR_CODES = Object.freeze([
  "bad_json",
  "bad_message",
  "unknown_type",
  "too_many_chunks",
  "out_of_bounds",
  "unknown_being",
  "rate_limited",
  "resync_too_soon",
] as const);

/** An error code. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The states of the world, the same for every client: `hello.state` and `status.state`. */
export const WORLD_STATES = Object.freeze(["running", "paused", "stalled", "halted"] as const);

/** Whether a world survives a restart: `ephemeral` worlds do not (ADR 0025). */
export const DURABILITIES = Object.freeze(["ephemeral", "durable"] as const);
