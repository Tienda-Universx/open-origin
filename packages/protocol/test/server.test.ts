import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  AbortMessage,
  CLIENT_LIMITS,
  CommitMessage,
  DeltaMessage,
  ERROR_CODES,
  ErrorMessage,
  EventsMessage,
  HelloMessage,
  Limits,
  MAX_NONCE,
  NoticeMessage,
  PongMessage,
  parseServerMessage,
  SERVER_MESSAGE_TYPES,
  ServerMessage,
  SnapshotMessage,
  StatusMessage,
} from "../src/public/index.ts";
import { being, clockAt, TERRAIN, WORLD_ID } from "./support/messages.ts";
import { Random } from "./support/random.ts";

const AT = { seq: 3, tick: 40, txn: 2 };

/** One message of each type, with every required member and no optional one. */
const MINIMAL: Record<string, Record<string, unknown>> = {
  hello: {
    type: "hello",
    seq: 0,
    tick: 40,
    protocol: "open-origin.public.v1",
    audience: "public",
    world: { id: WORLD_ID },
    durability: "ephemeral",
    state: "running",
    clock: clockAt(40),
    limits: { ...CLIENT_LIMITS },
  },
  delta: { type: "delta", ...AT, chunks: [], drop: [] },
  snapshot: { type: "snapshot", ...AT, reset: false, chunks: [] },
  events: { type: "events", ...AT, items: [] },
  commit: { type: "commit", ...AT, clock: clockAt(40) },
  abort: { type: "abort", ...AT },
  notice: { type: "notice", seq: 3, tick: 40, code: "interest_trimmed", chunks: [[1, 1]] },
  pong: { type: "pong", seq: 3, tick: 40, nonce: 9 },
  status: { type: "status", seq: 3, tick: 40, state: "paused" },
  error: { type: "error", seq: 3, tick: 40, code: "rate_limited" },
};

/** The schema of each type. */
const SCHEMAS: Record<string, z.ZodType> = {
  hello: HelloMessage,
  delta: DeltaMessage,
  snapshot: SnapshotMessage,
  events: EventsMessage,
  commit: CommitMessage,
  abort: AbortMessage,
  notice: NoticeMessage,
  pong: PongMessage,
  status: StatusMessage,
  error: ErrorMessage,
};

/** Each type with its optional members filled in. */
const FULL: Record<string, Record<string, unknown>> = {
  delta: {
    ...MINIMAL.delta,
    chunks: [
      {
        at: [0, 0],
        v: 39,
        gone: [4],
        upsert: [being(5, [3, 3])],
        speech: [{ tick: 40, speaker: 5, to: 6, act: "greet", text: "Being 5 greets being 6." }],
        speechMissed: 2,
      },
    ],
    drop: [[1, 0]],
  },
  snapshot: {
    ...MINIMAL.snapshot,
    chunks: [
      { at: [0, 0], v: 12, terrain: TERRAIN, beings: [being(5, [3, 3])], frag: { i: 0, n: 2 } },
    ],
    followed: being(5, [3, 3]),
  },
  events: {
    ...MINIMAL.events,
    items: [{ kind: "death", tick: 7, being: 4, chunk: [0, 0] }],
    missed: 3,
  },
  status: { ...MINIMAL.status, reason: "Maintenance of the journal." },
};

const accepts = (value: unknown) => ServerMessage.safeParse(value).success;

describe("the server's types", () => {
  test("are exactly the ten of ADR 0026", () => {
    const types: readonly string[] = SERVER_MESSAGE_TYPES;
    expect(types).toEqual(Object.keys(MINIMAL));
    const schemaTypes: readonly string[] = ServerMessage.options.map(
      (option) => option.shape.type.value,
    );
    expect(schemaTypes).toEqual([...SERVER_MESSAGE_TYPES]);
  });

  test.each(Object.keys(MINIMAL))("%s accepts its minimal and its full form", (type) => {
    expect(accepts(MINIMAL[type])).toBe(true);
    expect(SCHEMAS[type]?.safeParse(MINIMAL[type]).success).toBe(true);
    if (FULL[type] !== undefined) expect(accepts(FULL[type])).toBe(true);
  });

  test.each(Object.keys(MINIMAL))("%s rejects an extra key, at the top and inside", (type) => {
    const message = FULL[type] ?? MINIMAL[type] ?? {};
    expect(accepts({ ...message, extra: 1 })).toBe(false);
    expect(accepts({ ...message, simSecondsPerTick: 12 })).toBe(false);
    expect(accepts(JSON.parse(`${JSON.stringify(message).slice(0, -1)},"__proto__":{}}`))).toBe(
      false,
    );
  });

  test.each(Object.keys(MINIMAL))("%s rejects the loss of any one required key", (type) => {
    const message = MINIMAL[type] ?? {};
    const kept = Object.keys(message).map((key) => {
      const { [key]: _, ...rest } = message;
      return accepts(rest);
    });
    expect(kept).toEqual(Object.keys(message).map(() => false));
  });
});

