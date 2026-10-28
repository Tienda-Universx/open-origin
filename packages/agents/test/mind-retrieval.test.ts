/**
 * Retrieval in `mind@1` (docs/architecture/mind.md "The brain mind@1", plan §K.3): one pass ranks
 * records by age × importance × relevance, and retention, the trait of memory, stretches how
 * long a record stays recent. Each factor is moved alone, then against another, and the pass is
 * shown to rank each record once.
 */
import { describe, expect, test } from "bun:test";
import { beings } from "@open-origin/engine";
import {
  memoryHalfLife,
  type Ranked,
  recency,
  retrievalScore,
  retrieve,
} from "../src/brain/mind/retrieval.ts";

/** A record to rank: its id and its three factors. */
type Item = Ranked;

const item = (id: number, age: number, importance: number, relevance: number): Item => ({
  id,
  age,
  importance,
  relevance,
});

const H = 1000;
const pick = (items: readonly Item[], halfLife = H) => retrieve(items, (r) => r, halfLife)?.id;

describe("recency", () => {
  test("is 1000 now, a half at one half-life, and falls with age", () => {
    expect(recency(0, H)).toBe(1000);
    expect(recency(H, H)).toBe(500);
    expect(recency(3 * H, H)).toBe(250);
    expect(recency(H + 1, H)).toBeLessThan(recency(H, H));
  });

  test("scores the product of recency, importance, and relevance", () => {
    expect(retrievalScore(item(1, H, 800, 600), H)).toBe(500 * 800 * 600);
  });
});

describe("retrieve", () => {
  test("ranks by age alone: the younger of two equal records", () => {
    expect(pick([item(1, 900, 500, 500), item(2, 100, 500, 500)])).toBe(2);
  });

  test("ranks by importance alone: the more important of two equal records", () => {
    expect(pick([item(1, 100, 400, 500), item(2, 100, 900, 500)])).toBe(2);
  });

  test("ranks by relevance alone: the more relevant of two equal records", () => {
    expect(pick([item(1, 100, 500, 900), item(2, 100, 500, 300)])).toBe(1);
  });

  test("weighs the three together: an old important record against a new minor one", () => {
    // Old: recency 1000·1000/4000 = 250, 250·900 = 225,000; new: 1000·500 = 500,000.
    expect(pick([item(1, 3 * H, 900, 1000), item(2, 0, 500, 1000)])).toBe(2);
    // Relevance tips it back: the new one at relevance 400 scores 200,000.
    expect(pick([item(1, 3 * H, 900, 1000), item(2, 0, 500, 400)])).toBe(1);
  });

  test("breaks a tie by the lower id, and retrieves nothing irrelevant", () => {
    expect(pick([item(5, 10, 500, 500), item(3, 10, 500, 500)])).toBe(3);
    expect(pick([item(1, 0, 900, 0), item(2, 0, 0, 900)])).toBeUndefined();
    expect(pick([])).toBeUndefined();
  });

  test("skips the records the ranking leaves out", () => {
    const ranked = retrieve([1, 2, 3], (id) => (id === 2 ? undefined : item(id, 0, 500, id)), H);
    expect(ranked).toBe(3);
    expect(retrieve([2], () => undefined, H)).toBeUndefined();
  });

  test("ranks each record once, in one pass", () => {
    const seen: number[] = [];
    const items = [item(4, 50, 300, 900), item(1, 10, 900, 100), item(7, 999, 999, 999)];
    retrieve(
      items,
      (r) => {
        seen.push(r.id);
        return r;
      },
      H,
    );
    expect(seen).toEqual([4, 1, 7]);
  });
});

describe("retention, the trait of memory", () => {
  const laws = beings.defaultLife2().species[0] as beings.Species2;

  test("scales the half-life of a belief's recency", () => {
    const neutral = memoryHalfLife(laws, 1000);
    expect(neutral).toBe(laws.mind.halfLife.belief);
    expect(memoryHalfLife(laws, 800)).toBe(Math.floor((laws.mind.halfLife.belief * 800) / 1000));
    expect(memoryHalfLife(laws, 1200)).toBe(Math.floor((laws.mind.halfLife.belief * 1200) / 1000));
  });

  test("lets a being of high retention keep to an old important record that one of low retention leaves", () => {
    const old = item(1, 2 * laws.mind.halfLife.belief, 900, 1000);
    // Recency 375 at retention 1200 (old 337,500 against 300,000) and 285 at 800 (256,500).
    const fresh = item(2, 0, 300, 1000);
    expect(pick([old, fresh], memoryHalfLife(laws, 1200))).toBe(1);
    expect(pick([old, fresh], memoryHalfLife(laws, 800))).toBe(2);
  });
});
