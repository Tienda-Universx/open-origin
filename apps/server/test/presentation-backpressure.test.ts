/**
 * The send discipline of the presentation's edge (plan tests 7b and 13 in process; ADR 0026,
 * "Ordering and liveness" and "Limits and backpressure"; ADR 0025, "Playout"). A client gets at
 * most its period's budget, every message counted: parts, commits, `pong`, `status`, `error`,
 * `notice`, `abort`, and what a drain sends; and a message goes out only while its socket buffers
 * less than 256 KiB, so the buffer never passes 512 KiB. A seeded property checks both with
 * sockets that drain at random rates, clients that churn their interest, ping, resync, send
 * rejected messages, and are aborted by the memory guard, and a world that stops and resumes; then,
 * while every socket drains, each transaction sends more than a period's budget less a part in each
 * period but its last. The fan-out serves clients within 40 ms a period on the injected clock,
 * those that do not fit first in the next. The world's state reaches every client in hello and as
 * `status` on each change, and a stopped world sends `status` each period instead of a commit.
 */
import { describe, expect, test } from "bun:test";
import {
  type BeingPublic,
  type ChunkCoord,
  chunkKey,
  type ServerMessage,
} from "@open-origin/protocol/public";
import { Random } from "../../../packages/protocol/test/support/random.ts";
import { BUFFER_BYTES } from "../src/presentation/client.ts";
import type { WorldState } from "../src/presentation/frames.ts";
import type { ClientId } from "../src/presentation/interest.ts";
import {
  FAN_OUT_MICROS,
  MIN_PART_BYTES,
  type Presentation,
} from "../src/presentation/presentation.ts";
import { RETAINED_BYTES } from "../src/presentation/retention.ts";
import {
  being,
  chunkOfCell,
  expected,
  ModelWorld,
  plain,
  presentationOver,
  shown,
  type TickChanges,
  ViewClient,
} from "./support/presentation.ts";

/** The 3 × 2 chunks of the property's world. */
const AREA: readonly ChunkCoord[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [0, 1],
  [1, 1],
  [2, 1],
];
const PER_CHUNK = 300;
/**
 * Parts of 16 KiB in a budget of three a period, and a view of about three chunks. Only the two
 * busy chunks change, about 74 KB of records: up-to-date clients retain their last versions, and
 * the limit of 110 KB retained acts once lagging clients retain older ones.
 */
const PART = MIN_PART_BYTES;
const BUDGET = 3 * PART;
const VIEW = 160_000;
const RETAINED = 110_000;
const PERIODS = 48;
const DRAINED_PERIODS = 30;
const CLIENTS = 4;

/** A being of chunk `at` that talks to a far id, so its record is about 120 bytes. */
function talker(id: number, cell: readonly [number, number]): BeingPublic {
  return being(id, cell, { kind: "talk", to: 8_000_000_000_000_000 + id, act: "unknown" });
}

/** The beings of the area at boot, `PER_CHUNK` in each chunk. */
function populate(): BeingPublic[] {
  return AREA.flatMap(([x, y], k) =>
    Array.from({ length: PER_CHUNK }, (_, n) =>
      talker(1 + k * PER_CHUNK + n, [x * 32 + (n % 32), y * 32 + Math.floor(n / 32)]),
    ),
  );
}

/** One tick of the property's world: 25 beings of the busy chunks move in them, and one speaks. */
function changesOf(random: Random, model: ModelWorld): TickChanges {
  const busy = [...model.beings.values()].filter(({ cell }) => cell[1] < 32 && cell[0] < 64);
  const set = Array.from({ length: 25 }, () =>
    talker(random.pick(busy).id, [random.below(64), random.below(32)]),
  );
  const tick = model.tick + 1;
  const speaker = set[0];
  if (speaker === undefined) return { set };
  const at = chunkOfCell(speaker.cell);
  return {
    set,
    speech: [{ at, speech: { tick, speaker: speaker.id, to: 1, act: "greet", text: plain("hi") } }],
    feed: [{ kind: "greeting", tick, from: speaker.id, to: 1, chunk: at }],
  };
}

