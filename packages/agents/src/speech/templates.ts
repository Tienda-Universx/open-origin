/**
 * The templates of `speech@1` (ADR 0024, docs/architecture/mind.md "Speech"): pure renderings, in
 * English, of the acts `speech.uttered` reports, for logs and the feed of T6. They write only what
 * an act holds, the speaker, the hearer, the act, and a tell's claim and confidence, in words an
 * audit checks for target topics (plan §K.4): a template never seeds one. An inhabitant's own
 * concept is rendered as it is: the audit restricts what the templates inject, not what inhabitants
 * think. Changing what any template writes is a new version.
 */
import type { mind } from "@open-origin/engine";

/** The version of the templates. */
export const SPEECH_TEMPLATES = "speech@1";

/** An act as `speech.uttered` reports it: speaker, hearer, act, a tell's content, and the cell. */
export type UtteredAct = {
  readonly id: number;
  readonly to: number;
  readonly act: mind.Act;
  readonly p?: mind.Proposition;
  readonly band?: number;
  readonly cell: readonly [number, number];
};

/** How a rendering names the speaker and the hearer. */
export type Names = { readonly speaker: string; readonly hearer: string };

/** `uttered` in words, naming its beings by `names`, or as "being" and their id. */
export function renderAct(uttered: UtteredAct, names?: Names): string {
  const speaker = names?.speaker ?? `Being ${uttered.id}`;
  const hearer = names?.hearer ?? `being ${uttered.to}`;
  switch (uttered.act) {
    case "greet":
      return `${speaker} greets ${hearer}.`;
    case "ask":
      return `${speaker} asks ${hearer} where to find food.`;
    case "unknown":
      return `${speaker} tells ${hearer} that it does not know.`;
    default:
      return `${speaker} tells ${hearer}${confidence(uttered.band)}, that ${claim(uttered.p)}.`;
  }
}

/** The confidence of a tell's band, set off by a comma: sure, fairly sure, or unsure. */
function confidence(band: number | undefined): string {
  if (band === undefined) return "";
  if (band >= 2) return ", sure";
  return band === 1 ? ", fairly sure" : ", unsure";
}

/**
 * What a proposition claims: the food of a cell, or near it, for a proposition of the shape mind@1
 * gives those concepts; otherwise its concept of its terms, and its value, negated when it is a
 * negation.
 */
function claim(p: mind.Proposition | undefined): string {
  if (p === undefined) return "something";
  const food = foodOf(p);
  if (food !== undefined) return food;
  const value = p.v === undefined ? "" : `, at ${p.v}`;
  const said = `${p.p} holds of ${p.a.map(term).join(" and ")}${value}`;
  return p.neg === true ? `it is not so that ${said}` : said;
}

/**
 * What `p` says of food when it has the shape of mind.md's table, no negation and one cell: for
 * `m1.food-at`, a band 0 to 2 as its value, and for `m1.food-near`, no value; undefined otherwise.
 */
function foodOf(p: mind.Proposition): string | undefined {
  const [only, ...more] = p.a;
  if (p.neg === true || more.length > 0 || only === undefined || !("c" in only)) return undefined;
  if (p.p === "m1.food-near" && p.v === undefined) return `there is food near ${place(only.c)}`;
  const amount = p.v === undefined ? undefined : amountOf(p.v);
  if (p.p === "m1.food-at" && amount !== undefined)
    return `there is ${amount} food at ${place(only.c)}`;
  return undefined;
}

/** The amount of food a band of the food cue says: none, some, or plenty; undefined for no band. */
function amountOf(band: number): string | undefined {
  if (band === 2) return "plenty of";
  if (band === 1) return "some";
  return band === 0 ? "no" : undefined;
}

/** A term of a proposition: a cell, a being, or a number. */
function term(of: mind.Term): string {
  if ("c" in of) return place(of.c);
  if ("e" in of) return `being ${of.e}`;
  return `${of.n}`;
}

/** A cell, as its coordinates. */
function place(cell: readonly [number, number]): string {
  return `(${cell[0]}, ${cell[1]})`;
}
