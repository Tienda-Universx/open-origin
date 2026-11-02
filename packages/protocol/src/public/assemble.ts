/**
 * The assembly of one transaction from its parts (ADR 0026), for the reference reducer: the chunks
 * that leave the view, the merged differences of each visible chunk, the full content of each
 * chunk that enters, put together from its fragments, the followed being, and the feed. Assembly
 * reads the parts only; it reports the first way they break the protocol, and applies nothing.
 */

import { CHUNK_CELLS } from "./constants.ts";
import type { BeingPublic, ChunkCoord, FeedItem, Speech } from "./dto.ts";
import { chunkKey } from "./dto.ts";
import type { DeltaMessage, EventsMessage, SnapshotMessage } from "./server.ts";
import type { TerrainPublic } from "./terrain.ts";

/** A part of a transaction. */
export type Part = DeltaMessage | SnapshotMessage | EventsMessage;

/** The differences of one visible chunk, merged across the parts that carry them. */
export type ChunkDelta = {
  readonly at: ChunkCoord;
  readonly v: number;
  readonly gone: number[];
  readonly upsert: BeingPublic[];
  readonly speech: Speech[];
  speechMissed: number;
};

/** The full content of a chunk that enters the view, put together from all its fragments. */
export type ChunkContent = {
  readonly at: ChunkCoord;
  readonly v: number;
  readonly terrain: TerrainPublic;
  readonly beings: ReadonlyMap<number, BeingPublic>;
};

/** A transaction, assembled: what its commit applies, in the order it applies it. */
export type Transaction = {
  readonly reset: boolean;
  readonly drop: ReadonlyMap<string, ChunkCoord>;
  readonly deltas: ReadonlyMap<string, ChunkDelta>;
  readonly entering: ReadonlyMap<string, ChunkContent>;
  /** The followed being's record, null for none, or undefined when no part said. */
  readonly followed: BeingPublic | null | undefined;
  readonly feed: readonly FeedItem[];
  readonly missed: number;
};

type SnapshotChunk = SnapshotMessage["chunks"][number];

/** The fragments of a chunk that enters, gathered so far. */
type Gathered = {
  readonly at: ChunkCoord;
  readonly v: number;
  readonly n: number;
  /** By fragment index, so that each fragment is found in constant time. */
  readonly frags: Map<number, SnapshotChunk>;
};

/** A transaction while its parts are read, with the snapshot fragments still apart. */
type Builder = {
  resets: Set<boolean>;
  drop: Map<string, ChunkCoord>;
  deltas: Map<string, ChunkDelta>;
  gathered: Map<string, Gathered>;
  followed: BeingPublic | null | undefined;
  feed: FeedItem[];
  missed: number;
};

/** Why an assembly failed. */
export class TransactionProblem {
  constructor(readonly detail: string) {}
}

/** Whether `being` lies in the chunk `at`: a chunk holds the beings of its 32 × 32 cells. */
export function liesIn(being: BeingPublic, [x, y]: ChunkCoord): boolean {
  // Exact: a cell is a safe integer, and ⌊cell / 32⌋ rounds toward negative infinity.
  const [cellX, cellY] = being.cell;
  return Math.floor(cellX / CHUNK_CELLS) === x && Math.floor(cellY / CHUNK_CELLS) === y;
}

/** Merges the differences of `delta`'s chunks, and its drops, into `builder`. */
function readDelta(builder: Builder, delta: DeltaMessage): TransactionProblem | undefined {
  for (const at of delta.drop) builder.drop.set(chunkKey(at), at);
  for (const chunk of delta.chunks) {
    const key = chunkKey(chunk.at);
    const merged = builder.deltas.get(key);
    if (merged !== undefined && merged.v !== chunk.v) {
      return new TransactionProblem(`chunk ${key} has two versions: ${merged.v} and ${chunk.v}`);
    }
    const into = merged ?? {
      at: chunk.at,
      v: chunk.v,
      gone: [],
      upsert: [],
      speech: [],
      speechMissed: 0,
    };
    into.gone.push(...chunk.gone);
    into.upsert.push(...chunk.upsert);
    into.speech.push(...chunk.speech);
    into.speechMissed += chunk.speechMissed ?? 0;
    builder.deltas.set(key, into);
  }
  return undefined;
}

