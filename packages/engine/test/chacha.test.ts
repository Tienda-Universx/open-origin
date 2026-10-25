import { describe, expect, test } from "bun:test";
import { isU32 } from "../src/int.ts";
import { CHACHA20_BLOCK_WORDS, ChaCha20Key, chacha20Block } from "../src/rng/chacha.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { Sfc32 } from "./support/sfc32.ts";

/**
 * The ChaCha20 block function of RFC 8439 §2.3, a keyed pseudorandom function for terrain (ADR
 * 0021). The RFC prints keys, nonces, and blocks as bytes, and a state word is four of those bytes
 * read little-endian (§2.3), so "00 01 02 03" is the word 0x03020100. The input is state words 12
 * to 15: the block counter, then the nonce's three words.
 */

const NOT_U32 = (value: string) => `${value} is not an integer in [0, 4294967295]`;
const HOLE = "the element is a hole: the array must be dense";

/** The words of `rows`, bytes written as two hex digits and separated by spaces, little-endian. */
function wordsOf(...rows: readonly string[]): number[] {
  const bytes = rows
    .join(" ")
    .split(" ")
    .map((byte) => {
      if (!/^[0-9a-f]{2}$/.test(byte)) throw new Error(`${JSON.stringify(byte)} is not a byte`);
      return Number.parseInt(byte, 16);
    });
  if (bytes.length % 4 !== 0) throw new Error(`${bytes.length} bytes are not whole words`);
  const words: number[] = [];
  for (let at = 0; at < bytes.length; at += 4) {
    words.push(bytes.slice(at, at + 4).reduceRight((word, byte) => word * 256 + byte, 0));
  }
  return words;
}

/** A block function test vector, as RFC 8439 prints it. */
type Vector = {
  readonly name: string;
  /** The key's 32 bytes, in rows of 16. */
  readonly key: readonly string[];
  /** The nonce's 12 bytes. */
  readonly nonce: string;
  readonly counter: number;
  /** The serialized block (§2.3.2) or the keystream (A.1): 64 bytes, in rows of 16. */
  readonly block: readonly string[];
  /** "ChaCha state at the end": the same block, printed as its 16 words. */
  readonly state: readonly number[];
};

const SECTION_2_3_2: Vector = {
  name: "RFC 8439 section 2.3.2",
  key: [
    "00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f",
    "10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f",
  ],
  nonce: "00 00 00 09 00 00 00 4a 00 00 00 00",
  counter: 1,
  block: [
    "10 f1 e7 e4 d1 3b 59 15 50 0f dd 1f a3 20 71 c4",
    "c7 d1 f4 c7 33 c0 68 03 04 22 aa 9a c3 d4 6c 4e",
    "d2 82 64 46 07 9f aa 09 14 c2 d7 05 d9 8b 02 a2",
    "b5 12 9c d1 de 16 4e b9 cb d0 83 e8 a2 50 3c 4e",
  ],
  state: [
    0xe4e7f110, 0x15593bd1, 0x1fdd0f50, 0xc47120a3, 0xc7f4d1c7, 0x0368c033, 0x9aaa2204, 0x4e6cd4c3,
    0x466482d2, 0x09aa9f07, 0x05d7c214, 0xa2028bd9, 0xd19c12b5, 0xb94e16de, 0xe883d0cb, 0x4e3c50a2,
  ],
};

