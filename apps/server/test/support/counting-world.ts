import { createWorld, type Ruleset, type World } from "@open-origin/engine";

type Count = { n: number };

/**
 * A world at tick 0, 12 simulated seconds per tick, whose one system counts the ticks in the
 * global value and throws at the tick `faultAt`, which step reports as a system_fault. It has no
 * command handler, so the engine rejects every command it is given.
 */
export function countingWorld(faultAt: number): World {
  const ruleset: Ruleset<Count, Count> = {
    versions: { ruleset: "server-test@1", generator: "none@1", brain: "none@1" },
    systems: [
      {
        name: "count",
        streams: [],
        run: (ctx) => {
          const global = ctx.writeGlobal();
          global.n += 1;
          if (global.n === faultAt) throw new Error("a planted fault");
          return undefined;
        },
      },
    ],
    commands: {},
    validateGlobal: () => [],
    validateChunk: () => [],
  };
  return createWorld({
    seed: [1, 2],
    simSecondsPerTick: 12,
    global: { n: 0 },
    chunks: {},
    ruleset,
  });
}
