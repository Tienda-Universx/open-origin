import { describe, expect, test } from "bun:test";
import {
  BeingPublic,
  FeedItem,
  MAX_BEING_RECORD_BYTES,
  MAX_CELL,
  MAX_CHUNK,
  MIN_CELL,
  MIN_CHUNK,
  Speech,
} from "../src/public/index.ts";

const MAX_ID = Number.MAX_SAFE_INTEGER;

/** The longest identifier: 32 characters. */
const LONGEST_SPECIES = `s${"-".repeat(31)}`;

/** Every activity at its longest: each id the largest, each act the longest. */
const LONGEST_ACTIVITIES = [
  { kind: "eat" },
  { kind: "idle" },
  { kind: "sleep" },
  { kind: "talk", to: MAX_ID, act: "unknown" },
  { kind: "walk", dir: 7 },
];

/** A being whose every field takes the most characters its schema allows. */
function longestBeing(activity: object) {
  return {
    id: MAX_ID,
    species: LONGEST_SPECIES,
    stage: "adult",
    born: MAX_ID,
    // −2^31 has the most digits of any cell coordinate, and a sign.
    cell: [MIN_CELL, MIN_CELL],
    activity,
  };
}

const BEING = {
  id: 7,
  species: "s1",
  stage: "adult",
  born: 120,
  cell: [-3, 40],
  activity: { kind: "walk", dir: 2 },
};

describe("BeingPublic", () => {
  test("its largest valid record encodes to at most 256 bytes of JSON", () => {
    const sizes = LONGEST_ACTIVITIES.map((activity) => {
      const being = longestBeing(activity);
      expect(BeingPublic.safeParse(being).success).toBe(true);
      return JSON.stringify(being).length;
    });
    // The talk is the longest: a hearer of 16 digits and the act "unknown".
    expect(sizes.indexOf(Math.max(...sizes))).toBe(3);
    expect(Math.max(...sizes)).toBe(206);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_BEING_RECORD_BYTES);
  });

  test("accepts a being in each activity", () => {
    for (const activity of [
      { kind: "eat" },
      { kind: "idle" },
      { kind: "sleep" },
      { kind: "talk", to: 9, act: "greet" },
      { kind: "walk", dir: 0 },
    ]) {
      expect(BeingPublic.safeParse({ ...BEING, activity }).success).toBe(true);
    }
  });

  test("rejects extra keys, missing keys, and C1 members of the engine's being", () => {
    const { born: _, ...missing } = BEING;
    const cases = [
      { ...BEING, health: 900 },
      { ...BEING, needs: { nutrition: 1, rest: 1 } },
      missing,
      { ...BEING, activity: { kind: "walk", dir: 2, dirs: "222" } },
      { ...BEING, activity: { kind: "eat", bites: 3 } },
      { ...BEING, activity: { kind: "talk", to: 9, act: "tell", captured: {} } },
      { ...BEING, activity: { kind: "talk", to: 9 } },
      { ...BEING, activity: { kind: "eat", dir: 1 } },
      JSON.parse(`${JSON.stringify(BEING).slice(0, -1)},"__proto__":{"id":1}}`),
    ];
    expect(cases.map((being) => BeingPublic.safeParse(being).success)).toEqual(
      cases.map(() => false),
    );
  });

  test("rejects values off the engine's bounds, by one", () => {
    const cases = [
      { ...BEING, id: 0 },
      { ...BEING, id: MAX_ID + 1 },
      { ...BEING, id: 1.5 },
      { ...BEING, id: "7" },
      { ...BEING, born: -1 },
      { ...BEING, cell: [MIN_CELL - 1, 0] },
      { ...BEING, cell: [0, MAX_CELL + 1] },
      { ...BEING, cell: [0, 0, 0] },
      { ...BEING, species: "S1" },
      { ...BEING, species: `s${"a".repeat(32)}` },
      { ...BEING, species: "1s" },
      { ...BEING, stage: "child" },
      { ...BEING, activity: { kind: "walk", dir: 8 } },
      { ...BEING, activity: { kind: "walk", dir: -1 } },
      { ...BEING, activity: { kind: "talk", to: 9, act: "shout" } },
      { ...BEING, activity: { kind: "run" } },
    ];
    expect(cases.map((being) => BeingPublic.safeParse(being).success)).toEqual(
      cases.map(() => false),
    );
    expect(BeingPublic.safeParse({ ...BEING, cell: [MIN_CELL, MAX_CELL] }).success).toBe(true);
  });
});

describe("Speech", () => {
  const SPEECH = { tick: 40, speaker: 7, to: 9, act: "greet", text: "Being 7 greets being 9." };

  test("accepts an act with plain text", () => {
    expect(Speech.safeParse(SPEECH).success).toBe(true);
  });

  test("rejects text that is not plain, an extra key, and a missing one", () => {
    const { text: _, ...missing } = SPEECH;
    const cases = [
      { ...SPEECH, text: `line${String.fromCodePoint(10)}break` },
      { ...SPEECH, text: "" },
      { ...SPEECH, text: "x".repeat(281) },
      { ...SPEECH, html: "<b>x</b>" },
      { ...SPEECH, act: "whisper" },
      missing,
    ];
    expect(cases.map((speech) => Speech.safeParse(speech).success)).toEqual(cases.map(() => false));
  });
});

describe("FeedItem", () => {
  const ITEMS = [
    { kind: "arrival", being: 4, species: "s1", chunk: [0, -1] },
    { kind: "death", being: 4, chunk: [MIN_CHUNK, MAX_CHUNK] },
    { kind: "greeting", from: 4, to: 5, chunk: [3, 3] },
  ];

  test("accepts an arrival, a death, and a greeting", () => {
    expect(ITEMS.map((item) => FeedItem.safeParse(item).success)).toEqual([true, true, true]);
  });

  test("carries no text, and rejects another kind or a chunk off the world", () => {
    const cases = [
      ...ITEMS.map((item) => ({ ...item, text: "Being 4 greets being 5." })),
      { kind: "speech", from: 4, to: 5, chunk: [3, 3] },
      { kind: "death", being: 4, chunk: [MAX_CHUNK + 1, 0] },
      { kind: "death", being: 4, chunk: [0, MIN_CHUNK - 1] },
      { kind: "greeting", from: 4, chunk: [3, 3] },
    ];
    expect(cases.map((item) => FeedItem.safeParse(item).success)).toEqual(cases.map(() => false));
  });
});
