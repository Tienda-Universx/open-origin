import { describe, expect, test } from "bun:test";
import {
  type Applied,
  applyMessage,
  type ChunkCoord,
  CLIENT_LIMITS,
  type ClientState,
  chunkKey,
  findBeing,
  initialClientState,
  type ServerMessage,
} from "../src/public/index.ts";
import {
  type At,
  abort,
  being,
  clockAt,
  commit,
  delta,
  events,
  hello,
  message,
  snapshot,
  TERRAIN,
  WORLD_ID,
} from "./support/messages.ts";

const A: ChunkCoord = [0, 0];
const B: ChunkCoord = [1, 0];
const C: ChunkCoord = [0, 1];

/** A client fed message by message, with the seq of each message counted for it. */
class Session {
  state: ClientState = initialClientState();
  #seq = 1;

  apply(message: ServerMessage): Applied {
    const applied = applyMessage(this.state, message);
    this.state = applied.state;
    return applied;
  }

  /** Where the next message sits: the next seq, `tick`, and `txn`. */
  at(tick: number, txn: number): At {
    const seq = this.#seq;
    this.#seq += 1;
    return { seq, tick, txn };
  }

  /** Loses the next message: its seq is never seen. */
  lose(): void {
    this.#seq += 1;
  }

  /** The visible view; a session is connected once it has a hello. */
  get view() {
    const view = this.state.view;
    if (view === undefined) throw new Error("no view before hello");
    return view;
  }

  /** The ids of the beings of the visible chunk `at`, sorted, or undefined when it is not visible. */
  ids(at: ChunkCoord): number[] | undefined {
    const chunk = this.view.chunks.get(chunkKey(at));
    return chunk === undefined ? undefined : [...chunk.beings.keys()].sort((a, b) => a - b);
  }
}

/**
 * A session after hello at tick 10 and a reset at tick 12 that shows chunk A with being 1, chunk B
 * with being 2, and follows being 1.
 */
function connected(): Session {
  const session = new Session();
  session.apply(hello(10));
  const at = session.at(12, 1);
  session.apply(
    snapshot(
      at,
      [
        { at: A, v: 11, beings: [being(1, [2, 3])] },
        { at: B, v: 12, beings: [being(2, [40, 5])] },
      ],
      { reset: true, followed: being(1, [2, 3]) },
    ),
  );
  const applied = session.apply(commit(session.at(12, 1)));
  expect(applied.anomaly).toBeUndefined();
  return session;
}

describe("before and at hello", () => {
  test("a client starts with no connection and no view", () => {
    const state = initialClientState();
    expect([state.connection, state.view, state.stale, state.expectedSeq]).toEqual([
      undefined,
      undefined,
      true,
      0,
    ]);
  });

  test("a message before hello is an anomaly and changes nothing", () => {
    const state = initialClientState();
    const applied = applyMessage(state, commit({ seq: 1, tick: 5, txn: 0 }));
    expect(applied.state).toBe(state);
    expect(applied.anomaly?.kind).toBe("before_hello");
  });

  test("hello opens an empty, stale view at its tick and clock", () => {
    const session = new Session();
    session.apply(hello(10, "paused"));
    const connection: unknown = session.state.connection;
    expect(connection).toEqual({
      worldId: WORLD_ID,
      durability: "ephemeral",
      limits: CLIENT_LIMITS,
      helloTick: 10,
    });
    expect(session.view.tick).toBe(10);
    expect(session.view.clock).toEqual(clockAt(10));
    expect(session.view.chunks.size).toBe(0);
    expect([session.state.stale, session.state.expectedSeq]).toEqual([true, 1]);
    expect(session.state.world).toEqual({ state: "paused", reason: undefined });
  });

  test("a connection's first transaction must be a reset: anything else is not applied", () => {
    const session = new Session();
    session.apply(hello(10));
    session.apply(snapshot(session.at(11, 0), [{ at: A, v: 11 }]));
    const ignored = session.apply(commit(session.at(11, 0)));
    expect([ignored.anomaly, ignored.committed]).toEqual([undefined, undefined]);
    expect([session.view.chunks.size, session.view.tick, session.state.stale]).toEqual([
      0,
      10,
      true,
    ]);
    session.apply(snapshot(session.at(12, 1), [{ at: A, v: 11 }], { reset: true }));
    const applied = session.apply(commit(session.at(12, 1)));
    expect(applied.committed?.reset).toBe(true);
    expect([session.view.chunks.size, session.view.tick, session.state.stale]).toEqual([
      1,
      12,
      false,
    ]);
  });
});

