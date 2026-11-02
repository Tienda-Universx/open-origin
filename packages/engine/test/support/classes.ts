/**
 * Walks of the classification registry (ADR 0008, ADR 0024, ADR 0026) over values the engine holds:
 * the paths a node does not classify, and those it classifies C3. Lists follow `each`, records of
 * several kinds their `kind`, and a leaf classified C3 covers everything it holds, as the registry
 * states: nothing below it is ever copied.
 */
import type { beings } from "../../src/index.ts";

type ClassNode = beings.ClassNode;

/** The node of the member `name` of the record node `node`, if it names one. */
export function memberOf(node: ClassNode, name: string): ClassNode | undefined {
  return node.members?.find((member) => member.name === name)?.node;
}

/** A value below another that a node classifies, with its node, if any names it, and its path. */
type Visit = {
  readonly node: ClassNode | undefined;
  readonly value: unknown;
  readonly path: string;
};

/** Whether `node` is a leaf: it has only its class. */
function isLeaf(node: ClassNode): boolean {
  return node.members === undefined && node.each === undefined && node.kinds === undefined;
}

/** The members or entries of `value` at `path`, each with the node `node` gives it, if any. */
function inside(node: ClassNode, value: unknown, path: string): Visit[] {
  if (isLeaf(node) && node.class === "C3") return [];
  if (node.kinds === undefined) return entriesOf(node, value, path);
  const kind = (value as { kind: string }).kind;
  const of = node.kinds.find((entry) => entry.kind === kind)?.node;
  return of === undefined
    ? [{ node: undefined, value, path: `${path}/kind` }]
    : inside(of, value, path);
}

/** The entries of the list `value`, or the members of the record `value`, under `node`. */
function entriesOf(node: ClassNode, value: unknown, path: string): Visit[] {
  const each = node.each;
  if (each !== undefined && Array.isArray(value))
    return value.map((entry, index) => ({ node: each, value: entry, path: `${path}/${index}` }));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value).map(([name, member]) => ({
    node: memberOf(node, name),
    value: member,
    path: `${path}/${name}`,
  }));
}

/**
 * The paths of every member of `value`, at any depth, that `node` does not classify: the registry
 * must name each one.
 */
export function unclassified(node: ClassNode, value: unknown, path = ""): string[] {
  return inside(node, value, path).flatMap((visit) =>
    visit.node === undefined ? [visit.path] : unclassified(visit.node, visit.value, visit.path),
  );
}

/** Every path below `value` whose class in `node` is C3. */
export function secretPaths(node: ClassNode, value: unknown, path = ""): string[] {
  return inside(node, value, path).flatMap(({ node: inner, value: member, path: at }) => {
    if (inner === undefined) return [];
    return [...(inner.class === "C3" ? [at] : []), ...secretPaths(inner, member, at)];
  });
}
