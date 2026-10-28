/**
 * The mental operations of one decision of `mind@1` (ADR 0024, docs/architecture/mind.md "Beliefs"
 * and "The brain mind@1"). The brain considers, in this order, what it sees of what it believes,
 * what it hears, and what it sees anew:
 *
 * - a **check**: the belief of a cell it sees whose cue contradicts it, or confirms a belief it
 *   held with less than the confidence of sight; the cue is remembered and the belief revised,
 *   and for a testimony its trust in the speaker changed, citing the belief and the cue; a belief
 *   already contradicted and contradicted again is dropped;
 * - a **testimony**: the first `tell` of a food claim it hears, unless it holds it already,
 *   remembered and believed by told-food, citing the relationship with its speaker when it holds
 *   one;
 * - a **landmark**: the best food cue in sight, unless it lies within LANDMARK_SPACING of food it
 *   believes in, remembered and believed by seen-food;
 *
 * and, from the act it chose, an unreachable food it forgets and a being it meets. Each is all or
 * nothing, and is added only when the whole decision may still be proposed (operations.ts). Every
 * belief operation is its rule applied to what it cites (rules.ts); none cites nothing. Which
 * claim a testimony or a landmark forms depends on what the being hears and sees, never on a
 * record it does not cite, and the check, the only operation that its records choose, comes first:
 * decided again with only the records an operation cites, the decision proposes it again, the
 * ablation of mind.md ("Evaluation").
 */
import { type beings, type DeepReadonly, mind } from "@open-origin/engine";
import { greatest } from "../curves.ts";
import { chebyshev, cueAt } from "./cells.ts";
import type { BrainLaws } from "./laws.ts";
import {
  attempt,
  type Intent,
  intentionOf,
  NO_OPS,
  type Ops,
  type Recall,
  type Related,
} from "./operations.ts";
import {
  BEING_W,
  CONTRADICTED_CR,
  FOOD_W,
  HEARD_W,
  LANDMARK_SPACING,
  RULE_IDS,
  SEEN_CR,
  TELL_FLOOR,
  TESTIMONY_FLOOR,
} from "./parameters.ts";
import { memoryHalfLife, retrieve } from "./retrieval.ts";
import {
  type CitedEpisode,
  type CitedRecord,
  claims,
  foodClaim,
  revisedConfidence,
  seenFood,
  toldFood,
  trustChange,
} from "./rules.ts";

type Senses2 = DeepReadonly<beings.Senses2>;
type BeliefView = Senses2["mind"]["beliefs"][number];

/** The bit of told evidence in a belief's `src`, as a view shows it. */
const TOLD = mind.EVIDENCE.told;

/** The id the next `remember` of `ops` makes. */
function nextEpisode(recall: Recall, ops: Ops): number {
  return recall.senses.mind.next + ops.remember.length;
}

/** Whether the mind holds, or the decision believes, that the food at `cell` is of band `v`. */
function heldOrBelieved(recall: Recall, ops: Ops, cell: mind.Cell, v: number): boolean {
  const all = [...recall.senses.mind.beliefs, ...ops.believe];
  return all.some((belief) => claims(belief.p, cell, v));
}

/** The episode a message of the decision becomes, as the view of the next decision shows it. */
function heardEpisode(message: Senses2["perceived"]["heard"][number]): CitedEpisode {
  return { kind: "heard", ...message };
}

/** The relationship the mind holds with `who`, if any. */
function relationWith(recall: Recall, who: number | undefined): mind.RelationshipView | undefined {
  return who === undefined ? undefined : recall.senses.mind.relations.find((r) => r.who === who);
}

/**
 * A testimony: the first message that tells a food claim the mind does not hold, which told-food
 * believes at TESTIMONY_FLOOR or more, remembered and believed.
 */
function testimony(recall: Recall, ops: Ops): Intent | undefined {
  const { heard } = recall.senses.perceived;
  const index = heard.findIndex(
    (message) => message.act === "tell" && foodClaim(message.p) !== undefined,
  );
  const message = heard[index];
  const claim = message === undefined ? undefined : foodClaim(message.p);
  if (message === undefined || claim === undefined) return undefined;
  if (heldOrBelieved(recall, ops, claim.cell, claim.v)) return undefined;
  const known = relationWith(recall, message.who);
  const cited: CitedRecord[] = [{ store: "episodes", record: heardEpisode(message) }];
  if (known !== undefined) cited.push({ store: "relations", record: known });
  const formed = toldFood(cited, recall.senses.self.traits);
  if (formed === undefined || formed.cr < TESTIMONY_FLOOR) return undefined;
  const id = nextEpisode(recall, ops);
  return {
    remember: [{ percept: { heard: index }, w: HEARD_W, cited: true }],
    believe: [
      {
        p: formed.p,
        cr: formed.cr,
        ev: known === undefined ? [id] : [id, known.id],
        rule: RULE_IDS.told,
      },
    ],
  };
}

