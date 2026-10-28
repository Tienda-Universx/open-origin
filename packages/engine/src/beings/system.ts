/**
 * The beings system (ADR 0023): one run per tick, in three phases. It collects the beings due at the
 * tick from the chunks of the occupancy index, advances each in order of id (decisions included),
 * resolves the contests over food, and, under beings@2, the contest for room (ADR 0024), whose
 * losers keep nothing of their decision, nor its events, and writes what changed. Its work grows with occupied chunks, beings due, decisions, and changed bytes, never
 * with the size of the world.
 */
import type { CanonicalValue } from "../canonical/value.ts";
import type { TickContext } from "../world/contracts.ts";
import { advance } from "./advance.ts";
import type { Controllers } from "./capture.ts";
import type { BeingsChunk } from "./chunk.ts";
import { type BeingsEnv, type BeingsGlobal, envOf } from "./env.ts";
import { applyWorks, collectDue, hasId, resolveClaims } from "./resolve.ts";
import { resolveRoom } from "./room.ts";
import type { BeingsRules } from "./rules.ts";

/** One tick of the beings of the world behind `ctx`, with the ruleset's brains and rules. */
export function runBeings(
  ctx: TickContext<BeingsGlobal, BeingsChunk>,
  controllers: Controllers,
  rules: BeingsRules,
): void {
  const env = envOf(ctx, controllers, rules);
  if (rules.minds) {
    runBeings2(env);
    return;
  }
  const works = collectDue(env).map(({ key, being }) => advance(env, key, being));
  const takes = resolveClaims(env, works);
  applyWorks(env, works, takes);
}

/** An event that a tick of beings@2 holds until the contest for room has decided whom it keeps. */
type Held = { readonly type: string; readonly payload: CanonicalValue };

/** `env`, whose events go to `sink` instead of the tick. */
function holding(env: BeingsEnv, sink: Held[]): BeingsEnv {
  return {
    ...env,
    emit: (type, payload) => {
      sink.push({ type, payload });
    },
  };
}

/**
 * One tick of beings@2 (mind.md, "The tick of beings@2"): its phases as under beings@1, with the
 * contest for room after those over food. Each being's events of the second phase are held until
 * the contest decides; a loser keeps nothing of its decision, so its are dropped, and the crowded
 * end of its walk, which the contest emits, stands for them. Then the tick emits the second phase's
 * events by being id, then the third phase's: contests over food by place, and for room by chunk.
 */
function runBeings2(env: BeingsEnv): void {
  const held: Held[][] = [];
  const works = collectDue(env).map(({ key, being }) => {
    const events: Held[] = [];
    held.push(events);
    return advance(holding(env, events), key, being);
  });
  const third: Held[] = [];
  const takes = resolveClaims(holding(env, third), works);
  const losers = resolveRoom(holding(env, third), works);
  works.forEach((work, index) => {
    if (hasId(losers, work.old.id)) return;
    for (const { type, payload } of held[index] ?? []) env.emit(type, payload);
  });
  for (const { type, payload } of third) env.emit(type, payload);
  applyWorks(env, works, takes);
}