/** A camera of 1 to 6 chunks of the area, in a random order. */
function cameraOf(random: Random): ChunkCoord[] {
  const camera = new Map<string, ChunkCoord>();
  const size = 1 + random.below(AREA.length);
  while (camera.size < size) {
    const at = random.pick(AREA);
    camera.set(chunkKey(at), at);
  }
  return [...camera.values()];
}

/** A client of the property, its socket's drain a period, and what it received in each period. */
type Tracked = {
  client: ViewClient;
  id: ClientId;
  drain: number;
  /** Its frame count when the current period began. */
  from: number;
  /** By period, the bytes it received, and the transactions whose parts or commit it received. */
  readonly periods: Map<number, { bytes: number; parts: Set<number>; commits: Set<number> }>;
};

/** What the property covered, so that it is never checked vacuously. */
type Coverage = Record<ServerMessage["type"] | "lagging" | "drains" | "slowCloses", number>;

/** The property's run: its world, its presentation, its clients, and what they covered. */
class Run {
  readonly random = new Random(0x0ba5e);
  readonly model = new ModelWorld(0, populate());
  state: WorldState = "running";
  readonly over;
  readonly tracked: Tracked[] = [];
  period = 0;
  readonly coverage: Coverage = {
    hello: 0,
    delta: 0,
    snapshot: 0,
    events: 0,
    commit: 0,
    abort: 0,
    notice: 0,
    pong: 0,
    status: 0,
    error: 0,
    lagging: 0,
    drains: 0,
    slowCloses: 0,
  };

  /** A run whose replaced versions are limited to `retained` bytes. */
  constructor(retained = RETAINED) {
    this.over = presentationOver(this.model, {
      partBytes: PART,
      periodBytes: BUDGET,
      viewBytes: VIEW,
      retainedBytes: retained,
      worldState: () => this.state,
    });
  }

  get presentation(): Presentation {
    return this.over.presentation;
  }

  /** Connects a client whose socket buffers what it receives, with a random camera. */
  connect(): Tracked {
    const client = new ViewClient();
    client.buffering = true;
    const id = this.presentation.connect(client);
    const drain = this.random.pick([0, 2048, PART]);
    const tracked: Tracked = { client, id, drain, from: 0, periods: new Map() };
    client.onMessage = (message) => this.#note(tracked, message);
    this.send(tracked, { type: "subscribe", chunks: cameraOf(this.random) });
    return tracked;
  }

  send(tracked: Tracked, message: object): void {
    this.presentation.receive(tracked.id, JSON.stringify(message));
  }

  /** One client's moves between two periods. */
  churn(tracked: Tracked): void {
    const roll = this.random.below(100);
    const beings = [...this.model.beings.keys()];
    if (roll < 8) this.send(tracked, { type: "subscribe", chunks: cameraOf(this.random) });
    else if (roll < 12) this.send(tracked, { type: "follow", being: this.random.pick(beings) });
    else if (roll < 14) this.send(tracked, { type: "follow", being: 1_000_000 });
    else if (roll < 18) this.send(tracked, { type: "ping", nonce: this.random.below(1000) });
    else if (roll < 21) this.send(tracked, { type: "resync" });
    else if (roll < 23) this.presentation.abort(tracked.id);
    else if (roll < 26) tracked.drain = this.random.pick([0, 2048, PART, 4 * PART, 1 << 20]);
  }

  /** The socket writes what its drain allows; crossing under the threshold, it says it drained. */
  drain(tracked: Tracked): void {
    const { client } = tracked;
    const full = client.buffer >= BUFFER_BYTES;
    client.buffer = Math.max(0, client.buffer - tracked.drain);
    if (!full || client.buffer >= BUFFER_BYTES) return;
    this.coverage.drains += 1;
    this.presentation.drained(tracked.id);
  }

