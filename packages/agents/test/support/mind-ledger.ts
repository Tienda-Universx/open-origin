import {
  type beings,
  canonicalize,
  type EngineEvent,
  mind,
  type StepResult,
} from "@open-origin/engine";
import type { Senses2 } from "./mind-senses.ts";

/**
 * The items of the evaluation of mind.md ("Evaluation") that the ledger decides: each a predicate
 * over the events `mind.changed` and `mind.provenance` of a run, which name the records a decision
 * encoded, formed, revised, and related, and what each live one cites. What a cited record is (its
 * kind, cell, value, speaker, act, and proposition, a belief's confidence, evidence, and speaker,
 * a relationship's trust) the ledger does not carry: it is read from the state after the tick that
 * created or changed it, as it stood then. Two kinds of record leave the state in the decision that
 * makes them: an episode a full store evicts at once, whose kind the percept of its `remember`
 * gives, since a new record takes its id from its place among the operations; and a belief a full
 * store evicts at once, which the ledger gives no citations for and which is classed by the rule
 * it names (`seen-food` cites one food episode, `told-food` a heard tell), each a check of
 * mind-rules-check.ts. The observer reads the world after each step and never changes what happens.
 */

/** What the ledger shows one being did over a run. */
export type LedgerTally = {
  readonly id: number;
  /** Episodes encoded of a food cue and of a being. */
  food: number;
  being: number;
  /** Beliefs formed (new ones) that cite an episode of its own observation: food, being, ate, failed. */
  formedOwn: number;
  /** Beliefs formed (new ones) that cite a heard episode of a tell. */
  formedTold: number;
  /** Believes or revises that cite a heard episode of a tell: beliefs from testimony. */
  fromTestimony: number;
  /** Revisions down of an m1.food-at belief that cite, at its cell, a food cue of another band or a failure to find food. */
  revisedDown: number;
  /** Relates that changed trust in a speaker, citing its told belief and a cue of that belief's cell. */
  trustChecked: number;
  /** Beliefs it formed that a full store evicted at once. */
  evictedAtOnce: number;
};

/** A record of a mind as the state held it, and its store. */
type Known = mind.MindRecord;

/** A decision of the brain, kept until its tick's ledger shows whether it applied. */
type Decision = { readonly senses: Senses2; readonly intention: beings.Intention2 };

type Changed = {
  readonly id: number;
  readonly encoded: readonly number[];
  readonly formed: readonly { readonly id: number; readonly rule: string }[];
  readonly revised: readonly { readonly id: number; readonly rule?: string }[];
  readonly related: readonly number[];
};
type Entry = {
  readonly id: number;
  readonly tn: number;
  readonly ex: number;
  readonly ev: readonly number[];
};
type Provenance = { readonly id: number; readonly records: readonly Entry[] };

/** The kinds of episode that are a being's own observation. */
const OWN = new Set(["food", "being", "ate", "failed"]);
/** The reasons of a failure to find food at a cell. */
const NO_FOOD = new Set(["no_food", "food_gone"]);

/** Whether `known` is a heard episode of a tell. */
const isTell = (known: Known | undefined) =>
  known?.store === "episodes" && known.record.kind === "heard" && known.record.act === "tell";

/** The cell and band of an `m1.food-at` proposition, or undefined for any other. */
function foodAt(
  p: mind.Proposition,
): { readonly cell: readonly number[]; readonly v: number } | undefined {
  const term = p.a[0] as { c?: readonly number[] } | undefined;
  if (p.p !== "m1.food-at" || p.neg === true || term?.c === undefined || p.v === undefined)
    return undefined;
  return { cell: term.c, v: p.v };
}

/** Whether `known` is an episode at `cell`. */
function atCell(known: Known | undefined, cell: readonly number[]): boolean {
  if (known?.store !== "episodes" || !("cell" in known.record)) return false;
  return canonicalize(known.record.cell as never) === canonicalize(cell as never);
}

/** The kind of episode a `remember` percept makes, as the engine copies it. */
function perceptKind(senses: Senses2, percept: unknown): string {
  const kinds = percept as { food?: unknown; being?: unknown; heard?: number };
  if (kinds.food !== undefined) return "food";
  if (kinds.being !== undefined) return "being";
  if (kinds.heard !== undefined)
    return senses.perceived.heard[kinds.heard]?.who === undefined ? "external" : "heard";
  return senses.self.outcome.result === "failed" ? "failed" : "ate";
}

