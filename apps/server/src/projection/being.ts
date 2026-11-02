/**
 * The public record of a being (ADR 0026, "Projections and classification"): BeingPublic, built
 * field by field from the members BEING_CLASSES classifies C0, never by serializing the being. It
 * reads a being of beings@1 or beings@2 alike, as a detached read of the world holds it.
 */
import type { beings, DeepReadonly } from "@open-origin/engine";
import { BeingPublic } from "@open-origin/protocol/public";

/**
 * Where a field of BeingPublic comes from: the path of a member of BEING_CLASSES, by member names,
 * where a segment names a kind when the registry branches by `kind`, and a member that every kind
 * holds is named directly; and, for a field derived from what the path holds, how.
 */
export type FieldSource = {
  readonly path: readonly string[];
  readonly derived?: string;
};

/** Every field of BeingPublic, by its dotted name, and the C0 member of the registry it reads. */
export const BEING_PUBLIC_SOURCES: Readonly<Record<string, FieldSource>> = Object.freeze({
  id: { path: ["id"] },
  species: { path: ["species"] },
  stage: { path: ["stage"] },
  born: { path: ["born"] },
  cell: { path: ["cell"] },
  "activity.kind": { path: ["activity", "kind"] },
  "activity.to": { path: ["activity", "talk", "to"] },
  "activity.act": { path: ["activity", "talk", "act"] },
  "activity.dir": {
    path: ["activity", "walk"],
    derived: "the direction of the walk's current step: the digit of `dirs` at `done`",
  },
});

/** The code of the digit 0: a walk's `dirs` holds each step's direction as one digit. */
const DIGIT_ZERO = 48;

type Activity = DeepReadonly<beings.Activity>;

/** What an observer sees of `activity`: its kind, a talk's hearer and act, a walk's direction. */
function activityOf(activity: Activity) {
  switch (activity.kind) {
    case "talk":
      return { kind: activity.kind, to: activity.to, act: activity.act };
    case "walk":
      // A stored walk is always on a step: `done` stays below the number of its directions.
      return { kind: activity.kind, dir: activity.dirs.charCodeAt(activity.done) - DIGIT_ZERO };
    default:
      return { kind: activity.kind };
  }
}

/**
 * The public record of `being`, unchecked: exactly the fields of BEING_PUBLIC_SOURCES, in the
 * schema's order, so that two records of the same C0 content encode to the same bytes.
 */
export function publicRecordOf(being: DeepReadonly<beings.Being>): unknown {
  const { id, species, stage, born, cell, activity } = being;
  return { id, species, stage, born, cell: [cell[0], cell[1]], activity: activityOf(activity) };
}

/**
 * `record`, the public record of the being `id`, checked by the protocol's schema. Throws when it
 * is not a valid BeingPublic, naming the being and the fields at fault, never their values.
 */
export function checkedRecord(id: number, record: unknown): BeingPublic {
  const parsed = BeingPublic.safeParse(record);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.map(({ path, code }) => `${path.join(".")} (${code})`);
  throw new Error(`the being ${id} has no valid public record: ${fields.join(", ")}`);
}
