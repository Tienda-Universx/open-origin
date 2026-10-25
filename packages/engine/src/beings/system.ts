/**
 * The beings system (ADR 0023): one run per tick, in three phases. It collects the beings due at the
 * tick from the chunks of the occupancy index, advances each in order of id (decisions included),
 * resolves the contests over food, and writes what changed. Its work grows with occupied chunks,
 * beings due, decisions, and changed bytes, never with the size of the world.
 */
import type { TickContext } from "../world/contracts.ts";
import { advance } from "./advance.ts";
import type { BeingsChunk } from "./chunk.ts";
import { type BeingsGlobal, type Controllers, envOf } from "./env.ts";
import { applyWorks, collectDue, resolveClaims } from "./resolve.ts";

/** One tick of the beings of the world behind `ctx`, with the ruleset's brains. */
export function runBeings(
  ctx: TickContext<BeingsGlobal, BeingsChunk>,
  controllers: Controllers,
): void {
  const env = envOf(ctx, controllers);
  const works = collectDue(env).map(({ key, being }) => advance(env, key, being));
  const takes = resolveClaims(env, works);
  applyWorks(env, works, takes);
}
