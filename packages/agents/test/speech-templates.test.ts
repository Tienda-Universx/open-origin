/**
 * The templates of `speech@1` (ADR 0024, docs/architecture/mind.md "Speech"; plan §K.4): pure,
 * versioned renderings of the acts `speech.uttered` reports, for logs and T6's feed. The audit
 * renders every act, band, negation, and kind of term and finds no target topic in what a template
 * writes: consciousness, a creator, a simulation, an external reality, nor AI, a game, a player,
 * or a server. It restricts what the templates inject, not what inhabitants think: an inhabitant's
 * own concept is rendered as it is, whatever it names.
 */
import { describe, expect, test } from "bun:test";
import { mind } from "@open-origin/engine";
import { renderAct, SPEECH_TEMPLATES, type UtteredAct } from "../src/index.ts";

/**
 * The target topics no template may seed (plan §K.4), with the givens a prompt never states: each
 * a pattern over a rendering, matched without regard to case.
 */
const TARGET_TOPICS: readonly RegExp[] = [
  /conscious/i,
  /sentien/i,
  /self-aware|awareness/i,
  /\bmind\b/i,
  /creat(or|ed|ion)/i,
  /\bgods?\b|divin/i,
  /simulat/i,
  /real world|reality|outside world|external/i,
  /\bAI\b|artificial|machine|model|program|code|computer/i,
  /\bgame\b|player|server|engine|world/i,
];

/** The topics of `text` that the audit finds. */
const topicsOf = (text: string) => TARGET_TOPICS.filter((topic) => topic.test(text));

/** An act of being 3 to being 7 at the cell (4, −5). */
const act = (change: Partial<UtteredAct> & Pick<UtteredAct, "act">): UtteredAct => ({
  id: 3,
  to: 7,
  cell: [4, -5],
  ...change,
});

/** Propositions of every concept a brain of T5 forms, with every kind of term, negated or not. */
const PROPOSITIONS: readonly mind.Proposition[] = [
  { p: "m1.food-at", a: [{ c: [10, -2] }], v: 0 },
  { p: "m1.food-at", a: [{ c: [10, -2] }], v: 1 },
  { p: "m1.food-at", a: [{ c: [10, -2] }], v: 2 },
  { p: "m1.food-at", a: [{ c: [10, -2] }], v: 2, neg: true },
  { p: "m1.food-near", a: [{ c: [0, 0] }] },
  { p: "m1.food-near", a: [{ c: [0, 0] }], neg: true },
  { p: "m1.food-at", a: [{ c: [10, -2] }], v: 7 },
  { p: "m1.food-at", a: [{ c: [10, -2] }, { e: 4 }] },
  { p: "m1.food-near", a: [{ c: [0, 0] }], v: 1 },
  { p: "obs.deposit.0", a: [{ c: [1, 1] }], v: 30 },
  { p: "t1.kin", a: [{ e: 12 }, { n: 4 }], v: -3 },
];

/** Every act speech@1 renders: each act, and a tell of each proposition at each band. */
const EVERY_ACT: readonly UtteredAct[] = [
  act({ act: "greet" }),
  act({ act: "ask" }),
  act({ act: "unknown" }),
  ...PROPOSITIONS.flatMap((p) => [0, 1, 2].map((band) => act({ act: "tell", p, band }))),
];