describe("a transaction", () => {
  test("is invisible until its commit, which shows it whole at its tick and clock", () => {
    const session = connected();
    const before = session.view;
    session.apply(delta(session.at(15, 2), [{ at: A, v: 14, upsert: [being(1, [4, 3])] }]));
    session.apply(snapshot(session.at(15, 2), [{ at: C, v: 9, beings: [being(3, [1, 40])] }]));
    session.apply(events(session.at(15, 2), []));
    expect(session.view).toBe(before);
    expect(session.view.chunks.get(chunkKey(A))?.beings.get(1)?.cell).toEqual([2, 3]);
    const applied = session.apply(commit(session.at(15, 2)));
    expect(applied.anomaly).toBeUndefined();
    expect([session.view.tick, session.view.clock]).toEqual([15, clockAt(15)]);
    expect(session.view.chunks.get(chunkKey(A))?.beings.get(1)?.cell).toEqual([4, 3]);
    expect(session.view.chunks.get(chunkKey(A))?.v).toBe(14);
    expect(session.ids(C)).toEqual([3]);
    // The earlier view is a value: the commit made a new one.
    expect(before.chunks.get(chunkKey(A))?.beings.get(1)?.cell).toEqual([2, 3]);
    expect(before.chunks.has(chunkKey(C))).toBe(false);
  });

  test("moves the clock only at a commit, never at another message", () => {
    const session = connected();
    const clock = session.view.clock;
    for (const other of [
      { type: "pong", nonce: 1 },
      { type: "status", state: "stalled", reason: "Journal stall." },
      { type: "notice", code: "interest_trimmed", chunks: [C] },
      { type: "error", code: "rate_limited" },
    ]) {
      const { seq, tick } = session.at(12, 0);
      session.apply(message({ ...other, seq, tick }));
      expect(session.view.clock).toBe(clock);
    }
    const world: unknown = session.state.world;
    expect(world).toEqual({ state: "stalled", reason: "Journal stall." });
    expect(session.state.trimmed).toEqual([C]);
    session.apply(events(session.at(20, 2), []));
    expect(session.view.clock).toBe(clock);
    session.apply(commit(session.at(20, 2)));
    expect(session.view.clock).toEqual(clockAt(20));
  });

  test("with no parts still commits: a heartbeat that moves the tick and the clock", () => {
    const session = connected();
    const applied = session.apply(commit(session.at(13, 2)));
    expect(applied.committed).toEqual({
      txn: 2,
      tick: 13,
      reset: false,
      speech: [],
      speechMissed: [],
      feed: [],
      missed: 0,
    });
    expect([session.view.tick, session.ids(A), session.ids(B)]).toEqual([13, [1], [2]]);
  });

  test("is discarded whole by its abort", () => {
    const session = connected();
    const before = session.view;
    session.apply(delta(session.at(15, 2), [{ at: A, v: 15, gone: [1] }], [B]));
    const aborted = session.apply(abort(session.at(15, 2)));
    expect([aborted.anomaly, aborted.committed, session.state.pending]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(session.view).toBe(before);
    // The next transaction takes the view from where it was.
    session.apply(delta(session.at(16, 3), [{ at: A, v: 16, upsert: [being(4, [9, 9])] }]));
    session.apply(commit(session.at(16, 3)));
    expect([session.ids(A), session.ids(B)]).toEqual([[1, 4], [2]]);
  });

  test("brings its speech and feed at the commit", () => {
    const session = connected();
    const greet = { tick: 14, speaker: 1, to: 2, act: "greet", text: "Being 1 greets being 2." };
    session.apply(delta(session.at(15, 2), [{ at: A, v: 11, speech: [greet], speechMissed: 2 }]));
    const item = { kind: "greeting", tick: 3, from: 1, to: 2, chunk: A };
    session.apply(events(session.at(15, 2), [item], 5));
    const committed: unknown = session.apply(commit(session.at(15, 2))).committed;
    expect(committed).toEqual({
      txn: 2,
      tick: 15,
      reset: false,
      speech: [{ at: A, speech: greet }],
      speechMissed: [{ at: A, count: 2 }],
      feed: [item],
      missed: 5,
    });
  });
});

describe("the order of a commit", () => {
  test("gone comes before upsert: a being gone and upserted in one chunk stays, updated", () => {
    const session = connected();
    session.apply(
      delta(session.at(15, 2), [{ at: A, v: 15, gone: [1], upsert: [being(1, [7, 7])] }]),
    );
    session.apply(commit(session.at(15, 2)));
    expect(session.view.chunks.get(chunkKey(A))?.beings.get(1)?.cell).toEqual([7, 7]);
  });

  test("drop comes first: a chunk dropped and entering in one transaction takes the new content", () => {
    const session = connected();
    session.apply(snapshot(session.at(15, 2), [{ at: B, v: 15, beings: [being(5, [33, 1])] }]));
    session.apply(delta(session.at(15, 2), [], [B]));
    session.apply(commit(session.at(15, 2)));
    expect(session.ids(B)).toEqual([5]);
  });

  test("a chunk dropped in one part cannot have differences in another", () => {
    // Within one part the schema already rejects it; across parts only the transaction can.
    const session = connected();
    session.apply(delta(session.at(15, 2), [{ at: B, v: 15, gone: [2] }]));
    session.apply(delta(session.at(15, 2), [], [B]));
    const applied = session.apply(commit(session.at(15, 2)));
    expect(applied.anomaly?.kind).toBe("bad_transaction");
    expect(session.ids(B)).toEqual([2]);
  });

  test("a being leaves one visible chunk and enters another in the same transaction", () => {
    const session = connected();
    // The arrival comes first, in its own part; the leaving in the next.
    session.apply(delta(session.at(15, 2), [{ at: B, v: 15, upsert: [being(1, [32, 3])] }]));
    session.apply(delta(session.at(15, 2), [{ at: A, v: 15, gone: [1] }]));
    session.apply(commit(session.at(15, 2)));
    expect([session.ids(A), session.ids(B)]).toEqual([[], [1, 2]]);
    expect(findBeing(session.view, 1)?.cell).toEqual([32, 3]);
    // The followed being's record moves with it.
    expect(session.view.followed?.cell).toEqual([32, 3]);
  });
});

describe("a reset", () => {
  test("replaces the whole view at its commit, and the old view stays, stale, until then", () => {
    const session = connected();
    session.lose();
    const gap = session.apply(events(session.at(14, 2), []));
    expect(gap.anomaly?.kind).toBe("seq_gap");
    const stale = session.view;
    expect(session.state.stale).toBe(true);
    session.apply(
      snapshot(session.at(18, 3), [{ at: C, v: 9, beings: [being(3, [1, 40])] }], { reset: true }),
    );
    expect(session.view).toBe(stale);
    expect([session.ids(A), session.ids(B), session.ids(C)]).toEqual([[1], [2], undefined]);
    const applied = session.apply(commit(session.at(18, 3)));
    expect(applied.committed?.reset).toBe(true);
    expect([session.ids(A), session.ids(B), session.ids(C)]).toEqual([undefined, undefined, [3]]);
    expect([session.state.stale, session.view.tick, session.view.followed]).toEqual([
      false,
      18,
      null,
    ]);
  });

  test("carries no delta", () => {
    const session = connected();
    session.apply(snapshot(session.at(15, 2), [{ at: C, v: 9 }], { reset: true }));
    session.apply(delta(session.at(15, 2), [{ at: A, v: 15, gone: [1] }]));
    expect(session.apply(commit(session.at(15, 2))).anomaly?.kind).toBe("bad_transaction");
    expect(session.ids(A)).toEqual([1]);
  });
});

describe("fragments", () => {
  test("of one chunk, across several parts, show the chunk whole at the commit", () => {
    const session = connected();
    const at = (i: number) => ({ at: C, v: 30, frag: { i, n: 3 } });
    session.apply(
      snapshot(session.at(31, 2), [{ ...at(2), beings: [being(7, [5, 33])], terrain: null }]),
    );
    session.apply(
      snapshot(session.at(31, 2), [{ ...at(0), beings: [being(5, [0, 32])], terrain: null }]),
    );
    expect(session.ids(C)).toBeUndefined();
    session.apply(snapshot(session.at(31, 2), [{ ...at(1), beings: [being(6, [31, 63])] }]));
    expect(session.ids(C)).toBeUndefined();
    session.apply(commit(session.at(31, 2)));
    expect(session.ids(C)).toEqual([5, 6, 7]);
    expect(session.view.chunks.get(chunkKey(C))?.terrain).toBeDefined();
  });

  /** Each case: what breaks, the fragments sent, of 3, and those that carry the terrain. */
  const BROKEN: readonly (readonly [string, readonly number[], readonly number[]])[] = [
    ["one is missing", [0, 1], [0]],
    ["one comes twice", [0, 1, 1, 2], [0]],
    ["two carry terrain", [0, 1, 2], [0, 1]],
    ["none carries terrain", [0, 1, 2], []],
  ];

  test.each(BROKEN)("break the transaction when %s", (_, indexes, withTerrain) => {
    const session = connected();
    for (const i of indexes) {
      const terrain = withTerrain.includes(i) ? TERRAIN : null;
      session.apply(
        snapshot(session.at(31, 2), [{ at: C, v: 30, frag: { i, n: 3 }, beings: [], terrain }]),
      );
    }
    const applied = session.apply(commit(session.at(31, 2)));
    expect(applied.anomaly?.kind).toBe("bad_transaction");
    expect([session.ids(C), session.state.stale]).toEqual([undefined, true]);
  });
});

describe("anomalies", () => {
  test("a seq gap discards the transaction in flight, even a reset, which never applies", () => {
    const session = connected();
    session.apply(snapshot(session.at(15, 2), [{ at: A, v: 15 }], { reset: true }));
    // The lost part held chunk C of the reset.
    session.lose();
    const gap = session.apply(snapshot(session.at(15, 2), [{ at: B, v: 15 }], { reset: true }));
    expect(gap.anomaly).toEqual({ kind: "seq_gap", detail: "expected seq 4, received 5" });
    const closed = session.apply(commit(session.at(15, 2)));
    expect([closed.anomaly, closed.committed]).toEqual([undefined, undefined]);
    expect([session.ids(A), session.ids(B), session.view.tick, session.state.stale]).toEqual([
      [1],
      [2],
      12,
      true,
    ]);
  });

  test("a gap before the first part seen of a transaction discards that transaction too", () => {
    const session = connected();
    // The lost part was the first of reset 2, with chunk C.
    session.lose();
    session.apply(snapshot(session.at(15, 2), [{ at: A, v: 15 }], { reset: true }));
    expect(session.apply(commit(session.at(15, 2))).committed).toBeUndefined();
    expect([session.ids(A), session.ids(C)]).toEqual([[1], undefined]);
    // The next reset applies whole.
    const beings = [being(9, [1, 1])];
    session.apply(snapshot(session.at(17, 3), [{ at: A, v: 16, beings }], { reset: true }));
    expect(session.apply(commit(session.at(17, 3))).committed?.reset).toBe(true);
    expect([session.ids(A), session.state.stale]).toEqual([[9], false]);
  });

  test("a commit whose tick does not exceed the previous commit's", () => {
    const session = connected();
    for (const tick of [12, 11]) {
      const applied = session.apply(commit(session.at(tick, 2)));
      expect(applied.anomaly?.kind).toBe("tick_not_increasing");
      expect([session.view.tick, session.state.stale]).toEqual([12, true]);
    }
  });

  test("a first commit below hello's tick", () => {
    const session = new Session();
    session.apply(hello(10));
    session.apply(snapshot(session.at(9, 0), [], { reset: true }));
    expect(session.apply(commit(session.at(9, 0))).anomaly?.kind).toBe("tick_not_increasing");
    expect(session.view.tick).toBe(10);
  });

  test("parts of one transaction at different ticks, or two transactions at once", () => {
    const ticks = connected();
    ticks.apply(events(ticks.at(15, 2), []));
    expect(ticks.apply(events(ticks.at(16, 2), [])).anomaly?.kind).toBe("bad_transaction");
    const overlap = connected();
    overlap.apply(events(overlap.at(15, 2), []));
    expect(overlap.apply(events(overlap.at(15, 3), [])).anomaly?.kind).toBe("bad_transaction");
    const closing = connected();
    closing.apply(events(closing.at(15, 2), []));
    expect(closing.apply(commit(closing.at(15, 3))).anomaly?.kind).toBe("bad_transaction");
  });

  test("differences of a chunk that is not visible, or of a being that is not there", () => {
    const cases = [
      [{ at: C, v: 15, gone: [] }],
      [{ at: A, v: 15, gone: [2] }],
      [{ at: A, v: 10 }],
      [{ at: A, v: 15, upsert: [being(1, [40, 3])] }],
    ];
    for (const chunks of cases) {
      const session = connected();
      session.apply(delta(session.at(15, 2), chunks));
      expect(session.apply(commit(session.at(15, 2))).anomaly?.kind).toBe("bad_transaction");
      expect([session.ids(A), session.view.tick]).toEqual([[1], 12]);
    }
  });

  test("a chunk entering that is already visible", () => {
    const session = connected();
    session.apply(snapshot(session.at(15, 2), [{ at: A, v: 15 }]));
    expect(session.apply(commit(session.at(15, 2))).anomaly?.kind).toBe("bad_transaction");
  });
});

describe("reconnecting", () => {
  test("keeps the old view and clock, stale, until the new connection's reset", () => {
    const session = connected();
    const old = session.view;
    const other = "fedcba9876543210fedcba9876543210";
    session.apply(message({ ...hello(3), world: { id: other } }));
    expect([session.view, session.state.stale, session.state.connection?.worldId]).toEqual([
      old,
      true,
      other,
    ]);
    // A new world may start at a lower tick: the commits of the new connection are compared anew.
    const fresh = new Session();
    fresh.state = session.state;
    fresh.apply(snapshot(fresh.at(4, 0), [{ at: C, v: 4 }], { reset: true }));
    const applied = fresh.apply(commit(fresh.at(4, 0)));
    expect(applied.anomaly).toBeUndefined();
    expect([fresh.ids(A), fresh.ids(C), fresh.view.tick, fresh.view.clock]).toEqual([
      undefined,
      [],
      4,
      clockAt(4),
    ]);
  });
});

describe("purity", () => {
  test("the same messages give the same states, and earlier states never change", () => {
    const first = connected();
    const second = connected();
    const states = [first.state];
    for (const session of [first, second]) {
      session.apply(delta(session.at(15, 2), [{ at: A, v: 15, gone: [1] }], [B]));
      session.apply(commit(session.at(15, 2)));
    }
    expect(second.state).toEqual(first.state);
    expect(states[0]?.view?.chunks.size).toBe(2);
    expect([first.ids(A), first.ids(B)]).toEqual([[], undefined]);
  });
});
