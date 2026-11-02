/**
 * Support for the presentation plane's tests: a model world that publishes ticks the way the C0
 * projection does and remembers its public state at every tick, the oracle every view is compared
 * with; a client that reads its frames with the protocol's strict schema and applies them with the
 * reference reducer, `applyMessage`; terrain that differs from chunk to chunk; and a presentation
 * over a model world, driven period by period.
 */
import {
  type Anomaly,
  applyMessage,
  type BeingPublic,
  type ChunkCoord,
  type ClientState,
  type Committed,
  chunkKey,
  encodeTerrain,
  type FeedItem,
  initialClientState,
  type LocalSpeech,
  MAX_PART_BYTES,
  PlainText,
  parseServerMessage,
  type ServerMessage,
  type TerrainPublic,
  utf8Length,
} from "@open-origin/protocol/public";
import {
  type ClientSink,
  Presentation,
  type PresentationOptions,
} from "../../src/presentation/presentation.ts";
import type {
  PublishedChunk,
  PublishedListener,
  PublishedTick,
} from "../../src/world/published.ts";
import { FakeClock, FakeTimer } from "./fake-time.ts";

/** `text`, checked as the plain text every text field holds. */
export function plain(text: string): PlainText {
  return PlainText.parse(text);
}

/** The world id hello announces in these tests. */
export const WORLD_ID = "0123456789abcdef0123456789abcdef";

/** The chunk of `cell`: a chunk holds 32 × 32 cells, and ⌊cell / 32⌋ rounds toward −∞. */
export function chunkOfCell([x, y]: readonly [number, number]): ChunkCoord {
  return [Math.floor(x / 32), Math.floor(y / 32)];
}

/** The terrain of each chunk asked for so far, by key. */
const TERRAINS = new Map<string, TerrainPublic>();

/**
 * The terrain of a chunk, which differs from chunk to chunk: its first cell's elevation says which.
 * The same object is returned for the same chunk.
 */
export function terrainAt([x, y]: ChunkCoord): TerrainPublic {
  const key = chunkKey([x, y]);
  const known = TERRAINS.get(key);
  if (known !== undefined) return known;
  const elevation = Array.from({ length: 1024 }, (_, cell) =>
    cell === 0 ? (x * 7 + y * 13) % 100 : 0,
  );
  const terrain = encodeTerrain(
    { elevation, liquidDepth: Array(1024).fill(0), substrate: Array(1024).fill(0) },
    {
      elevation: { min: -100, max: 100 },
      liquidDepth: { min: 0, max: 100 },
      substrate: { min: 0, max: 15 },
    },
  );
  TERRAINS.set(key, terrain);
  return terrain;
}

/** A being of species `s1`, idle unless `activity` is given. */
export function being(
  id: number,
  cell: readonly [number, number],
  activity: BeingPublic["activity"] = { kind: "idle" },
): BeingPublic {
  return { id, species: "s1", stage: "adult", born: 0, cell: [cell[0], cell[1]], activity };
}

/** A chunk as the public sees it at a tick: its version and its beings by id. */
export type ChunkState = { readonly v: number; readonly beings: ReadonlyMap<number, BeingPublic> };

/** The public world at one tick: its clock, its chunks that ever held a being, and every being. */
export type WorldAt = {
  readonly tick: number;
  readonly chunks: ReadonlyMap<string, ChunkState>;
  readonly beings: ReadonlyMap<number, BeingPublic>;
};

/** What one tick of the model does: beings that are set (enter or change), leave, speak, and feed. */
export type TickChanges = {
  readonly set?: readonly BeingPublic[];
  readonly leave?: readonly number[];
  readonly speech?: readonly LocalSpeech[];
  readonly feed?: readonly FeedItem[];
};

/** The clock of `tick` in the model: 100 ticks a day. */
export function clockAt(tick: number) {
  return { tick, day: Math.floor(tick / 100), dayPermille: (tick % 100) * 10 };
}

/**
 * A model of the public world: it publishes each tick as the projection does, a chunk only when
 * its C0 bytes change, with `upsert` and `gone` by id, and keeps its public state at every tick.
 */
export class ModelWorld {
  readonly #beings = new Map<number, BeingPublic>();
  readonly #versions = new Map<string, number>();
  readonly #history = new Map<number, WorldAt>();
  #tick: number;

