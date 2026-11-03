/**
 * The memory guard of retained versions (ADR 0026, "Limits and backpressure"): at most 128 MiB of
 * replaced chunk versions stay pinned in all, configurable, counted exactly by the mirror and
 * checked after each period's fan-out. While above the limit, the oldest retained version, the one
 * replaced first, is taken, and every client that pins it is aborted: its transaction's pins go,
 * and, when it pins that version in its view at L, its view's pins too, so its next transaction is
 * a reset. The version replaced first is pinned by the clients furthest behind, never by a client
 * whose view and transaction are newer than its replacement.
 */
import type { ChunkVersion } from "./version.ts";

/** The default limit of retained bytes: 128 MiB. */
export const RETAINED_BYTES = 128 * 1024 * 1024;

/** What the guard reads of a client: the versions its view pins at L, and its transaction's. */
export type Pinner = {
  readonly view: { readonly pinned: ReadonlyMap<string, ChunkVersion> };
  readonly txn: { readonly pins: ReadonlyMap<string, ChunkVersion> } | undefined;
};

/** What the guard reads of the mirror. */
export type Retained = {
  readonly retainedBytes: number;
  oldestRetained(): ChunkVersion | undefined;
  /** Whether `version` was replaced and is still pinned. */
  retains(version: ChunkVersion): boolean;
};

/** The oldest version `mirror` retains while its retained bytes pass `limit`. */
function overLimit(mirror: Retained, limit: number): ChunkVersion | undefined {
  return mirror.retainedBytes > limit ? mirror.oldestRetained() : undefined;
}

/**
 * The clients of `clients` that pin each version `mirror` retains, in their order: one pass over
 * every client's pins, a client listed once per version even when its view and its transaction
 * both pin it.
 */
function holdersIndex<C extends Pinner>(
  mirror: Retained,
  clients: Iterable<C>,
): Map<ChunkVersion, C[]> {
  const index = new Map<ChunkVersion, C[]>();
  const add = (version: ChunkVersion, client: C) => {
    if (!mirror.retains(version)) return;
    const holders = index.get(version);
    if (holders === undefined) index.set(version, [client]);
    else if (holders.at(-1) !== client) holders.push(client);
  };
  for (const client of clients) {
    for (const version of client.view.pinned.values()) add(version, client);
    for (const version of client.txn?.pins.values() ?? []) add(version, client);
  }
  return index;
}

/**
 * While the versions `mirror` retains pass `limit` bytes, aborts every client of `clients` that pins
 * the oldest one, with `atL` when its view pins it at L, and returns the clients aborted, each once.
 * Throws when a version is still pinned once its clients were aborted: a fault, never a loop.
 *
 * `clients` is read once, and only when the limit is passed: the clients that pin each retained
 * version are indexed in one pass over their pins, so a check costs the pins plus the versions it
 * frees, not a pass over the clients per version. No pin is added while the guard runs, and the
 * holders of a version are checked again when it is taken, since aborting a client for an older
 * version may have released its pin of this one.
 */
export function guardRetention<C extends Pinner>(
  mirror: Retained,
  limit: number,
  clients: Iterable<C>,
  abort: (client: C, atL: boolean) => void,
): Set<C> {
  const aborted = new Set<C>();
  let holders: Map<ChunkVersion, C[]> | undefined;
  for (
    let oldest = overLimit(mirror, limit);
    oldest !== undefined;
    oldest = overLimit(mirror, limit)
  ) {
    holders ??= holdersIndex(mirror, clients);
    for (const client of holders.get(oldest) ?? []) {
      const atL = client.view.pinned.get(oldest.key) === oldest;
      if (!atL && client.txn?.pins.get(oldest.key) !== oldest) continue;
      abort(client, atL);
      aborted.add(client);
    }
    if (mirror.oldestRetained() === oldest) {
      const at = `version ${oldest.v} of chunk ${oldest.key}`;
      throw new Error(`the retained ${at} is still pinned once its clients were aborted`);
    }
  }
  return aborted;
}
