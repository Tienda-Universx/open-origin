import { type beings, canonicalize, mind } from "@open-origin/engine";
import { CONTRADICTED_CR, TELL_FLOOR } from "../../src/brain/mind/parameters.ts";
import {
  BELIEF_RULES,
  type CitedEpisode,
  type CitedRecord,
  foodClaim,
  revisedConfidence,
  trustChange,
} from "../../src/brain/mind/rules.ts";
import { type Senses2, SPECIES2 } from "./mind-senses.ts";

/**
 * The check that every belief operation of `mind@1` is its rule applied to what it cites
 * (docs/architecture/mind.md, "Evaluation"; plan §5.2). From the senses of a decision and the
 * intention it returned, it rebuilds each cited record as the decision saw it: a record the mind
 * held from the view, and a record the decision creates from its percept, as the engine copies it.
 * Then a `believe` must equal `BELIEF_RULES[rule]` of its citations, a `revise` must equal
 * `revisedConfidence` of the belief it revises and its citations, a `relate` must be the
 * `trustChange` of the told belief and the cue it cites, and a `drop` must name a belief mind@1
 * drops: contradicted again, or food beyond the window it would seek. It reads nothing else.
 */

/** The kinds of activity of beings@2, whose index a `being` episode holds. */
const ACTIVITIES = ["eat", "idle", "sleep", "walk", "talk"];

type Percept = NonNullable<beings.MindIntention["remember"]>[number]["percept"];

/** The episode the engine copies from `percept` at this decision, as a rule reads it. */
function perceived(senses: Senses2, percept: Percept): CitedEpisode | undefined {
  if ("food" in percept) {
    const { origin, side, foodCue } = senses.window;
    const [x, y] = percept.food;
    const index = (y - (origin[1] as number)) * side + (x - (origin[0] as number));
    return { kind: "food", cell: [x, y], v: foodCue[index] as number };
  }
  if ("heard" in percept) {
    const message = senses.perceived.heard[percept.heard];
    if (message === undefined) return undefined;
    if (message.who === undefined)
      return { kind: "external", ...(message.p ? { p: message.p } : {}) };
    return { kind: "heard", ...message };
  }
  if ("being" in percept) {
    const being = senses.perceived.beings[percept.being];
    if (being === undefined) return undefined;
    return {
      kind: "being",
      who: being.id,
      cell: being.cell,
      v: ACTIVITIES.indexOf(being.activity),
    };
  }
  return { kind: "outcome" };
}

/** The episodes a decision created, by local id, as the engine holds them after its tick. */
export type Created = ReadonlyMap<number, CitedEpisode>;

/**
 * The records the decision may cite, by local id: those held, and those its operations create,
 * rebuilt from their percepts, or taken from `created` when the engine's records are known.
 */
function citable(
  senses: Senses2,
  ops: beings.MindIntention,
  created: Created | undefined,
): Map<number, CitedRecord> {
  const records = new Map<number, CitedRecord>();
  const view = senses.mind;
  for (const record of view.episodes) records.set(record.id, { store: "episodes", record });
  for (const record of view.beliefs) records.set(record.id, { store: "beliefs", record });
  for (const record of view.relations) records.set(record.id, { store: "relations", record });
  let next = view.next;
  for (const { percept } of ops.remember ?? []) {
    const record = created === undefined ? perceived(senses, percept) : created.get(next);
    if (record !== undefined) records.set(next, { store: "episodes", record });
    next += 1;
  }
  for (const { p, cr } of ops.believe ?? []) {
    records.set(next, { store: "beliefs", record: { p, cr } as never });
    next += 1;
  }
  return records;
}

/** Whether two propositions are the same canonical value. */
const same = (a: mind.Proposition, b: mind.Proposition) => canonicalize(a) === canonicalize(b);

type Believe = NonNullable<beings.MindIntention["believe"]>[number];
type Revise = NonNullable<beings.MindIntention["revise"]>[number];

/** The records `ev` cites, each undefined when the decision could not cite it. */
function citedBy(records: ReadonlyMap<number, CitedRecord>, ev: readonly number[]) {
  const cited = ev.map((id) => records.get(id));
  return cited.some((record) => record === undefined) ? undefined : (cited as CitedRecord[]);
}

/** Why `op` is not its rule applied to what it cites; undefined when it is. */
function believeProblem(
  records: ReadonlyMap<number, CitedRecord>,
  op: Believe,
  traits: beings.Traits2,
): string | undefined {
  const name = `believe ${canonicalize(op.p)} ${op.cr}`;
  if (op.ev.length === 0) return `${name} cites nothing`;
  const cited = citedBy(records, op.ev);
  const rule = BELIEF_RULES[op.rule];
  if (rule === undefined || cited === undefined)
    return `${name}: ${op.rule} or a citation is unknown`;
  const formed = rule(cited, traits);
  if (formed === undefined || !same(formed.p, op.p) || formed.cr !== op.cr)
    return `${name} is not ${op.rule} of what it cites`;
  return undefined;
}