/** A belief the window shows to be contradicted, or confirmed when the being doubted it. */
type Checked = { readonly belief: BeliefView; readonly cell: mind.Cell; readonly cue: number };

/** The claim of `belief` and the cue the window shows of its cell, when the window covers it. */
function shownClaim(
  senses: Senses2,
  belief: BeliefView,
): { readonly v: number; readonly cell: mind.Cell; readonly cue: number } | undefined {
  const claim = foodClaim(belief.p);
  const cue = claim === undefined ? undefined : cueAt(senses.window, claim.cell);
  return claim === undefined || cue === undefined ? undefined : { ...claim, cue };
}

/**
 * The belief to check, by retrieval among those whose cell the window covers and that the act does
 * not rely on: contradicted ones are twice as relevant as doubted ones the cue confirms, and each
 * weighs its certainty either way, as salience does.
 */
function checkFocus(recall: Recall): Checked | undefined {
  const { senses, keep } = recall;
  const halfLife = memoryHalfLife(recall.laws, senses.self.traits.retention);
  const belief = retrieve(
    senses.mind.beliefs,
    (candidate) => {
      const shown = shownClaim(senses, candidate);
      if (shown === undefined || keep.includes(candidate.id)) return undefined;
      const contradicted = shown.cue !== shown.v;
      if (!contradicted && candidate.cr >= SEEN_CR) return undefined;
      const importance = greatest(candidate.cr, 1000 - candidate.cr);
      return {
        id: candidate.id,
        age: candidate.u,
        importance,
        relevance: contradicted ? 1000 : 500,
      };
    },
    halfLife,
  );
  const shown = belief === undefined ? undefined : shownClaim(senses, belief);
  if (belief === undefined || shown === undefined) return undefined;
  return { belief, cell: shown.cell, cue: shown.cue };
}

/**
 * A check: the belief of a cell the window covers that its cue contradicts, or confirms when the
 * being held it with less than the confidence of sight, revised by its cue, which it remembers;
 * for a testimony, with the trust in its speaker changed. A belief already at the confidence of a
 * contradiction and contradicted again is dropped instead.
 */
function check(recall: Recall, ops: Ops): Intent | undefined {
  const focus = checkFocus(recall);
  if (focus === undefined) return undefined;
  const { belief, cell, cue } = focus;
  const contradicted = foodClaim(belief.p)?.v !== cue;
  if (contradicted && belief.cr <= CONTRADICTED_CR) return { drop: [belief.id] };
  const id = nextEpisode(recall, ops);
  const seen: CitedRecord[] = [{ store: "episodes", record: { kind: "food", cell, v: cue } }];
  const cr = revisedConfidence(belief, seen);
  if (cr === undefined) return undefined;
  const relate = trusted(recall, belief, seen, id);
  return {
    remember: [{ percept: { food: [cell[0], cell[1]] as const }, w: FOOD_W, cited: true }],
    revise: [{ id: belief.id, cr, ev: [id] }],
    ...(relate === undefined ? {} : { relate: [relate] }),
  };
}

/**
 * The change of trust in the speaker of `belief`, a testimony, by the cue `seen`, the episode `id`,
 * citing both: undefined when the belief was not told, the mind holds no relationship with its
 * speaker, or the law allows no change.
 */
function trusted(
  recall: Recall,
  belief: BeliefView,
  seen: readonly CitedRecord[],
  id: number,
): Related | undefined {
  const speaker = (belief.src & TOLD) === 0 ? undefined : relationWith(recall, belief.who);
  const tr = speaker === undefined ? 0 : (trustChange(belief, seen, recall.laws) ?? 0);
  return speaker === undefined || tr === 0
    ? undefined
    : { who: speaker.who, tr, because: [belief.id, id] };
}

