import type { CanonicalValue, Command } from "../../src/index.ts";
import type { Sfc32 } from "./sfc32.ts";

/**
 * Random valid command lists for tally (plan §8 "Fuzz de comandos"), drawn from sfc32: the
 * command fuzz and the snapshot round trip share them, so both drive the same commands.
 */

/** Keys that exist, keys that do not, and text that is no chunk key. */
const KEYS = ["0,0", "1,0", "-1,0", "0,1", "9,9", "0,-0", "x"];
const TYPES = ["plant", "plant", "name", "birth", "lottery", "unknown.command"];
const NAMES = ["", "Ana", `Zo${String.fromCharCode(0xeb)}`, String.fromCodePoint(0x1f98a)];

function randomPayload(random: Sfc32, type: string): CanonicalValue {
  switch (type) {
    case "plant":
      return { at: random.pick(KEYS), amount: random.between(-5, 150) };
    case "name":
      return {
        entity: random.below(8) === 0 ? "one" : random.between(1, 20),
        name: random.pick(NAMES),
      };
    default:
      return random.below(2) === 0 ? {} : [random.next()];
  }
}

/** A valid list of 0 to 3 commands for `tick`. */
export function validCommands(random: Sfc32, tick: number): Command[] {
  const commands: Command[] = [];
  let seq = random.below(3);
  for (let count = random.below(4); count > 0; count -= 1) {
    const type = random.pick(TYPES);
    const origin =
      random.below(2) === 0
        ? ({ kind: "admin" } as const)
        : ({ kind: "inhabitant", actor: random.between(1, 30) } as const);
    commands.push({ applyTick: tick, seq, type, origin, payload: randomPayload(random, type) });
    seq += 1 + random.below(3);
  }
  return commands;
}
