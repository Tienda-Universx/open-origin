/**
 * Immutable chunk versions (ADR 0026, "Interest and transactions"): the C0 content of one chunk at
 * the tick it last changed, `{v, records}`, with its being records sorted by id and encoded once.
 * The mirror makes a new version only when a published tick changes the chunk's C0 bytes, and the
 * current versions are shared by every client that shows them. The difference by id between two
 * versions is computed once per pair and shared too.
 */
import type { BeingPublic, ChunkCoord } from "@open-origin/protocol/public";
import { chunkKey, utf8Length } from "@open-origin/protocol/public";
import type { PublishedChunk } from "../world/published.ts";

/** A being's public record, with its JSON text and that text's size in UTF-8 bytes. */
export type EncodedBeing = {
  readonly id: number;
  readonly record: BeingPublic;
  readonly json: string;
  readonly bytes: number;
};

/** The ids that left a chunk between two versions, and the records that entered or changed. */
export type VersionDiff = {
  readonly gone: readonly number[];
  readonly upsert: readonly EncodedBeing[];
};

const NO_IDS: readonly number[] = Object.freeze([]);
const NO_DIFF: VersionDiff = Object.freeze({ gone: NO_IDS, upsert: Object.freeze([]) });

/** `record`, encoded once. */
export function encodeBeing(record: BeingPublic): EncodedBeing {
  const json = JSON.stringify(record);
  return Object.freeze({ id: record.id, record, json, bytes: utf8Length(json) });
}

/**
 * The records of `old` merged with `upsert`, sorted by id, without the ids `gone` lists: a record
 * of `upsert` replaces the one of the same id. `upsert` must be sorted by id.
 */
function merged(
  old: readonly EncodedBeing[],
  upsert: readonly EncodedBeing[],
  gone: ReadonlySet<number>,
): EncodedBeing[] {
  const records: EncodedBeing[] = [];
  let i = 0;
  let j = 0;
  while (i < old.length || j < upsert.length) {
    const kept = old[i];
    const added = upsert[j];
    if (added === undefined || (kept !== undefined && kept.id < added.id)) {
      if (kept !== undefined && !gone.has(kept.id)) records.push(kept);
      i += 1;
    } else {
      records.push(added);
      if (kept?.id === added.id) i += 1;
      j += 1;
    }
  }
  return records;
}

/** The difference by id from `old` to `now`, both sorted by id: what left, and what is new. */
function diffOf(old: readonly EncodedBeing[], now: readonly EncodedBeing[]): VersionDiff {
  const gone: number[] = [];
  const upsert: EncodedBeing[] = [];
  let j = 0;
  for (const before of old) {
    // The records of `now` whose ids come before this one entered the chunk.
    for (let after = now[j]; after !== undefined && after.id < before.id; after = now[j]) {
      upsert.push(after);
      j += 1;
    }
    const same = now[j];
    if (same?.id !== before.id) {
      gone.push(before.id);
      continue;
    }
    if (same.json !== before.json) upsert.push(same);
    j += 1;
  }
  for (; j < now.length; j += 1) {
    const after = now[j];
    if (after !== undefined) upsert.push(after);
  }
  return Object.freeze({ gone: Object.freeze(gone), upsert: Object.freeze(upsert) });
}

/** One immutable version of a chunk's C0 content. */
export class ChunkVersion {
  readonly key: string;
  readonly at: ChunkCoord;
  /** The tick at which the chunk's C0 content last changed. */
  readonly v: number;
  /** The chunk's beings, sorted by id. */
  readonly records: readonly EncodedBeing[];
  /** The UTF-8 bytes of the records' JSON, which retained versions count. */
  readonly bytes: number;
  /**
   * Whether the mirror holds it. A chunk that held no being since boot has no held version: its
   * content is an empty version at the boot tick, made where it is read, which pins nothing.
   */
  readonly held: boolean;
  /** The differences from older versions to this one, keyed weakly by the older version. */
  readonly #diffs = new WeakMap<ChunkVersion, VersionDiff>();

  private constructor(at: ChunkCoord, v: number, records: readonly EncodedBeing[], held: boolean) {
    this.key = chunkKey(at);
    this.at = at;
    this.v = v;
    this.records = Object.freeze(records);
    this.bytes = records.reduce((sum, record) => sum + record.bytes, 0);
    this.held = held;
  }

  /** The empty content, at version `v`, of the chunk `at`, which no published tick changed yet. */
  static empty(at: ChunkCoord, v: number): ChunkVersion {
    return new ChunkVersion(at, v, [], false);
  }

  /** The version that `change`, a published change of this chunk, makes of this one. */
  next(change: PublishedChunk): ChunkVersion {
    const upsert = change.upsert.map(encodeBeing).sort((a, b) => a.id - b.id);
    const records = merged(this.records, upsert, new Set(change.gone));
    return new ChunkVersion(change.at, change.v, records, true);
  }

  /** The record of the being `id`, or undefined when this version does not hold it. */
  find(id: number): EncodedBeing | undefined {
    let low = 0;
    let high = this.records.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const record = this.records[middle];
      if (record === undefined || record.id === id) return record;
      if (record.id < id) low = middle + 1;
      else high = middle - 1;
    }
    return undefined;
  }

  /**
   * The difference by id from `old`, an earlier version of the same chunk, to this one: computed
   * once per pair, then shared by every client that needs it.
   */
  diffFrom(old: ChunkVersion): VersionDiff {
    if (old === this) return NO_DIFF;
    if (old.records.length === 0) return Object.freeze({ gone: NO_IDS, upsert: this.records });
    const cached = this.#diffs.get(old);
    if (cached !== undefined) return cached;
    const diff = diffOf(old.records, this.records);
    this.#diffs.set(old, diff);
    return diff;
  }
}
