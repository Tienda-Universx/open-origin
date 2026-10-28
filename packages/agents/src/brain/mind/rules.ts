/**
 * The rules of `mind@1` (ADR 0024, docs/architecture/mind.md "Beliefs" and "The brain mind@1",
 * plan §5.2): each belief operation it proposes is the output of one of these exported pure
 * functions, applied to the records the operation cites and the being's traits, and of nothing
 * else. A rule reads only the content of what it cites: an episode's kind, cell, speaker, value,
 * act, proposition, and band, and a relationship's being and trust; never an age, an importance,
 * or anything the being senses outside its records. So a `believe` is `BELIEF_RULES[rule](cited)`
 * and a `revise` is `revisedConfidence(belief, cited)`, which a test can check from the records
 * alone (docs/architecture/mind.md, "Evaluation").
 *
 * `mind@1` forms one concept, `m1.food-at`: the band of the food of its species' deposit at a
 * cell, as its window cues it. A rule accepts a record as a view shows it or as the state holds it,
 * since it reads only the members both have.
 */
import { type beings, type DeepReadonly, floorDiv, type mind } from "@open-origin/engine";
import { least } from "../curves.ts";
import {
  CONTRADICTED_CR,
  FOOD_AT,
  RULE_IDS,
  SEEN_CR,
  STRANGER_TRUST,
  TOLD_CR,
  TRUST_STEP,
  UNSPOKEN_BAND,
} from "./parameters.ts";

/** A proposition as a brain reads it, in its senses or its own records. */
export type Claim = DeepReadonly<mind.Proposition>;

/** An episode as a rule reads it: the content a view and the state both hold. */
export type CitedEpisode = {
  readonly kind: string;
  readonly cell?: readonly number[];
  readonly who?: number;
  readonly v?: number;
  readonly p?: Claim;
  readonly act?: string;
  readonly band?: number;
};

/** A cited record with the store that holds it, as the engine's records name them. */
export type CitedRecord =
  | { readonly store: "episodes"; readonly record: CitedEpisode }
  | { readonly store: "beliefs"; readonly record: { readonly p: Claim } }
  | { readonly store: "relations"; readonly record: { readonly who: number; readonly tr: number } };

/** What a rule forms: a proposition and its confidence. */
export type Formed = { readonly p: mind.Proposition; readonly cr: number };

/** A rule of a `believe`: what it forms from the records it cites and the traits, if anything. */
export type BeliefRule = (
  cited: readonly CitedRecord[],
  traits: beings.Traits2,
) => Formed | undefined;

/** The bands of food a window cues: 0, 1, and 2. */
const BANDS = 3;

/** The proposition that the food at `cell` is of band `v`. */
export function foodAt(cell: mind.Cell, v: number): mind.Proposition {
  return { p: FOOD_AT, a: [{ c: [cell[0], cell[1]] }], v };
}

/** Whether `v` is a band of food: 0, 1, or 2. */
function isBand(v: number | undefined): v is number {
  return v !== undefined && v >= 0 && v < BANDS;
}

/** `cell` as a cell when it holds two coordinates. */
function cellOf(cell: readonly number[] | undefined): mind.Cell | undefined {
  const [x, y] = cell ?? [];
  return x === undefined || y === undefined ? undefined : [x, y];
}

/** The cell and band of `p` when it is a food-at proposition of mind@1's shape. */
export function foodClaim(
  p: Claim | undefined,
): { readonly cell: mind.Cell; readonly v: number } | undefined {
  if (p === undefined || p.p !== FOOD_AT || p.neg !== undefined || p.a.length !== 1)
    return undefined;
  const [term] = p.a;
  const cell = term !== undefined && "c" in term ? cellOf(term.c) : undefined;
  return cell === undefined || !isBand(p.v) ? undefined : { cell, v: p.v };
}

/** Whether `p` is the claim that the food at `cell` is of band `v`. */
export function claims(p: Claim, cell: mind.Cell, v: number): boolean {
  const claim = foodClaim(p);
  return claim !== undefined && claim.v === v && sameCell(claim.cell, cell);
}

/** Whether two cells are the same. */
function sameCell(a: readonly number[] | undefined, b: mind.Cell): boolean {
  return a !== undefined && a[0] === b[0] && a[1] === b[1];
}

/** The one cited record when it is a food cue: its cell and band. */
function citedCue(cited: readonly CitedRecord[]): { cell: mind.Cell; v: number } | undefined {
  const [only] = cited;
  if (cited.length !== 1 || only?.store !== "episodes" || only.record.kind !== "food")
    return undefined;
  const cell = cellOf(only.record.cell);
  const { v } = only.record;
  return cell === undefined || !isBand(v) ? undefined : { cell, v };
}