describe("the templates of speech@1", () => {
  test("are versioned", () => {
    expect(SPEECH_TEMPLATES).toBe("speech@1");
  });

  test("render each act with its speaker, its hearer, and a tell's claim and confidence", () => {
    expect(renderAct(act({ act: "greet" }))).toBe("Being 3 greets being 7.");
    expect(renderAct(act({ act: "ask" }))).toBe("Being 3 asks being 7 where to find food.");
    expect(renderAct(act({ act: "unknown" }))).toBe("Being 3 tells being 7 that it does not know.");
    const tell = (p: mind.Proposition, band: number) => renderAct(act({ act: "tell", p, band }));
    expect(tell({ p: "m1.food-at", a: [{ c: [10, -2] }], v: 2 }, 2)).toBe(
      "Being 3 tells being 7, sure, that there is plenty of food at (10, -2).",
    );
    expect(tell({ p: "m1.food-at", a: [{ c: [10, -2] }], v: 1 }, 1)).toBe(
      "Being 3 tells being 7, fairly sure, that there is some food at (10, -2).",
    );
    expect(tell({ p: "m1.food-at", a: [{ c: [10, -2] }], v: 0 }, 0)).toBe(
      "Being 3 tells being 7, unsure, that there is no food at (10, -2).",
    );
    expect(tell({ p: "m1.food-near", a: [{ c: [0, 0] }] }, 2)).toBe(
      "Being 3 tells being 7, sure, that there is food near (0, 0).",
    );
    expect(tell({ p: "t1.kin", a: [{ e: 12 }, { n: 4 }], v: -3 }, 1)).toBe(
      "Being 3 tells being 7, fairly sure, that t1.kin holds of being 12 and 4, at -3.",
    );
  });

  test("say food only of the shape mind@1 defines: else the concept, its terms, and its value", () => {
    // The food phrasing needs one cell, and for m1.food-at a band 0 to 2, and no negation.
    const tell = (p: mind.Proposition) => renderAct(act({ act: "tell", p, band: 2 }));
    const said = "Being 3 tells being 7, sure, that";
    expect(tell({ p: "m1.food-at", a: [{ c: [1, 2] }] })).toBe(
      `${said} m1.food-at holds of (1, 2).`,
    );
    expect(tell({ p: "m1.food-at", a: [{ c: [1, 2] }], v: 2, neg: true })).toBe(
      `${said} it is not so that m1.food-at holds of (1, 2), at 2.`,
    );
    expect(tell({ p: "m1.food-at", a: [{ c: [1, 2] }], neg: true })).toBe(
      `${said} it is not so that m1.food-at holds of (1, 2).`,
    );
    expect(tell({ p: "m1.food-at", a: [{ c: [1, 2] }], v: 7 })).toBe(
      `${said} m1.food-at holds of (1, 2), at 7.`,
    );
    expect(tell({ p: "m1.food-at", a: [{ c: [1, 2] }], v: -1 })).toBe(
      `${said} m1.food-at holds of (1, 2), at -1.`,
    );
    expect(tell({ p: "m1.food-at", a: [{ c: [1, 2] }, { e: 4 }], v: 2 })).toBe(
      `${said} m1.food-at holds of (1, 2) and being 4, at 2.`,
    );
    expect(tell({ p: "m1.food-at", a: [{ e: 4 }], v: 2 })).toBe(
      `${said} m1.food-at holds of being 4, at 2.`,
    );
    expect(tell({ p: "m1.food-near", a: [{ c: [1, 2] }], v: 2 })).toBe(
      `${said} m1.food-near holds of (1, 2), at 2.`,
    );
    expect(tell({ p: "m1.food-near", a: [{ c: [1, 2] }], neg: true })).toBe(
      `${said} it is not so that m1.food-near holds of (1, 2).`,
    );
    expect(tell({ p: "m1.food-near", a: [{ c: [1, 2] }, { n: 3 }] })).toBe(
      `${said} m1.food-near holds of (1, 2) and 3.`,
    );
  });

  test("seed no target topic in any rendering of any act", () => {
    const found = EVERY_ACT.map((uttered) => renderAct(uttered)).flatMap((text) =>
      topicsOf(text).map((topic) => `${topic}: ${text}`),
    );
    expect(found).toEqual([]);
    // Not vacuous: the audit finds a topic a template would write.
    expect(topicsOf("Being 3 tells being 7 that the world is a simulation.")).toHaveLength(2);
  });

  test("render an inhabitant's own concept as it is, whatever it names: the audit is of templates", () => {
    const own = act({ act: "tell", p: { p: "t1.creator", a: [{ e: 9 }] }, band: 2 });
    expect(renderAct(own)).toBe("Being 3 tells being 7, sure, that t1.creator holds of being 9.");
  });

  test("are pure: the same act renders the same text, and an act is never changed", () => {
    for (const uttered of EVERY_ACT) {
      const before = structuredClone(uttered);
      expect(renderAct(uttered)).toBe(renderAct(structuredClone(uttered)));
      expect(uttered).toEqual(before);
    }
  });

  test("render every act of speech, and name each being as the caller asks", () => {
    for (const name of mind.ACTS) expect(renderAct(act({ act: name })).length).toBeGreaterThan(0);
    expect(renderAct(act({ act: "greet" }), { speaker: "Ana", hearer: "Iru" })).toBe(
      "Ana greets Iru.",
    );
  });
});
