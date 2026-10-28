/**
 * The mind of a being of beings@2 as its chunk holds it (ADR 0024, docs/architecture/mind.md "The
 * mind of a being"): this module reads its shape, the exact members of every record by its kind,
 * integers, cells, acts, and propositions, and then asks the mind layer for the invariants a mind
 * must hold (mind.checkMind), which only a shape it could read reaches. Like the readers of a
 * being, it reads canonical values, reports every problem with its path, and never throws.
 */
import type { IssueSink } from "../canonical/value.ts";
import { IssueList } from "../errors.ts";
import { checkMind, checkProposition, type Mind } from "../mind/index.ts";
import { type Fields, range, readFields, readInt, readList } from "./schema.ts";

/** Any safe integer: this reader checks the type, and the mind layer the bounds. */
const SAFE = range(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
/** Any length: the mind layer bounds each store, and the capacity of a chunk bounds the rest. */
const ANY = range(0, Number.MAX_SAFE_INTEGER);

/** The members of a record, and the names among them that hold integers. */
type Shape = {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly ints: readonly string[];
};

const shape = (required: string[], optional: string[], ints: string[]): Shape =>
  Object.freeze({
    required: Object.freeze(required),
    optional: Object.freeze(optional),
    ints: Object.freeze(ints),
  });

/** The members of an episode, by its kind (mind/records.ts). */
const EPISODES = Object.freeze({
  food: shape(["cell", "id", "kind", "r", "t", "v", "w"], [], ["id", "r", "t", "v", "w"]),
  being: shape(
    ["cell", "id", "kind", "r", "t", "v", "w", "who"],
    [],
    ["id", "r", "t", "v", "w", "who"],
  ),
  ate: shape(["cell", "id", "kind", "r", "t", "v", "w"], [], ["id", "r", "t", "v", "w"]),
  failed: shape(["cell", "id", "kind", "r", "t", "v", "w"], [], ["id", "r", "t", "v", "w"]),
  heard: shape(
    ["act", "cell", "ex", "id", "kind", "r", "t", "tn", "w", "who"],
    ["band", "p"],
    ["band", "ex", "id", "r", "t", "tn", "w", "who"],
  ),
  external: shape(["id", "kind", "p", "r", "t", "tn", "w"], [], ["id", "r", "t", "tn", "w"]),
});
const KINDS = Object.freeze(["food", "being", "ate", "failed", "heard", "external"] as const);

const BELIEF = shape(
  ["cr", "dp", "ev", "ex", "id", "lost", "p", "src", "tn", "u"],
  ["who"],
  ["cr", "dp", "ex", "id", "lost", "src", "tn", "u", "who"],
);
const RELATIONSHIP = shape(
  ["aff", "f", "id", "seen", "talk", "tn", "tr", "turns", "who"],
  [],
  ["aff", "f", "id", "seen", "talk", "tn", "tr", "turns", "who"],
);
const MESSAGE = shape(
  ["act", "ex", "t", "tn"],
  ["band", "cell", "p", "who"],
  ["band", "ex", "t", "tn", "who"],
);
const QUOTA = shape(["day", "said", "woken"], [], ["day", "said", "woken"]);
const MIND = shape(
  ["beliefs", "episodes", "exposure", "inbox", "next", "quota", "relations"],
  [],
  ["exposure", "next"],
);

/** Reports what is not a cell: two integers. */
function checkCell(value: unknown, path: string, sink: IssueSink): void {
  readList(value, path, range(2, 2), sink)?.forEach((axis, index) => {
    readInt(axis, `${path}/${index}`, SAFE, sink);
  });
}

/** Reports every problem of a record of `shape`: its members, integers, cells, acts, and propositions. */
function checkRecord(
  value: unknown,
  path: string,
  form: Shape,
  sink: IssueSink,
): Fields | undefined {
  const fields = readFields(value, path, form, sink);
  if (fields === undefined) return undefined;
  for (const name of form.ints) fields.int(name, SAFE);
  if (fields.value("cell") !== undefined) checkCell(fields.value("cell"), fields.at("cell"), sink);
  const act = fields.value("act");
  if (act !== undefined && typeof act !== "string")
    sink.report(fields.at("act"), "the act must be a string");
  const proposition = fields.value("p");
  if (proposition !== undefined) checkProposition(proposition, fields.at("p"), sink);
  return fields;
}

/** Reports every problem of the episode at `value`, by its kind. */
function checkEpisode(value: unknown, path: string, sink: IssueSink): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    sink.report(path, `the value must be an episode, a record with a kind: ${KINDS.join(", ")}`);
    return;
  }
  // A canonical record is plain data: its kind is a data property.
  const kind: unknown = (value as { readonly kind?: unknown }).kind;
  const found = KINDS.find((candidate) => candidate === kind);
  if (found === undefined) {
    sink.report(`${path}/kind`, `the kind must be one of ${KINDS.join(", ")}`);
    return;
  }
  checkRecord(value, path, EPISODES[found], sink);
}

/** Reports every problem of a belief: a record whose citations are a list of integers. */
function checkBelief(value: unknown, path: string, sink: IssueSink): void {
  const belief = checkRecord(value, path, BELIEF, sink);
  if (belief === undefined) return;
  readList(belief.value("ev"), belief.at("ev"), ANY, sink)?.forEach((id, index) => {
    readInt(id, `${belief.at("ev")}/${index}`, SAFE, sink);
  });
}

/** Reports every problem of each entry of the list at `value`, checked by `check`. */
function checkStore(
  value: unknown,
  path: string,
  check: (entry: unknown, at: string, sink: IssueSink) => void,
  sink: IssueSink,
): void {
  readList(value, path, ANY, sink)?.forEach((entry, index) => {
    check(entry, `${path}/${index}`, sink);
  });
}

/**
 * Reports to `sink` every problem of `value` as the mind of a being, at paths from `path`: its
 * shape first; then, when the shape could be read without a problem, every invariant of the mind
 * layer. `value` is canonical, as a validator's value is.
 */
export function checkMindValue(value: unknown, path: string, sink: IssueSink): void {
  if (value === undefined) return;
  const issues = new IssueList();
  const held = checkRecord(value, path, MIND, issues);
  if (held !== undefined) {
    checkStore(held.value("episodes"), held.at("episodes"), checkEpisode, issues);
    checkStore(held.value("beliefs"), held.at("beliefs"), checkBelief, issues);
    checkStore(
      held.value("relations"),
      held.at("relations"),
      (entry, at, inner) => checkRecord(entry, at, RELATIONSHIP, inner),
      issues,
    );
    checkStore(
      held.value("inbox"),
      held.at("inbox"),
      (entry, at, inner) => checkRecord(entry, at, MESSAGE, inner),
      issues,
    );
    checkRecord(held.value("quota"), held.at("quota"), QUOTA, issues);
  }
  for (const issue of issues.issues) sink.report(issue.path, issue.message);
  // The shape is that of a Mind: every member and every record could be read.
  if (held !== undefined && issues.count === 0) checkMind(value as Mind, path, sink);
}