/**
 * seen-food: from one food cue the being remembers, the belief that its cell holds the band it
 * saw, with the confidence of sight.
 */
export function seenFood(
  cited: readonly CitedRecord[],
  _traits: beings.Traits2,
): Formed | undefined {
  const cue = citedCue(cited);
  return cue === undefined ? undefined : { p: foodAt(cue.cell, cue.v), cr: SEEN_CR };
}

/** A message telling a food claim: its claim, its speaker if visible, and its band. */
type Testimony = {
  readonly claim: { readonly cell: mind.Cell; readonly v: number };
  readonly who: number | undefined;
  readonly band: number;
};

/**
 * The testimony of a cited episode: a `tell` of a food claim, heard from a speaker or, from a
 * research injection, with no visible speaker and no band, which weighs as the middle band.
 */
function testimonyOf(record: CitedEpisode): Testimony | undefined {
  const injected = record.kind === "external";
  if (!injected && (record.kind !== "heard" || record.act !== "tell")) return undefined;
  const claim = foodClaim(record.p);
  const band = record.band ?? UNSPOKEN_BAND;
  if (claim === undefined || !isBand(band)) return undefined;
  return { claim, who: injected ? undefined : record.who, band };
}

/**
 * told-food: from a testimony, and the relationship with its speaker when the being cites it, the
 * belief the speaker told, with the confidence the speaker's band starts from, weighed by trust
 * and credulity: ⌊TOLD_CR[band] · (500 + trust) · credulity / 10^6⌋, at most 1000. A speaker the
 * being cites no relationship with, or that it could not see, weighs as a being it does not know,
 * with the trust of a new relationship. The relationship, when cited, comes second.
 */
export function toldFood(
  cited: readonly CitedRecord[],
  traits: beings.Traits2,
): Formed | undefined {
  const [heard, known, ...rest] = cited;
  if (heard?.store !== "episodes" || rest.length > 0) return undefined;
  const testimony = testimonyOf(heard.record);
  if (testimony === undefined) return undefined;
  let trust = STRANGER_TRUST;
  if (known !== undefined) {
    if (known.store !== "relations" || known.record.who !== testimony.who) return undefined;
    trust = known.record.tr;
  }
  const start = TOLD_CR[testimony.band] as number;
  const cr = floorDiv(start * (500 + trust) * traits.credulity, 1_000_000);
  return { p: foodAt(testimony.claim.cell, testimony.claim.v), cr: least(cr, 1000) };
}

/** The rules of `believe`, by the identifier the ledger records. */
export const BELIEF_RULES: Readonly<Record<string, BeliefRule>> = Object.freeze({
  [RULE_IDS.seen]: seenFood,
  [RULE_IDS.told]: toldFood,
});

/**
 * Whether the food cue `cited` alone confirms the food belief `belief` (true), contradicts it
 * (false), or says nothing of it (undefined): it must be one cue of the belief's cell.
 */
function checked(
  belief: { readonly p: Claim },
  cited: readonly CitedRecord[],
): boolean | undefined {
  const claim = foodClaim(belief.p);
  const cue = citedCue(cited);
  if (claim === undefined || cue === undefined || !sameCell(cue.cell, claim.cell)) return undefined;
  return cue.v === claim.v;
}

/**
 * The confidence of a revision of a food belief by one food cue of its cell, which is all a revise
 * of `mind@1` cites: the confidence of sight when the cue has the believed band, and that of a
 * contradiction when it has another. It does not read the confidence the belief held.
 */
export function revisedConfidence(
  belief: { readonly p: Claim },
  cited: readonly CitedRecord[],
): number | undefined {
  const holds = checked(belief, cited);
  if (holds === undefined) return undefined;
  return holds ? SEEN_CR : CONTRADICTED_CR;
}

/**
 * The change of trust in the speaker of a food belief by one food cue of its cell: TRUST_STEP up
 * when the claim held, down when it did not, never more than the law `relations.delta` allows.
 */
export function trustChange(
  belief: { readonly p: Claim },
  cited: readonly CitedRecord[],
  laws: { readonly relations: { readonly delta: number } },
): number | undefined {
  const holds = checked(belief, cited);
  if (holds === undefined) return undefined;
  const step = least(TRUST_STEP, laws.relations.delta);
  // 0 − step, not −step: a step of 0 gives 0, never −0, which is no canonical value.
  return holds ? step : 0 - step;
}