describe("hello", () => {
  test("has exactly these keys, and no rate of the world", () => {
    expect(Object.keys(HelloMessage.shape)).toEqual([
      "type",
      "seq",
      "tick",
      "protocol",
      "audience",
      "world",
      "durability",
      "state",
      "clock",
      "limits",
    ]);
    expect(Object.keys(Limits.shape)).toEqual(Object.keys(CLIENT_LIMITS));
    expect(Object.keys(HelloMessage.shape.clock.shape)).toEqual(["tick", "day", "dayPermille"]);
  });

  test("rejects a rate, a speed, or the seconds of a tick", () => {
    const hello = MINIMAL.hello ?? {};
    for (const key of ["tickRateHz", "simSecondsPerTick", "rate", "speed", "chunkCells"]) {
      expect(accepts({ ...hello, [key]: 5 })).toBe(false);
      expect(accepts({ ...hello, clock: { ...clockAt(40), [key]: 5 } })).toBe(false);
      expect(accepts({ ...hello, limits: { ...CLIENT_LIMITS, [key]: 5 } })).toBe(false);
    }
  });

  test("has seq 0, the clock of its tick, the protocol, and a world id of 32 hex digits", () => {
    const hello = MINIMAL.hello ?? {};
    const cases = [
      { ...hello, seq: 1 },
      { ...hello, clock: clockAt(41) },
      { ...hello, protocol: "open-origin.public.v2" },
      { ...hello, audience: "admin" },
      { ...hello, world: { id: WORLD_ID.toUpperCase() } },
      { ...hello, world: { id: WORLD_ID.slice(1) } },
      { ...hello, world: { id: `${WORLD_ID}0` } },
      { ...hello, durability: "durable-ish" },
      { ...hello, state: "fast" },
      { ...hello, limits: { ...CLIENT_LIMITS, maxChunks: 65 } },
      { ...hello, limits: { ...CLIENT_LIMITS, burst: 0 } },
    ];
    expect(cases.map(accepts)).toEqual(cases.map(() => false));
    expect(accepts({ ...hello, durability: "durable", state: "halted" })).toBe(true);
  });
});

describe("bounds", () => {
  test("of the clock, seq, tick, and nonce", () => {
    const cases = [
      { ...MINIMAL.commit, clock: { ...clockAt(40), dayPermille: 1000 } },
      { ...MINIMAL.commit, clock: { ...clockAt(40), day: -1 } },
      { ...MINIMAL.commit, clock: clockAt(39) },
      { ...MINIMAL.abort, seq: -1 },
      { ...MINIMAL.abort, tick: 2 ** 53 },
      { ...MINIMAL.abort, txn: 1.5 },
      { ...MINIMAL.pong, nonce: MAX_NONCE + 1 },
      { ...MINIMAL.pong, nonce: -1 },
    ];
    expect(cases.map(accepts)).toEqual(cases.map(() => false));
    expect(accepts({ ...MINIMAL.pong, nonce: MAX_NONCE })).toBe(true);
  });

  test("of codes and states", () => {
    const cases = [
      { ...MINIMAL.error, code: "internal" },
      { ...MINIMAL.notice, code: "slow" },
      { ...MINIMAL.notice, chunks: [] },
      { ...MINIMAL.status, state: "fast" },
      { ...MINIMAL.status, reason: `two${String.fromCodePoint(10)}lines` },
    ];
    expect(cases.map(accepts)).toEqual(cases.map(() => false));
    for (const code of ERROR_CODES) expect(accepts({ ...MINIMAL.error, code })).toBe(true);
  });

  test("of a transaction's chunks: no version, and no speech, after its tick", () => {
    const [chunk] = (FULL.delta?.chunks as object[] | undefined) ?? [];
    const cases = [
      { ...FULL.delta, chunks: [{ ...chunk, v: 41 }] },
      {
        ...FULL.delta,
        chunks: [
          { ...chunk, speech: [{ tick: 41, speaker: 5, to: 6, act: "greet", text: "Hi." }] },
        ],
      },
      { ...FULL.snapshot, chunks: [{ at: [0, 0], v: 41, beings: [], frag: { i: 0, n: 1 } }] },
    ];
    expect(cases.map(accepts)).toEqual(cases.map(() => false));
  });

  test("of a transaction's feed: no item after its tick", () => {
    const death = (tick: number) => ({ kind: "death", tick, being: 4, chunk: [0, 0] });
    const greeting = (tick: number) => ({ kind: "greeting", tick, from: 4, to: 5, chunk: [0, 0] });
    const feed = (items: object[]) => ({ ...MINIMAL.events, items });
    const atTick = [feed([death(40)]), feed([death(0), greeting(40)])];
    expect(atTick.map(accepts)).toEqual([true, true]);
    const after = [feed([death(41)]), feed([death(7), greeting(41)])];
    expect(after.map(accepts)).toEqual([false, false]);
  });

  test("of fragments: an index below a count of at least one", () => {
    const fragment = (frag: object) => ({
      ...MINIMAL.snapshot,
      chunks: [{ at: [0, 0], v: 1, beings: [], frag }],
    });
    expect(
      [
        { i: 0, n: 1 },
        { i: 1, n: 2 },
      ].map((frag) => accepts(fragment(frag))),
    ).toEqual([true, true]);
    const bad = [{ i: 1, n: 1 }, { i: 0, n: 0 }, { i: -1, n: 1 }, { i: 0 }, { i: 0, n: 1, of: 1 }];
    expect(bad.map((frag) => accepts(fragment(frag)))).toEqual(bad.map(() => false));
  });
});