const APPENDIX_A1: readonly Vector[] = [
  {
    name: "RFC 8439 appendix A.1, test vector #1",
    key: [
      "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
      "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    ],
    nonce: "00 00 00 00 00 00 00 00 00 00 00 00",
    counter: 0,
    block: [
      "76 b8 e0 ad a0 f1 3d 90 40 5d 6a e5 53 86 bd 28",
      "bd d2 19 b8 a0 8d ed 1a a8 36 ef cc 8b 77 0d c7",
      "da 41 59 7c 51 57 48 8d 77 24 e0 3f b8 d8 4a 37",
      "6a 43 b8 f4 15 18 a1 1c c3 87 b6 69 b2 ee 65 86",
    ],
    state: [
      0xade0b876, 0x903df1a0, 0xe56a5d40, 0x28bd8653, 0xb819d2bd, 0x1aed8da0, 0xccef36a8,
      0xc70d778b, 0x7c5941da, 0x8d485751, 0x3fe02477, 0x374ad8b8, 0xf4b8436a, 0x1ca11815,
      0x69b687c3, 0x8665eeb2,
    ],
  },
  {
    name: "RFC 8439 appendix A.1, test vector #2",
    key: [
      "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
      "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    ],
    nonce: "00 00 00 00 00 00 00 00 00 00 00 00",
    counter: 1,
    block: [
      "9f 07 e7 be 55 51 38 7a 98 ba 97 7c 73 2d 08 0d",
      "cb 0f 29 a0 48 e3 65 69 12 c6 53 3e 32 ee 7a ed",
      "29 b7 21 76 9c e6 4e 43 d5 71 33 b0 74 d8 39 d5",
      "31 ed 1f 28 51 0a fb 45 ac e1 0a 1f 4b 79 4d 6f",
    ],
    state: [
      0xbee7079f, 0x7a385155, 0x7c97ba98, 0x0d082d73, 0xa0290fcb, 0x6965e348, 0x3e53c612,
      0xed7aee32, 0x7621b729, 0x434ee69c, 0xb03371d5, 0xd539d874, 0x281fed31, 0x45fb0a51,
      0x1f0ae1ac, 0x6f4d794b,
    ],
  },
  {
    name: "RFC 8439 appendix A.1, test vector #3",
    key: [
      "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
      "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01",
    ],
    nonce: "00 00 00 00 00 00 00 00 00 00 00 00",
    counter: 1,
    block: [
      "3a eb 52 24 ec f8 49 92 9b 9d 82 8d b1 ce d4 dd",
      "83 20 25 e8 01 8b 81 60 b8 22 84 f3 c9 49 aa 5a",
      "8e ca 00 bb b4 a7 3b da d1 92 b5 c4 2f 73 f2 fd",
      "4e 27 36 44 c8 b3 61 25 a6 4a dd eb 00 6c 13 a0",
    ],
    state: [
      0x2452eb3a, 0x9249f8ec, 0x8d829d9b, 0xddd4ceb1, 0xe8252083, 0x60818b01, 0xf38422b8,
      0x5aaa49c9, 0xbb00ca8e, 0xda3ba7b4, 0xc4b592d1, 0xfdf2732f, 0x4436274e, 0x2561b3c8,
      0xebdd4aa6, 0xa0136c00,
    ],
  },
  {
    name: "RFC 8439 appendix A.1, test vector #4",
    key: [
      "00 ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
      "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    ],
    nonce: "00 00 00 00 00 00 00 00 00 00 00 00",
    counter: 2,
    block: [
      "72 d5 4d fb f1 2e c4 4b 36 26 92 df 94 13 7f 32",
      "8f ea 8d a7 39 90 26 5e c1 bb be a1 ae 9a f0 ca",
      "13 b2 5a a2 6c b4 a6 48 cb 9b 9d 1b e6 5b 2c 09",
      "24 a6 6c 54 d5 45 ec 1b 73 74 f4 87 2e 99 f0 96",
    ],
    state: [
      0xfb4dd572, 0x4bc42ef1, 0xdf922636, 0x327f1394, 0xa78dea8f, 0x5e269039, 0xa1bebbc1,
      0xcaf09aae, 0xa25ab213, 0x48a6b46c, 0x1b9d9bcb, 0x092c5be6, 0x546ca624, 0x1bec45d5,
      0x87f47473, 0x96f0992e,
    ],
  },
  {
    name: "RFC 8439 appendix A.1, test vector #5",
    key: [
      "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
      "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00",
    ],
    nonce: "00 00 00 00 00 00 00 00 00 00 00 02",
    counter: 0,
    block: [
      "c2 c6 4d 37 8c d5 36 37 4a e2 04 b9 ef 93 3f cd",
      "1a 8b 22 88 b3 df a4 96 72 ab 76 5b 54 ee 27 c7",
      "8a 97 0e 0e 95 5c 14 f3 a8 8e 74 1b 97 c2 86 f7",
      "5f 8f c2 99 e8 14 83 62 fa 19 8a 39 53 1b ed 6d",
    ],
    state: [
      0x374dc6c2, 0x3736d58c, 0xb904e24a, 0xcd3f93ef, 0x88228b1a, 0x96a4dfb3, 0x5b76ab72,
      0xc727ee54, 0x0e0e978a, 0xf3145c95, 0x1b748ea8, 0xf786c297, 0x99c28f5f, 0x628314e8,
      0x398a19fa, 0x6ded1b53,
    ],
  },
];

const VECTORS = [SECTION_2_3_2, ...APPENDIX_A1];

const keyOf = (vector: Vector): number[] => wordsOf(...vector.key);
const inputOf = (vector: Vector): number[] => [vector.counter, ...wordsOf(vector.nonce)];

const KEY = keyOf(SECTION_2_3_2);
const INPUT = inputOf(SECTION_2_3_2);
const EXPECTED = [...SECTION_2_3_2.state];

/** A copy of `words` with a hole at `index`, whose prototype has `inherited` there if given. */
function holed(words: readonly number[], index: number, inherited?: number): number[] {
  const copy: number[] = [];
  words.forEach((word, at) => {
    if (at !== index) copy[at] = word;
  });
  copy.length = words.length;
  if (inherited !== undefined) {
    Object.setPrototypeOf(copy, Object.create(Array.prototype, { [index]: { value: inherited } }));
  }
  return copy;
}

/** The block of `prepared` for `input`, through fresh buffers, as a plain array. */
function blockOf(prepared: ChaCha20Key, input: readonly number[]): number[] {
  const output = new Uint32Array(CHACHA20_BLOCK_WORDS);
  prepared.blockInto(Uint32Array.from(input), output);
  return Array.from(output);
}

describe("chacha20Block on the RFC 8439 vectors", () => {
  test("the RFC's bytes read as the words of section 2.3.2's state after the key setup", () => {
    // "ChaCha state with the key setup", its last three rows.
    expect(KEY).toEqual([
      0x03020100, 0x07060504, 0x0b0a0908, 0x0f0e0d0c, 0x13121110, 0x17161514, 0x1b1a1918,
      0x1f1e1d1c,
    ]);
    expect(INPUT).toEqual([0x00000001, 0x09000000, 0x4a000000, 0x00000000]);
  });

  for (const vector of VECTORS) {
    test(`${vector.name}: the block's bytes and the final state's words`, () => {
      const output = chacha20Block(keyOf(vector), inputOf(vector));
      expect(output).toEqual(wordsOf(...vector.block));
      expect(output).toEqual([...vector.state]);
    });
  }
});

describe("chacha20Block on words with the high bit set", () => {
  // No RFC 8439 vector has a key or input word of 2^31 or more. These outputs were computed by
  // OpenSSL 3.5.8 when this test was written: `openssl enc -chacha20` over 64 zero bytes, with the
  // key's bytes and an IV of the counter's 4 bytes, little-endian, then the nonce's 12 bytes.
  const blocks: readonly { name: string; key: number[]; input: number[]; output: number[] }[] = [
    {
      name: "all ones",
      key: [
        0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff,
        0xffffffff,
      ],
      input: [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff],
      output: [
        0xcf212bd7, 0xc4b0b6a4, 0x2bf6611d, 0x9c15118a, 0xbc634f6a, 0x5703c256, 0x37adc796,
        0xbb211181, 0x4ad556ec, 0x933a0f53, 0x508ad23d, 0xfa3bb2fe, 0x5b404ff6, 0x71f385e9,
        0x8346df8b, 0x49e76be9,
      ],
    },
    {
      name: "high bits",
      key: [
        0xfcfdfeff, 0xf8f9fafb, 0xf4f5f6f7, 0xf0f1f2f3, 0xecedeeef, 0xe8e9eaeb, 0xe4e5e6e7,
        0xe0e1e2e3,
      ],
      input: [0x80000000, 0xdeadbeef, 0x80000001, 0xfffffffe],
      output: [
        0x781ba86a, 0x30aab43c, 0x13fc674e, 0x75c6ea96, 0x6806e2a8, 0x3c5902eb, 0xfcc2e71a,
        0x0623a78f, 0xbb73e5d0, 0x18505582, 0x221d4cfb, 0xeb7dd4ba, 0xe951f9f8, 0x03bea22d,
        0x7818b61d, 0x46166f09,
      ],
    },
  ];

  for (const { name, key, input, output } of blocks) {
    test(name, () => {
      expect(chacha20Block(key, input)).toEqual(output);
      expect(blockOf(new ChaCha20Key(key), input)).toEqual(output);
    });
  }
});

describe("chacha20Block validation", () => {
  test.each([0, 7, 9])("rejects a key of %d words", (length) => {
    const key = Array.from({ length }, () => 0);
    expect(engineErrorOf(() => chacha20Block(key, INPUT)).issues).toEqual([
      { path: "/key", message: `the key must have 8 words, not ${length}` },
    ]);
  });

  test.each([0, 3, 5])("rejects an input of %d words", (length) => {
    const input = Array.from({ length }, () => 0);
    expect(engineErrorOf(() => chacha20Block(KEY, input)).issues).toEqual([
      { path: "/input", message: `the input must have 4 words, not ${length}` },
    ]);
  });

  test("reports the key's and the input's problems together, key first, as invalid_value", () => {
    const error = engineErrorOf(() => chacha20Block([1, 2, 3], [-1, 0, 1.5, 0x1_0000_0000]));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([
      { path: "/key", message: "the key must have 8 words, not 3" },
      { path: "/input/0", message: NOT_U32("-1") },
      { path: "/input/2", message: NOT_U32("1.5") },
      { path: "/input/3", message: NOT_U32("4294967296") },
    ]);
  });

  test("reports every word that is not a u32, with its path", () => {
    const key = [0, -1, 2, 1.5, 4, 0x1_0000_0000, Number.NaN, 7];
    // Deliberately ill-typed, as a JavaScript caller can be.
    const input = ["1", 0, 1n, 3] as unknown as readonly number[];
    expect(engineErrorOf(() => chacha20Block(key, input)).issues).toEqual([
      { path: "/key/1", message: NOT_U32("-1") },
      { path: "/key/3", message: NOT_U32("1.5") },
      { path: "/key/5", message: NOT_U32("4294967296") },
      { path: "/key/6", message: NOT_U32("NaN") },
      { path: "/input/0", message: NOT_U32("a value of type string") },
      { path: "/input/2", message: NOT_U32("a value of type bigint") },
    ]);
  });

  test("describes a word that is not a number by its type alone, without running its code", () => {
    const hostile = {
      valueOf: () => {
        throw new Error("valueOf ran");
      },
      toString: () => {
        throw new Error("toString ran");
      },
    };
    // Deliberately ill-typed, as a JavaScript caller can be.
    const input = [hostile, true, undefined, null] as unknown as readonly number[];
    expect(engineErrorOf(() => chacha20Block(KEY, input)).issues).toEqual([
      { path: "/input/0", message: NOT_U32("a value of type object") },
      { path: "/input/1", message: NOT_U32("a value of type boolean") },
      { path: "/input/2", message: NOT_U32("a value of type undefined") },
      { path: "/input/3", message: NOT_U32("a value of type object") },
    ]);
  });

  test("rejects a hole, also a trailing one and one whose index the prototype fills", () => {
    const key = holed(KEY, 7);
    const input = holed(INPUT, 2, 7);
    expect(key.length).toBe(8);
    expect(Array.isArray(input) && input[2] === 7).toBe(true);
    expect(engineErrorOf(() => chacha20Block(key, input)).issues).toEqual([
      { path: "/key/7", message: HOLE },
      { path: "/input/2", message: HOLE },
    ]);
  });

  test.each([
    ["a string", "abcdefgh"],
    ["an array-like object", { length: 8 }],
    ["a typed array", new Uint32Array(8)],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s where an array belongs", (_, value) => {
    // Deliberately ill-typed, as a JavaScript caller can be.
    const words = value as unknown as readonly number[];
    expect(engineErrorOf(() => chacha20Block(words, words)).issues).toEqual([
      { path: "/key", message: "the key must be an array of 8 words" },
      { path: "/input", message: "the input must be an array of 4 words" },
    ]);
  });

  test("rejects a length that is not a number, which only a Proxy can report", () => {
    const key = new Proxy([...KEY], {
      get: (target, property, receiver) =>
        property === "length" ? "8" : Reflect.get(target, property, receiver),
    });
    expect(engineErrorOf(() => chacha20Block(key, INPUT)).issues).toEqual([
      { path: "/key", message: "the key must have 8 words, not a value of type string" },
    ]);
  });
});

describe("chacha20Block and ChaCha20Key read each word once", () => {
  /** KEY, whose word 1 is a getter that gives the right word on its first read only. */
  function keyWithGetter(): { key: number[]; reads: () => number } {
    let reads = 0;
    const key = Object.defineProperty([...KEY], 1, {
      get: () => (reads++ === 0 ? KEY[1] : 0),
      enumerable: true,
    });
    return { key, reads: () => reads };
  }

  test("a word behind a getter is read once, so validation and the block see the same word", () => {
    const viaFunction = keyWithGetter();
    expect(chacha20Block(viaFunction.key, INPUT)).toEqual(EXPECTED);
    expect(viaFunction.reads()).toBe(1);
    const viaKey = keyWithGetter();
    expect(blockOf(new ChaCha20Key(viaKey.key), INPUT)).toEqual(EXPECTED);
    expect(viaKey.reads()).toBe(1);
  });

  test("arrays with their own iterators are read by index, as they were validated", () => {
    const withIterator = (words: readonly number[]): number[] =>
      Object.assign([...words], {
        *[Symbol.iterator]() {
          yield 9;
        },
      });
    expect(chacha20Block(withIterator(KEY), withIterator(INPUT))).toEqual(EXPECTED);
    expect(blockOf(new ChaCha20Key(withIterator(KEY)), INPUT)).toEqual(EXPECTED);
  });
});

describe("ChaCha20Key", () => {
  test("gives the RFC 8439 vectors", () => {
    for (const vector of VECTORS) {
      expect(blockOf(new ChaCha20Key(keyOf(vector)), inputOf(vector))).toEqual(
        wordsOf(...vector.block),
      );
    }
  });

  test("equals chacha20Block, whose words are u32, on random keys and inputs", () => {
    const random = new Sfc32(20);
    const words = (count: number) => Array.from({ length: count }, () => random.next());
    const input = new Uint32Array(4);
    const output = new Uint32Array(CHACHA20_BLOCK_WORDS);
    const blocks = new Set<string>();
    for (let keys = 0; keys < 64; keys += 1) {
      const key = words(8);
      const prepared = new ChaCha20Key(key);
      for (let inputs = 0; inputs < 16; inputs += 1) {
        input.set(words(4));
        const expected = chacha20Block(key, Array.from(input));
        expect(expected.length === CHACHA20_BLOCK_WORDS && expected.every(isU32)).toBe(true);
        // One input and one output buffer serve every block, as in a hot loop.
        prepared.blockInto(input, output);
        expect(Array.from(output)).toEqual(expected);
        blocks.add(expected.join());
      }
    }
    // Two equal 512-bit blocks would be a defect, not chance, so a constant output fails here.
    expect(blocks.size).toBe(64 * 16);
  });

  test("leaves its inputs as they were, and keeps a copy of the key", () => {
    const key = [...KEY];
    const input = [...INPUT];
    const words = Uint32Array.from(INPUT);
    expect(chacha20Block(key, input)).toEqual(EXPECTED);
    const prepared = new ChaCha20Key(key);
    prepared.blockInto(words, new Uint32Array(CHACHA20_BLOCK_WORDS));
    expect(key).toEqual(KEY);
    expect(input).toEqual(INPUT);
    expect(Array.from(words)).toEqual(INPUT);
    key.fill(0);
    expect(blockOf(prepared, INPUT)).toEqual(EXPECTED);
  });

  test("interleaved prepared keys give what each gives alone", () => {
    const random = new Sfc32(21);
    const words = (count: number) => Array.from({ length: count }, () => random.next());
    const keys = [words(8), words(8)];
    const inputs = Array.from({ length: 8 }, () => words(4));
    const alone = keys.map((key) => inputs.map((input) => chacha20Block(key, input)));
    expect(alone[0]).not.toEqual(alone[1]);
    const prepared = keys.map((key) => new ChaCha20Key(key));
    inputs.forEach((input, at) => {
      prepared.forEach((each, which) => {
        expect(blockOf(each, input)).toEqual(alone[which]?.[at] ?? []);
      });
    });
  });

  test("writes output words 0 to 15 alone, and its input may share the output's memory", () => {
    const output = new Uint32Array(CHACHA20_BLOCK_WORDS + 2).fill(7);
    const input = output.subarray(0, 4);
    input.set(INPUT);
    new ChaCha20Key(KEY).blockInto(input, output);
    expect(Array.from(output)).toEqual([...EXPECTED, 7, 7]);
  });

  test("rejects a key as chacha20Block does, as invalid_value", () => {
    const error = engineErrorOf(() => new ChaCha20Key([1, 2]));
    expect(error.code).toBe("invalid_value");
    expect(error.issues).toEqual([{ path: "/key", message: "the key must have 8 words, not 2" }]);
    // Deliberately ill-typed, as a JavaScript caller can be.
    const keys = [
      holed(KEY, 3, 5),
      [...KEY.slice(0, 7), -1],
      "key",
      new Uint32Array(8),
    ] as unknown as (readonly number[])[];
    for (const key of keys) {
      expect(engineErrorOf(() => new ChaCha20Key(key)).issues).toEqual(
        engineErrorOf(() => chacha20Block(key, INPUT)).issues,
      );
    }
  });
});
