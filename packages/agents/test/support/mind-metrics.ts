import {
  beings,
  canonicalize,
  type EngineEvent,
  readView,
  type StepResult,
} from "@open-origin/engine";
import { CONTRADICTED_CR, RULE_IDS } from "../../src/brain/mind/parameters.ts";
import type { CitedEpisode } from "../../src/brain/mind/rules.ts";
import { type Created, ruleProblems } from "./mind-rules-check.ts";
import type { Senses2 } from "./mind-senses.ts";
import type { ScenarioWorld } from "./scenario.ts";

/**
 * What `mind@1` did over a run of the T5 scenario, against the items of mind.md ("Evaluation")
 * and the targets of calibration: read from the events of every tick, from the intentions its
 * decisions returned, which apply only when the tick's ledger shows them, and from the state.
 * The observer reads the world after each step and never changes what happens.
 */

/** What one being's mind did over a run. */
export type MindTally = {
  readonly id: number;
  foodEpisodes: number;
  beingEpisodes: number;
  /** Beliefs formed by seen-food, from its own observations. */
  seenBeliefs: number;
  /** Beliefs formed by told-food, from testimony. */
  toldBeliefs: number;
  /** Revisions down after seeing a belief contradicted. */
  revisedDown: number;
  /** Changes of trust by a testimony checked. */
  trustChecks: number;
  greeted: number;
  wasGreeted: number;
  /** Acts started, and the ticks spent asleep. */
  acts: number;
  /** Decisions to walk to food it believes in, and toward a being to greet it. */
  seeks: number;
  approaches: number;
  sleptTicks: number;
  /** The tick its current sleep started, while it sleeps. */
  asleepSince: number | undefined;
  relationsAtEnd: number;
  beliefsAtEnd: readonly string[];
};

/** What the minds of a run did. */
export type MindRun = {
  readonly tallies: ReadonlyMap<number, MindTally>;
  /** Conversations: delivered acts of a pair, both ways, each within `speech.gap` of the last. */
  conversations: number;
  /** Records of the ledger whose lineage holds model-prior-suspect. */
  priorSuspect: number;
  /** Belief operations that were not their rule applied to what they cite. */
  readonly ruleProblems: string[];
  decisions: number;
};

/** A decision of the brain: whose, what it sensed, and what it proposed. */
type Decision = { readonly senses: Senses2; readonly intention: beings.Intention2 };

/** A conversation of one pair under way: its last delivery, and the directions it had. */
type Talking = { last: number; forth: boolean; back: boolean };

/**
 * The observer of a run of `mind@1`: its brain wraps the brain of the scenario, which a world needs
 * before the observer can read it, and `start` then gives it the world and the ids of its beings.
 */
export class MindObserver {
  #world: ScenarioWorld | undefined;
  #gapTicks = 0;
  readonly #pending: Decision[] = [];
  readonly #pairs = new Map<string, Talking>();
  readonly run: MindRun = {
    tallies: new Map(),
    conversations: 0,
    priorSuspect: 0,
    ruleProblems: [],
    decisions: 0,
  };

  /** Starts observing `world`, whose beings have the ids `ids`. */
  start(world: ScenarioWorld, ids: readonly number[]): void {
    this.#world = world;
    const view = readView(world);
    const species = view.readGlobal().life.species[0] as beings.Species2;
    this.#gapTicks = Math.floor(species.speech.gap / view.simSecondsPerTick);
    const tallies = this.run.tallies as Map<number, MindTally>;
    for (const id of ids) tallies.set(id, newTally(id));
  }

  /** The world it observes. */
  get #observed(): ScenarioWorld {
    if (this.#world === undefined) throw new Error("the observer has not started");
    return this.#world;
  }

  /** `inner`, which records each decision for the observer and decides unchanged. */
  controller(inner: beings.Controller2): beings.Controller2 {
    const pending = this.#pending;
    return {
      ...inner,
      decide: (senses) => {
        const intention = inner.decide(senses);
        pending.push({ senses, intention });
        return intention;
      },
    };
  }

