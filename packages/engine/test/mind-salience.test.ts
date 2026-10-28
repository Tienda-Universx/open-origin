/**
 * Time, salience, and forgetting (docs/architecture/mind.md): the closed form of salience against
 * an exact rational oracle at the edges of each half-life, its monotony, pinned episodes, the
 * refresh of a recall within the pins, forgetting with its ledger links, the eviction of a full
 * store of episodes, and the view, which is a pure function of the mind and the moment.
 */
import { describe, expect, test } from "bun:test";
import { canonicalize, mind } from "../src/index.ts";
import {
  belief,
  contextAt,
  external,
  foodAt,
  heard,
  lawsWith,
  mindOf,
  own,
  relationship,
  seen,
} from "./support/mind-records.ts";
import { Sfc32 } from "./support/sfc32.ts";

const {
  admitEpisode,
  decay,
  episodeSalience,
  beliefSalience,
  forget,
  importanceWithin,
  refreshEpisode,
  scaledHalfLife,
  viewOf,
} = mind;

/**
 * The oracle: w halved k times, then the line from that value to its half across the half-life,
 * at the fraction (E − kH)/H, rounded down; in BigInt, with 2^k taken as a BigInt power.
 */
function oracle(w: number, seconds: number, halfLife: number): number {
  const E = BigInt(seconds);
  const H = BigInt(halfLife);
  const k = E / H;
  if (k >= 30n) return 0;
  const a = BigInt(w) / 2n ** k;
  const drop = a - a / 2n;
  return Number(a - (drop * (E - k * H)) / H);
}

describe("scaledHalfLife", () => {
  test("scales a half-life by retention in permille, and is at least one second", () => {
    expect(scaledHalfLife(75_600, 1000)).toBe(75_600);
    expect(scaledHalfLife(75_600, 800)).toBe(60_480);
    expect(scaledHalfLife(75_600, 1200)).toBe(90_720);
    expect(scaledHalfLife(999, 1)).toBe(1);
    expect(scaledHalfLife(0x7fff_ffff, 10_000)).toBe(21_474_836_470);
  });
});

describe("decay", () => {
  test("equals the oracle at the edges of every half-life, and is 0 from the 30th", () => {
    const random = new Sfc32(5302);
    for (let round = 0; round < 300; round += 1) {
      const w = random.between(0, 1000);
      const H = random.between(1, 2_000_000);
      for (let k = 0; k <= 31; k += 1) {
        for (const E of [k * H - 1, k * H, k * H + 1, k * H + random.below(H)]) {
          if (E < 0) continue;
          expect(decay(w, E, H)).toBe(oracle(w, E, H));
        }
      }
      expect(decay(w, 30 * H, H)).toBe(0);
      expect(decay(w, 30 * H - 1, H)).toBe(oracle(w, 30 * H - 1, H));
    }
  });

  test("is w at its anchor, halves each half-life, and falls linearly within one", () => {
    expect(decay(1000, 0, 100)).toBe(1000);
    expect(decay(1000, 100, 100)).toBe(500);
    expect(decay(1000, 50, 100)).toBe(750);
    expect(decay(1000, 200, 100)).toBe(250);
    expect(decay(1000, 99, 100)).toBe(505);
    expect(decay(999, 100, 100)).toBe(499);
    expect(decay(1, 100, 100)).toBe(0);
  });

  test("never comes back after 30 half-lives, however many more pass", () => {
    // A shift by k wraps modulo 32, so the cut at 30 is what keeps these at 0.
    for (const k of [30, 31, 32, 33, 40, 64, 1000]) {
      expect(decay(1000, k * 1000, 1000)).toBe(0);
      expect(decay(0x40_0000, k * 1000 + 999, 1000)).toBe(0);
    }
    expect(decay(1000, Number.MAX_SAFE_INTEGER, 1)).toBe(0);
  });

  test("never increases with the seconds that pass", () => {
    const random = new Sfc32(5303);
    for (let round = 0; round < 200; round += 1) {
      const w = random.between(0, 0x40_0000);
      const H = random.between(1, 5000);
      let previous = w;
      for (let E = 0; E <= 32 * H; E += 1 + random.below(H)) {
        const s = decay(w, E, H);
        expect(s).toBeLessThanOrEqual(previous);
        previous = s;
      }
    }
  });

  test("stays exact with the largest familiarity and half-life the laws allow", () => {
    const H = 0x7fff_ffff;
    const w = 0x40_0000;
    for (const E of [H - 1, 2 * H - 1, 29 * H + H - 1])
      expect(decay(w, E, H)).toBe(oracle(w, E, H));
  });
});

