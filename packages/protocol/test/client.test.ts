import { describe, expect, test } from "bun:test";
import {
  CLIENT_LIMITS,
  CLIENT_MESSAGE_TYPES,
  ClientMessage,
  type ClientMessageError,
  MAX_CHUNK,
  MAX_NONCE,
  MIN_CHUNK,
  parseClientMessage,
  utf8Length,
} from "../src/public/index.ts";
import { Random } from "./support/random.ts";

/** The code parseClientMessage gives `text`, or "ok". */
function codeOf(text: string): ClientMessageError | "ok" {
  const result = parseClientMessage(text);
  return result.ok ? "ok" : result.code;
}

/** The text of `value` as a client would send it. */
const json = (value: unknown) => JSON.stringify(value);

/** `count` distinct chunks inside the world. */
const chunks = (count: number) => Array.from({ length: count }, (_, index) => [index, -index]);

describe("the client allowlist", () => {
  test("is exactly subscribe, follow, ping, and resync", () => {
    expect([...CLIENT_MESSAGE_TYPES]).toEqual(["subscribe", "follow", "ping", "resync"]);
    const schemaTypes: readonly string[] = ClientMessage.options.map(
      (option) => option.shape.type.value,
    );
    expect(schemaTypes).toEqual([...CLIENT_MESSAGE_TYPES]);
  });

  test("accepts each type with valid fields, and gives the message back", () => {
    const valid = [
      { type: "subscribe", chunks: [] },
      {
        type: "subscribe",
        chunks: [
          [MIN_CHUNK, MAX_CHUNK],
          [0, 0],
        ],
      },
      { type: "follow", being: 7 },
      { type: "follow", being: null },
      { type: "ping", nonce: 0 },
      { type: "ping", nonce: MAX_NONCE },
      { type: "resync" },
    ];
    for (const value of valid) {
      const result: unknown = parseClientMessage(json(value));
      expect(result).toEqual({ ok: true, message: value });
    }
  });

  test.each([
    "pause",
    "resume",
    "speed",
    "setSpeed",
    "step",
    "seek",
    "rewind",
    "tick",
    "rate",
    "clock",
    "time",
    "hello",
    "commit",
    "Subscribe",
    "ping ",
    "",
    "__proto__",
    "constructor",
    "toString",
  ])("a message of type %p is unknown_type, whatever else it holds", (type) => {
    expect(codeOf(json({ type }))).toBe("unknown_type");
    expect(codeOf(json({ type, speed: 2, tick: 10, rate: 30 }))).toBe("unknown_type");
  });
});