  /** A client the memory guard closed with 1013 comes back as a new connection. */
  replaceEnded(): void {
    for (const [index, tracked] of this.tracked.entries()) {
      if (tracked.client.ended === undefined) continue;
      expect(tracked.client.ended).toEqual({ reason: "too_slow", code: 1013 });
      this.coverage.slowCloses += 1;
      this.tracked[index] = this.connect();
    }
  }

  /** Runs one period, every client's bytes since the last one checked against the budget. */
  runPeriod(changes: TickChanges): void {
    this.over.publisher.publish(this.model.step(changes));
    for (const tracked of this.tracked) {
      const sent = tracked.client.sizes.slice(tracked.from).reduce((sum, size) => sum + size, 0);
      expect(sent).toBeLessThanOrEqual(BUDGET);
      tracked.from = tracked.client.sizes.length;
    }
    this.period += 1;
    this.presentation.period();
    this.coverage.lagging += this.presentation.telemetry().laggingClients;
  }

  /**
   * Runs `periods` periods in which clients churn, sockets drain at their rates, and the world
   * stops now and then.
   */
  churning(periods: number): void {
    for (let period = 1; period <= periods; period += 1) {
      if (period % 13 === 0) this.state = this.state === "running" ? "paused" : "running";
      for (const tracked of this.tracked) this.churn(tracked);
      this.runPeriod(changesOf(this.random, this.model));
      for (const tracked of this.tracked) this.drain(tracked);
      this.replaceEnded();
    }
  }

  /**
   * Runs `periods` periods, every socket drained whole after each; clients churn in the first
   * three.
   */
  draining(periods: number): void {
    for (let period = 1; period <= periods; period += 1) {
      if (period <= 3) for (const tracked of this.tracked) this.churn(tracked);
      this.runPeriod(changesOf(this.random, this.model));
      for (const tracked of this.tracked) {
        tracked.client.buffer = 0;
        this.presentation.drained(tracked.id);
      }
    }
  }

  #note(tracked: Tracked, message: ServerMessage): void {
    this.coverage[message.type] += 1;
    const record = tracked.periods.get(this.period) ?? {
      bytes: 0,
      parts: new Set<number>(),
      commits: new Set<number>(),
    };
    record.bytes += tracked.client.sizes.at(-1) ?? 0;
    if (message.type === "commit") record.commits.add(message.txn);
    else if ("txn" in message && message.type !== "abort") record.parts.add(message.txn);
    tracked.periods.set(this.period, record);
  }
}