describe("parseServerMessage", () => {
  test("gives a message, bad_json, or bad_message, and never throws", () => {
    const pong: unknown = parseServerMessage(JSON.stringify(MINIMAL.pong));
    expect(pong).toEqual({
      ok: true,
      message: MINIMAL.pong,
    });
    expect(parseServerMessage("{")).toEqual({ ok: false, code: "bad_json" });
    expect(parseServerMessage(JSON.stringify({ ...MINIMAL.pong, rate: 1 }))).toEqual({
      ok: false,
      code: "bad_message",
    });
    expect(parseServerMessage('{"type":"setSpeed","seq":1,"tick":1,"speed":2}')).toEqual({
      ok: false,
      code: "bad_message",
    });
  });
});

describe("a chunk appears once in a delta and in a notice", () => {
  /** A delta entry for the chunk `at`, with no change in it. */
  const entry = (at: [number, number]) => ({ at, v: 1, gone: [], upsert: [], speech: [] });

  test("a delta rejects a chunk twice in chunks, twice in drop, or in both", () => {
    const delta = MINIMAL.delta;
    const cases = [
      { ...delta, chunks: [entry([1, 1]), entry([1, 1])] },
      {
        ...delta,
        drop: [
          [2, 2],
          [2, 2],
        ],
      },
      { ...delta, chunks: [entry([3, 3])], drop: [[3, 3]] },
    ];
    expect(cases.map((message) => DeltaMessage.safeParse(message).success)).toEqual([
      false,
      false,
      false,
    ]);
    const distinct = { ...delta, chunks: [entry([1, 1]), entry([1, 2])], drop: [[2, 1]] };
    expect(DeltaMessage.safeParse(distinct).success).toBe(true);
  });

  test("a notice rejects a chunk listed twice", () => {
    const twice = {
      ...MINIMAL.notice,
      chunks: [
        [1, 1],
        [1, 1],
      ],
    };
    expect(NoticeMessage.safeParse(twice).success).toBe(false);
    const distinct = {
      ...MINIMAL.notice,
      chunks: [
        [1, 1],
        [1, 2],
      ],
    };
    expect(NoticeMessage.safeParse(distinct).success).toBe(true);
  });
});

describe("parseServerMessage never throws on hostile text", () => {
  test("rejects JSON values that are not records, and a type that only __proto__ holds", () => {
    const texts = ["null", "[]", "42", '"pong"', "true", '{"__proto__":{"type":"pong"}}'];
    expect(texts.map(parseServerMessage)).toEqual(
      texts.map(() => ({ ok: false, code: "bad_message" })),
    );
  });

  test("seeded fuzz: every result is a message, bad_json, or bad_message", () => {
    const random = new Random(0x5eed_0003);
    const keys = ["type", "seq", "tick", "txn", "chunks", "drop", "__proto__", "constructor", "x"];
    const values: unknown[] = [null, 0, -1, 2 ** 53, 1.5, "", "pong", [], {}, [[1, 1]], true];
    const types = [...SERVER_MESSAGE_TYPES, "setSpeed", "pause"];
    const codes = new Set<string>();
    for (let n = 0; n < 500; n += 1) {
      const record: Record<string, unknown> = { type: random.pick(types) };
      for (let k = random.below(5); k > 0; k -= 1) record[random.pick(keys)] = random.pick(values);
      const json = JSON.stringify(record);
      const text = random.below(4) === 0 ? json.slice(0, random.below(json.length + 1)) : json;
      const result = parseServerMessage(text);
      codes.add(result.ok ? "ok" : result.code);
    }
    expect([...codes].every((code) => ["ok", "bad_json", "bad_message"].includes(code))).toBe(true);
    // The fuzz reached both rejections, so neither branch is untested by it.
    expect(codes.has("bad_json") && codes.has("bad_message")).toBe(true);
  });
});
