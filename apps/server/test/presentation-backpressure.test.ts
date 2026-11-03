/**
 * The send discipline of the presentation's edge (plan tests 7b and 13 in process; ADR 0026,
 * "Ordering and liveness" and "Limits and backpressure"; ADR 0025, "Playout"). A message goes out
 * only while its client's socket buffers less than 256 KiB, and what a drain sends takes from the
 * period's budget, which it never renews. The fan-out serves clients within 40 ms a period on the
 * injected clock, those that do not fit first in the next. The world's state reaches every client
 * in hello and as `status` on each change, and a stopped world sends `status` each period instead
 * of a commit.
 */
import { describe, expect, test } from "bun:test";
import type { BeingPublic, ChunkCoord } from "@open-origin/protocol/public";
import { BUFFER_BYTES } from "../src/presentation/client.ts";
import type { WorldState } from "../src/presentation/frames.ts";
import { FAN_OUT_MICROS, MIN_PART_BYTES } from "../src/presentation/presentation.ts";
import { being, ModelWorld, presentationOver, ViewClient } from "./support/presentation.ts";

/** Six chunks of 300 beings each, about 240 KB in all. */
const AREA: readonly ChunkCoord[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [0, 1],
  [1, 1],
  [2, 1],
];
const PER_CHUNK = 300;
/** Parts of 16 KiB in a budget of three a period. */
const PART = MIN_PART_BYTES;
const BUDGET = 3 * PART;

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

describe("a client's sends", () => {
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
});

describe("the world's state", () => {
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