describe("parseClientMessage rejects", () => {
  test("text that is not JSON as bad_json", () => {
    for (const text of ["", "{", "nope", "{'type':'ping'}", '{"type":"ping",}', "\u{1F30D}"]) {
      expect(codeOf(text)).toBe("bad_json");
    }
  });

  test("a value that is not a record, or has no string type of its own, as bad_message", () => {
    const texts = [
      "null",
      "[]",
      '[{"type":"ping","nonce":1}]',
      "1",
      '"ping"',
      "true",
      "{}",
      '{"type":1}',
      '{"type":null}',
      '{"type":["ping"]}',
      '{"type":{"type":"ping"}}',
      '{"__proto__":{"type":"resync"}}',
    ];
    expect(texts.map(codeOf)).toEqual(texts.map(() => "bad_message"));
  });

  test("extra keys, __proto__, and constructor as bad_message", () => {
    const texts = [
      json({ type: "resync", chunks: [] }),
      json({ type: "ping", nonce: 1, seq: 4 }),
      json({ type: "follow", being: 1, camera: [] }),
      '{"type":"resync","__proto__":{"admin":true}}',
      '{"type":"subscribe","chunks":[],"constructor":{"prototype":{}}}',
    ];
    expect(texts.map(codeOf)).toEqual(texts.map(() => "bad_message"));
  });

  test("wrong types, fractions, and values off their bounds as bad_message", () => {
    const values = [
      { type: "ping" },
      { type: "ping", nonce: "1" },
      { type: "ping", nonce: 1.5 },
      { type: "ping", nonce: -1 },
      { type: "ping", nonce: MAX_NONCE + 1 },
      { type: "follow" },
      { type: "follow", being: 0 },
      { type: "follow", being: -1 },
      { type: "follow", being: 1.5 },
      { type: "follow", being: 2 ** 53 },
      { type: "follow", being: "7" },
      { type: "subscribe" },
      { type: "subscribe", chunks: {} },
      { type: "subscribe", chunks: [[1]] },
      { type: "subscribe", chunks: [[1, 2, 3]] },
      { type: "subscribe", chunks: [["1", 2]] },
      { type: "subscribe", chunks: [[1.5, 2]] },
      { type: "subscribe", chunks: [null] },
      {
        type: "subscribe",
        chunks: [
          [0, 0],
          [0, 0],
        ],
      },
      // An integer beyond 2^53 is no safe integer: malformed, not merely outside the world.
      { type: "subscribe", chunks: [[2 ** 53, 0]] },
      // A coordinate outside the world beside a malformed one is malformed first.
      {
        type: "subscribe",
        chunks: [
          [MAX_CHUNK + 1, 0],
          ["x", 0],
        ],
      },
    ];
    expect(values.map((value) => codeOf(json(value)))).toEqual(values.map(() => "bad_message"));
  });

  test("more than 64 chunks as too_many_chunks, before anything in them", () => {
    expect(codeOf(json({ type: "subscribe", chunks: chunks(CLIENT_LIMITS.maxChunks) }))).toBe("ok");
    expect(codeOf(json({ type: "subscribe", chunks: chunks(CLIENT_LIMITS.maxChunks + 1) }))).toBe(
      "too_many_chunks",
    );
    const malformed = [...chunks(CLIENT_LIMITS.maxChunks), ["x", 0]];
    expect(codeOf(json({ type: "subscribe", chunks: malformed }))).toBe("too_many_chunks");
  });

  test("coordinates outside the world, by one, as out_of_bounds", () => {
    const outside = [
      [MIN_CHUNK - 1, 0],
      [MAX_CHUNK + 1, 0],
      [0, MIN_CHUNK - 1],
      [0, MAX_CHUNK + 1],
      [2 ** 52, 0],
    ];
    for (const chunk of outside) {
      expect(codeOf(json({ type: "subscribe", chunks: [[0, 0], chunk] }))).toBe("out_of_bounds");
    }
    const edges = [
      [MIN_CHUNK, MIN_CHUNK],
      [MAX_CHUNK, MAX_CHUNK],
    ];
    expect(codeOf(json({ type: "subscribe", chunks: edges }))).toBe("ok");
  });

  test("a message over 4 KiB of UTF-8 as bad_message, unparsed", () => {
    const base = json({ type: "ping", nonce: 1 });
    const padded = (bytes: number) => `${base}${" ".repeat(bytes - base.length)}`;
    expect(codeOf(padded(CLIENT_LIMITS.maxMessageBytes))).toBe("ok");
    expect(codeOf(padded(CLIENT_LIMITS.maxMessageBytes + 1))).toBe("bad_message");
    // Not even JSON: the size is checked first.
    expect(codeOf("{".repeat(CLIENT_LIMITS.maxMessageBytes + 1))).toBe("bad_message");
    expect(codeOf("é".repeat(CLIENT_LIMITS.maxMessageBytes / 2 + 1))).toBe("bad_message");
  });
});

describe("utf8Length", () => {
  test("counts the bytes of each code point, and a lone surrogate as U+FFFD", () => {
    expect(utf8Length("")).toBe(0);
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("世")).toBe(3);
    expect(utf8Length("\u{1F30D}")).toBe(4);
    expect(utf8Length(String.fromCharCode(0xd800))).toBe(3);
    const random = new Random(0x5eed_0002);
    for (let run = 0; run < 200; run += 1) {
      const text = Array.from({ length: random.below(20) }, () =>
        String.fromCharCode(random.below(0x1_0000)),
      ).join("");
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
    }
  });
});

