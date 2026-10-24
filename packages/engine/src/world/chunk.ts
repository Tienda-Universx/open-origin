/**
 * Chunk keys (plan §4): the string "x,y", both coordinates safe integers in canonical decimal, as
 * a template literal writes them. Each coordinate pair has exactly one key and each key one pair,
 * so a key can serve as a canonical record key and a digest input.
 */
import { numberProblem } from "../canonical/value.ts";
import { describeValue, EngineError, type Issue } from "../errors.ts";

/** The position of a chunk on the world grid. */
export type ChunkCoord = { readonly x: number; readonly y: number };

/** A chunk's key: "x,y" in canonical decimal, such as "-1,0". */
export type ChunkKey = string;

/** A key read by readChunkKey: its coordinates, or every problem found, as sentences. */
type ChunkKeyReading =
  | { readonly coord: ChunkCoord; readonly problems?: undefined }
  | { readonly coord?: undefined; readonly problems: readonly string[] };

const FORM = 'the chunk key must be two integers joined by one comma, as in "-1,0"';
const notDecimal = (axis: "x" | "y"): string =>
  `the ${axis} of the chunk key is not a safe integer in canonical decimal`;

/** Why `value` is not a coordinate; undefined when it is one. */
function coordinateProblem(value: unknown): string | undefined {
  if (typeof value !== "number") return `${describeValue(value)} is not a safe integer`;
  return numberProblem(value);
}

/**
 * The key of `coord`. Throws EngineError("invalid_value") with every coordinate that is not a
 * safe integer, or that is -0, which is not canonical.
 */
export function chunkKey(coord: ChunkCoord): ChunkKey {
  if (typeof coord !== "object" || coord === null) {
    throw new EngineError("invalid_value", [
      { path: "", message: "the chunk coordinates must be a record { x, y }" },
    ]);
  }
  const { x, y } = coord;
  const issues: Issue[] = [];
  const xProblem = coordinateProblem(x);
  if (xProblem !== undefined) issues.push({ path: "/x", message: xProblem });
  const yProblem = coordinateProblem(y);
  if (yProblem !== undefined) issues.push({ path: "/y", message: yProblem });
  if (issues.length > 0) throw new EngineError("invalid_value", issues);
  return `${x},${y}`;
}

/**
 * The safe integer that `text` writes in canonical decimal, or undefined. Writing the number back
 * must give `text` again, which rejects "-0", "+1", "01", spaces, "1e3", "0x10", "1.0", and "".
 */
function canonicalInteger(text: string): number | undefined {
  const value = Number(text);
  return Number.isSafeInteger(value) && `${value}` === text ? value : undefined;
}

/** Reads `key` strictly: its coordinates, or every problem with it. Never throws. */
export function readChunkKey(key: unknown): ChunkKeyReading {
  if (typeof key !== "string") {
    return { problems: [`the chunk key must be a string, not ${typeof key}`] };
  }
  const comma = key.indexOf(",");
  if (comma < 0 || key.includes(",", comma + 1)) return { problems: [FORM] };
  const x = canonicalInteger(key.slice(0, comma));
  const y = canonicalInteger(key.slice(comma + 1));
  if (x !== undefined && y !== undefined) return { coord: { x, y } };
  const problems: string[] = [];
  if (x === undefined) problems.push(notDecimal("x"));
  if (y === undefined) problems.push(notDecimal("y"));
  return { problems };
}

/** The coordinates of `key`. Throws EngineError("invalid_value") with every problem with it. */
export function parseChunkKey(key: ChunkKey): ChunkCoord {
  const reading = readChunkKey(key);
  if (reading.coord !== undefined) return reading.coord;
  throw new EngineError(
    "invalid_value",
    reading.problems.map((message) => ({ path: "", message })),
  );
}
