/**
 * The presentation plane (ADR 0025, "Playout"; ADR 0026, "Interest and transactions"; plan tests 8,
 * 9, and 10 in process), with the protocol's reference reducer as every client: a connection gets
 * hello and then a reset, a late one no feed from before its hello; an up-to-date client gets one
 * commit per period at the playout tick; the playout releases one tick a period and skips to the
 * newest beyond F while the feed keeps every tick; a being that crosses chunks leaves and enters the
 * right views, a follower's window moving with it; the feed reaches every client the same; a
 * period's budget counts every message; a lost message is detected and a resync heals the view; a
 * transaction, a reset or one of several periods included, carries the speech and the feed of
 * (L, L'] and counts what the rings lost once, however many parts it spans; an abort is discarded;
 * the timer runs the periods outside any publication; closing clients releases everything; and a
 * presentation that cannot apply its boot record leaves no listener.
 */
import { describe, expect, test } from "bun:test";
import {
  type ChunkCoord,
  type FeedItem,
  type LocalSpeech,
  MAX_FEED_ITEMS_PER_TICK,
  type ServerMessage,
} from "@open-origin/protocol/public";
import { Presentation } from "../src/presentation/presentation.ts";
import { EphemeralJournal } from "../src/world/journal.ts";
import { PublicationGate } from "../src/world/publication.ts";
import type { PublishedListener } from "../src/world/published.ts";
import { FakeClock, FakeTimer } from "./support/fake-time.ts";
import {
  being,
  bytesPerPeriod,
  clockAt,
  expected,
  ModelWorld,
  Publisher,
  plain,
  presentationOver,
  rethrow,
  shown,
  terrainAt,
  ViewClient,
  WORLD_ID,
  windowKeys,
  withinParts,
} from "./support/presentation.ts";

/** The type, seq, and tick of each message. */
const headers = (messages: readonly ServerMessage[]) =>
  messages.map(({ type, seq, tick }) => [type, seq, tick]);

/** An arrival of the being `id` at `tick` in the chunk `at`. */
function arrival(
  tick: number,
  id: number,
  at: ChunkCoord = [0, 0],
): Extract<FeedItem, { kind: "arrival" }> {
  return { kind: "arrival", tick, being: id, species: "s1", chunk: at };
}

/** The tick of the view `client` shows. */
function tickOf(client: ViewClient): number {
  const view = client.state.view;
  if (view === undefined) throw new Error("the client shows no view");
  return view.tick;
}

/** The keys of the chunks `client` shows. */
const keysOf = (client: ViewClient) => [...(client.state.view?.chunks.keys() ?? [])].sort();

/** 200 beings in the chunk (0, 0), about 18 KB of records: two parts of 16 KiB. */
const CROWD = Array.from({ length: 200 }, (_, index) => being(index + 1, [index % 32, 1]));

/** The speech of `tick` in the chunk (0, 0). */
function said(tick: number): LocalSpeech {
  return {
    at: [0, 0],
    speech: { tick, speaker: 1, to: 2, act: "tell", text: plain(`news of tick ${tick}`) },
  };
}

/** The deltas among `messages`. */
const deltas = (messages: readonly ServerMessage[]) =>
  messages.filter(
    (message): message is Extract<ServerMessage, { type: "delta" }> => message.type === "delta",
  );

