import type { beings, CanonicalValue, World } from "@open-origin/engine";
import { behavior } from "../../../../packages/engine/test/support/beings-world.ts";
import {
  being2,
  beings2World,
  brain2,
  chunksOf,
  SPECIES2,
} from "../../../../packages/engine/test/support/beings2-world.ts";
import {
  belief,
  external,
  heard,
  mindOf,
  own,
  relationship,
} from "../../../../packages/engine/test/support/mind-records.ts";
import type { CommandIntent } from "../../src/world/source.ts";

/**
 * The canary world of the projection's tests (ADR 0026): two beings of beings@2 on the test
 * genesis. The walker, being 1, steps east and west across the border of the chunks (2, −1) and
 * (3, −1), so its record changes at every arrival and it crosses chunks. The sitter, being 2, idles
 * in the chunk (2, −1) and holds canaries: distinctive traits (C1), a mind whose records name
 * distinctive concepts and numbers and carry taints (C1, C3), and, at INJECTION_TICK, a research
 * injection of one more (C3). Neither ever speaks, so no canary can reach a client legitimately.
 */

/** The walker and the sitter. */
export const WALKER = 1;
export const SITTER = 2;

/** The walker's two cells, west and east of the border, and the sitter's cell. */
export const WEST: readonly [number, number] = [95, -30];
export const EAST: readonly [number, number] = [96, -30];
export const SITTER_CELL: readonly [number, number] = [90, -30];

/** The tick of the injection into the sitter. */
export const INJECTION_TICK = 3;

/** The sitter's traits: distinctive values, each a canary of class C1. */
export const CANARY_TRAITS: beings.Traits2 = Object.freeze({
  appetite: 1187,
  sleepiness: 1163,
  curiosity: 1151,
  sociability: 1129,
  credulity: 1117,
  retention: 1103,
});

/** Concepts and numbers that only the sitter's mind and the injection hold. */
export const CANARY_TEXTS = Object.freeze(["t1.zqheard", "t1.zqbelief", "t1.zqinjected"]);
export const CANARY_NUMBERS = Object.freeze([424_242, 434_343, 454_545, 464_646]);

/** The sitter's mind: an own episode, a tainted message, a research injection, a belief, a bond. */
function sitterMind() {
  const term = (n: number) => [{ n }] as [{ n: number }];
  return mindOf({
    episodes: [
      own(1, { cell: [SITTER_CELL[0], SITTER_CELL[1]], v: 2 }),
      heard(2, WALKER, { tn: 2, ex: 4, p: { p: "t1.zqheard", a: term(424_242) } }),
      external(3, { tn: 2, p: { p: "t1.zqinjected", a: term(434_343) } }),
    ],
    beliefs: [
      belief(4, { ev: [1, 2], tn: 2, ex: 4, src: 3, p: { p: "t1.zqbelief", a: term(454_545) } }),
    ],
    relations: [relationship(5, WALKER, { tn: 1, talk: 5, turns: 2 })],
  });
}

/** The walker steps across the border and back, one step per decision; the sitter idles. */
const crossing = brain2((senses) => {
  if (senses.self.id !== WALKER) {
    return { steps: [{ kind: "idle", ms: 30_000 }], wakeWhen: {}, behavior: behavior("rest") };
  }
  const dirs = senses.self.cell[0] === WEST[0] ? "0" : "4";
  return { steps: [{ kind: "walk", dirs }], wakeWhen: {}, behavior: behavior("roam") };
});

/** The canary world at tick 0, with distinctive seeds. */
export function canaryWorld(): World {
  const chunks = chunksOf([
    being2(WALKER, WEST),
    being2(SITTER, SITTER_CELL, { traits: CANARY_TRAITS, mind: sitterMind() }),
  ]);
  return beings2World({
    controllers: { [SPECIES2.id]: crossing },
    seed: [0x5eed_c0de, 0x0dd_ba11],
    chunks: chunks as unknown as { readonly [key: string]: CanonicalValue },
  });
}

/** The research injection into the sitter at INJECTION_TICK, with one more canary, as C3 taints. */
export const INJECTION: CommandIntent = {
  type: "mind.inject",
  origin: { kind: "admin" },
  payload: {
    being: SITTER,
    cell: [SITTER_CELL[0], SITTER_CELL[1]],
    p: { p: "t1.zqinjected", a: [{ n: 464_646 }] },
    taints: 4,
  },
};

/** The canary world's script: the injection at its tick, nothing else. */
export function canaryScript(): CommandIntent[][] {
  return Array.from({ length: INJECTION_TICK }, (_, index) =>
    index + 1 === INJECTION_TICK ? [INJECTION] : [],
  );
}