  constructor(boot: number, beings: readonly BeingPublic[] = []) {
    this.#tick = boot;
    for (const record of beings) this.#beings.set(record.id, record);
    for (const record of beings) this.#versions.set(chunkKey(chunkOfCell(record.cell)), boot);
    this.#remember();
  }

  get tick(): number {
    return this.#tick;
  }

  /** The beings now. */
  get beings(): ReadonlyMap<number, BeingPublic> {
    return this.#beings;
  }

  /** The boot record: every chunk that holds a being, whole, at the boot tick. */
  boot(): PublishedTick {
    const at = this.at(this.#tick);
    const chunks: PublishedChunk[] = [...at.chunks].flatMap(([key, chunk]) =>
      chunk.beings.size === 0
        ? []
        : [{ at: parseKey(key), v: chunk.v, upsert: [...chunk.beings.values()], gone: [] }],
    );
    return { tick: this.#tick, clock: clockAt(this.#tick), chunks, speech: [], feed: [] };
  }

  /** Runs one tick of `changes` and returns what it publishes. */
  step(changes: TickChanges = {}): PublishedTick {
    const tick = this.#tick + 1;
    const before = this.at(this.#tick);
    for (const id of changes.leave ?? []) this.#beings.delete(id);
    for (const record of changes.set ?? []) this.#beings.set(record.id, record);
    this.#tick = tick;
    const chunks = this.#changes(before, tick);
    this.#remember();
    return {
      tick,
      clock: clockAt(tick),
      chunks,
      speech: changes.speech ?? [],
      feed: changes.feed ?? [],
    };
  }

  /** The public world at `tick`. */
  at(tick: number): WorldAt {
    const world = this.#history.get(tick);
    if (world === undefined) throw new Error(`the model holds no tick ${tick}`);
    return world;
  }

  /** The chunks whose C0 bytes changed since `before`, with new versions at `tick`. */
  #changes(before: WorldAt, tick: number): PublishedChunk[] {
    const after = groupByChunk(this.#beings);
    const keys = new Set([...before.chunks.keys(), ...after.keys()]);
    const chunks: PublishedChunk[] = [];
    for (const key of keys) {
      const old = before.chunks.get(key)?.beings ?? new Map<number, BeingPublic>();
      const now = after.get(key) ?? new Map<number, BeingPublic>();
      const upsert = [...now.values()].filter(
        (record) => JSON.stringify(old.get(record.id)) !== JSON.stringify(record),
      );
      const gone = [...old.keys()].filter((id) => !now.has(id));
      if (upsert.length === 0 && gone.length === 0) continue;
      this.#versions.set(key, tick);
      chunks.push({ at: parseKey(key), v: tick, upsert, gone });
    }
    return chunks;
  }

  #remember(): void {
    const grouped = groupByChunk(this.#beings);
    const chunks = new Map<string, ChunkState>();
    for (const [key, v] of this.#versions)
      chunks.set(key, { v, beings: grouped.get(key) ?? new Map() });
    this.#history.set(this.#tick, { tick: this.#tick, chunks, beings: new Map(this.#beings) });
  }
}

/** The chunk `[x, y]` of its key. */
export function parseKey(key: string): ChunkCoord {
  const [x, y] = key.split(",").map(Number);
  return [x ?? 0, y ?? 0];
}

/** `beings` by chunk key, then by id. */
function groupByChunk(
  beings: ReadonlyMap<number, BeingPublic>,
): Map<string, Map<number, BeingPublic>> {
  const grouped = new Map<string, Map<number, BeingPublic>>();
  for (const record of beings.values()) {
    const key = chunkKey(chunkOfCell(record.cell));
    const chunk = grouped.get(key) ?? new Map<number, BeingPublic>();
    chunk.set(record.id, record);
    grouped.set(key, chunk);
  }
  return grouped;
}

/**
 * A client of the presentation: each frame it is sent is parsed by the protocol's strict schema
 * and applied by the reference reducer. It records every message, commit, and anomaly, the size of
 * every frame, and may lag or lose its next frame.
 */
export class ViewClient implements ClientSink {
  state: ClientState = initialClientState();
  readonly messages: ServerMessage[] = [];
  readonly commits: Committed[] = [];
  readonly anomalies: Anomaly[] = [];
  /** The size in bytes of every frame received. */
  readonly sizes: number[] = [];
  /** Whether the client says its buffer is full. */
  lag = false;
  /** How many of the next frames are lost before the reducer sees them. */
  lose = 0;
  /** Called with each message the client receives, before the reducer applies it. */
  onMessage: ((message: ServerMessage) => void) | undefined;
  /** Called after each commit the reducer applied. */
  onCommit: ((committed: Committed) => void) | undefined;

  send(frame: string): void {
    this.sizes.push(utf8Length(frame));
    const parsed = parseServerMessage(frame);
    if (!parsed.ok)
      throw new Error(`the server sent a message the schema rejects: ${frame.slice(0, 200)}`);
    if (this.lose > 0) {
      this.lose -= 1;
      return;
    }
    this.messages.push(parsed.message);
    this.onMessage?.(parsed.message);
    const applied = applyMessage(this.state, parsed.message);
    this.state = applied.state;
    if (applied.anomaly !== undefined) this.anomalies.push(applied.anomaly);
    if (applied.committed !== undefined) {
      this.commits.push(applied.committed);
      this.onCommit?.(applied.committed);
    }
  }

  lagging(): boolean {
    return this.lag;
  }

  /** The largest frame received, which no part may make larger than MAX_PART_BYTES. */
  get largest(): number {
    return Math.max(0, ...this.sizes);
  }
}

/** Every frame `client` received was at most MAX_PART_BYTES. */
export function withinParts(client: ViewClient): boolean {
  return client.largest <= MAX_PART_BYTES;
}

/** The world plane's side of a presentation: its boot record, then each published tick. */
export class Publisher {
  readonly #listeners = new Set<PublishedListener>();
  readonly #boot: PublishedTick;

  constructor(boot: PublishedTick) {
    this.#boot = boot;
  }

  subscribe = (listener: PublishedListener): (() => void) => {
    listener(this.#boot);
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  publish(published: PublishedTick): void {
    for (const listener of this.#listeners) listener(published);
  }
}

/** A presentation over a model world, driven period by period by the test. */
export function presentationOver(
  model: ModelWorld,
  options: Partial<Omit<PresentationOptions, "subscribeToPublished">> = {},
) {
  const publisher = new Publisher(model.boot());
  const clock = new FakeClock();
  const presentation = new Presentation({
    subscribeToPublished: publisher.subscribe,
    readTerrain: terrainAt,
    clock,
    timer: new FakeTimer(clock),
    tickRateHz: 5,
    batchTicks: 5,
    world: { id: WORLD_ID, durability: "ephemeral" },
    ...options,
  });
  /** Runs one tick of the model, publishes it, and lets one period pass. */
  const advance = (changes?: TickChanges): void => {
    publisher.publish(model.step(changes));
    presentation.period();
  };
  return { presentation, publisher, advance };
}

/** What a view shows, in the shape of the model's state: by chunk key, version and beings. */
export function shown(state: ClientState): Map<string, ChunkState> {
  const view = state.view;
  const chunks = new Map<string, ChunkState>();
  for (const [key, chunk] of view?.chunks ?? [])
    chunks.set(key, { v: chunk.v, beings: new Map(chunk.beings) });
  return chunks;
}

/**
 * The view the model expects at `tick` for the chunks `keys`: each chunk's version and beings, an
 * untouched chunk empty at the boot tick `boot`.
 */
export function expected(model: ModelWorld, tick: number, keys: Iterable<string>, boot: number) {
  const world = model.at(tick);
  const chunks = new Map<string, ChunkState>();
  for (const key of keys) chunks.set(key, world.chunks.get(key) ?? { v: boot, beings: new Map() });
  return chunks;
}

/** The follow window around the chunk of `cell`. */
export function windowKeys(cell: readonly [number, number]): string[] {
  const [x, y] = chunkOfCell(cell);
  const keys: string[] = [];
  for (let dy = -1; dy <= 1; dy += 1)
    for (let dx = -1; dx <= 1; dx += 1) keys.push(chunkKey([x + dx, y + dy]));
  return keys;
}
