import type { World } from "../../src/index.ts";
import { step } from "../../src/index.ts";
import { type Data, stepRuleset, stepWorld, system, writable } from "./step-rulesets.ts";

/** Where a trapped world keeps its Proxy: chunk 0,0, the global value, or both. */
export type TrapPlace = "chunk" | "global";

/** What a Proxy's trap runs on each read of a property, and how many reads ran it. */
export type Hook = { run: (() => void) | undefined; reads: number };

/** A Proxy of `{ a: 1 }` whose traps count each read and run `hook.run`, then answer as data. */
function trapping(hook: Hook): Data {
  return new Proxy<Data>(
    { a: 1 },
    {
      getOwnPropertyDescriptor(target, key) {
        hook.reads += 1;
        hook.run?.();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        hook.reads += 1;
        return Reflect.ownKeys(target);
      },
    },
  );
}

/**
 * A world that holds, from tick 1, a Proxy at `inner` of each place in `places`, written through
 * the barrier, so that its traps run whenever the engine reads that value: ruleset code can create
 * one, and JavaScript cannot tell it from its target (docs/architecture/determinism.md, "What is
 * detected, and when"). The hook starts unset; set `hook.run` to make every read call it.
 */
export function trappedWorld(places: readonly TrapPlace[] = ["chunk"]): {
  readonly world: World;
  readonly hook: Hook;
} {
  const hook: Hook = { run: undefined, reads: 0 };
  const world = stepWorld(
    stepRuleset([
      system("trapper", (ctx) => {
        if (ctx.tick !== 1) return;
        if (places.includes("chunk")) writable(ctx, "0,0").inner = trapping(hook);
        if (places.includes("global")) (ctx.writeGlobal() as Data).inner = trapping(hook);
      }),
    ]),
  );
  step(world, []);
  return { world, hook };
}
