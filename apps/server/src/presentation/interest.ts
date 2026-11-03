/**
 * Interest (ADR 0026, "Interest and transactions"): what each client wants to see. Its effective
 * interest is its camera, at most 64 chunks that each `subscribe` replaces, joined with its follow
 * window, the followed being's chunk ± 1, at most 9 chunks, which moves with the being. An inverted
 * index maps each chunk to the clients whose effective interest holds it, and the followers of each
 * being are counted: observation telemetry (C3), which the world plane cannot import.
 */
import {
  type ChunkCoord,
  CLIENT_LIMITS,
  chunkKey,
  distinctChunks,
  MAX_CHUNK,
  MIN_CHUNK,
} from "@open-origin/protocol/public";

/** A client of the presentation plane, by the number it was given when it connected. */
export type ClientId = number;

/** The offsets of the follow window: the center first, then its neighbors row by row. */
const WINDOW: readonly (readonly [number, number])[] = Object.freeze([
  [0, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
]);

/**
 * The follow window around `center`: the chunks at ± 1 on each axis that lie in the world, the
 * center first, so a view that must be trimmed keeps the followed being's own chunk first.
 */
export function followWindow([x, y]: ChunkCoord): ChunkCoord[] {
  const window: ChunkCoord[] = [];
  for (const [dx, dy] of WINDOW) {
    const at: ChunkCoord = [x + dx, y + dy];
    if (at.every((axis) => axis >= MIN_CHUNK && axis <= MAX_CHUNK)) window.push(at);
  }
  return window;
}

/** One client's interest. */
type Wants = {
  camera: readonly ChunkCoord[];
  /** The followed being, or null. */
  target: number | null;
  window: readonly ChunkCoord[];
  /** The effective interest, by chunk key: the window first, then the camera in its order. */
  effective: ReadonlyMap<string, ChunkCoord>;
};

/** The interest of every client, the inverted index, and the followers of each being. */
export class Interest {
  readonly #wants = new Map<ClientId, Wants>();
  readonly #index = new Map<string, Set<ClientId>>();
  readonly #followers = new Map<number, number>();

  /** Starts tracking `client`, which wants nothing yet. */
  add(client: ClientId): void {
    if (this.#wants.has(client)) throw new Error(`client ${client} is already tracked`);
    this.#wants.set(client, { camera: [], target: null, window: [], effective: new Map() });
  }

  /**
   * Replaces the camera of `client` with `chunks`, which the transport already checked: at most
   * 64, each once. An empty list cancels it.
   */
  subscribe(client: ClientId, chunks: readonly ChunkCoord[]): void {
    if (chunks.length > CLIENT_LIMITS.maxChunks || !distinctChunks(chunks)) {
      throw new RangeError(`a camera holds at most ${CLIENT_LIMITS.maxChunks} distinct chunks`);
    }
    const wants = this.#of(client);
    wants.camera = chunks.map(([x, y]): ChunkCoord => [x, y]);
    this.#reindex(client, wants);
  }

  /** How many chunks of `chunks` the camera of `client` does not hold. */
  added(client: ClientId, chunks: readonly ChunkCoord[]): number {
    const camera = new Set(this.#of(client).camera.map(chunkKey));
    return chunks.filter((at) => !camera.has(chunkKey(at))).length;
  }

  /** Makes `client` follow `being`, or nothing for null. The window moves with `moveWindow`. */
  follow(client: ClientId, being: number | null): void {
    const wants = this.#of(client);
    this.#count(wants.target, -1);
    wants.target = being;
    this.#count(being, 1);
  }

  /** The being `client` follows, or null. */
  target(client: ClientId): number | null {
    return this.#of(client).target;
  }

  /** Centers the follow window of `client` on `center`, the followed being's chunk; none for undefined. */
  moveWindow(client: ClientId, center: ChunkCoord | undefined): void {
    const wants = this.#of(client);
    wants.window = center === undefined ? [] : followWindow(center);
    this.#reindex(client, wants);
  }

  /** The effective interest of `client`: its window first, then its camera, each chunk once. */
  effective(client: ClientId): readonly ChunkCoord[] {
    return [...this.#of(client).effective.values()];
  }

  /** Stops tracking `client`: its interest, its index entries, and its following go. */
  remove(client: ClientId): void {
    const wants = this.#of(client);
    this.#count(wants.target, -1);
    for (const key of wants.effective.keys()) this.#unindex(key, client);
    this.#wants.delete(client);
  }

  /** The clients whose effective interest holds the chunk `at`. */
  clientsOf(at: ChunkCoord): ReadonlySet<ClientId> {
    return this.#index.get(chunkKey(at)) ?? new Set();
  }

  /** How many clients follow `being` (C3). */
  followers(being: number): number {
    return this.#followers.get(being) ?? 0;
  }

  /** How many clients are tracked, how many chunk entries the index holds, and how many followings. */
  usage(): { readonly clients: number; readonly indexEntries: number; readonly following: number } {
    let indexEntries = 0;
    for (const clients of this.#index.values()) indexEntries += clients.size;
    let following = 0;
    for (const count of this.#followers.values()) following += count;
    return { clients: this.#wants.size, indexEntries, following };
  }

  #of(client: ClientId): Wants {
    const wants = this.#wants.get(client);
    if (wants === undefined) throw new Error(`client ${client} is not tracked`);
    return wants;
  }

  #count(being: number | null, by: 1 | -1): void {
    if (being === null) return;
    const count = (this.#followers.get(being) ?? 0) + by;
    if (count === 0) this.#followers.delete(being);
    else this.#followers.set(being, count);
  }

  /** Recomputes the effective interest of `client` and moves its index entries. */
  #reindex(client: ClientId, wants: Wants): void {
    const effective = new Map<string, ChunkCoord>();
    for (const at of [...wants.window, ...wants.camera]) effective.set(chunkKey(at), at);
    for (const key of wants.effective.keys()) if (!effective.has(key)) this.#unindex(key, client);
    for (const key of effective.keys()) {
      const clients = this.#index.get(key) ?? new Set();
      clients.add(client);
      this.#index.set(key, clients);
    }
    wants.effective = effective;
  }

  #unindex(key: string, client: ClientId): void {
    const clients = this.#index.get(key);
    clients?.delete(client);
    if (clients?.size === 0) this.#index.delete(key);
  }
}