  /**
   * Reads what the step `result` did; `minds` gives the beings after it, read from the world
   * unless the caller already holds them.
   */
  observe(
    result: StepResult,
    minds: () => ReadonlyMap<number, beings.Being2> = () => mindsOf(this.#observed),
  ): void {
    const { tick, events } = result;
    this.run.decisions += this.#pending.length;
    const changed = new Set(
      events.filter(({ type }) => type === "mind.changed").map(({ payload }) => idOf(payload)),
    );
    const after = changed.size > 0 ? minds() : new Map<number, beings.Being2>();
    for (const decision of this.#pending.splice(0)) {
      const id = decision.senses.self.id;
      this.#walked(decision);
      if (decision.intention.mind !== undefined && changed.has(id))
        this.#applied(decision, after.get(id));
    }
    this.#speech(tick, events);
    for (const event of events) this.#event(tick, event);
  }

  /** Counts a decision to seek food or approach a being, whether or not its tick kept it. */
  #walked({ senses, intention }: Decision): void {
    const tally = this.run.tallies.get(senses.self.id);
    if (tally === undefined) return;
    if (intention.behavior.kind === "seek") tally.seeks += 1;
    if (intention.behavior.kind === "approach") tally.approaches += 1;
  }

  /** Tallies a decision whose operations the tick applied, and checks them against their rules. */
  #applied(decision: Decision, being: beings.Being2 | undefined): void {
    const { senses, intention } = decision;
    const tally = this.run.tallies.get(senses.self.id);
    if (tally !== undefined) tallyOps(tally, intention.mind ?? {});
    const created = createdBy(senses, being);
    for (const problem of ruleProblems(senses, intention, created))
      this.run.ruleProblems.push(`being ${senses.self.id}: ${problem}`);
  }

  /** Greetings and conversations, from the acts delivered at `tick`. */
  #speech(tick: number, events: readonly EngineEvent[]): void {
    const acts = new Map<string, string>();
    for (const { type, payload } of events) {
      const { id, to, act } = payload as { id: number; to: number; act?: string };
      if (type === "speech.uttered") acts.set(`${id}>${to}`, act ?? "");
      if (type !== "speech.delivered") continue;
      if (acts.get(`${id}>${to}`) === "greet") {
        const speaker = this.run.tallies.get(id);
        const hearer = this.run.tallies.get(to);
        if (speaker !== undefined) speaker.greeted += 1;
        if (hearer !== undefined) hearer.wasGreeted += 1;
      }
      this.#delivered(tick, id, to);
    }
  }

  /** A delivered act of `from` to `to` at `tick`, in the conversation of their pair. */
  #delivered(tick: number, from: number, to: number): void {
    const key = from < to ? `${from},${to}` : `${to},${from}`;
    const forth = from < to;
    const talking = this.#pairs.get(key);
    if (talking === undefined || tick - talking.last > this.#gapTicks) {
      if (talking !== undefined) this.#closed(talking);
      this.#pairs.set(key, { last: tick, forth, back: !forth });
      return;
    }
    talking.last = tick;
    if (forth) talking.forth = true;
    else talking.back = true;
  }

  /** Counts a conversation that ended, when it went both ways. */
  #closed(talking: Talking): void {
    if (talking.forth && talking.back) this.run.conversations += 1;
  }

  /** Acts, sleeps, and the lineage of the ledger, from one event. */
  #event(tick: number, event: EngineEvent): void {
    const payload = event.payload as { id: number; activity?: string; records?: unknown[] };
    if (event.type === "mind.provenance") {
      const suspect = (record: unknown) => ((record as { tn: number }).tn & 1) !== 0;
      this.run.priorSuspect += (payload.records ?? []).filter(suspect).length;
    }
    const tally = this.run.tallies.get(payload.id);
    if (tally !== undefined) tallyActivity(tally, tick, event.type, payload.activity);
  }

  /** Closes the run at its last tick, `tick`: open conversations, sleeps, and the minds at the end. */
  finish(tick: number): MindRun {
    for (const talking of this.#pairs.values()) this.#closed(talking);
    this.#pairs.clear();
    for (const tally of this.run.tallies.values()) {
      if (tally.asleepSince !== undefined) tally.sleptTicks += tick - tally.asleepSince;
      tally.asleepSince = undefined;
    }
    for (const [id, being] of mindsOf(this.#observed)) {
      const tally = this.run.tallies.get(id);
      if (tally === undefined) continue;
      tally.relationsAtEnd = being.mind.relations.length;
      tally.beliefsAtEnd = being.mind.beliefs.map(({ p }) => canonicalize(p)).sort();
    }
    return this.run;
  }
}

/** Counts in `tally` what the applied operations `ops` encoded, formed, revised, and related. */
function tallyOps(tally: MindTally, ops: beings.MindIntention): void {
  const count = <T>(list: readonly T[] | undefined, holds: (item: T) => boolean) =>
    (list ?? []).filter(holds).length;
  tally.foodEpisodes += count(ops.remember, ({ percept }) => "food" in percept);
  tally.beingEpisodes += count(ops.remember, ({ percept }) => "being" in percept);
  tally.seenBeliefs += count(ops.believe, ({ rule }) => rule === RULE_IDS.seen);
  tally.toldBeliefs += count(ops.believe, ({ rule }) => rule === RULE_IDS.told);
  // A revision down after a contradiction: mind@1 revises to CONTRADICTED_CR only then.
  tally.revisedDown += count(ops.revise, ({ cr }) => cr === CONTRADICTED_CR);
  tally.trustChecks += count(ops.relate, ({ tr }) => (tr ?? 0) !== 0);
}

/** Counts in `tally` an act started, or a sleep started or ended, at `tick`. */
function tallyActivity(tally: MindTally, tick: number, type: string, activity?: string): void {
  if (type === "being.started" && activity === "talk") tally.acts += 1;
  if (type === "being.started" && activity === "sleep") tally.asleepSince = tick;
  if (type !== "being.finished" || activity !== "sleep") return;
  tally.sleptTicks += tick - (tally.asleepSince ?? tick);
  tally.asleepSince = undefined;
}

/** The id of an event's being. */
const idOf = (payload: unknown) => (payload as { id: number }).id;

/** A tally of nothing yet. */
function newTally(id: number): MindTally {
  return {
    id,
    foodEpisodes: 0,
    beingEpisodes: 0,
    seenBeliefs: 0,
    toldBeliefs: 0,
    revisedDown: 0,
    trustChecks: 0,
    greeted: 0,
    wasGreeted: 0,
    acts: 0,
    seeks: 0,
    approaches: 0,
    sleptTicks: 0,
    asleepSince: undefined,
    relationsAtEnd: 0,
    beliefsAtEnd: [],
  };
}

/** Every being of `world` after its last step, by id. */
function mindsOf(world: ScenarioWorld): Map<number, beings.Being2> {
  const view = readView(world);
  const found = new Map<number, beings.Being2>();
  for (const key of view.readGlobal().occupancy)
    for (const being of view.readChunk(key)?.beings ?? [])
      found.set(being.id, being as beings.Being2);
  return found;
}

/** The episodes the decision of `senses` created, as `being` holds them after the tick. */
function createdBy(senses: Senses2, being: beings.Being2 | undefined): Created {
  const created = new Map<number, CitedEpisode>();
  for (const episode of being?.mind.episodes ?? [])
    if (episode.id >= senses.mind.next) created.set(episode.id, episode);
  return created;
}

/**
 * The share of its awake time a being spent talking, in permille, over `ticks` ticks: each act it
 * started lasts `actTicks` ticks, until the tick it ends, and it was awake whenever it did not sleep.
 */
export function talkingShare(tally: MindTally, ticks: number, actTicks: number): number {
  const awake = ticks - tally.sleptTicks;
  return awake <= 0 ? 0 : Math.floor((tally.acts * actTicks * 1000) / awake);
}

/** Whether the sets of believed propositions of any two beings differ at the end. */
export function diverse(run: MindRun): boolean {
  const sets = [...run.tallies.values()].map(({ beliefsAtEnd }) => beliefsAtEnd.join("|"));
  return new Set(sets).size === sets.length;
}

/** The items of mind.md a being's tally misses, by name; empty when it meets them all. */
export function mindMisses(tally: MindTally): string[] {
  const items: [string, boolean][] = [
    ["food episode", tally.foodEpisodes < 1],
    ["being episode", tally.beingEpisodes < 1],
    ["3 beliefs seen", tally.seenBeliefs < 3],
    ["relationship at end", tally.relationsAtEnd < 1],
    ["greeted", tally.greeted < 1],
    ["was greeted", tally.wasGreeted < 1],
  ];
  return items.filter(([, missed]) => missed).map(([name]) => name);
}

/** The step function the scenario runner calls: `observer` reads each step. */
export function observing(observer: MindObserver): (result: StepResult) => void {
  return (result) => observer.observe(result);
}

/** The ticks of one act of speech in a world of `sps` seconds per tick, by the law `actMs`. */
export function actTicks(actMs: number, sps: number): number {
  return beings.ceilDiv(actMs, sps * 1000);
}