describe("a connection", () => {
  test("gets hello, then a reset even of an empty view, each message one seq after the last", () => {
    const model = new ModelWorld(0);
    const { presentation } = presentationOver(model);
    const client = new ViewClient();
    presentation.connect(client);
    expect(client.messages).toEqual([]);
    presentation.period();
    expect(headers(client.messages)).toEqual([
      ["hello", 0, 0],
      ["snapshot", 1, 0],
      ["commit", 2, 0],
    ]);
    expect(client.messages[0]).toMatchObject({
      world: { id: WORLD_ID },
      durability: "ephemeral",
      clock: clockAt(0),
    });
    expect(client.messages[1]).toMatchObject({ txn: 0, reset: true, chunks: [] });
    expect(client.messages[2]).toMatchObject({ txn: 0, clock: clockAt(0) });
    expect([client.anomalies, client.state.stale, client.state.view?.tick]).toEqual([[], false, 0]);
  });

  test("an up-to-date client gets one commit per period, at the playout tick, and none while it holds", () => {
    const model = new ModelWorld(0);
    const { presentation, advance } = presentationOver(model);
    const client = new ViewClient();
    presentation.connect(client);
    presentation.period();
    advance();
    advance();
    expect(headers(client.messages.slice(3))).toEqual([
      ["commit", 3, 1],
      ["commit", 4, 2],
    ]);
    // Nothing was published: the playout tick holds, and no commit could pass the last one.
    presentation.period();
    expect(client.messages).toHaveLength(5);
    expect(client.commits.map(({ tick }) => tick)).toEqual([0, 1, 2]);
  });

  test("starts with a reset at the playout tick when it connects late, its view whole, and no feed from before its hello", () => {
    const model = new ModelWorld(0, [being(1, [3, 3])]);
    const { presentation, advance } = presentationOver(model);
    advance({ set: [being(2, [40, 3])], feed: [arrival(1, 2, [1, 0])] });
    advance({ feed: [arrival(2, 3)] });
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [
      [0, 0],
      [1, 0],
    ]);
    presentation.period();
    expect(headers(client.messages).map(([type]) => type)).toEqual(["hello", "snapshot", "commit"]);
    expect(client.messages[1]).toMatchObject({ reset: true, tick: 2 });
    expect(shown(client.state)).toEqual(expected(model, 2, ["0,0", "1,0"], 0));
    // The feed of ticks 1 and 2 came before hello, at tick 2: the client hears from tick 3 on.
    advance({ feed: [arrival(3, 4)] });
    expect(client.commits.map(({ tick, feed, missed }) => [tick, feed, missed])).toEqual([
      [2, [], 0],
      [3, [arrival(3, 4)], 0],
    ]);
  });
});

describe("the playout", () => {
  test("hands one published tick a period, and skips to the newest when more than F wait", () => {
    const model = new ModelWorld(0);
    const { presentation, publisher } = presentationOver(model);
    const client = new ViewClient();
    presentation.connect(client);
    presentation.period();
    // A batch of F = 5 ticks reaches the presentation at once, each with one arrival.
    for (let tick = 1; tick <= 5; tick += 1)
      publisher.publish(model.step({ feed: [arrival(tick, tick)] }));
    for (let period = 0; period < 5; period += 1) presentation.period();
    expect(client.commits.map(({ tick }) => tick)).toEqual([0, 1, 2, 3, 4, 5]);
    // Seven wait, more than F: the mirror applies all of them and the period releases tick 12.
    for (let tick = 6; tick <= 12; tick += 1)
      publisher.publish(model.step({ feed: [arrival(tick, tick)] }));
    presentation.period();
    expect(client.commits.map(({ tick }) => tick)).toEqual([0, 1, 2, 3, 4, 5, 12]);
    // The rings kept every tick: the commit of tick 12 brings the feed of ticks 6 to 12.
    expect(client.commits.flatMap(({ feed }) => feed.map(({ tick }) => tick))).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });

  test("runs each period in a timer task of its own, never inside a publication", () => {
    const model = new ModelWorld(0);
    const publisher = new Publisher(model.boot());
    const clock = new FakeClock();
    const timer = new FakeTimer(clock);
    const presentation = new Presentation({
      subscribeToPublished: publisher.subscribe,
      readTerrain: terrainAt,
      clock,
      timer,
      tickRateHz: 5,
      batchTicks: 5,
      world: { id: WORLD_ID, durability: "ephemeral" },
      worldState: () => "running",
    });
    const client = new ViewClient();
    presentation.connect(client);
    presentation.start();
    publisher.publish(model.step());
    // The publication only queued the tick: nothing went out.
    expect(client.messages).toEqual([]);
    expect(timer.next).toBe(200_000);
    timer.runUntil(200_000);
    expect(client.commits.map(({ tick }) => tick)).toEqual([1]);
    publisher.publish(model.step());
    timer.runUntil(400_000);
    expect(client.commits.map(({ tick }) => tick)).toEqual([1, 2]);
    presentation.stop();
    expect(timer.pending).toBe(0);
  });
});