describe("a client's sends", () => {
  test("stay within the period's budget, every message counted, and its buffer within 512 KiB, whatever it drains (seeded property)", () => {
    const run = new Run();
    for (let n = 0; n < CLIENTS; n += 1) run.tracked.push(run.connect());
    run.churning(PERIODS);
    // Every kind of message, lagging sockets, drains, and closes for slowness took place.
    const uncovered = Object.entries(run.coverage).filter(([, count]) => count === 0);
    expect(uncovered).toEqual([]);
    for (const { client } of run.tracked) {
      expect(client.peakBeforeSend).toBeLessThan(BUFFER_BYTES);
      expect(client.peak).toBeLessThanOrEqual(BUFFER_BYTES + PART);
      expect(client.anomalies).toEqual([]);
    }
  });

  test("while every socket drains, a transaction sends more than a budget less a part in each period but its last", () => {
    const run = new Run(RETAINED_BYTES);
    for (let n = 0; n < CLIENTS; n += 1) run.tracked.push(run.connect());
    run.draining(DRAINED_PERIODS);
    // A period in which a transaction went on without its commit left no room for another part.
    const spanning = run.tracked.flatMap(({ periods }) =>
      [...periods.values()].filter(({ parts, commits }) =>
        [...parts].some((txn) => !commits.has(txn)),
      ),
    );
    expect(spanning.length).toBeGreaterThan(0);
    expect(spanning.filter(({ bytes }) => bytes <= BUDGET - PART)).toEqual([]);
    // Each client is up to date: its last commit is at the playout tick.
    const last = run.tracked.map(({ client }) => client.commits.at(-1)?.tick);
    expect(last).toEqual(run.tracked.map(() => run.model.tick));
  });

  test("stop at exactly 256 KiB buffered, and go on under it, one message at a time", () => {
    const model = new ModelWorld(0, populate());
    const { presentation, advance } = presentationOver(model, {
      partBytes: PART,
      periodBytes: BUDGET,
    });
    const client = new ViewClient();
    client.buffering = true;
    client.buffer = BUFFER_BYTES;
    const id = presentation.connect(client);
    presentation.subscribe(id, AREA);
    presentation.period();
    expect(client.sizes).toEqual([]);
    expect(presentation.telemetry().laggingClients).toBe(1);
    presentation.drained(id);
    expect(client.sizes).toEqual([]);
    // One byte under the threshold: one message goes, and the buffer is then over it.
    client.buffer = BUFFER_BYTES - 1;
    presentation.drained(id);
    expect(client.messages.map(({ type }) => type)).toEqual(["hello"]);
    client.buffer = BUFFER_BYTES - 1;
    advance();
    // The next period starts the reset: its first part goes, and the full buffer holds back the
    // rest.
    expect(client.messages.map(({ type }) => type)).toEqual(["hello", "snapshot"]);
    expect(client.buffer).toBeGreaterThanOrEqual(BUFFER_BYTES);
    expect(presentation.telemetry().laggingClients).toBe(1);
  });

  test("go out on a drain within what is left of the period's budget, and a drain starts no transaction", () => {
    const model = new ModelWorld(0, populate());
    const { presentation, advance } = presentationOver(model, {
      partBytes: PART,
      periodBytes: BUDGET,
    });
    const client = new ViewClient();
    const id = presentation.connect(client);
    presentation.subscribe(id, AREA);
    const sent = () => client.sizes.reduce((sum, size) => sum + size, 0);
    /** Runs a period, then two drains: the bytes of the three stay within one budget. */
    const period = (run: () => void) => {
      const before = sent();
      run();
      presentation.drained(id);
      presentation.drained(id);
      return sent() - before;
    };
    // The reset of six chunks, about 240 KB, takes several periods: each spends its budget.
    expect(period(() => presentation.period())).toBeGreaterThan(BUDGET - PART);
    const periods: number[] = [];
    while (client.commits.length === 0) periods.push(period(advance));
    expect(periods.length).toBeGreaterThan(2);
    expect(Math.max(...periods)).toBeLessThanOrEqual(BUDGET);
    expect(periods.slice(0, -1).every((bytes) => bytes > BUDGET - PART)).toBe(true);
    // Between periods, with nothing in flight, a drain sends nothing and starts nothing.
    const messages = client.messages.length;
    presentation.drained(id);
    expect(client.messages.length).toBe(messages);
    advance();
    expect(client.commits).toHaveLength(2);
  });
});

describe("the fan-out", () => {
  test("serves clients within 40 ms a period, those that do not fit first in the next", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const fanOuts: number[] = [];
    const { presentation, clock, advance } = presentationOver(model, {
      recordFanOut: (micros) => fanOuts.push(micros),
    });
    /** By period, the clients that got a commit in it. */
    const served: number[][] = [];
    const clients = Array.from({ length: 10 }, (_, index) => {
      const client = new ViewClient();
      // Each commit costs 10 ms on the injected clock: four clients fit in a period.
      client.onCommit = () => {
        clock.advance(FAN_OUT_MICROS / 4);
        served.at(-1)?.push(index + 1);
      };
      presentation.connect(client);
      return client;
    });
    for (let period = 0; period < 6; period += 1) {
      served.push([]);
      advance();
    }
    expect(served).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 1, 2],
      [3, 4, 5, 6],
      [7, 8, 9, 10],
      [1, 2, 3, 4],
    ]);
    expect(fanOuts).toEqual(Array(6).fill(FAN_OUT_MICROS));
    expect(clients.every((client) => client.anomalies.length === 0)).toBe(true);
  });

  test("counts as lagging a client with a full buffer that the time budget deferred", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    const { presentation, clock, advance } = presentationOver(model);
    const clients = Array.from({ length: 6 }, () => {
      const client = new ViewClient();
      // Each commit costs 10 ms on the injected clock: four clients fit in a period.
      client.onCommit = () => clock.advance(FAN_OUT_MICROS / 4);
      presentation.connect(client);
      return client;
    });
    const [deferred] = clients.slice(5);
    if (deferred === undefined) throw new Error("six clients were made");
    deferred.lag = true;
    advance();
    // Clients 5 and 6 waited for the next period; the sixth's buffer is full all the same.
    expect(clients.map((client) => client.commits.length)).toEqual([1, 1, 1, 1, 0, 0]);
    expect(presentation.telemetry().laggingClients).toBe(1);
  });
});

