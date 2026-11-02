/**
 * Builders of valid server messages for the protocol's tests. Each builder parses what it builds
 * with the ServerMessage schema, so a fixture that breaks the protocol fails where it is made.
 */
import {
  type BeingPublic,
  type ChunkCoord,
  CLIENT_LIMITS,
  encodeTerrain,
  ServerMessage,
  type TerrainPublic,
} from "../../src/public/index.ts";

export const WORLD_ID = "0123456789abcdef0123456789abcdef";

/** The clock of `tick`, as a server with 100 ticks a day would compute it. */
export function clockAt(tick: number) {
  return { tick, day: Math.floor(tick / 100), dayPermille: (tick % 100) * 10 };
}

/** A flat terrain: every cell at elevation 0, under no liquid, on substrate 0. */
export const TERRAIN: TerrainPublic = encodeTerrain(
  {
    elevation: Array.from({ length: 1024 }, () => 0),
    liquidDepth: Array.from({ length: 1024 }, () => 0),
    substrate: Array.from({ length: 1024 }, () => 0),
  },
  {
    elevation: { min: -100, max: 100 },
    liquidDepth: { min: 0, max: 100 },
    substrate: { min: 0, max: 3 },
  },
);

/** A being `id` at `cell`, idle unless `activity` says otherwise. */
export function being(
  id: number,
  cell: readonly [number, number],
  activity: BeingPublic["activity"] = { kind: "idle" },
): BeingPublic {
  return { id, species: "s1", stage: "adult", born: 0, cell: [cell[0], cell[1]], activity };
}

/** The message `fields` describes, checked by the schema. */
export function message(fields: object): ServerMessage {
  return ServerMessage.parse(fields);
}

/** `hello` at `tick`. */
export function hello(tick: number, state = "running"): ServerMessage {
  return message({
    type: "hello",
    seq: 0,
    tick,
    protocol: "open-origin.public.v1",
    audience: "public",
    world: { id: WORLD_ID },
    durability: "ephemeral",
    state,
    clock: clockAt(tick),
    limits: { ...CLIENT_LIMITS },
  });
}

/** Where a message sits: its seq, its tick, and its transaction. */
export type At = { readonly seq: number; readonly tick: number; readonly txn: number };

/** A visible chunk's differences. */
export type DeltaChunk = {
  readonly at: ChunkCoord;
  readonly v: number;
  readonly gone?: readonly number[];
  readonly upsert?: readonly BeingPublic[];
  readonly speech?: readonly object[];
  readonly speechMissed?: number;
};

/** A `delta` part with `chunks` and `drop`. */
export function delta(at: At, chunks: readonly DeltaChunk[], drop: readonly ChunkCoord[] = []) {
  return message({
    type: "delta",
    ...at,
    chunks: chunks.map((chunk) => ({ gone: [], upsert: [], speech: [], ...chunk })),
    drop,
  });
}

/** A fragment of a chunk's full content: fragment 0 of 1 with the terrain, unless told. */
export type SnapshotChunk = {
  readonly at: ChunkCoord;
  readonly v: number;
  readonly beings?: readonly BeingPublic[];
  readonly frag?: { readonly i: number; readonly n: number };
  readonly terrain?: TerrainPublic | null;
};

/** A `snapshot` part; a chunk carries TERRAIN unless its `terrain` is null. */
export function snapshot(
  at: At,
  chunks: readonly SnapshotChunk[],
  options: { readonly reset?: boolean; readonly followed?: BeingPublic | null } = {},
) {
  return message({
    type: "snapshot",
    ...at,
    reset: options.reset ?? false,
    chunks: chunks.map(({ terrain, beings = [], frag = { i: 0, n: 1 }, ...chunk }) => ({
      ...chunk,
      beings,
      frag,
      ...(terrain === null ? {} : { terrain: terrain ?? TERRAIN }),
    })),
    ...(options.followed === undefined ? {} : { followed: options.followed }),
  });
}

/** An `events` part. */
export function events(at: At, items: readonly object[], missed?: number) {
  return message({ type: "events", ...at, items, ...(missed === undefined ? {} : { missed }) });
}

/** The `commit` of a transaction. */
export function commit(at: At) {
  return message({ type: "commit", ...at, clock: clockAt(at.tick) });
}

/** The `abort` of a transaction. */
export function abort(at: At) {
  return message({ type: "abort", ...at });
}
