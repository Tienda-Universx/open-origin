/**
 * The invariants of a mind (ADR 0024), which a chunk of beings@2 must hold and its validator checks
 * without seeing the laws: every value within MIND_BOUNDS; every record's id below `next`, unique
 * across the three stores, each store in increasing id; one relationship per being; every citation
 * live, at most three and each once, and a belief citing only beliefs of a lower id; each belief's
 * depth one more than that of the deepest belief it cites; and each belief's taints containing
 * those of every record it cites, so that not even a crafted snapshot holds an unclosed taint. A
 * mind the engine wrote always holds them.
 */
import type { IssueSink } from "../canonical/value.ts";
import { greatest } from "../int.ts";
import { type IntRange, MIND_BOUNDS, within } from "./bounds.ts";
import {
  ACTS,
  type Belief,
  type Cell,
  type Episode,
  type InboxMessage,
  type LocalId,
  type Mind,
  type MindRecord,
  type Relationship,
  recordOf,
} from "./records.ts";
import { citedTaints, coversTaints } from "./taints.ts";

const B = MIND_BOUNDS;

/** The bounds of an episode's value, by its kind. */
const VALUES = Object.freeze({ food: B.band, being: B.value, ate: B.value, failed: B.failure });

/** Reports `value` at `path` unless it is a safe integer within `bounds`. */
function checkInt(value: number, bounds: IntRange, path: string, sink: IssueSink): void {
  if (Number.isSafeInteger(value) && within(value, bounds)) return;
  sink.report(path, `must be an integer from ${bounds.min} to ${bounds.max}`);
}

/** checkInt for an optional member, which may be absent. */
function checkOptional(
  value: number | undefined,
  bounds: IntRange,
  path: string,
  sink: IssueSink,
): void {
  if (value !== undefined) checkInt(value, bounds, path, sink);
}

function checkCell(cell: Cell, path: string, sink: IssueSink): void {
  checkInt(cell[0], B.cell, `${path}/0`, sink);
  checkInt(cell[1], B.cell, `${path}/1`, sink);
}

function checkAct(act: string, path: string, sink: IssueSink): void {
  if (!(ACTS as readonly string[]).includes(act))
    sink.report(path, `the act is one of ${ACTS.join(", ")}`);
}

/** Reports a store holding more records than any law allows. */
function checkSize(
  records: readonly unknown[],
  bounds: IntRange,
  path: string,
  sink: IssueSink,
): void {
  if (records.length <= bounds.max) return;
  sink.report(path, `a store holds at most ${bounds.max} records, not ${records.length}`);
}

type Located = { readonly id: LocalId; readonly store: MindRecord["store"]; readonly at: string };

/** Every record of `mind`, with its store and its path, in the order of the stores. */
function recordsOf(mind: Mind, path: string): Located[] {
  const located = (store: MindRecord["store"], records: readonly { readonly id: LocalId }[]) =>
    records.map((record, index) => ({ id: record.id, store, at: `${path}/${store}/${index}` }));
  return [
    ...located("episodes", mind.episodes),
    ...located("beliefs", mind.beliefs),
    ...located("relations", mind.relations),
  ];
}

/** Reports ids that are not below `next`, a store out of increasing id, and an id held twice. */
function checkIds(mind: Mind, path: string, sink: IssueSink): void {
  const ids = { min: 1, max: mind.next - 1 };
  const records = recordsOf(mind, path);
  records.forEach(({ id, store, at }, index) => {
    checkInt(id, ids, `${at}/id`, sink);
    const before = records[index - 1];
    if (before !== undefined && before.store === store && before.id >= id) {
      sink.report(
        `${at}/id`,
        `${id} must be above ${before.id}: a store keeps its records in increasing id`,
      );
    } else if (records.findIndex((other) => other.id === id) < index) {
      sink.report(`${at}/id`, `${id} is the id of another record: local ids are unique in a mind`);
    }
  });
}

function checkEpisode(episode: Episode, path: string, sink: IssueSink): void {
  checkInt(episode.t, B.tick, `${path}/t`, sink);
  checkInt(episode.w, B.permille, `${path}/w`, sink);
  checkInt(episode.r, B.tick, `${path}/r`, sink);
  if (episode.kind === "external") {
    checkInt(episode.tn, B.taints, `${path}/tn`, sink);
    return;
  }
  checkCell(episode.cell, `${path}/cell`, sink);
  if (episode.kind !== "heard") {
    checkInt(episode.v, VALUES[episode.kind], `${path}/v`, sink);
    if (episode.kind === "being") checkInt(episode.who, B.entity, `${path}/who`, sink);
    return;
  }
  checkInt(episode.who, B.entity, `${path}/who`, sink);
  checkAct(episode.act, `${path}/act`, sink);
  checkOptional(episode.band, B.band, `${path}/band`, sink);
  checkInt(episode.tn, B.taints, `${path}/tn`, sink);
  checkInt(episode.ex, B.taints, `${path}/ex`, sink);
}