describe("a being that crosses chunks", () => {
  test("leaves and enters the views of clients on one chunk, the other, both, and its follower", () => {
    const model = new ModelWorld(0, [being(1, [30, 5]), being(2, [10, 10])]);
    const { presentation, advance } = presentationOver(model);
    const clients = {
      a: new ViewClient(),
      b: new ViewClient(),
      both: new ViewClient(),
      follower: new ViewClient(),
    };
    const ids = Object.fromEntries(
      Object.entries(clients).map(([name, client]) => [name, presentation.connect(client)]),
    );
    presentation.subscribe(ids.a ?? 0, [[0, 0]]);
    presentation.subscribe(ids.b ?? 0, [[1, 0]]);
    presentation.subscribe(ids.both ?? 0, [
      [0, 0],
      [1, 0],
    ]);
    presentation.follow(ids.follower ?? 0, 1);
    presentation.period();
    const route: [number, number][] = [
      [31, 5],
      [32, 5],
      [33, 5],
      [32, 5],
      [31, 5],
    ];
    for (const cell of route) {
      advance({ set: [being(1, cell, { kind: "walk", dir: cell[0] >= 32 ? 0 : 4 })] });
      const { tick } = model;
      expect(shown(clients.a.state)).toEqual(expected(model, tick, ["0,0"], 0));
      expect(shown(clients.b.state)).toEqual(expected(model, tick, ["1,0"], 0));
      expect(shown(clients.both.state)).toEqual(expected(model, tick, ["0,0", "1,0"], 0));
      expect(shown(clients.follower.state)).toEqual(expected(model, tick, windowKeys(cell), 0));
      expect(clients.follower.state.view?.followed).toEqual(model.beings.get(1));
    }
    const all = Object.values(clients);
    expect(all.flatMap(({ anomalies }) => anomalies)).toEqual([]);
    // The crossing at tick 2 reached the client of both chunks as one transaction: gone, then upsert.
    const crossing = clients.both.messages.find(
      (message): message is Extract<ServerMessage, { type: "delta" }> =>
        message.type === "delta" && message.tick === 2,
    );
    expect(
      crossing?.chunks.map(({ at, gone, upsert }) => [at, gone, upsert.map(({ id }) => id)]),
    ).toEqual([
      [[0, 0], [1], []],
      [[1, 0], [], [1]],
    ]);
    // The follower's window moved east with the being, then back: the column it left was dropped.
    const moves = clients.follower.messages.filter(
      (message): message is Extract<ServerMessage, { type: "delta" }> =>
        message.type === "delta" && message.drop.length > 0,
    );
    expect(moves.map(({ tick, drop }) => [tick, drop.map(([x]) => x)])).toEqual([
      [2, [-1, -1, -1]],
      [5, [2, 2, 2]],
    ]);
  });
});

describe("the feed", () => {
  test("reaches clients watching disjoint regions with the same items in the same order", () => {
    const model = new ModelWorld(0, [being(1, [3, 3]), being(2, [400, 400])]);
    const { presentation, advance } = presentationOver(model);
    const clients = [new ViewClient(), new ViewClient(), new ViewClient()];
    const ids = clients.map((client) => presentation.connect(client));
    presentation.subscribe(ids[0] ?? 0, [[0, 0]]);
    presentation.subscribe(ids[1] ?? 0, [[12, 12]]);
    presentation.period();
    const feed: FeedItem[] = [];
    for (let tick = 1; tick <= 6; tick += 1) {
      const items = [
        arrival(tick, 10 + tick, [tick, -tick]),
        { kind: "death" as const, tick, being: 2, chunk: [12, 12] as ChunkCoord },
      ];
      feed.push(...items);
      advance({ feed: items });
    }
    for (const client of clients) {
      expect(client.commits.flatMap((committed) => committed.feed)).toEqual(feed);
      expect(client.commits.every(({ missed }) => missed === 0)).toBe(true);
    }
  });

  test("goes out at most 64 items a tick, the rest counted as missed", () => {
    const model = new ModelWorld(0);
    const { presentation, advance } = presentationOver(model);
    const client = new ViewClient();
    presentation.connect(client);
    presentation.period();
    const items = Array.from({ length: 70 }, (_, index) => arrival(1, index + 1));
    advance({ feed: items });
    const committed = client.commits.at(-1);
    expect(committed?.feed).toEqual(items.slice(0, 64));
    expect(committed?.missed).toBe(6);
  });
});

