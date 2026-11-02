/**
 * The presentation plane (ADR 0025, "Playout"; ADR 0026, "Interest and transactions"; plan tests 8,
 * 9, and 10 in process), with the protocol's reference reducer as every client: a connection gets
 * hello and then a reset; an up-to-date client gets one commit per period at the playout tick; the
 * playout releases one tick a period and skips to the newest beyond F while the feed keeps every
 * tick; a being that crosses chunks leaves and enters the right views, a follower's window moving
 * with it; the feed reaches every client the same; a lost message is detected and a resync heals
 * the view; an abort is discarded; local speech covers (L, L'] and counts what the ring lost; the
 * timer runs the periods outside any publication; and closing clients releases everything.
 */
import { describe, expect, test } from "bun:test";
import type { ChunkCoord, FeedItem, ServerMessage } from "@open-origin/protocol/public";
import { Presentation } from "../src/presentation/presentation.ts";
import { FakeClock, FakeTimer } from "./support/fake-time.ts";
import {
  being,
  clockAt,
  expected,
  ModelWorld,
  Publisher,
  plain,
  presentationOver,
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
function arrival(tick: number, id: number, at: ChunkCoord = [0, 0]): FeedItem {
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

  test("starts with a reset at the playout tick when it connects late, its view whole", () => {
    const model = new ModelWorld(0, [being(1, [3, 3])]);
    const { presentation, advance } = presentationOver(model);
    advance({ set: [being(2, [40, 3])] });
    advance();
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

  test("counts the speech a lagging client can no longer read as missed", () => {
    const model = new ModelWorld(0, [being(1, [3, 3])]);
    const { presentation, advance } = presentationOver(model);
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, [[0, 0]]);
    presentation.period();
    client.lag = true;
    for (let tick = 1; tick <= 302; tick += 1) {
      advance({
        speech: [
          { at: [0, 0], speech: { tick, speaker: 1, to: 1, act: "tell", text: plain("x") } },
        ],
      });
    }
    client.lag = false;
    presentation.period();
    const committed = client.commits.at(-1);
    // The ring keeps the last 300 ticks: ticks 3 to 302; ticks 1 and 2 are missed.
    expect(committed?.speech.map(({ speech: { tick } }) => tick)).toEqual(
      Array.from({ length: 300 }, (_, index) => index + 3),
    );
    expect(committed?.speechMissed).toEqual([{ at: [0, 0], count: 2 }]);
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
    expect(withinParts(client)).toBe(true);
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
      const id = presentation.connect({ send: () => undefined, lagging: () => false });
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
