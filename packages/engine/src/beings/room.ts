/**
 * The contest for room of beings@2 (ADR 0024, docs/architecture/mind.md "The tick of beings@2",
 * phase 3), after the contests over food: a chunk has as free places its capacity, a law of life@2,
 * less the beings it holds when the beings system starts, after the commands of the tick, spawns
 * included, since nothing is written before the last phase and a departure frees no place until
 * the next tick. When more beings arrive in a chunk than it has free places, the arrivals, by
 * increasing id, are ordered by `random.permutation` on the stream `beings.crowd`, keyed by the
 * lowest arriving id, and the first take the places. The rest end their walk at the cell they
 * started the tick in, which their own chunk still counts, `failed` with the reason `crowded`, and
 * idle 1 ms, so that they decide again at the next tick. Chunks are resolved in the kernel's order
 * of keys, so their events follow that order.
 */
import { copyCanonical } from "../canonical/copy.ts";
import { compareCodeUnits } from "../canonical/order.ts";
import type { ChunkKey } from "../world/chunk.ts";
import type { Work } from "./advance.ts";
import type { Being } from "./being.ts";
import { type BeingsEnv, CROWD_STREAM } from "./env.ts";
import type { LifeConfig2 } from "./life2.ts";
import { greatest } from "./rates.ts";

/** A being that ends the tick in another chunk than the one it started in, and that chunk. */
type Arrival = { readonly work: Work; readonly chunk: ChunkKey };

/** The beings that end the tick in a chunk they did not start it in, by chunk key, then id. */
function arrivalsOf(env: BeingsEnv, works: readonly Work[]): Arrival[] {
  const arrivals: Arrival[] = [];
  for (const work of works) {
    if (work.died) continue;
    const chunk = env.place(work.cell).chunk;
    if (chunk !== work.from) arrivals.push({ work, chunk });
  }
  return arrivals.sort(
    (a, b) => compareCodeUnits(a.chunk, b.chunk) || a.work.old.id - b.work.old.id,
  );
}

/**
 * The walk that brought `work` into a chunk without room ends where the being started the tick, and
 * the being keeps nothing of a decision it made at this tick (mind.md, "The tick of beings@2"): a
 * walk whose last step arrived already ended in the second phase, where the being decided again,
 * and that intention is discarded with what it started, its plan, behavior, wake conditions, and
 * cooldowns. Its mind is the one it had at the start of the tick: the system shares it, never writes
 * it. It decides again at the next tick from the cell it is in.
 */
function crowd(env: BeingsEnv, work: Work): void {
  env.emit("being.finished", {
    id: work.old.id,
    activity: "walk",
    result: "failed",
    reason: "crowded",
  });
  // Copies of the record validateChunk accepted, detached from the state; its mind is not copied.
  const { cell, behavior, wakeWhen, cooldowns } = work.old;
  const restored = copyCanonical({ cell, behavior, wakeWhen, cooldowns }) as Pick<
    Being,
    "cell" | "behavior" | "wakeWhen" | "cooldowns"
  >;
  work.cell = restored.cell;
  work.outcome = { result: "failed", tick: env.tick, reason: "crowded" };
  work.activity = { kind: "idle", start: env.tick, ms: 1 };
  work.plan = [];
  work.behavior = restored.behavior;
  work.wakeWhen = restored.wakeWhen;
  work.cooldowns = restored.cooldowns;
}

/** Resolves the arrivals in one chunk, sorted by id, against its free places. */
function contestRoom(env: BeingsEnv, arrivals: readonly Arrival[], capacity: number): void {
  const [first] = arrivals;
  if (first === undefined) return;
  const held = env.view.readChunk(first.chunk)?.beings.length ?? 0;
  const free = greatest(capacity - held, 0);
  if (arrivals.length <= free) return;
  // The arrivals are sorted by id, so the first has the lowest one.
  const order = env.ctx.random.permutation(CROWD_STREAM, first.work.old.id, arrivals.length);
  for (const index of order.slice(free)) crowd(env, (arrivals[index] as Arrival).work);
}

/**
 * The contest for room of every chunk that beings arrive in at this tick, in the order of chunk
 * keys; under beings@1, whose chunks have no capacity, nothing.
 */
export function resolveRoom(env: BeingsEnv, works: readonly Work[]): void {
  if (!env.rules.minds) return;
  // validateGlobal accepted the laws of life@2, which hold the capacity.
  const { capacity } = env.ctx.readGlobal().life as LifeConfig2;
  const arrivals = arrivalsOf(env, works);
  for (let start = 0; start < arrivals.length; ) {
    let end = start + 1;
    while (end < arrivals.length && arrivals[end]?.chunk === arrivals[start]?.chunk) end += 1;
    contestRoom(env, arrivals.slice(start, end), capacity);
    start = end;
  }
}