describe("parts", () => {
  test("fill up to the part's bytes and never past them, broken on items", () => {
    const model = new ModelWorld(0, [being(1, [3, 3])]);
    const { presentation, advance } = presentationOver(model, {
      partBytes: 16_384,
      periodBytes: 1 << 20,
    });
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [[0, 0]]);
    presentation.period();
    // While the client lags, 16 ticks of 64 feed items each and of speech: 1,024 items of each.
    client.lag = true;
    const feed: FeedItem[] = [];
    for (let tick = 1; tick <= 16; tick += 1) {
      const items = Array.from({ length: 64 }, (_, index) =>
        arrival(tick, 1000 + tick * 64 + index),
      );
      const speech = items.map(({ being: speaker }) => ({
        at: [0, 0] as ChunkCoord,
        speech: { tick, speaker, to: 1, act: "tell" as const, text: plain(`news of ${speaker}`) },
      }));
      feed.push(...items);
      advance({ feed: items, speech });
    }
    client.lag = false;
    presentation.period();
    const sizes = (type: string) =>
      client.messages.flatMap((message, index) =>
        message.type === type ? [client.sizes[index] ?? 0] : [],
      );
    // Each run of parts but its last is full to within one item.
    for (const type of ["delta", "events"]) {
      const parts = sizes(type);
      expect(parts.length).toBeGreaterThan(3);
      expect(Math.max(...parts)).toBeLessThanOrEqual(16_384);
      expect(Math.min(...parts.slice(0, -1))).toBeGreaterThan(16_384 - 400);
    }
    expect(client.commits.at(-1)?.feed).toEqual(feed);
    expect(client.commits.at(-1)?.speech).toHaveLength(1024);
    expect(client.anomalies).toEqual([]);
  });
});

describe("a period's budget", () => {
  test("counts every message, hello and abort included", () => {
    /** A client of the chunk (0, 0) of CROWD, under a budget of `periodBytes`. */
    const watch = (periodBytes: number) => {
      const model = new ModelWorld(0, CROWD);
      const { presentation } = presentationOver(model, { partBytes: 16_384, periodBytes });
      const client = new ViewClient();
      const id = presentation.connect(client);
      presentation.subscribe(id, [[0, 0]]);
      return { presentation, client, id };
    };
    // Under a large budget, the reset is two snapshot parts and a commit, all in one period.
    const large = watch(1 << 20);
    large.presentation.period();
    expect(large.client.messages.map(({ type }) => type)).toEqual([
      "hello",
      "snapshot",
      "snapshot",
      "commit",
    ]);
    // A budget of exactly those parts and that commit: with hello or an abort, they no longer fit.
    const [, first = 0, second = 0, commit = 0] = large.client.sizes;
    const budget = first + second + commit;
    const { presentation, client, id } = watch(budget);
    const counts: number[] = [];
    const types: string[][] = [];
    const period = () => {
      const from = client.messages.length;
      presentation.period();
      counts.push(client.sizes.length);
      types.push(client.messages.slice(from).map(({ type }) => type));
    };
    period();
    presentation.abort(id);
    period();
    period();
    // The same reset again, at the same tick and with as many digits in each seq: the same sizes.
    expect(types).toEqual([["hello", "snapshot"], ["abort", "snapshot", "snapshot"], ["commit"]]);
    expect(Math.max(...bytesPerPeriod(client, counts))).toBeLessThanOrEqual(budget);
    expect(client.commits.map(({ txn, reset, tick }) => [txn, reset, tick])).toEqual([
      [1, true, 0],
    ]);
    expect(client.anomalies).toEqual([]);
  });
});

