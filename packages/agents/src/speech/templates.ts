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

/** What a proposition claims, negated when it is a negation. */
function claim(p: mind.Proposition | undefined): string {
  if (p === undefined) return "something";
  const said = statement(p);
  return p.neg === true ? `it is not so that ${said}` : said;
}

/** What a proposition states: the food of a cell or near it, or its concept of its terms. */
function statement(p: mind.Proposition): string {
  const [first] = p.a;
  const cell = first !== undefined && "c" in first ? first.c : undefined;
  if (p.p === "m1.food-at" && cell !== undefined)
    return `there is ${amount(p.v)} food at ${place(cell)}`;
  if (p.p === "m1.food-near" && cell !== undefined) return `there is food near ${place(cell)}`;
  const value = p.v === undefined ? "" : `, at ${p.v}`;
  return `${p.p} holds of ${p.a.map(term).join(" and ")}${value}`;
}

/** The amount of food a band of the food cue says: none, some, or plenty. */
function amount(band: number | undefined): string {
  if (band === 2) return "plenty of";
  return band === 1 ? "some" : "no";
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
