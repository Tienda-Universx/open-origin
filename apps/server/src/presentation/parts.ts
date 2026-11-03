/**
 * The parts of a transaction (ADR 0026, "Fragmentation"): its content split into `delta`,
 * `snapshot`, and `events` messages of at most `limit` bytes each, broken on record boundaries.
 * Each part is filled against an upper bound of its size, every integer of its frame counted at
 * its widest, so no part passes `limit` whatever its `seq`. A chunk's differences may span several
 * parts, each with the chunk once; a chunk that enters is cut into fragments that each fit in a
 * part, `frag{i, n}`, with its terrain in the first, so `n` is known before any fragment goes out.
 * The parts are produced one at a time, and read only pinned versions, so a transaction that spans
 * several periods still sends the content of its tick while the world moves on.
 */
import {
  type ChunkCoord,
  MAX_BEING_RECORD_BYTES,
  MAX_VIEW_CHUNKS,
  MIN_CHUNK,
} from "@open-origin/protocol/public";
import { byteLength } from "./bytes.ts";
import { type Frame, frameOf, headBytes, WIDEST_INTEGER as W } from "./frames.ts";
import type { RingItem } from "./ring.ts";
import type { ChunkVersion, EncodedBeing } from "./version.ts";

/** The tick and the id of the transaction that every part carries. */
export type PartHead = { readonly tick: number; readonly txn: number };

/** A JSON text and its size in UTF-8 bytes. */
export type EncodedText = { readonly json: string; readonly bytes: number };

/** The differences of one visible chunk, and its speech, as a transaction sends them. */
export type DeltaContent = {
  readonly at: ChunkCoord;
  readonly v: number;
  readonly gone: readonly number[];
  readonly upsert: readonly EncodedBeing[];
  readonly speech: readonly RingItem[];
  readonly speechMissed: number;
};

/** A chunk that enters the view: its pinned version and its terrain. */
export type Entering = { readonly version: ChunkVersion; readonly terrain: EncodedText };

/** A chunk coordinate at its widest. */
const WIDEST_AT = `[${MIN_CHUNK},${MIN_CHUNK}]`;

/** The most bytes of a delta frame around its entries and drops. */
const DELTA_FRAME = headBytes("delta") + `"tick":${W},"txn":${W},"chunks":[],"drop":[]}`.length;
/** The most bytes of one delta entry around its items, with the comma before it. */
const DELTA_ENTRY =
  `{"at":${WIDEST_AT},"v":${W},"gone":[],"upsert":[],"speech":[],"speechMissed":${W}},`.length;
/** The most bytes of one dropped chunk, with its comma. */
const DROP = WIDEST_AT.length + 1;
/** The most bytes of a snapshot frame around its fragments and its followed record. */
const SNAPSHOT_FRAME =
  headBytes("snapshot") + `"tick":${W},"txn":${W},"reset":false,"chunks":[],"followed":}`.length;
/** The most bytes of one fragment around its terrain and records, with its comma. */
const FRAGMENT = `{"at":${WIDEST_AT},"v":${W},"terrain":,"beings":[],"frag":{"i":${W},"n":${W}}},`
  .length;
/** The most bytes of an events frame around its items. */
const EVENTS_FRAME =
  headBytes("events") + `"tick":${W},"txn":${W},"items":[],"missed":${W}}`.length;

/** The texts of one part being filled, against an upper bound of its frame's bytes. */
class Filling {
  readonly texts: string[] = [];
  readonly #limit: number;
  #bound: number;

  constructor(frame: number, limit: number) {
    if (frame > limit) throw new RangeError(`a part of ${limit} bytes cannot hold ${frame}`);
    this.#bound = frame;
    this.#limit = limit;
  }

  /** Whether `bytes` more fit, and one more entry of the message's chunks, when `entry`. */
  fits(bytes: number, entry = false): boolean {
    if (entry && this.texts.length >= MAX_VIEW_CHUNKS) return false;
    return this.#bound + bytes <= this.#limit;
  }

  take(bytes: number): void {
    this.#bound += bytes;
  }
}

/** One delta entry of a chunk, filled item by item. */
class DeltaEntry {
  readonly gone: string[] = [];
  readonly upsert: string[] = [];
  readonly speech: string[] = [];
  readonly #chunk: DeltaContent;
  readonly #missed: number;