describe("a lost message", () => {
  test("is detected by the reducer as a seq gap, and a resync restores a correct view", () => {
    const model = new ModelWorld(0, [being(1, [3, 3]), being(2, [5, 5])]);
    const { presentation, advance } = presentationOver(model);
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [[0, 0]]);
    presentation.period();
    // The delta of tick 1 is lost: the commit after it arrives one seq too far.
    client.lose = 1;
    advance({ set: [being(1, [4, 3])] });
    expect(client.anomalies.map(({ kind }) => kind)).toEqual(["seq_gap"]);
    expect(client.state.stale).toBe(true);
    advance({ set: [being(2, [6, 5])] });
    // Stale, the view takes no delta: it still shows tick 0.
    expect(client.state.view?.tick).toBe(0);
    presentation.resync(id);
    advance({ leave: [1] });
    const last = client.messages.at(-2);
    expect(last).toMatchObject({ type: "snapshot", reset: true, tick: 3 });
    expect([client.state.stale, client.state.view?.tick]).toEqual([false, 3]);
    expect(shown(client.state)).toEqual(expected(model, 3, ["0,0"], 0));
  });
});

describe("a transaction", () => {
  test("carries the speech of (L, L'] for chunks that stay, none for a chunk that enters", () => {
    const model = new ModelWorld(0, [being(1, [3, 3]), being(2, [40, 3])]);
    const { presentation, advance } = presentationOver(model);
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [[0, 0]]);
    presentation.period();
    const said = (tick: number, at: ChunkCoord) => ({
      at,
      speech: { tick, speaker: 1, to: 2, act: "greet" as const, text: plain(`hello ${tick}`) },
    });
    advance({ speech: [said(1, [0, 0]), said(1, [1, 0])] });
    presentation.subscribe(id, [
      [0, 0],
      [1, 0],
    ]);
    advance({ speech: [said(2, [0, 0]), said(2, [1, 0])] });
    advance({ speech: [said(3, [1, 0])] });
    expect(
      client.commits.map(({ speech }) => speech.map(({ at, speech: { tick } }) => [at, tick])),
    ).toEqual([
      [],
      [[[0, 0], 1]],
      // The chunk (1, 0) entered at tick 2: its speech of ticks 1 and 2 is not history it gets.
      [[[0, 0], 2]],
      [[[1, 0], 3]],
    ]);
  });

  test("counts the speech and the feed a lagging client can no longer read as missed, once however many parts they span", () => {
    const model = new ModelWorld(0, [being(1, [3, 3])]);
    const { presentation, advance } = presentationOver(model, {
      partBytes: 16_384,
      periodBytes: 1 << 20,
    });
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [[0, 0]]);
    presentation.period();
    // While the client lags, 302 ticks of speech, and 70 feed items in each of the last four.
    client.lag = true;
    const feed: FeedItem[] = [];
    for (let tick = 1; tick <= 302; tick += 1) {
      const items =
        tick > 298
          ? Array.from({ length: 70 }, (_, index) => arrival(tick, tick * 100 + index))
          : [];
      feed.push(...items.slice(0, MAX_FEED_ITEMS_PER_TICK));
      advance({ speech: [said(tick)], feed: items });
    }
    client.lag = false;
    presentation.period();
    const committed = client.commits.at(-1);
    // The ring keeps the last 300 ticks: ticks 3 to 302; ticks 1 and 2 are missed.
    expect(committed?.speech).toEqual(Array.from({ length: 300 }, (_, index) => said(index + 3)));
    expect(committed?.speechMissed).toEqual([{ at: [0, 0], count: 2 }]);
    // The feed ring keeps 64 items of each tick: 6 of each of the last four ticks are missed.
    expect(committed?.feed).toEqual(feed);
    expect(committed?.missed).toBe(4 * (70 - MAX_FEED_ITEMS_PER_TICK));
    // The chunk's entry went on from one delta part to the next, and the feed took several parts.
    const parts = client.messages.filter(({ tick }) => tick === committed?.tick);
    const entries = deltas(parts).map(({ chunks }) => chunks.map(({ at }) => at));
    expect(entries.length).toBeGreaterThan(1);
    expect(entries).toEqual(entries.map(() => [[0, 0]]));
    expect(parts.filter(({ type }) => type === "events").length).toBeGreaterThan(1);
    expect(withinParts(client, 16_384)).toBe(true);
    expect(client.anomalies).toEqual([]);
  });

  test("that is a reset carries the feed of (L, L'], as every transaction does", () => {
    const model = new ModelWorld(0, [being(1, [3, 3])]);
    const { presentation, advance } = presentationOver(model);
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [[0, 0]]);
    presentation.period();
    advance({ feed: [arrival(1, 11)] });
    presentation.resync(id);
    advance({ feed: [arrival(2, 12)] });
    expect(
      client.commits.map(({ tick, reset, feed, missed }) => [tick, reset, feed, missed]),
    ).toEqual([
      [0, true, [], 0],
      [1, false, [arrival(1, 11)], 0],
      [2, true, [arrival(2, 12)], 0],
    ]);
  });

  test("that spans periods leaves the speech and the feed released meanwhile to the next one", () => {
    const model = new ModelWorld(0, CROWD);
    // Parts of 16 KiB in a budget of 16 KiB: at most one full part a period.
    const { presentation, advance } = presentationOver(model, {
      partBytes: 16_384,
      periodBytes: 16_384,
    });
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [[0, 0]]);
    while (client.commits.length === 0) presentation.period();
    // Every being moves at tick 1: its delta takes two parts, and only the first goes out.
    const moved = CROWD.map((record) => being(record.id, [record.cell[0], 2]));
    advance({ set: moved, speech: [said(1)], feed: [arrival(1, 1001)] });
    expect([presentation.tick, client.commits.length]).toEqual([1, 1]);
    // Tick 2 is released while that transaction is in flight, which then commits.
    advance({ speech: [said(2)], feed: [arrival(2, 1002)] });
    expect([presentation.tick, client.commits.map(({ tick }) => tick)]).toEqual([2, [0, 1]]);
    advance();
    expect(client.commits.map(({ tick, speech, feed }) => [tick, speech, feed])).toEqual([
      [0, [], []],
      [1, [said(1)], [arrival(1, 1001)]],
      [3, [said(2)], [arrival(2, 1002)]],
    ]);
    expect(shown(client.state)).toEqual(expected(model, 3, ["0,0"], 0));
    expect(client.anomalies).toEqual([]);
  });

  test("that is aborted is discarded; the next one moves the view from L, or resets it", () => {
    const beings = Array.from({ length: 200 }, (_, index) => being(index + 1, [index % 32, 1]));
    const model = new ModelWorld(0, beings);
    // Parts of 16 KiB in a budget of 16 KiB: at most one part a period.
    const { presentation, advance } = presentationOver(model, {
      partBytes: 16_384,
      periodBytes: 16_384,
    });
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [[0, 0]]);
    // Hello and the reset's first part go; its second part waits for the next period.
    presentation.period();
    expect(headers(client.messages)).toEqual([
      ["hello", 0, 0],
      ["snapshot", 1, 0],
    ]);
    presentation.abort(id);
    for (let period = 0; period < 6; period += 1) advance();
    const aborts = () => client.messages.filter(({ type }) => type === "abort");
    expect(aborts()).toEqual([{ type: "abort", seq: 2, tick: 0, txn: 0 }]);
    // The view never became current: the next transaction, started a tick later, is again a reset.
    expect(client.commits[0]).toMatchObject({ txn: 1, reset: true, tick: 1 });
    expect(shown(client.state)).toEqual(expected(model, tickOf(client), ["0,0"], 0));
    // A delta in flight is aborted: its parts are discarded, and the next delta starts from L.
    advance({ set: beings.map((record) => being(record.id, [record.cell[0], 2])) });
    const before = tickOf(client);
    presentation.abort(id);
    expect(tickOf(client)).toBe(before);
    for (let period = 0; period < 6; period += 1) advance();
    expect(aborts()).toHaveLength(2);
    expect(client.commits.map(({ reset }) => reset).slice(1)).not.toContain(true);
    expect(shown(client.state)).toEqual(expected(model, tickOf(client), ["0,0"], 0));
    // With its view released too, the client's next transaction is a reset.
    const commits = client.commits.length;
    presentation.abort(id, { releaseView: true });
    for (let period = 0; period < 6; period += 1) advance();
    expect(client.commits[commits]).toMatchObject({ reset: true });
    expect(shown(client.state)).toEqual(expected(model, tickOf(client), ["0,0"], 0));
    expect(client.anomalies).toEqual([]);
    expect(withinParts(client, 16_384)).toBe(true);
    expect(presentation.usage().pins).toBe(1);
  });
});