/** Gathers the fragments of `snapshot`'s chunks into `builder`. */
function readSnapshot(builder: Builder, snapshot: SnapshotMessage): TransactionProblem | undefined {
  builder.resets.add(snapshot.reset);
  if (snapshot.followed !== undefined) builder.followed = snapshot.followed;
  for (const chunk of snapshot.chunks) {
    const key = chunkKey(chunk.at);
    const gathered = builder.gathered.get(key) ?? {
      at: chunk.at,
      v: chunk.v,
      n: chunk.frag.n,
      frags: new Map(),
    };
    if (gathered.v !== chunk.v || gathered.n !== chunk.frag.n) {
      return new TransactionProblem(
        `the fragments of chunk ${key} disagree on its version or count`,
      );
    }
    if (gathered.frags.has(chunk.frag.i)) {
      return new TransactionProblem(`chunk ${key} has fragment ${chunk.frag.i} twice`);
    }
    gathered.frags.set(chunk.frag.i, chunk);
    builder.gathered.set(key, gathered);
  }
  return undefined;
}

/** Adds the feed of `events` to `builder`. */
function readEvents(builder: Builder, events: EventsMessage): undefined {
  builder.feed.push(...events.items);
  builder.missed += events.missed ?? 0;
  return undefined;
}

/** Reads one part into `builder`. */
function readPart(builder: Builder, part: Part): TransactionProblem | undefined {
  if (part.type === "delta") return readDelta(builder, part);
  if (part.type === "snapshot") return readSnapshot(builder, part);
  return readEvents(builder, part);
}

/** The terrain of a chunk's fragments: exactly one of them carries it. */
function terrainOf(
  key: string,
  frags: ReadonlyMap<number, SnapshotChunk>,
): TerrainPublic | TransactionProblem {
  const terrains = [...frags.values()].flatMap(({ terrain }) =>
    terrain === undefined ? [] : [terrain],
  );
  const [terrain] = terrains;
  if (terrain === undefined || terrains.length > 1) {
    return new TransactionProblem(`chunk ${key} must carry its terrain in exactly one fragment`);
  }
  return terrain;
}

/**
 * The beings of a chunk's fragments, all of which arrived, in fragment order and by id: each once,
 * each inside the chunk.
 */
function beingsOf(key: string, gathered: Gathered): Map<number, BeingPublic> | TransactionProblem {
  const beings = new Map<number, BeingPublic>();
  for (let i = 0; i < gathered.n; i += 1) {
    for (const being of gathered.frags.get(i)?.beings ?? []) {
      if (beings.has(being.id)) {
        return new TransactionProblem(`chunk ${key} holds being ${being.id} twice`);
      }
      if (!liesIn(being, gathered.at)) {
        return new TransactionProblem(`being ${being.id} does not lie in chunk ${key}`);
      }
      beings.set(being.id, being);
    }
  }
  return beings;
}

/** The full content of a chunk from its gathered fragments, which must all have arrived. */
function contentOf(key: string, gathered: Gathered): ChunkContent | TransactionProblem {
  // Each index is below n and arrived once, so n fragments are all of them.
  if (gathered.frags.size !== gathered.n) {
    return new TransactionProblem(
      `chunk ${key} has ${gathered.frags.size} of ${gathered.n} fragments`,
    );
  }
  const terrain = terrainOf(key, gathered.frags);
  if (terrain instanceof TransactionProblem) return terrain;
  const beings = beingsOf(key, gathered);
  if (beings instanceof TransactionProblem) return beings;
  return { at: gathered.at, v: gathered.v, terrain, beings };
}

/** The content of every chunk that enters, or the first problem of one. */
function enteringOf(builder: Builder): Map<string, ChunkContent> | TransactionProblem {
  const entering = new Map<string, ChunkContent>();
  for (const [key, gathered] of builder.gathered) {
    const content = contentOf(key, gathered);
    if (content instanceof TransactionProblem) return content;
    entering.set(key, content);
  }
  return entering;
}

/** Why a builder's parts do not form a transaction; undefined when they do. */
function shapeProblem(builder: Builder): TransactionProblem | undefined {
  if (builder.resets.size > 1) return new TransactionProblem("snapshot parts disagree on reset");
  if (builder.resets.has(true) && (builder.drop.size > 0 || builder.deltas.size > 0)) {
    return new TransactionProblem("a reset replaces the whole view: it carries no delta");
  }
  return undefined;
}

/** The transaction `parts` form, in the order they arrived, or the first way they break it. */
export function assemble(parts: readonly Part[]): Transaction | TransactionProblem {
  const builder: Builder = {
    resets: new Set(),
    drop: new Map(),
    deltas: new Map(),
    gathered: new Map(),
    followed: undefined,
    feed: [],
    missed: 0,
  };
  for (const part of parts) {
    const problem = readPart(builder, part);
    if (problem !== undefined) return problem;
  }
  const problem = shapeProblem(builder);
  if (problem !== undefined) return problem;
  const entering = enteringOf(builder);
  if (entering instanceof TransactionProblem) return entering;
  const { drop, deltas, followed, feed, missed } = builder;
  return { reset: builder.resets.has(true), drop, deltas, entering, followed, feed, missed };
}