/** A tally of nothing yet. */
const newTally = (id: number): LedgerTally => ({
  id,
  food: 0,
  being: 0,
  formedOwn: 0,
  formedTold: 0,
  fromTestimony: 0,
  revisedDown: 0,
  trustChecked: 0,
  evictedAtOnce: 0,
});

/** The live records of `held`, by local id. */
function recordsOf(held: mind.Mind): Map<number, Known> {
  const records = new Map<number, Known>();
  for (const record of held.episodes) records.set(record.id, { store: "episodes", record });
  for (const record of held.beliefs) records.set(record.id, { store: "beliefs", record });
  for (const record of held.relations) records.set(record.id, { store: "relations", record });
  return records;
}

/** What one decision's ledger names, with the records before and after it. */
type Step = {
  readonly tick: number;
  readonly tally: LedgerTally;
  readonly changed: Changed;
  readonly entries: ReadonlyMap<number, Entry>;
  readonly before: ReadonlyMap<number, Known>;
  readonly after: ReadonlyMap<number, Known>;
  readonly decision: Decision | undefined;
};

/** The record `id` as the decision left it, or as it was before, when it is no longer live. */
const cited = (step: Step, id: number) => step.after.get(id) ?? step.before.get(id);

/**
 * The observer of a run: `controller` wraps the brain of the scenario, so that an episode evicted
 * at once can be told by its percept; `observe` reads each step, with the beings after it.
 */
export class LedgerItems {
  readonly tallies = new Map<number, LedgerTally>();
  /** Beliefs whose lineage holds model-prior-suspect, by the ledger. */
  priorSuspect = 0;
  readonly #known = new Map<number, Map<number, Known>>();
  readonly #pending = new Map<number, Decision>();
  readonly #onTold: ((being: number, tick: number, p: mind.Proposition) => void) | undefined;

  /** `onTold`, when given, receives each live belief formed from testimony, as it forms. */
  constructor(onTold?: (being: number, tick: number, p: mind.Proposition) => void) {
    this.#onTold = onTold;
  }

  /** `inner`, which keeps each decision of the tick for the observer and decides unchanged. */
  controller(inner: beings.Controller2): beings.Controller2 {
    const pending = this.#pending;
    return {
      ...inner,
      decide: (senses) => {
        const intention = inner.decide(senses);
        pending.set(senses.self.id, { senses, intention });
        return intention;
      },
    };
  }

  /** Reads the ledger of the step `result`; `minds` gives each being's mind after it. */
  observe(result: StepResult, minds: () => ReadonlyMap<number, beings.Being2>): void {
    const pairs = changesOf(result.events);
    let after: ReadonlyMap<number, beings.Being2> | undefined;
    for (const { changed, provenance } of pairs) {
      after ??= minds();
      const held = after.get(changed.id)?.mind;
      if (held === undefined) continue;
      const tally = this.tallies.get(changed.id) ?? newTally(changed.id);
      this.tallies.set(changed.id, tally);
      const records = recordsOf(held);
      this.#step({
        tick: result.tick,
        tally,
        changed,
        entries: new Map((provenance?.records ?? []).map((entry) => [entry.id, entry])),
        before: this.#known.get(changed.id) ?? new Map(),
        after: records,
        decision: this.#pending.get(changed.id),
      });
      this.#known.set(changed.id, records);
    }
    this.#pending.clear();
  }

  /** Tallies what one decision's ledger names. */
  #step(step: Step): void {
    const { tally, changed } = step;
    for (const id of changed.encoded) countEpisode(tally, episodeKind(step, id));
    for (const formed of changed.formed) this.#formed(step, formed);
    for (const { id } of changed.revised) this.#revised(step, id);
    for (const id of changed.related) if (trustChecked(step, id)) tally.trustChecked += 1;
    for (const entry of step.entries.values())
      if (priorSuspect(step, entry)) this.priorSuspect += 1;
  }

  /** A new belief: from its own observations, from testimony, or evicted at once. */
  #formed(step: Step, formed: { readonly id: number; readonly rule: string }): void {
    const { tally } = step;
    const belief = step.after.get(formed.id);
    const ev = step.entries.get(formed.id)?.ev;
    if (belief?.store !== "beliefs" || ev === undefined) {
      formedByRule(tally, formed.rule);
      return;
    }
    const records = ev.map((id) => cited(step, id));
    if (records.some((known) => known?.store === "episodes" && OWN.has(known.record.kind)))
      tally.formedOwn += 1;
    if (!records.some(isTell)) return;
    tally.formedTold += 1;
    tally.fromTestimony += 1;
    this.#onTold?.(tally.id, step.tick, belief.record.p);
  }

  /** A revision: from testimony, or down after seeing its claim contradicted. */
  #revised(step: Step, id: number): void {
    const was = step.before.get(id);
    const now = step.after.get(id);
    if (was?.store !== "beliefs" || now?.store !== "beliefs") return;
    const added = now.record.ev.filter((cite) => !was.record.ev.includes(cite));
    const records = added.map((cite) => cited(step, cite));
    if (records.some(isTell)) step.tally.fromTestimony += 1;
    const claim = foodAt(now.record.p);
    if (claim === undefined || now.record.cr >= was.record.cr) return;
    const contradicts = (known: Known | undefined) => {
      if (known?.store !== "episodes" || !atCell(known, claim.cell)) return false;
      const { kind } = known.record;
      const v = (known.record as { v: number }).v;
      return (
        (kind === "food" && v !== claim.v) ||
        (kind === "failed" && NO_FOOD.has(mind.FAILURES[v] ?? ""))
      );
    };
    if (records.some(contradicts)) step.tally.revisedDown += 1;
  }

  /** Closes the run: the tallies of every being of `ids`, zero for one whose mind never changed. */
  finish(ids: readonly number[]): LedgerTally[] {
    return ids.map((id) => this.tallies.get(id) ?? newTally(id));
  }
}