describe("closing", () => {
  test("releases interest, index entries, followings, pins, and retained bytes, to exactly zero", () => {
    const beings = Array.from({ length: 60 }, (_, index) =>
      being(index + 1, [index % 64, index % 40]),
    );
    const model = new ModelWorld(0, beings);
    const { presentation, advance } = presentationOver(model, {
      partBytes: 16_384,
      periodBytes: 16_384,
    });
    const open: number[] = [];
    for (let cycle = 0; cycle < 20; cycle += 1) {
      // A sink that drops what it gets: these clients only hold pins and interest.
      const id = presentation.connect({
        send: () => undefined,
        buffered: () => 0,
        end: rethrow,
      });
      presentation.subscribe(id, [
        [0, 0],
        [1, 0],
        [cycle % 3, 1],
      ]);
      presentation.follow(id, (cycle % 60) + 1);
      open.push(id);
      // Every being moves, so versions are replaced while clients pin them mid-transaction.
      advance({
        set: beings.map((record) =>
          being(record.id, [(record.cell[0] + cycle) % 64, record.cell[1]]),
        ),
      });
      if (cycle % 2 === 1) presentation.close(open.shift() ?? 0);
    }
    expect(presentation.usage().retainedBytes).toBeGreaterThan(0);
    for (const id of open) presentation.close(id);
    expect(presentation.usage()).toEqual({
      clients: 0,
      interest: { clients: 0, indexEntries: 0, following: 0 },
      pins: 0,
      retainedBytes: 0,
      faults: 0,
      failed: false,
    });
  });
});