/** The codes parseClientMessage may give. */
const CODES = new Set([
  "bad_json",
  "bad_message",
  "unknown_type",
  "too_many_chunks",
  "out_of_bounds",
]);

/** The keys a fuzzed record may hold: the protocol's, a few dangerous ones, and noise. */
const KEYS = ["type", "chunks", "being", "nonce", "__proto__", "constructor", "seq", "x"];
const TYPES = [...CLIENT_MESSAGE_TYPES, "pause", "speed", "", "PING"];

/** A random record of at most `depth` levels, with an own `__proto__` when it draws one. */
function randomRecord(random: Random, depth: number): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (let key = random.below(4); key > 0; key -= 1) {
    // defineProperty makes `__proto__` an own key, as JSON.parse does.
    Object.defineProperty(record, random.pick(KEYS), {
      value: randomValue(random, depth - 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (random.below(2) === 0) record.type = random.pick(TYPES);
  return record;
}

/** The kinds of random values: leaves first, then the nested ones. */
const VALUE_KINDS: readonly ((random: Random, depth: number) => unknown)[] = [
  () => null,
  (random) => random.below(2) === 0,
  (random) => random.pick([0, 1, -1, 1.5, MAX_NONCE, MAX_NONCE + 1, MIN_CHUNK - 1, 2 ** 53]),
  (random) => random.below(0x1_0000) - 0x8000,
  (random) => random.pick(TYPES),
  (random) => String.fromCharCode(random.below(0x1_0000)),
  (random) => [random.below(9) - 4, random.below(9) - 4],
  (random, depth) => Array.from({ length: random.below(4) }, () => randomValue(random, depth - 1)),
  randomRecord,
];

/** How many kinds of VALUE_KINDS are leaves. */
const LEAF_KINDS = 7;

/** A random JSON value of at most `depth` levels, biased toward the protocol's shapes. */
function randomValue(random: Random, depth: number): unknown {
  const kinds = depth > 0 ? VALUE_KINDS.length : LEAF_KINDS;
  return random.pick(VALUE_KINDS.slice(0, kinds))(random, depth);
}

describe("parseClientMessage under fuzz", () => {
  test("never throws, gives a listed code or a valid message, and never echoes its input", () => {
    const random = new Random(0x5eed_0003);
    const seen = new Set<string>();
    for (let run = 0; run < 600; run += 1) {
      const text = run % 3 === 0 ? json(randomValue(random, 3)) : fuzzText(random);
      const result = parseClientMessage(text);
      seen.add(result.ok ? "ok" : result.code);
      if (result.ok) {
        expect(ClientMessage.parse(JSON.parse(text))).toEqual(result.message);
        continue;
      }
      expect(CODES.has(result.code)).toBe(true);
      expect(Object.keys(result)).toEqual(["ok", "code"]);
    }
    // The fuzz reached every outcome, so the loop checked each kind of result.
    expect([...seen].sort()).toEqual([...CODES, "ok"].sort());
  });
});

/** A random text: random code units, or a valid message with a few characters changed. */
function fuzzText(random: Random): string {
  if (random.below(2) === 0) {
    return Array.from({ length: random.below(40) }, () =>
      String.fromCharCode(random.below(0x1_0000)),
    ).join("");
  }
  const base = random.pick([
    json({ type: "subscribe", chunks: chunks(random.below(70)) }),
    json({ type: "subscribe", chunks: [[MAX_CHUNK + random.below(3), 0]] }),
    json({ type: "ping", nonce: random.below(10) }),
    json({ type: "follow", being: random.below(3) }),
    json({ type: "resync" }),
  ]);
  if (random.below(3) === 0) return base;
  const at = random.below(base.length);
  return `${base.slice(0, at)}${String.fromCharCode(random.below(128))}${base.slice(at + 1)}`;
}
