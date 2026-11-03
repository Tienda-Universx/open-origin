/**
 * The memory guard of retained versions (ADR 0026, "Limits and backpressure"): at most 128 MiB of
 * replaced chunk versions stay pinned in all, configurable, counted exactly by the mirror and
 * checked after each period's fan-out. While above the limit, the oldest retained version, the one
 * replaced first, is taken, and every client that pins it is aborted: its transaction's pins go,
 * and, when it pins that version in its view at L, its view's pins too, so its next transaction is
 * a reset. The version replaced first is pinned by the clients furthest behind, never by a client
 * whose view and transaction are newer than its replacement.
 */
import type { Client } from "./client.ts";
import type { ChunkVersion } from "./version.ts";

/** The default limit of retained bytes: 128 MiB. */
export const RETAINED_BYTES = 128 * 1024 * 1024;

/** A client that pins a version, and whether its view at L pins it. */
export type Holder = { readonly client: Client; readonly atL: boolean };

/** The clients of `clients` that pin `version`, in their transaction or in their view at L. */
export function holdersOf(clients: Iterable<Client>, version: ChunkVersion): Holder[] {
  const holders: Holder[] = [];
  for (const client of clients) {
    const atL = client.view.pinned.get(version.key) === version;
    const inTransaction = client.txn?.pins.get(version.key) === version;
    if (atL || inTransaction) holders.push({ client, atL });
  }
  return holders;
}