/** Why `op` is not the revision of what it cites; undefined when it is. */
function reviseProblem(records: ReadonlyMap<number, CitedRecord>, op: Revise): string | undefined {
  const belief = records.get(op.id);
  const cited = citedBy(records, op.ev);
  if (belief?.store !== "beliefs" || cited === undefined)
    return `revise ${op.id}: the belief or a citation is unknown`;
  if (revisedConfidence(belief.record, cited) !== op.cr)
    return `revise ${op.id} to ${op.cr} is not the revision of what it cites`;
  return undefined;
}

type Relate = NonNullable<beings.MindIntention["relate"]>[number];

/** The belief and the cue a `relate` cites, in that order and nothing else, when it does. */
function beliefAndCue(
  records: ReadonlyMap<number, CitedRecord>,
  because: readonly number[],
): { readonly belief: CitedRecord; readonly cue: CitedRecord } | undefined {
  const [belief, cue, ...rest] = because.map((id) => records.get(id));
  if (belief?.store !== "beliefs" || cue?.store !== "episodes" || rest.length > 0) return undefined;
  return { belief, cue };
}

/** Whether the cited belief `belief` was told by the being `who`. */
function toldBy(belief: CitedRecord, who: number): boolean {
  const { src = 0, who: speaker } = belief.record as { src?: number; who?: number };
  return (src & mind.EVIDENCE.told) !== 0 && speaker === who;
}

/**
 * Why `op` is not the trust change of the testimony it checks; undefined when it is. It cites a
 * belief the being was told, held before the decision, whose speaker is the being it relates, then
 * a cue of that belief's cell, and changes trust by `trustChange` of them and affinity not at all.
 */
function relateProblem(
  records: ReadonlyMap<number, CitedRecord>,
  op: Relate,
  laws: TrustLaws,
): string | undefined {
  const name = `relate ${op.who} by ${op.tr ?? 0}`;
  const cited = beliefAndCue(records, op.because);
  if (cited === undefined) return `${name} cites no belief and one cue of it`;
  if (!toldBy(cited.belief, op.who)) return `${name} relates no speaker of the belief it cites`;
  const tr = trustChange(cited.belief.record as { p: mind.Proposition }, [cited.cue], laws);
  if (op.aff !== undefined || tr === undefined || tr !== op.tr)
    return `${name} is not the trust change of what it cites`;
  return undefined;
}

/** The food cue the window of `senses` shows at `cell`, or undefined beyond it. */
function cueOf(senses: Senses2, cell: readonly number[]): number | undefined {
  const { origin, side, foodCue } = senses.window;
  const column = (cell[0] as number) - (origin[0] as number);
  const row = (cell[1] as number) - (origin[1] as number);
  if (column < 0 || column >= side || row < 0 || row >= side) return undefined;
  return foodCue[row * side + column];
}

/**
 * Why `mind@1` may not drop the belief `id`; undefined when it may: food its window shows with
 * another band, at a confidence of at most CONTRADICTED_CR, so contradicted again; or food beyond
 * its window that it would walk to, which it forgets when it can get no nearer.
 */
function dropProblem(senses: Senses2, id: number): string | undefined {
  const belief = senses.mind.beliefs.find((held) => held.id === id);
  const claim = belief === undefined ? undefined : foodClaim(belief.p);
  if (belief === undefined || claim === undefined) return `drop ${id}: no belief of food it holds`;
  const cue = cueOf(senses, claim.cell);
  if (cue === undefined)
    return claim.v > 0 && belief.cr >= TELL_FLOOR ? undefined : `drop ${id}: no food to seek`;
  const again = cue !== claim.v && belief.cr <= CONTRADICTED_CR;
  return again ? undefined : `drop ${id}: not contradicted again`;
}

/** The laws a trust change reads. */
type TrustLaws = { readonly relations: { readonly delta: number } };

/**
 * Every belief operation of `intention` that is not its rule applied to what it cites: a
 * `believe`, a `revise`, a `relate`, and a `drop`. The episodes it creates are rebuilt from their
 * percepts unless `created` gives the engine's; `laws` bound a change of trust, the frozen ones
 * by default.
 */
export function ruleProblems(
  senses: Senses2,
  intention: beings.Intention2,
  created?: Created,
  laws: TrustLaws = SPECIES2,
): string[] {
  const ops = intention.mind ?? {};
  const records = citable(senses, ops, created);
  const traits = senses.self.traits;
  return [
    ...(ops.believe ?? []).map((op) => believeProblem(records, op, traits)),
    ...(ops.revise ?? []).map((op) => reviseProblem(records, op)),
    ...(ops.relate ?? []).map((op) => relateProblem(records, op, laws)),
    ...(ops.drop ?? []).map((id) => dropProblem(senses, id)),
  ].filter((problem): problem is string => problem !== undefined);
}
