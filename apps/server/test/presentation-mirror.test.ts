/**
 * The presentation plane's mirror and its parts (ADR 0025, "Playout"; ADR 0026, "Interest and
 * transactions"): chunk versions are immutable, made only for the chunks a tick changes, and
 * their differences by id are computed once per pair; pins count exactly and retained versions'
 * bytes return to zero; the rings keep H ticks and at most 2,048 items and count every item they
 * cannot give; the feed keeps 64 items a tick; and the playout releases one tick a period, or
 * every waiting tick in order when more than F wait.
 */
import { describe, expect, test } from "bun:test";
import {
  type BeingPublic,
  type ChunkCoord,
  type FeedItem,
  PlainText,
  utf8Length,
} from "@open-origin/protocol/public";
import { byteLength } from "../src/presentation/bytes.ts";
import { FEED, Mirror } from "../src/presentation/mirror.ts";
import { Playout } from "../src/presentation/playout.ts";
import { TickRing } from "../src/presentation/ring.ts";
import { ChunkVersion, encodeBeing } from "../src/presentation/version.ts";
import type { PublishedChunk, PublishedTick } from "../src/world/published.ts";

/** The being `id` at `cell`, idle. */
function being(id: number, cell: readonly [number, number]): BeingPublic {
  return {
    id,
    species: "s1",
    stage: "adult",
    born: 0,
    cell: [cell[0], cell[1]],
    activity: { kind: "idle" },
  };
}

/** A published tick, by default with no change, speech, or feed. */
function tickOf(
  tick: number,
  parts: Partial<Omit<PublishedTick, "tick" | "clock">> = {},
): PublishedTick {
  return {
    tick,
    clock: { tick, day: 0, dayPermille: tick % 1000 },
    chunks: parts.chunks ?? [],
    speech: parts.speech ?? [],
    feed: parts.feed ?? [],
  };
}

/** The change of the chunk `at` at tick `v`. */
function change(
  at: ChunkCoord,
  v: number,
  upsert: BeingPublic[],
  gone: number[] = [],
): PublishedChunk {
  return { at, v, upsert, gone };
}

/** The ids and cells a version holds. */
const contents = (version: ChunkVersion) =>
  version.records.map(({ record }) => [record.id, record.cell]);

/** An arrival of the being `id` at `tick`. */
const arrival = (tick: number, id: number): FeedItem => ({
  kind: "arrival",
  tick,
  being: id,
  species: "s1",
  chunk: [0, 0],
});

describe("chunk versions", () => {
  test("merge a change by id: upserts replace or enter in id order, and gone ids leave", () => {
    const first = ChunkVersion.empty([0, 0], 0).next(
      change([0, 0], 1, [being(5, [1, 1]), being(2, [3, 3])]),
    );
    expect(contents(first)).toEqual([
      [2, [3, 3]],
      [5, [1, 1]],
    ]);
    const second = first.next(change([0, 0], 2, [being(9, [4, 4]), being(5, [2, 2])], [2]));
    expect(second.v).toBe(2);
    expect(contents(second)).toEqual([
      [5, [2, 2]],
      [9, [4, 4]],
    ]);
    // The older version is immutable: it still holds what it held.
    expect(contents(first)).toEqual([
      [2, [3, 3]],
      [5, [1, 1]],
    ]);
    expect(second.bytes).toBe(second.records.reduce((sum, { json }) => sum + json.length, 0));
    expect(second.find(9)?.record).toEqual(being(9, [4, 4]));
    expect(second.find(2)).toBeUndefined();
  });

  test("diff two versions by id once per pair, and share the result", () => {
    const one = ChunkVersion.empty([0, 0], 0).next(
      change([0, 0], 1, [being(1, [0, 0]), being(2, [0, 0]), being(3, [0, 0])]),
    );
    const two = one.next(change([0, 0], 2, [being(2, [1, 0]), being(4, [0, 0])], [1]));
    const diff = two.diffFrom(one);
    expect(diff.gone).toEqual([1]);
    expect(diff.upsert.map(({ record }) => record)).toEqual([being(2, [1, 0]), being(4, [0, 0])]);
    expect(two.diffFrom(one)).toBe(diff);
    // A record whose bytes did not change is never sent again; a version is no change of itself.
    const three = two.next(change([0, 0], 3, [being(3, [0, 0])]));
    expect(three.diffFrom(two)).toEqual({ gone: [], upsert: [] });
    expect(three.diffFrom(three)).toEqual({ gone: [], upsert: [] });
    // From an empty chunk, everything enters.
    expect(three.diffFrom(ChunkVersion.empty([0, 0], 0)).upsert).toBe(three.records);
  });

  test("encode a record once, with its UTF-8 size", () => {
    const encoded = encodeBeing(being(7, [-3, 40]));
    expect(encoded.json).toBe(JSON.stringify(being(7, [-3, 40])));
    expect(encoded.bytes).toBe(encoded.json.length);
    // A text that is not ASCII counts its UTF-8 bytes: two for é, four for a character beyond the BMP.
    expect(["plain", "café", "a𝄞b", ""].map(byteLength)).toEqual([5, 5, 6, 0]);
    expect(["café", "a𝄞b"].map(byteLength)).toEqual(["café", "a𝄞b"].map(utf8Length));
  });
});

