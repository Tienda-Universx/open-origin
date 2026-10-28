/**
 * The beings system (ADR 0023): one run per tick, in three phases. It collects the beings due at the
 * tick from the chunks of the occupancy index, advances each in order of id (decisions included),
 * resolves the contests over food, and, under beings@2, the contest for room (ADR 0024), and writes
 * what changed. Its work grows with occupied chunks, beings due, decisions, and changed bytes, never
 * with the size of the world.
 */
import type { TickContext } from "../world/contracts.ts";
import { advance } from "./advance.ts";
import type { Controllers } from "./capture.ts";
import type { BeingsChunk } from "./chunk.ts";
import { type BeingsGlobal, envOf } from "./env.ts";
import { applyWorks, collectDue, resolveClaims } from "./resolve.ts";
import { resolveRoom } from "./room.ts";
import type { BeingsRules } from "./rules.ts";

/** One tick of the beings of the world behind `ctx`, with the ruleset's brains and rules. */
export function runBeings(
  ctx: TickContext<BeingsGlobal, BeingsChunk>,
  controllers: Controllers,
  rules: BeingsRules,
): void {
  const env = envOf(ctx, controllers, rules);
  const works = collectDue(env).map(({ key, being }) => advance(env, key, being));
  const takes = resolveClaims(env, works);
  resolveRoom(env, works);
  applyWorks(env, works, takes);
}
