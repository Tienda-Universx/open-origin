/**
 * The admin command `mind.inject { being, cell, p, taints }` of beings@2 (ADR 0024,
 * docs/architecture/mind.md "Commands and faults", "Provenance and taints", and "Events"): research
 * puts a claim in the inbox of one being, as a message with no speaker and no cell, a `tell` of the
 * proposition `p`, whose lineage is the taints the payload declares with `human-external` always
 * among them. The being is the one with that id standing at `cell`: the engine reads the chunk of
 * the cell and nothing else, so it never searches the world. The being's exposure grows at once,
 * and the message wakes it at the next tick under the rule of a hearer (hearing.ts), without
 * counting in its daily wakes. The payload, which the kernel bounds at 8 KiB, is read with exact
 * members and the proposition with `mind.checkProposition`, in any namespace. Rejections:
 * `admin_only`, `invalid_inject`, `not_found`, and `full`. An accepted injection emits
 * `mind.injected` and a `mind.provenance` with the being's new exposure, both C3.
 */
import type { IssueSink } from "../canonical/value.ts";
import { IssueList } from "../errors.ts";
import { least } from "../int.ts";
import {
  checkProposition,
  copyProposition,
  type InboxMessage,
  MIND_BOUNDS,
  type Proposition,
  TAINTS,
} from "../mind/index.ts";
import type { ChunkKey } from "../world/chunk.ts";
import type { Command, ReadView, Rejection, TickContext } from "../world/contracts.ts";
import { chunkOfCell, MAX_CELL, MIN_CELL } from "../worldgen/index.ts";
import type { Being2, Cell } from "./being.ts";
import { type BeingsChunk, dueOf, indexOfBeing } from "./chunk.ts";
import type { BeingsGlobal } from "./env.ts";
import { dayOfTick, delivered, hearingWakes } from "./hearing.ts";
import type { LifeConfig2, Species2 } from "./life2.ts";
import { range, readFields, readInt, readList } from "./schema.ts";

/** A valid payload of `mind.inject`. */
type Injection = {
  readonly being: number;
  readonly cell: Cell;
  readonly p: Proposition;
  readonly taints: number;
};

/** The members of the payload, all required. */
const MEMBERS = Object.freeze({ required: Object.freeze(["being", "cell", "p", "taints"]) });

/** A cell of the world: two coordinates within its bounds. */
function readCell(value: unknown, path: string, sink: IssueSink): Cell | undefined {
  const axes = readList(value, path, range(2, 2), sink);
  const x = readInt(axes?.[0], `${path}/0`, range(MIN_CELL, MAX_CELL), sink);
  const y = readInt(axes?.[1], `${path}/1`, range(MIN_CELL, MAX_CELL), sink);
  return x === undefined || y === undefined || axes?.length !== 2 ? undefined : [x, y];
}

/** The injection `payload` asks for, after reporting every problem of it to `issues`. */
function readInjection(payload: unknown, issues: IssueList): Injection | undefined {
  const fields = readFields(payload, "", MEMBERS, issues);
  if (fields === undefined) return undefined;
  const being = fields.int("being", MIND_BOUNDS.entity);
  const cell = readCell(fields.value("cell"), fields.at("cell"), issues);
  const p = fields.value("p");
  const proposition = p !== undefined && checkProposition(p, fields.at("p"), issues);
  const taints = fields.int("taints", MIND_BOUNDS.taints);
  if (being === undefined || cell === undefined || !proposition || taints === undefined)
    return undefined;
  // checkProposition accepted `p`, a canonical value of the payload.
  return issues.count > 0 ? undefined : { being, cell, p: p as Proposition, taints };
}

/** Where the being of an injection stands: its chunk, its index there, and its record. */
type Located = { readonly key: ChunkKey; readonly index: number; readonly being: Being2 };

/**
 * The being of `injection` in the chunk of its cell, found by binary search on the ids the chunk
 * keeps in increasing order, if it stands at that cell; undefined otherwise.
 */
function locate(
  view: ReadView<BeingsGlobal, BeingsChunk>,
  injection: Injection,
): Located | undefined {
  const [x, y] = injection.cell;
  const key: ChunkKey = `${chunkOfCell(x)},${chunkOfCell(y)}`;
  const beings = view.readChunk(key)?.beings ?? [];
  const index = indexOfBeing(beings, injection.being);
  const being = index === undefined ? undefined : beings[index];
  if (index === undefined || being === undefined || being.cell[0] !== x || being.cell[1] !== y)
    return undefined;
  // validateChunk accepted every being of beings@2 with its mind.
  return { key, index, being: being as unknown as Being2 };
}

/** The laws of the species of `being`; validateGlobal accepted laws of life@2 for every being's. */
function speciesOf(view: ReadView<BeingsGlobal, BeingsChunk>, being: Being2): Species2 {
  const life = view.readGlobal().life as LifeConfig2;
  return life.species.find((species) => species.id === being.species) as Species2;
}

/**
 * `check` of `mind.inject`: a rejection for an injection that is not the admin's, a payload that is
 * not one, no being with that id at that cell, or a being whose inbox is full.
 */
export function checkInject(
  view: ReadView<BeingsGlobal, BeingsChunk>,
  command: Command,
): Rejection | undefined {
  // Research acts through the admin plane only (AGENTS.md, rule 7); an inhabitant never injects.
  if (command.origin.kind !== "admin") return { reason: "admin_only" };
  const issues = new IssueList();
  const injection = readInjection(command.payload, issues);
  if (injection === undefined)
    return {
      reason: "invalid_inject",
      details: { issues: issues.issues.map(({ path, message }) => ({ path, message })) },
    };
  const located = locate(view, injection);
  if (located === undefined) return { reason: "not_found" };
  const room = speciesOf(view, located.being).mind.inbox;
  return located.being.mind.inbox.length >= room ? { reason: "full" } : undefined;
}

/**
 * `apply` of `mind.inject`: the message at the end of the being's inbox, its exposure grown, and,
 * when hearing wakes it, its wake at the next tick at the latest; then the events.
 */
export function applyInject(
  ctx: TickContext<BeingsGlobal, BeingsChunk>,
  command: Command,
): undefined {
  // check accepted the payload, and the being stands at its cell in the live state.
  const injection = readInjection(command.payload, new IssueList()) as Injection;
  const { key, index, being } = locate(ctx, injection) as Located;
  const message: InboxMessage = {
    t: ctx.tick,
    act: "tell",
    p: copyProposition(injection.p),
    tn: injection.taints | TAINTS.humanExternal,
    ex: 0,
  };
  const mind = delivered(being.mind, message);
  const day = dayOfTick(ctx.tick, ctx.simSecondsPerTick, ctx.readGlobal().genesis.laws.day.length);
  const { wakesPerDay } = speciesOf(ctx, being).speech;
  const wakes = hearingWakes(mind, being.activity, { at: ctx.tick, day, wakesPerDay });
  const wake = wakes ? least(being.wake, ctx.tick + 1) : being.wake;
  const injected: Being2 = { ...being, mind, wake };
  const chunk = ctx.writeChunk(key);
  chunk.beings = chunk.beings.with(index, injected);
  chunk.due = dueOf(chunk.beings);
  ctx.emit("mind.injected", { id: being.id });
  ctx.emit("mind.provenance", { id: being.id, records: [], exposure: mind.exposure });
  return undefined;
}