describe("the world's state", () => {
  test("may reach a client between the parts of its transaction, at its visible tick", () => {
    const dense = Array.from({ length: 300 }, (_, index) => being(index + 1, [index % 32, 3]));
    const model = new ModelWorld(0, dense);
    let state: WorldState = "running";
    const { presentation, advance } = presentationOver(model, {
      worldState: () => state,
      partBytes: MIN_PART_BYTES,
      periodBytes: MIN_PART_BYTES,
    });
    const client = new ViewClient();
    const id = presentation.connect(client);
    // An empty view first: its reset commits at tick 0 in the first period.
    presentation.period();
    expect(client.commits.map(({ tick }) => tick)).toEqual([0]);
    presentation.subscribe(id, [[0, 0]]);
    advance();
    state = "paused";
    for (let period = 0; period < 8; period += 1) presentation.period();
    const types = client.messages.map(({ type, tick }) => `${type}@${tick}`);
    const status = types.indexOf("status@0");
    const commit = types.indexOf("commit@1");
    // The status, at the visible tick 0, falls between the parts of the transaction to tick 1.
    expect(types.slice(3, status)).toContain("snapshot@1");
    expect(status).toBeLessThan(commit);
    expect(client.anomalies).toEqual([]);
    expect(client.state.world.state).toBe("paused");
    expect(shown(client.state)).toEqual(expected(model, 1, ["0,0"], 0));
  });

  test("reaches every client in hello and as status on each change; a stopped world sends it each period", () => {
    const model = new ModelWorld(0, [being(1, [5, 5])]);
    let state: WorldState = "paused";
    const { presentation, advance } = presentationOver(model, { worldState: () => state });
    const early = new ViewClient();
    presentation.connect(early);
    presentation.period();
    expect(early.messages.map(({ type }) => type)).toEqual(["hello", "snapshot", "commit"]);
    expect(early.state.world.state).toBe("paused");
    // A stopped world's playout gives no new commit: status comes each period instead.
    presentation.period();
    presentation.period();
    expect(early.messages.slice(3)).toMatchObject([
      { type: "status", tick: 0, state: "paused" },
      { type: "status", tick: 0, state: "paused" },
    ]);
    state = "running";
    advance();
    expect(early.messages.slice(5)).toMatchObject([
      { type: "status", tick: 0, state: "running" },
      { type: "commit", tick: 1 },
    ]);
    const late = new ViewClient();
    presentation.connect(late);
    state = "halted";
    presentation.period();
    expect(late.messages.map((message) => [message.type, message.tick])).toEqual([
      ["hello", 1],
      ["status", 1],
      ["snapshot", 1],
      ["commit", 1],
    ]);
    expect([early.state.world.state, late.state.world.state]).toEqual(["halted", "halted"]);
    expect(late.messages[0]).toMatchObject({ state: "running" });
    // An up-to-date client of a halted world hears it each period, with nothing else to say.
    presentation.period();
    expect(early.messages.at(-1)).toMatchObject({ type: "status", tick: 1, state: "halted" });
  });
});