describe("the rings", () => {
  test("keep the last H ticks and count what a reader can no longer read as missed", () => {
    const ring = new TickRing({ ticks: 3, items: 100 });
    for (let tick = 1; tick <= 5; tick += 1) ring.add("a", tick, [`"a${tick}"`], 1);
    ring.evict(5);
    // Ticks 3 to 5 stay: the reader that saw one item misses ticks 2 and, kept, reads 3 to 5.
    expect(ring.since("a", 1)).toEqual({
      items: [3, 4, 5].map((n) => expect.objectContaining({ tick: n, n, json: `"a${n}"` })),
      missed: 1,
    });
    expect(ring.since("a", 4).items.map(({ n }) => n)).toEqual([5]);
    expect(ring.since("a", 5)).toEqual({ items: [], missed: 0 });
    expect(ring.since("b", 0)).toEqual({ items: [], missed: 0 });
  });

  test("keep at most their item bound, oldest out first, across streams", () => {
    const ring = new TickRing({ ticks: 300, items: 4 });
    ring.add("a", 1, ['"a1"', '"a2"'], 2);
    ring.add("b", 1, ['"b1"', '"b2"', '"b3"'], 3);
    ring.evict(1);
    expect(ring.size).toBe(4);
    expect(ring.since("a", 0)).toEqual({ items: [expect.objectContaining({ n: 2 })], missed: 1 });
    expect(ring.since("b", 0).items.map(({ n }) => n)).toEqual([1, 2, 3]);
    // Items counted but not kept are missed by every reader.
    ring.add("a", 2, ['"a3"'], 5);
    expect(ring.count("a")).toBe(7);
    expect(ring.since("a", 2)).toEqual({ items: [expect.objectContaining({ n: 3 })], missed: 4 });
  });
});