describe("interest", () => {
  test("joins the camera and the follow window, and counts a being's followers", () => {
    const model = new ModelWorld(0, [being(7, [100, 100])]);
    const { presentation } = presentationOver(model);
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [[0, 0]]);
    presentation.follow(id, 7);
    expect(presentation.followers(7)).toBe(1);
    presentation.period();
    expect(keysOf(client)).toEqual(["0,0", ...windowKeys([100, 100])].sort());
    // A camera of more than 64 chunks never reaches the plane: the transport refuses it first.
    const camera = Array.from({ length: 65 }, (_, index): ChunkCoord => [index, 0]);
    expect(() => presentation.subscribe(id, camera)).toThrow(RangeError);
    presentation.follow(id, null);
    expect(presentation.followers(7)).toBe(0);
  });
});

describe("faults", () => {
  test("a throw while serving one client drops it alone, and the next is served that period", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const { presentation, advance } = presentationOver(model);
    const failure = new Error("socket gone");
    const ended: unknown[] = [];
    let sent = 0;
    // Served first, it throws on its second message, inside its first transaction.
    const faulty = presentation.connect({
      send: () => {
        sent += 1;
        if (sent === 2) throw failure;
      },
      buffered: () => 0,
      end: (ending) => ended.push(ending),
    });
    presentation.subscribe(faulty, [[0, 0]]);
    const healthy = new ViewClient();
    const id = presentation.connect(healthy);
    presentation.subscribe(id, [[0, 0]]);
    presentation.period();
    expect(ended).toEqual([{ reason: "fault", cause: failure }]);
    expect(healthy.commits.map(({ tick }) => tick)).toEqual([0]);
    expect(presentation.usage()).toMatchObject({ clients: 1, faults: 1 });
    expect(() => presentation.close(faulty)).toThrow(`client ${faulty} is not connected`);
    advance();
    expect(healthy.commits.map(({ tick }) => tick)).toEqual([0, 1]);
    expect(ended).toEqual([{ reason: "fault", cause: failure }]);
    presentation.close(id);
    expect(presentation.usage()).toMatchObject({
      clients: 0,
      pins: 0,
      retainedBytes: 0,
      faults: 1,
    });
  });

  test("a terrain that throws as a transaction starts drops its client with no pin left", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const failure = new Error("no terrain");
    const { presentation } = presentationOver(model, {
      readTerrain: (at) => {
        if (at[0] === 1 && at[1] === 0) throw failure;
        return terrainAt(at);
      },
    });
    const ended: unknown[] = [];
    const faulty = presentation.connect({
      send: () => undefined,
      buffered: () => 0,
      end: (ending) => ended.push(ending),
    });
    presentation.subscribe(faulty, [
      [0, 0],
      [1, 0],
    ]);
    const healthy = new ViewClient();
    const id = presentation.connect(healthy);
    presentation.subscribe(id, [[0, 0]]);
    presentation.period();
    expect(ended).toEqual([{ reason: "fault", cause: failure }]);
    expect(healthy.commits.map(({ tick }) => tick)).toEqual([0]);
    presentation.close(id);
    expect(presentation.usage()).toMatchObject({
      clients: 0,
      pins: 0,
      retainedBytes: 0,
      faults: 1,
    });
  });

  test("a throw of the mirror stops and detaches the whole plane, and goes on", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const { presentation, publisher, timer } = presentationOver(model);
    const client = new ViewClient();
    presentation.connect(client);
    presentation.start();
    model.step();
    // Tick 2 right after tick 0: the mirror refuses a gap, which no client caused.
    publisher.publish(model.step());
    expect(() => presentation.period()).toThrow("the mirror is at tick 0 and cannot apply tick 2");
    expect(presentation.usage()).toMatchObject({ failed: true, faults: 0 });
    expect(publisher.listeners).toBe(0);
    expect(client.messages).toEqual([]);
    expect(timer.pending).toBe(0);
    expect(() => presentation.start()).toThrow("a stopped presentation cannot start again");
  });

  test("a presentation that cannot apply its boot record throws and leaves no listener", () => {
    const failure = new Error("an unreadable record");
    const record = being(1, [5, 5]);
    // A record whose JSON cannot be written: the mirror throws while it applies the boot record.
    Object.defineProperty(record, "activity", {
      enumerable: true,
      get: () => {
        throw failure;
      },
    });
    const gate = new PublicationGate({
      journal: new EphemeralJournal(),
      batchTicks: 5,
      boot: 0,
      bootRecord: {
        tick: 0,
        clock: clockAt(0),
        chunks: [{ at: [0, 0], v: 0, upsert: [record], gone: [] }],
        speech: [],
        feed: [],
      },
    });
    // The gate counts a listener's throw and keeps the listener: count what stays subscribed.
    const listeners = new Set<PublishedListener>();
    const subscribeToPublished = (listener: PublishedListener) => {
      const unsubscribe = gate.subscribe(listener);
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    };
    const clock = new FakeClock();
    const build = () =>
      new Presentation({
        subscribeToPublished,
        readTerrain: terrainAt,
        clock,
        timer: new FakeTimer(clock),
        tickRateHz: 5,
        batchTicks: 5,
        world: { id: WORLD_ID, durability: "ephemeral" },
        worldState: () => "running",
      });
    expect(build).toThrow("the world plane gave the presentation no boot record");
    expect(gate.listenerFaults).toBe(1);
    expect(listeners.size).toBe(0);
  });

  test("stop detaches the presentation from the world plane for good", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const { presentation, publisher } = presentationOver(model);
    expect(publisher.listeners).toBe(1);
    presentation.start();
    presentation.stop();
    expect(publisher.listeners).toBe(0);
    presentation.stop();
    expect(() => presentation.start()).toThrow("a stopped presentation cannot start again");
  });
});