describe("the salience of episodes and beliefs", () => {
  test("decays an episode's importance from r with the episode's half-life, scaled by retention", () => {
    const episode = own(1, { w: 800, r: 1000 });
    expect(episodeSalience(episode, contextAt(1000))).toBe(800);
    expect(episodeSalience(episode, contextAt(1000 + 75_600))).toBe(400);
    // Two seconds per tick: half the ticks for the same seconds.
    expect(
      episodeSalience(episode, contextAt(1000 + 37_800, undefined, { secondsPerTick: 2 })),
    ).toBe(400);
    // Retention 500 halves the half-life.
    expect(episodeSalience(episode, contextAt(1000 + 37_800, undefined, { retention: 500 }))).toBe(
      400,
    );
    // An anchor after the moment counts as no time passed.
    expect(episodeSalience(episode, contextAt(10))).toBe(800);
  });

  test("keeps a pinned episode at its importance forever", () => {
    const pinned = own(1, { w: 900, r: 0 });
    expect(episodeSalience(pinned, contextAt(Number.MAX_SAFE_INTEGER))).toBe(900);
    expect(episodeSalience(own(1, { w: 899, r: 0 }), contextAt(75_600))).toBe(449);
  });

  test("weighs a belief by its certainty either way, from u, with the belief's half-life", () => {
    expect(beliefSalience(belief(1, { cr: 900, u: 0 }), contextAt(0))).toBe(900);
    expect(beliefSalience(belief(1, { cr: 100, u: 0 }), contextAt(302_400))).toBe(450);
    expect(beliefSalience(belief(1, { cr: 500, u: 0 }), contextAt(604_800))).toBe(125);
  });
});

describe("recall and the pins", () => {
  const ctx = contextAt(75_600);

  test("a recall raises the importance to the salience plus recall, at most 1000, from now", () => {
    const episodes = [own(1, { w: 600, r: 0 })];
    expect(refreshEpisode(own(1, { w: 600, r: 0 }), episodes, ctx)).toMatchObject({
      w: 500,
      r: 75_600,
    });
    // 880 + 200 stops at 1000, which pins the episode: no other is pinned.
    const fresh = own(1, { w: 880, r: 75_600 });
    expect(refreshEpisode(fresh, [fresh], ctx).w).toBe(1000);
  });

  test("at most `pins` episodes are pinned: beyond them an importance stops below the pin level", () => {
    const laws = lawsWith({ pins: 1 });
    const pinned = own(1, { w: 950 });
    expect(importanceWithin([own(2)], undefined, 950, laws)).toBe(950);
    expect(importanceWithin([pinned], undefined, 950, laws)).toBe(899);
    expect(importanceWithin([pinned], undefined, 899, laws)).toBe(899);
    // The pinned episode itself keeps its place.
    expect(importanceWithin([pinned], 1, 1000, laws)).toBe(1000);
    expect(importanceWithin([pinned], undefined, 950, lawsWith({ pins: 0 }))).toBe(899);
  });

  test("a recall cannot pin an episode beyond the pins", () => {
    const laws = lawsWith({ pins: 1, recall: 1000 });
    const episodes = [own(1, { w: 950 }), own(2, { w: 500, r: 75_600 })];
    const raised = refreshEpisode(episodes[1] as mind.Episode, episodes, contextAt(75_600, laws));
    expect(raised.w).toBe(899);
  });
});