describe("the mirror", () => {
  test("boots from the boot record, and an untouched chunk is empty at the boot tick", () => {
    const mirror = new Mirror();
    expect(() => mirror.tick).toThrow("the mirror has not received its boot record");
    mirror.apply(tickOf(10, { chunks: [change([1, 2], 10, [being(1, [40, 70])])] }));
    expect([mirror.tick, mirror.bootTick, mirror.clock.tick]).toEqual([10, 10, 10]);
    expect(contents(mirror.current([1, 2]))).toEqual([[1, [40, 70]]]);
    const empty = mirror.current([5, 5]);
    expect([empty.v, empty.records.length, empty.held]).toEqual([10, 0, false]);
    expect(() => mirror.apply(tickOf(12))).toThrow(
      "the mirror is at tick 10 and cannot apply tick 12",
    );
  });

  test("makes a version only for a chunk a tick changes; the others stay shared", () => {
    const mirror = new Mirror();
    mirror.apply(
      tickOf(0, {
        chunks: [change([0, 0], 0, [being(1, [1, 1])]), change([1, 0], 0, [being(2, [33, 1])])],
      }),
    );
    const [a, b] = [mirror.current([0, 0]), mirror.current([1, 0])];
    mirror.apply(tickOf(1, { chunks: [change([0, 0], 1, [being(1, [2, 1])])] }));
    expect(mirror.current([0, 0])).not.toBe(a);
    expect(mirror.current([0, 0]).v).toBe(1);
    expect(mirror.current([1, 0])).toBe(b);
    // A tick that changes nothing public moves no version.
    mirror.apply(tickOf(2));
    expect(mirror.current([1, 0])).toBe(b);
  });

  test("follows a being across chunks, and forgets it once it is gone", () => {
    const mirror = new Mirror();
    mirror.apply(tickOf(0, { chunks: [change([0, 0], 0, [being(1, [31, 0])])] }));
    expect(mirror.locate(1)).toEqual([0, 0]);
    // The crossing lists the new chunk first: the being stays where it went.
    mirror.apply(
      tickOf(1, { chunks: [change([1, 0], 1, [being(1, [32, 0])]), change([0, 0], 1, [], [1])] }),
    );
    expect(mirror.locate(1)).toEqual([1, 0]);
    expect(mirror.record(1)?.record).toEqual(being(1, [32, 0]));
    mirror.apply(tickOf(2, { chunks: [change([1, 0], 2, [], [1])] }));
    expect([mirror.locate(1), mirror.record(1)]).toEqual([undefined, undefined]);
    // The emptied chunk keeps an empty version, at the tick it emptied.
    expect([mirror.current([1, 0]).v, mirror.current([1, 0]).records.length]).toEqual([2, 0]);
  });

  test("counts pins exactly and retains a replaced version only while it is pinned", () => {
    const mirror = new Mirror();
    mirror.apply(tickOf(0, { chunks: [change([0, 0], 0, [being(1, [1, 1]), being(2, [2, 2])])] }));
    const pinned = mirror.current([0, 0]);
    mirror.pin(pinned);
    mirror.pin(pinned);
    mirror.pin(mirror.current([9, 9]));
    expect([mirror.pins, mirror.retainedBytes]).toEqual([2, 0]);
    mirror.apply(tickOf(1, { chunks: [change([0, 0], 1, [being(1, [3, 1])])] }));
    expect(mirror.retainedBytes).toBe(pinned.bytes);
    mirror.unpin(pinned);
    expect(mirror.retainedBytes).toBe(pinned.bytes);
    mirror.unpin(pinned);
    expect([mirror.pins, mirror.retainedBytes]).toEqual([0, 0]);
    expect(() => mirror.unpin(pinned)).toThrow("the version 0 of 0,0 is not pinned");
    // A version replaced with no pin is never retained.
    mirror.apply(tickOf(2, { chunks: [change([0, 0], 2, [being(1, [4, 1])])] }));
    expect(mirror.retainedBytes).toBe(0);
    // A current version whose pins go is no retained version either.
    mirror.pin(mirror.current([0, 0]));
    mirror.unpin(mirror.current([0, 0]));
    expect([mirror.pins, mirror.retainedBytes]).toEqual([0, 0]);
  });

  test("keeps speech in the speaker's chunk and at most 64 feed items a tick, counting the rest", () => {
    const mirror = new Mirror();
    mirror.apply(tickOf(0));
    const speech = {
      tick: 1,
      speaker: 1,
      to: 2,
      act: "greet" as const,
      text: PlainText.parse("hello"),
    };
    const feed = Array.from({ length: 70 }, (_, index) => arrival(1, index + 1));
    mirror.apply(tickOf(1, { speech: [{ at: [3, -1], speech }], feed }));
    expect(mirror.speech.since("3,-1", 0)).toEqual({
      items: [expect.objectContaining({ tick: 1, n: 1, json: JSON.stringify(speech) })],
      missed: 0,
    });
    const read = mirror.feed.since(FEED, 0);
    expect(read.items.map(({ json }) => JSON.parse(json))).toEqual(feed.slice(0, 64));
    expect(read.missed).toBe(6);
  });
});

describe("the playout", () => {
  test("releases one tick a period while at most F wait, and every waiting tick beyond F", () => {
    const playout = new Playout(2);
    const applied: number[] = [];
    const apply = ({ tick }: PublishedTick) => {
      applied.push(tick);
    };
    expect(playout.release(apply)).toBe(0);
    for (const tick of [1, 2]) playout.push(tickOf(tick));
    expect([playout.release(apply), playout.waiting]).toEqual([1, 1]);
    for (const tick of [3, 4]) playout.push(tickOf(tick));
    // Three wait, more than F = 2: all of them, in order, and the newest is released.
    expect([playout.release(apply), playout.waiting]).toEqual([3, 0]);
    expect(applied).toEqual([1, 2, 3, 4]);
    expect(() => new Playout(0)).toThrow(RangeError);
  });
});