/** The records `belief` cites that `mind` holds, after reporting each citation it does not. */
function citedBy(belief: Belief, mind: Mind, path: string, sink: IssueSink): MindRecord[] {
  if (belief.ev.length > B.citations.max) {
    sink.report(`${path}/ev`, `a belief cites at most ${B.citations.max} records`);
  }
  const cited: MindRecord[] = [];
  belief.ev.forEach((id, index) => {
    const at = `${path}/ev/${index}`;
    const record = recordOf(mind, id);
    if (belief.ev.indexOf(id) !== index) sink.report(at, `${id} is cited twice`);
    else if (record === undefined) sink.report(at, `${id} is not a record the mind holds`);
    else if (record.store === "beliefs" && id >= belief.id) {
      sink.report(
        at,
        `belief ${belief.id} cites belief ${id}: a belief cites only beliefs of a lower id`,
      );
    } else cited.push(record);
  });
  return cited;
}

/** Reports a depth or taints that do not follow from what `belief` cites. */
function checkSupport(
  belief: Belief,
  cited: readonly MindRecord[],
  path: string,
  sink: IssueSink,
): void {
  let deepest = 0;
  for (const { store, record } of cited) {
    if (store === "beliefs") deepest = greatest(deepest, record.dp);
  }
  if (belief.dp !== deepest + 1) {
    sink.report(
      `${path}/dp`,
      `the depth must be ${deepest + 1}: one more than its deepest cited belief's`,
    );
  }
  const union = citedTaints(cited);
  if (!coversTaints(belief, union)) {
    sink.report(
      path,
      `the taints tn ${belief.tn} and ex ${belief.ex} must contain those of what it cites, tn ${union.tn} and ex ${union.ex}`,
    );
  }
}

function checkBelief(belief: Belief, mind: Mind, path: string, sink: IssueSink): void {
  checkInt(belief.cr, B.permille, `${path}/cr`, sink);
  checkInt(belief.src, B.evidence, `${path}/src`, sink);
  checkOptional(belief.who, B.entity, `${path}/who`, sink);
  checkInt(belief.lost, B.lost, `${path}/lost`, sink);
  checkInt(belief.tn, B.taints, `${path}/tn`, sink);
  checkInt(belief.ex, B.taints, `${path}/ex`, sink);
  checkInt(belief.dp, B.depth, `${path}/dp`, sink);
  checkInt(belief.u, B.tick, `${path}/u`, sink);
  checkSupport(belief, citedBy(belief, mind, path, sink), path, sink);
}

function checkRelationship(
  relationship: Relationship,
  others: readonly Relationship[],
  path: string,
  sink: IssueSink,
): void {
  checkInt(relationship.who, B.entity, `${path}/who`, sink);
  checkInt(relationship.f, B.familiarity, `${path}/f`, sink);
  checkInt(relationship.seen, B.tick, `${path}/seen`, sink);
  checkInt(relationship.aff, B.affinity, `${path}/aff`, sink);
  checkInt(relationship.tr, B.permille, `${path}/tr`, sink);
  checkInt(relationship.tn, B.taints, `${path}/tn`, sink);
  checkInt(relationship.talk, B.tick, `${path}/talk`, sink);
  checkInt(relationship.turns, B.turns, `${path}/turns`, sink);
  if (others.some((other) => other.who === relationship.who)) {
    sink.report(`${path}/who`, `the mind already holds a relationship with ${relationship.who}`);
  }
}

function checkMessage(message: InboxMessage, path: string, sink: IssueSink): void {
  checkOptional(message.who, B.entity, `${path}/who`, sink);
  checkInt(message.t, B.tick, `${path}/t`, sink);
  if (message.cell !== undefined) checkCell(message.cell, `${path}/cell`, sink);
  checkAct(message.act, `${path}/act`, sink);
  checkOptional(message.band, B.band, `${path}/band`, sink);
  checkInt(message.tn, B.taints, `${path}/tn`, sink);
  checkInt(message.ex, B.taints, `${path}/ex`, sink);
}

/** Reports the bounds of the members that are not records. */
function checkScalars(mind: Mind, path: string, sink: IssueSink): void {
  checkInt(mind.next, B.next, `${path}/next`, sink);
  checkInt(mind.exposure, B.taints, `${path}/exposure`, sink);
  checkInt(mind.quota.day, B.tick, `${path}/quota/day`, sink);
  checkInt(mind.quota.said, B.daily, `${path}/quota/said`, sink);
  checkInt(mind.quota.woken, B.daily, `${path}/quota/woken`, sink);
  checkSize(mind.episodes, B.episodes, `${path}/episodes`, sink);
  checkSize(mind.beliefs, B.beliefs, `${path}/beliefs`, sink);
  checkSize(mind.relations, B.relations, `${path}/relations`, sink);
  checkSize(mind.inbox, B.inbox, `${path}/inbox`, sink);
}

/**
 * Reports to `sink` every invariant `mind` breaks, at paths from `path`. `mind` has the shape of
 * Mind, as the beings layer read it; its propositions are that reader's to check, with
 * checkProposition.
 */
export function checkMind(mind: Mind, path: string, sink: IssueSink): void {
  checkScalars(mind, path, sink);
  checkIds(mind, path, sink);
  mind.episodes.forEach((episode, index) => {
    checkEpisode(episode, `${path}/episodes/${index}`, sink);
  });
  mind.beliefs.forEach((belief, index) => {
    checkBelief(belief, mind, `${path}/beliefs/${index}`, sink);
  });
  mind.relations.forEach((relationship, index) => {
    const before = mind.relations.slice(0, index);
    checkRelationship(relationship, before, `${path}/relations/${index}`, sink);
  });
  mind.inbox.forEach((message, index) => {
    checkMessage(message, `${path}/inbox/${index}`, sink);
  });
}