describe("forget", () => {
  const laws = lawsWith({ floor: 100 });

  test("forgets an episode below the floor, keeps one at it, and never a pinned one", () => {
    // One half-life: 400 → 200 and 199 → 99; the floor is 100.
    const subject = mindOf({
      episodes: [own(1, { w: 400 }), own(2, { w: 199 }), own(3, { w: 200 }), own(4, { w: 950 })],
      beliefs: [belief(5, { ev: [2, 1], lost: 2 })],
    });
    const { mind: after, forgot } = forget(subject, contextAt(75_600, laws));
    expect(after.episodes.map((episode) => episode.id)).toEqual([1, 3, 4]);
    expect(after.beliefs).toEqual([belief(5, { ev: [1], lost: 3 })]);
    expect(forgot).toEqual([{ id: 2, beliefs: [5] }]);
    expect(forget(subject, contextAt(30 * 75_600, laws)).mind.episodes.map((e) => e.id)).toEqual([
      4,
    ]);
  });

  test("leaves the same mind when nothing faded", () => {
    const subject = mindOf({ episodes: [own(1, { w: 400 })] });
    expect(forget(subject, contextAt(10, laws)).mind).toBe(subject);
  });

  test("saturates lost at 2^31 − 1", () => {
    const subject = mindOf({
      episodes: [own(1, { w: 0 }), own(2, { w: 0 })],
      beliefs: [belief(3, { ev: [1, 2], lost: 0x7fff_fffe })],
    });
    expect(forget(subject, contextAt(0, laws)).mind.beliefs[0]?.lost).toBe(0x7fff_ffff);
  });

  test("forgetting at several moments leaves the mind forgetting once does", () => {
    const random = new Sfc32(5304);
    for (let round = 0; round < 300; round += 1) {
      const subject = randomMind(random);
      const [t1, t2] = [random.below(400_000), random.below(400_000)].sort((a, b) => a - b);
      const once = forget(subject, contextAt(t2 ?? 0, laws)).mind;
      const first = forget(subject, contextAt(t1 ?? 0, laws)).mind;
      expect(forget(first, contextAt(t2 ?? 0, laws)).mind).toEqual(once);
    }
  });
});

describe("a full store of episodes", () => {
  const ctx = contextAt(100, lawsWith({ episodes: 2 }));

  test("evicts the episode of lowest salience, the new one included", () => {
    const subject = mindOf({ episodes: [own(1, { w: 300, r: 100 }), own(2, { w: 700, r: 100 })] });
    const added = admitEpisode(subject, own(3, { w: 500, t: 100, r: 100 }), ctx);
    expect(added.mind.episodes.map((episode) => episode.id)).toEqual([2, 3]);
    const weak = admitEpisode(subject, own(3, { w: 200, t: 100, r: 100 }), ctx);
    expect(weak.mind.episodes.map((episode) => episode.id)).toEqual([1, 2]);
    expect(weak.displaced).toEqual([{ id: 3, beliefs: [] }]);
  });

  test("evicts the oldest by t, then the lowest id, among equal saliences", () => {
    const subject = mindOf({ episodes: [own(1, { t: 50, r: 100 }), own(2, { t: 40, r: 100 })] });
    const byAge = admitEpisode(subject, own(3, { t: 100, r: 100 }), ctx);
    expect(byAge.mind.episodes.map((episode) => episode.id)).toEqual([1, 3]);
    const even = mindOf({ episodes: [own(1, { t: 50, r: 100 }), own(2, { t: 50, r: 100 })] });
    const byId = admitEpisode(even, own(3, { t: 50, r: 100 }), ctx);
    expect(byId.mind.episodes.map((episode) => episode.id)).toEqual([2, 3]);
  });

  test("takes the evicted episode out of the beliefs that cite it", () => {
    const subject = mindOf({
      episodes: [own(1, { w: 100, r: 100 }), own(2, { w: 700, r: 100 })],
      beliefs: [belief(3, { ev: [1, 2] })],
    });
    const added = admitEpisode(subject, own(4, { w: 500, r: 100 }), ctx);
    expect(added.mind.beliefs[0]).toMatchObject({ ev: [2], lost: 1 });
    expect(added.displaced).toEqual([{ id: 1, beliefs: [3] }]);
  });
});

/** A random mind of episodes of every kind, beliefs citing them, and relationships. */
function randomMind(random: Sfc32): mind.Mind {
  const episodes = Array.from({ length: 8 }, (_, index) => {
    const id = index + 1;
    const common = { w: random.between(0, 1000), t: random.below(50_000), r: random.below(50_000) };
    const kind = random.below(4);
    if (kind === 0) return own(id, common);
    if (kind === 1) return seen(id, 50 + id, common);
    if (kind === 2)
      return heard(id, 50 + id, { ...common, tn: random.below(8), ex: random.below(8) });
    return external(id, common);
  });
  const beliefs = [9, 10, 11].map((id) =>
    belief(id, {
      ev: [random.between(1, 8), 12],
      cr: random.between(0, 1000),
      u: random.below(9),
      src: 9,
    }),
  );
  const relations = [relationship(12, 77, { f: random.below(7200), seen: random.below(50_000) })];
  return mindOf({ episodes, beliefs, relations, exposure: 7 });
}