/** Counts an encoded episode of `kind` in `tally`. */
function countEpisode(tally: LedgerTally, kind: string | undefined): void {
  if (kind === "food") tally.food += 1;
  if (kind === "being") tally.being += 1;
}

/** Whether the provenance `entry` is of a live belief whose lineage holds model-prior-suspect. */
const priorSuspect = (step: Step, entry: Entry) =>
  step.after.get(entry.id)?.store === "beliefs" && (entry.tn & 1) !== 0;

/** The kind of the episode `id` the decision encoded: from the state, or from its percept. */
function episodeKind(step: Step, id: number): string | undefined {
  const known = step.after.get(id);
  if (known?.store === "episodes") return known.record.kind;
  if (step.decision === undefined) return undefined;
  const { senses, intention } = step.decision;
  const percept = intention.mind?.remember?.[id - senses.mind.next];
  return percept === undefined ? undefined : perceptKind(senses, percept.percept);
}

/** A belief a full store evicted at once, classed by the rule it names. */
function formedByRule(tally: LedgerTally, rule: string): void {
  tally.evictedAtOnce += 1;
  if (rule === "seen-food") tally.formedOwn += 1;
  if (rule !== "told-food") return;
  tally.formedTold += 1;
  tally.fromTestimony += 1;
}

/**
 * Whether the relationship `id` that the decision related changed its trust, citing a belief its
 * being told the mind, with told among its evidence, and an episode of food, a meal, or a failure
 * at that belief's cell.
 */
function trustChecked(step: Step, id: number): boolean {
  const now = step.after.get(id);
  const entry = step.entries.get(id);
  if (now?.store !== "relations" || entry === undefined || entry.ev.length === 0) return false;
  const was = step.before.get(id);
  const before = was?.store === "relations" ? was.record.tr : 500;
  if (now.record.tr === before) return false;
  const records = entry.ev.map((cite) => cited(step, cite));
  const who = now.record.who;
  return records.some((known) => {
    if (known?.store !== "beliefs") return false;
    const { record } = known;
    const claim = foodAt(record.p);
    if (record.who !== who || (record.src & mind.EVIDENCE.told) === 0 || claim === undefined)
      return false;
    return records.some(
      (cue) =>
        cue?.store === "episodes" &&
        ["food", "ate", "failed"].includes(cue.record.kind) &&
        atCell(cue, claim.cell),
    );
  });
}

/** The `mind.changed` events of a tick, each with the `mind.provenance` of its being after it. */
function changesOf(events: readonly EngineEvent[]) {
  const pairs: { changed: Changed; provenance: Provenance | undefined }[] = [];
  const open = new Map<number, (typeof pairs)[number]>();
  for (const { type, payload } of events) {
    const { id } = payload as { id: number };
    if (type === "mind.changed") {
      const pair = { changed: payload as Changed, provenance: undefined };
      pairs.push(pair);
      open.set(id, pair);
    } else if (type === "mind.provenance" && open.has(id)) {
      (open.get(id) as (typeof pairs)[number]).provenance = payload as Provenance;
      open.delete(id);
    }
  }
  return pairs;
}
