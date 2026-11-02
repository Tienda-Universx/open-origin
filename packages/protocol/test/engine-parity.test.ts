import { describe, expect, test } from "bun:test";
import { beings, mind, worldgen } from "../../engine/src/index.ts";
import {
  ACTIVITY_KINDS,
  ACTS,
  CHUNK_AREA,
  CHUNK_CELLS,
  DIRECTION_COUNT,
  MAX_CELL,
  MAX_CHUNK,
  MAX_CHUNK_BEINGS,
  MIN_CELL,
  MIN_CHUNK,
  STAGES,
  SUBSTRATE_CODES,
} from "../src/public/index.ts";

/**
 * The protocol repeats the engine's bounds and vocabularies, because it imports nothing from the
 * domain (ADR 0026); this file holds each copy equal to the engine's, so that a change on either
 * side fails here first.
 */

type ClassNode = typeof beings.BEING_CLASSES;

/** The C0 activity node of a being of beings@2: one record per kind. */
function activityNode(): ClassNode {
  const activity = beings.BEING_CLASSES.members?.find((member) => member.name === "activity");
  if (activity === undefined) throw new Error("BEING_CLASSES has no activity");
  return activity.node;
}

describe("the world's bounds", () => {
  test("a chunk has the engine's cells", () => {
    expect(CHUNK_CELLS).toBe(worldgen.CHUNK_CELLS);
    expect(CHUNK_AREA).toBe(worldgen.CHUNK_CELLS * worldgen.CHUNK_CELLS);
  });

  test("chunk and cell coordinates have the engine's bounds", () => {
    expect([MIN_CHUNK, MAX_CHUNK]).toEqual([worldgen.MIN_CHUNK, worldgen.MAX_CHUNK]);
    expect([MIN_CELL, MAX_CELL]).toEqual([worldgen.MIN_CELL, worldgen.MAX_CELL]);
  });

  test("a chunk holds at most as many beings as the largest version allows", () => {
    expect(MAX_CHUNK_BEINGS).toBe(beings.CHUNK_BOUNDS.beings.max);
  });

  test("the substrate codes are every class a genesis may have, in order", () => {
    const classes = worldgen.GENESIS_BOUNDS.terrain.substrate.classes;
    expect(classes.min).toBe(1);
    const codes: readonly number[] = SUBSTRATE_CODES;
    expect([...codes]).toEqual(Array.from({ length: classes.max }, (_, code) => code));
  });
});

describe("the vocabularies of a being", () => {
  test("stages, acts, and directions are the engine's", () => {
    const [stages, acts]: readonly (readonly string[])[] = [STAGES, ACTS];
    expect(stages).toEqual([...beings.STAGES]);
    expect(acts).toEqual([...mind.ACTS]);
    expect(DIRECTION_COUNT).toBe(beings.DIRECTIONS.length);
  });

  test("the activity kinds are those of beings@2, in order", () => {
    const kinds = (activityNode().kinds ?? []).map(({ kind }) => kind);
    const ours: readonly string[] = ACTIVITY_KINDS;
    expect(ours).toEqual(kinds);
  });
});