/** The cells of the food the being believes in, held or believed in this decision: its landmarks. */
function landmarks(recall: Recall, ops: Ops): mind.Cell[] {
  return [...recall.senses.mind.beliefs, ...ops.believe].flatMap((belief) => {
    const claim = foodClaim(belief.p);
    return claim !== undefined && claim.v > 0 && belief.cr >= TELL_FLOOR ? [claim.cell] : [];
  });
}

/** A cell of the window seen as a landmark: its cell, its cue, and its distance. */
type Sighted = { readonly cell: mind.Cell; readonly cue: number; readonly distance: number };

/** Whether `a` is a better landmark than `b`: a higher cue, then nearer; the scan breaks ties. */
function betterSight(a: Sighted, b: Sighted | undefined): boolean {
  if (b === undefined || a.cue !== b.cue) return b === undefined || a.cue > b.cue;
  return a.distance < b.distance;
}

/**
 * The landmark in sight: the cell of the window with the highest food cue, then the nearest, then
 * the first by index, that it does not cool; none when that cell lies within LANDMARK_SPACING of a
 * landmark the being has, or its band there is one the mind already believes or doubts. The cell
 * is chosen from what the being sees alone, so its records decide only whether it is new.
 */
function sighted(recall: Recall, ops: Ops): Sighted | undefined {
  const { window, self } = recall.senses;
  const cooled = self.cooldowns.map(({ cell }) => cell);
  let best: Sighted | undefined;
  for (let index = 0; index < window.side * window.side; index += 1) {
    const cue = window.foodCue[index] as number;
    if (cue === 0) continue;
    const column = index % window.side;
    const cell: mind.Cell = [
      (window.origin[0] as number) + column,
      (window.origin[1] as number) + (index - column) / window.side,
    ];
    if (cooled.some((other) => chebyshev(other, cell) === 0)) continue;
    const candidate = { cell, cue, distance: chebyshev(cell, self.cell) };
    if (betterSight(candidate, best)) best = candidate;
  }
  if (best === undefined || heldOrBelieved(recall, ops, best.cell, best.cue)) return undefined;
  const near = (landmark: mind.Cell) => chebyshev(landmark, best.cell) <= LANDMARK_SPACING;
  return landmarks(recall, ops).some(near) ? undefined : best;
}

/** A landmark: the food cue of the landmark in sight, remembered and believed by seen-food. */
function landmark(recall: Recall, ops: Ops): Intent | undefined {
  const sight = sighted(recall, ops);
  if (sight === undefined) return undefined;
  const { cell, cue } = sight;
  const cited: CitedRecord[] = [{ store: "episodes", record: { kind: "food", cell, v: cue } }];
  const formed = seenFood(cited, recall.senses.self.traits);
  if (formed === undefined) return undefined;
  return {
    remember: [{ percept: { food: [cell[0], cell[1]] }, w: FOOD_W, cited: true }],
    believe: [{ p: formed.p, cr: formed.cr, ev: [nextEpisode(recall, ops)], rule: RULE_IDS.seen }],
  };
}

/** A being the decision's act meets, the `index`-th the being perceives, remembered. */
function encounter(index: number): Intent {
  return { remember: [{ percept: { being: index }, w: BEING_W, cited: false }] };
}

/** What the decision's act asks of memory: a belief it relies on, a food it forgets, a being it meets. */
export type ActNeeds = {
  readonly keep?: number;
  readonly forget?: number;
  readonly meets?: number;
};

/**
 * The mental operations of the decision, by priority: a check, a testimony, a food the act
 * forgets, a landmark, and the being the act meets, each added only when it fits. Undefined when
 * the decision proposes none.
 */
export function mentalOperations(
  senses: Senses2,
  laws: BrainLaws,
  needs: ActNeeds,
): beings.MindIntention | undefined {
  const recall: Recall = { senses, laws, keep: needs.keep === undefined ? [] : [needs.keep] };
  let ops = attempt(recall, NO_OPS, check(recall, NO_OPS));
  ops = attempt(recall, ops, testimony(recall, ops));
  const { forget } = needs;
  if (
    forget !== undefined &&
    !ops.drop.includes(forget) &&
    !ops.revise.some(({ id }) => id === forget)
  )
    ops = attempt(recall, ops, { drop: [forget] });
  ops = attempt(recall, ops, landmark(recall, ops));
  if (needs.meets !== undefined) ops = attempt(recall, ops, encounter(needs.meets));
  return intentionOf(ops);
}