  constructor(chunk: DeltaContent, missed: number) {
    this.#chunk = chunk;
    this.#missed = missed;
  }

  get chunk(): DeltaContent {
    return this.#chunk;
  }

  text(): string {
    const { at, v } = this.#chunk;
    const missed = this.#missed > 0 ? `,"speechMissed":${this.#missed}` : "";
    const [gone, upsert, speech] = [this.gone, this.upsert, this.speech].map((items) =>
      items.join(","),
    );
    const lists = `"gone":[${gone}],"upsert":[${upsert}],"speech":[${speech}]`;
    return `{"at":${JSON.stringify(at)},"v":${v},${lists}${missed}}`;
  }
}

/** An item of a delta entry: a gone id, an upserted record, or an item of speech. */
type DeltaItem = {
  readonly into: "gone" | "upsert" | "speech";
  readonly json: string;
  readonly bytes: number;
};

function* itemsOf(chunk: DeltaContent): Generator<DeltaItem> {
  for (const id of chunk.gone) yield { into: "gone", json: String(id), bytes: String(id).length };
  for (const { json, bytes } of chunk.upsert) yield { into: "upsert", json, bytes };
  for (const { json, bytes } of chunk.speech) yield { into: "speech", json, bytes };
}

/** Fills delta parts with drops and entries, and keeps each finished part until it is taken. */
class DeltaPacker {
  readonly #head: PartHead;
  readonly #limit: number;
  #ready: Frame[] = [];
  #part: Filling;
  #drop: readonly ChunkCoord[];
  #entry: DeltaEntry | undefined;

  constructor(head: PartHead, drop: readonly ChunkCoord[], limit: number) {
    this.#head = head;
    this.#limit = limit;
    this.#drop = drop;
    this.#part = new Filling(DELTA_FRAME + drop.length * DROP, limit);
  }