describe("viewOf", () => {
  test("is the same whether the being was processed often or seldom", () => {
    const random = new Sfc32(5305);
    const laws = lawsWith({ floor: 120 });
    for (let round = 0; round < 300; round += 1) {
      const subject = randomMind(random);
      const moments = Array.from({ length: 4 }, () => random.below(600_000)).sort((a, b) => a - b);
      const last = moments.at(-1) ?? 0;
      let often = subject;
      for (const tick of moments) often = forget(often, contextAt(tick, laws)).mind;
      expect(viewOf(often, contextAt(last, laws))).toEqual(viewOf(subject, contextAt(last, laws)));
    }
  });

  test("shows ages in seconds instead of ticks, saturating at 2^31 − 1, and no taint", () => {
    const subject = mindOf({
      episodes: [heard(1, 41, { t: 10, r: 40, tn: 4, ex: 2 })],
      beliefs: [belief(2, { u: 0, tn: 4, ex: 6, ev: [1], src: 2 })],
      relations: [relationship(3, 41, { f: 3600, seen: 90, talk: 0, tn: 4 })],
      exposure: 6,
    });
    const view = viewOf(subject, contextAt(100, undefined, { secondsPerTick: 3 }));
    expect(view).toEqual({
      next: 4,
      episodes: [
        {
          id: 1,
          kind: "heard",
          t: 270,
          cell: [0, 0],
          who: 41,
          p: foodAt(1, 1),
          act: "tell",
          band: 2,
          w: 500,
          r: 180,
        },
      ],
      beliefs: [{ id: 2, p: foodAt(2, 0), cr: 800, src: 2, ev: [1], lost: 0, dp: 1, u: 300 }],
      // 3600 seconds at 5/36 give a familiarity of 500.
      // The being never addressed 41: talk 0 has no age to show.
      relations: [{ id: 3, who: 41, f: 500, seen: 30, aff: 0, tr: 500, turns: 0 }],
    });
    const text = canonicalize(view);
    for (const hidden of ['"tn"', '"ex"', '"exposure"']) expect(text).not.toContain(hidden);
    const old = viewOf(subject, contextAt(0x8000_0000));
    expect(old.beliefs[0]?.u).toBe(0x7fff_ffff);
  });

  test("shows how long ago the being last addressed a being, and nothing when it never did", () => {
    const subject = mindOf({
      relations: [relationship(1, 41, { talk: 60, turns: 2 }), relationship(2, 42, { talk: 0 })],
    });
    const [spoken, silent] = viewOf(subject, contextAt(100)).relations;
    expect(spoken).toMatchObject({ talk: 40, turns: 2 });
    expect(silent !== undefined && "talk" in silent).toBe(false);
  });

  test("shows an injection as a tell heard from no visible speaker, and external evidence as told", () => {
    const subject = mindOf({
      episodes: [external(1, { t: 5, r: 5, tn: 6 })],
      beliefs: [belief(2, { ev: [1], src: 8 | 1, tn: 6 })],
    });
    const view = viewOf(subject, contextAt(5));
    expect(view.episodes).toEqual([
      {
        id: 1,
        kind: "heard",
        t: 0,
        p: (subject.episodes[0] as mind.ExternalEpisode).p,
        act: "tell",
        w: 500,
        r: 0,
      },
    ]);
    expect(view.beliefs[0]?.src).toBe(2 | 1);
    expect(canonicalize(view)).not.toContain("external");
  });

  test("leaves out what would be forgotten by now, as forgetting would", () => {
    const subject = mindOf({
      episodes: [own(1, { w: 60 }), own(2, { w: 900 })],
      beliefs: [belief(3, { ev: [1, 2] })],
    });
    const view = viewOf(subject, contextAt(75_600));
    expect(view.episodes.map((episode) => episode.id)).toEqual([2]);
    expect(view.beliefs[0]).toMatchObject({ ev: [2], lost: 1 });
  });

  test("shares no value with the mind", () => {
    const subject = mindOf({
      episodes: [heard(1, 41)],
      beliefs: [belief(2, { ev: [1] })],
    });
    const before = structuredClone(subject);
    const view = viewOf(subject, contextAt(1)) as unknown as {
      episodes: { cell: number[]; p: { a: { c: number[] }[] } }[];
      beliefs: { ev: number[]; p: { a: { c: number[] }[] } }[];
    };
    view.episodes[0]?.cell.push(9);
    view.episodes[0]?.p.a[0]?.c.push(9);
    view.beliefs[0]?.ev.push(9);
    view.beliefs[0]?.p.a[0]?.c.push(9);
    expect(subject).toEqual(before);
  });
});