  /** Opens the entry of `chunk`, in a new part when this one is full. */
  open(chunk: DeltaContent): void {
    if (!this.#part.fits(DELTA_ENTRY, true)) this.#flush();
    this.#part.take(DELTA_ENTRY);
    this.#entry = new DeltaEntry(chunk, chunk.speechMissed);
  }

  /** Adds `item` to the open entry; when the part is full, the entry goes on in a new part. */
  add(item: DeltaItem): void {
    const entry = this.#entry;
    if (entry === undefined) throw new Error("no delta entry is open");
    if (!this.#part.fits(item.bytes + 1)) {
      this.#flush();
      this.#part.take(DELTA_ENTRY);
      // The chunk appears again in the new part, with the same version and no missed count.
      this.#entry = new DeltaEntry(entry.chunk, 0);
    }
    this.#part.take(item.bytes + 1);
    this.#entry?.[item.into].push(item.json);
  }

  close(): void {
    if (this.#entry !== undefined) this.#part.texts.push(this.#entry.text());
    this.#entry = undefined;
  }

  /** The parts finished so far, which leave the packer. */
  take(): Frame[] {
    const ready = this.#ready;
    this.#ready = [];
    return ready;
  }

  /** Finishes the part being filled. */
  finish(): void {
    this.close();
    const { tick, txn } = this.#head;
    const chunks = this.#part.texts.join(",");
    const drop = JSON.stringify(this.#drop);
    this.#ready.push(
      frameOf("delta", `"tick":${tick},"txn":${txn},"chunks":[${chunks}],"drop":${drop}}`),
    );
  }

  #flush(): void {
    this.finish();
    this.#drop = [];
    this.#part = new Filling(DELTA_FRAME, this.#limit);
  }
}

/** The delta parts of `chunks`, the differences of visible chunks, with `drop` in the first. */
export function* deltaParts(
  head: PartHead,
  drop: readonly ChunkCoord[],
  chunks: readonly DeltaContent[],
  limit: number,
): Generator<Frame> {
  const packer = new DeltaPacker(head, drop, limit);
  for (const chunk of chunks) {
    packer.open(chunk);
    for (const item of itemsOf(chunk)) {
      packer.add(item);
      yield* packer.take();
    }
    packer.close();
  }
  packer.finish();
  yield* packer.take();
}

/** A fragment of a chunk's full content: its records from `from` to before `to`, and its bytes. */
type Fragment = { readonly from: number; readonly to: number; readonly bytes: number };

/** The most bytes of a fragment's terrain and records that a part of `limit` bytes always holds. */
export function fragmentCap(limit: number): number {
  return limit - SNAPSHOT_FRAME - MAX_BEING_RECORD_BYTES - FRAGMENT;
}

/** The fragments of `chunk`, each at most `cap` bytes, with the terrain in the first. */
function fragmentsOf({ version, terrain }: Entering, cap: number): Fragment[] {
  const fragments: Fragment[] = [];
  let from = 0;
  let bytes = terrain.bytes;
  version.records.forEach((record, index) => {
    if (bytes + record.bytes + 1 > cap) {
      fragments.push({ from, to: index, bytes });
      from = index;
      bytes = 0;
    }
    bytes += record.bytes + 1;
  });
  fragments.push({ from, to: version.records.length, bytes });
  return fragments;
}

/** The text of fragment `i` of `n` of `chunk`. */
function fragmentText({ version, terrain }: Entering, fragment: Fragment, i: number, n: number) {
  const withTerrain = i === 0 ? `,"terrain":${terrain.json}` : "";
  const records = version.records.slice(fragment.from, fragment.to);
  const beings = records.map(({ json }) => json).join(",");
  const frag = `"frag":{"i":${i},"n":${n}}`;
  return `{"at":${JSON.stringify(version.at)},"v":${version.v}${withTerrain},"beings":[${beings}],${frag}}`;
}

/** The full content of chunks that enter, or of the whole view in a reset, and the followed being. */
export type SnapshotContent = {
  readonly reset: boolean;
  readonly chunks: readonly Entering[];
  /** The followed being's record or `null`, in the first part; undefined to say nothing. */
  readonly followed: string | undefined;
};

/** A snapshot part of `texts`, with `followed` when it is the first. */
function snapshotFrame(
  head: PartHead,
  reset: boolean,
  texts: readonly string[],
  followed: string | undefined,
): Frame {
  const said = followed === undefined ? "" : `,"followed":${followed}`;
  const chunks = `"chunks":[${texts.join(",")}]`;
  return frameOf(
    "snapshot",
    `"tick":${head.tick},"txn":${head.txn},"reset":${reset},${chunks}${said}}`,
  );
}

/** The snapshot parts of `content`: at least one, even with no chunk. */
export function* snapshotParts(
  head: PartHead,
  content: SnapshotContent,
  limit: number,
): Generator<Frame> {
  const cap = fragmentCap(limit);
  let followed = content.followed;
  let part = new Filling(
    SNAPSHOT_FRAME + (followed === undefined ? 0 : byteLength(followed)),
    limit,
  );
  for (const chunk of content.chunks) {
    const fragments = fragmentsOf(chunk, cap);
    for (const [i, fragment] of fragments.entries()) {
      const bytes = FRAGMENT + fragment.bytes;
      if (!part.fits(bytes, true)) {
        yield snapshotFrame(head, content.reset, part.texts, followed);
        followed = undefined;
        part = new Filling(SNAPSHOT_FRAME, limit);
      }
      part.take(bytes);
      part.texts.push(fragmentText(chunk, fragment, i, fragments.length));
    }
  }
  yield snapshotFrame(head, content.reset, part.texts, followed);
}

/** An events part of `texts`, with `missed` when it is above 0. */
function eventsFrame(head: PartHead, texts: readonly string[], missed: number): Frame {
  const said = missed > 0 ? `,"missed":${missed}` : "";
  return frameOf(
    "events",
    `"tick":${head.tick},"txn":${head.txn},"items":[${texts.join(",")}]${said}}`,
  );
}

/** The events parts of the feed `items`, with `missed` in the first. */
export function* eventsParts(
  head: PartHead,
  items: readonly RingItem[],
  missed: number,
  limit: number,
): Generator<Frame> {
  let first = missed;
  let part = new Filling(EVENTS_FRAME, limit);
  for (const item of items) {
    if (!part.fits(item.bytes + 1)) {
      yield eventsFrame(head, part.texts, first);
      first = 0;
      part = new Filling(EVENTS_FRAME, limit);
    }
    part.take(item.bytes + 1);
    part.texts.push(item.json);
  }
  yield eventsFrame(head, part.texts, first);
}
