/**
 * The ruleset of the beings (ADR 0023), `beings@1`: one system, `beings`, and one command,
 * `beings.spawn`, over a global value that holds the sealed genesis of worldgen, the sealed laws of
 * life, and the occupancy index, and chunks that hold beings and the food they took. The host gives
 * one brain per species; the ruleset captures them when it is made, so they cannot change later.
 */
import type { IssueSink } from "../canonical/value.ts";
import { type Issue, IssueList } from "../errors.ts";
import type { ChunkKey } from "../world/chunk.ts";
import type {
  Command,
  DeepReadonly,
  ReadView,
  Rejection,
  Ruleset,
  TickContext,
} from "../world/contracts.ts";
import { readMember, readRecordKeys, UNREAD } from "../world/members.ts";
import {
  chunkOfCell,
  type Genesis,
  genesisSeal,
  liquidLevel,
  MAX_CELL,
  MIN_CELL,
  prepareGenesis,
  sampleSurface,
  sealedGenesisIssues,
  WORLDGEN_VERSION,
} from "../worldgen/index.ts";
import { BEING_BOUNDS, type Being } from "./being.ts";
import { type BeingsChunk, beingsChunkIssues, dueOf } from "./chunk.ts";
import type { Controller, Senses } from "./contracts.ts";
import { type BeingsGlobal, BRAIN_STREAM, CONTEST_STREAM, type Controllers } from "./env.ts";
import { type LifeConfig, lifeSeal, type Species, sealedLifeIssues } from "./laws.ts";
import { insertOccupied, occupancyIssues } from "./occupancy.ts";
import { NEED_MAX } from "./rates.ts";
import { range, readFields, readId, readInt, readList, TICKS } from "./schema.ts";
import { runBeings } from "./system.ts";

/** The version of the beings ruleset: its system, its command, and its data. */
export const BEINGS_RULESET_VERSION = "beings@1";

/** What the host gives the ruleset: one brain per species of the world's laws of life. */
export type BeingsRulesetOptions = {
  readonly controllers: { readonly [species: string]: Controller };
};

/** The neutral trait, in permille. */
const NEUTRAL_TRAIT = 1000;

/** The brain of one species, read once: its version and its decide function. */
function captureOne(controller: unknown, path: string, issues: IssueList): Controller | undefined {
  // A member readMember could not read was already reported there.
  if (controller === UNREAD) return undefined;
  if (typeof controller !== "object" || controller === null) {
    issues.report(path, "a brain must be an object with a brain version and a decide function");
    return undefined;
  }
  const brain = readVersion(readMember(controller, "brain", `${path}/brain`, issues), path, issues);
  const decide = readMember(controller, "decide", `${path}/decide`, issues);
  if (decide !== UNREAD && typeof decide !== "function")
    issues.report(`${path}/decide`, "a brain must have a decide function");
  if (brain === undefined || typeof decide !== "function") return undefined;
  return Object.freeze({
    brain,
    decide: (senses: DeepReadonly<Senses>) => decide.call(controller, senses),
  });
}

/** `value` as the version of the brain at `path`; undefined after an issue, or when unread. */
function readVersion(value: unknown, path: string, issues: IssueList): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== UNREAD)
    issues.report(`${path}/brain`, "a brain's version must be a non-empty string");
  return undefined;
}

/** A frozen copy of the brains by species, each read once; throws invalid_ruleset with every problem. */
function captureControllers(value: unknown): Controllers {
  const issues = new IssueList();
  const captured: { [species: string]: Controller } = Object.create(null);
  const read = readRecordKeys(
    value,
    "/controllers",
    "the brains must be a plain record by species id",
    issues,
  );
  for (const species of read?.keys ?? []) {
    const path = `/controllers/${species}`;
    readId(species, path, issues);
    const controller = captureOne(
      readMember(read?.record ?? {}, species, path, issues),
      path,
      issues,
    );
    if (controller !== undefined) captured[species] = controller;
  }
  if (read !== undefined && read.keys.length === 0)
    issues.report("/controllers", "the ruleset needs a brain for at least one species");
  issues.throwIfAny("invalid_ruleset");
  return Object.freeze(captured);
}

/** The ruleset's brain version: each species and its brain, in the order of species ids. */
function brainVersion(controllers: Controllers, species: readonly string[]): string {
  return species.map((id) => `${id}:${(controllers[id] as Controller).brain}`).join(",");
}

/** Reports a species of the laws of life without a brain. */
function checkBrains(global: unknown, controllers: Controllers, sink: IssueSink): void {
  const life = (
    global as { readonly life?: { readonly species?: readonly { readonly id?: unknown }[] } }
  ).life;
  life?.species?.forEach((species, index) => {
    if (typeof species.id === "string" && controllers[species.id] === undefined) {
      sink.report(
        `/life/species/${index}/id`,
        `the ruleset has no brain for the species "${species.id}"`,
      );
    }
  });
}

/** Every problem of `value` as the global value of a world of beings. */
function globalIssues(value: unknown, controllers: Controllers): Issue[] {
  const issues = new IssueList();
  const global = readFields(
    value,
    "",
    { required: ["genesis", "genesisSeal", "life", "lifeSeal", "occupancy", "prunedDay"] },
    issues,
  );
  if (global === undefined) return issues.issues;
  for (const issue of [...sealedGenesisIssues(value), ...sealedLifeIssues(value)])
    issues.report(issue.path, issue.message);
  for (const issue of occupancyIssues(global.value("occupancy"), "/occupancy"))
    issues.report(issue.path, issue.message);
  global.int("prunedDay", TICKS);
  if (issues.count === 0) checkBrains(value, controllers, issues);
  return issues.issues;
}

/** The members of a spawn's payload, and their bounds. */
const SPAWN_MEMBERS = Object.freeze({
  required: Object.freeze(["cell", "species"]),
  optional: Object.freeze(["needs", "traits"]),
});

/** The validated payload of a spawn. */
type Spawn = {
  readonly species: Species;
  readonly cell: readonly [number, number];
  readonly needs: { readonly nutrition: number; readonly rest: number };
  readonly traits: {
    readonly appetite: number;
    readonly sleepiness: number;
    readonly curiosity: number;
  };
};

/** Every problem of the payload of a spawn, or the spawn it asks for. */
function readSpawn(
  view: ReadView<BeingsGlobal, BeingsChunk>,
  payload: unknown,
  issues: IssueList,
): Spawn | undefined {
  const fields = readFields(payload, "", SPAWN_MEMBERS, issues);
  if (fields === undefined) return undefined;
  const species = readSpecies(view, fields.value("species"), issues);
  const cell = readCell(fields.value("cell"), issues);
  const needs = readNeeds(fields.value("needs"), issues);
  const traits = readTraits(fields.value("traits"), species, issues);
  if (species === undefined || cell === undefined || needs === undefined || traits === undefined)
    return undefined;
  return issues.count > 0 ? undefined : { species, cell, needs, traits };
}

/** The species of the laws of life that `value` names; undefined after an issue at /species. */
function readSpecies(
  view: ReadView<BeingsGlobal, BeingsChunk>,
  value: unknown,
  issues: IssueList,
): Species | undefined {
  const id = readId(value, "/species", issues);
  if (id === undefined) return undefined;
  const found = view.readGlobal().life.species.find((candidate) => candidate.id === id);
  if (found === undefined) issues.report("/species", "the laws of life have no such species");
  // readGlobal gives the laws deep-readonly; a spawn only reads its species.
  return found as Species | undefined;
}

/** The cell `value` names inside the world; undefined after an issue at /cell. */
function readCell(value: unknown, issues: IssueList): readonly [number, number] | undefined {
  const cell = readList(value, "/cell", range(2, 2), issues);
  const x = readInt(cell?.[0], "/cell/0", range(MIN_CELL, MAX_CELL), issues);
  const y = readInt(cell?.[1], "/cell/1", range(MIN_CELL, MAX_CELL), issues);
  return x === undefined || y === undefined ? undefined : [x, y];
}

/** The needs `value` gives, both full when it is omitted; undefined after an issue at /needs. */
function readNeeds(value: unknown, issues: IssueList): Spawn["needs"] | undefined {
  if (value === undefined) return { nutrition: NEED_MAX, rest: NEED_MAX };
  const needs = readFields(value, "/needs", { required: ["nutrition", "rest"] }, issues);
  const level = range(0, NEED_MAX);
  const nutrition = needs?.int("nutrition", level);
  const rest = needs?.int("rest", level);
  return nutrition === undefined || rest === undefined ? undefined : { nutrition, rest };
}

/**
 * The traits `value` gives within the species' bounds, all neutral when it is omitted; undefined
 * after an issue at /traits. Without a species, each trait is still checked against the widest
 * bounds a being may have, so that its other problems are reported too.
 */
function readTraits(
  value: unknown,
  species: Species | undefined,
  issues: IssueList,
): Spawn["traits"] | undefined {
  if (value === undefined) {
    return { appetite: NEUTRAL_TRAIT, sleepiness: NEUTRAL_TRAIT, curiosity: NEUTRAL_TRAIT };
  }
  const names = { required: ["appetite", "curiosity", "sleepiness"] };
  const traits = readFields(value, "/traits", names, issues);
  const bounds = species?.traits ?? BEING_BOUNDS.trait;
  const appetite = traits?.int("appetite", bounds);
  const sleepiness = traits?.int("sleepiness", bounds);
  const curiosity = traits?.int("curiosity", bounds);
  if (appetite === undefined || sleepiness === undefined || curiosity === undefined)
    return undefined;
  return { appetite, sleepiness, curiosity };
}

/** Why a spawn at `cell` cannot happen: its cell lies under liquid deeper than the species wades. */
function spawnBlocked(view: ReadView<BeingsGlobal, BeingsChunk>, spawn: Spawn): string | undefined {
  const genesis = view.readGlobal().genesis as Genesis;
  const [x, y] = spawn.cell;
  const elevation =
    sampleSurface(
      prepareGenesis(genesis),
      { x, y, width: 1, height: 1 },
      spawn.species.diet.deposit,
    ).elevation[0] ?? 0;
  const depth = liquidLevel(genesis) - elevation;
  return depth > spawn.species.locomotion.maxWade
    ? "the cell lies under liquid deeper than the species may wade"
    : undefined;
}

/** `check` of `beings.spawn`: a rejection for a malformed spawn or a cell the species cannot stand on. */
function checkSpawn(
  view: ReadView<BeingsGlobal, BeingsChunk>,
  command: Command,
): Rejection | undefined {
  const issues = new IssueList();
  const spawn = readSpawn(view, command.payload, issues);
  if (spawn === undefined)
    return {
      reason: "invalid_spawn",
      details: { issues: issues.issues.map(({ path, message }) => ({ path, message })) },
    };
  const blocked = spawnBlocked(view, spawn);
  return blocked === undefined
    ? undefined
    : { reason: "invalid_spawn", details: { issues: [{ path: "/cell", message: blocked }] } };
}

/** A new being for `spawn`, born at `tick`, free at the next tick. */
function newBeing(id: number, spawn: Spawn, tick: number): Being {
  return {
    id,
    species: spawn.species.id,
    stage: "adult",
    born: tick,
    cell: [...spawn.cell],
    needs: { ...spawn.needs },
    health: NEED_MAX,
    anchor: tick,
    traits: { ...spawn.traits },
    condition: "ok",
    activity: { kind: "idle", start: tick, ms: 1 },
    plan: [],
    behavior: { kind: "none", since: tick, heading: 0 },
    wakeWhen: {},
    wake: tick + 1,
    outcome: { result: "none", tick, reason: "" },
    cooldowns: [],
  };
}

/** `apply` of `beings.spawn`: the being in the chunk of its cell, and the chunk in the occupancy index. */
function applySpawn(ctx: TickContext<BeingsGlobal, BeingsChunk>, command: Command): undefined {
  const spawn = readSpawn(ctx, command.payload, new IssueList()) as Spawn;
  const being = newBeing(ctx.newEntityId(), spawn, ctx.tick);
  const [x, y] = spawn.cell;
  const key: ChunkKey = `${chunkOfCell(x)},${chunkOfCell(y)}`;
  if (ctx.readChunk(key) === undefined)
    ctx.createChunk(key, { beings: [], depletion: [], due: Number.MAX_SAFE_INTEGER });
  const chunk = ctx.writeChunk(key);
  chunk.beings = [...chunk.beings, being].sort((a, b) => a.id - b.id);
  chunk.due = dueOf(chunk.beings);
  if (!ctx.readGlobal().occupancy.includes(key)) insertOccupied(ctx.writeGlobal().occupancy, key);
  ctx.emit("being.spawned", { id: being.id, species: being.species, cell: [x, y] });
  return undefined;
}

/**
 * The beings ruleset over the brains of `options`, one per species. Throws
 * EngineError("invalid_ruleset") with every problem of the brains.
 */
export function createBeingsRuleset(
  options: BeingsRulesetOptions,
): Ruleset<BeingsGlobal, BeingsChunk> {
  const issues = new IssueList();
  const given: unknown = options;
  const raw =
    typeof given === "object" && given !== null
      ? readMember(given, "controllers", "/controllers", issues)
      : undefined;
  issues.throwIfAny("invalid_ruleset");
  const controllers = captureControllers(raw === UNREAD ? undefined : raw);
  const species = Object.freeze(readRecordKeys(controllers, "", "", new IssueList())?.keys ?? []);
  return {
    versions: {
      ruleset: BEINGS_RULESET_VERSION,
      generator: WORLDGEN_VERSION,
      brain: brainVersion(controllers, species),
    },
    systems: [
      {
        name: "beings",
        streams: [BRAIN_STREAM, CONTEST_STREAM],
        run: (ctx) => {
          runBeings(ctx, controllers);
          return undefined;
        },
      },
    ],
    commands: { "beings.spawn": { check: checkSpawn, apply: applySpawn } },
    validateGlobal: (value) => globalIssues(value, controllers),
    validateChunk: (key, value) => beingsChunkIssues(key, value),
  };
}

/** The global value of a new world of beings, for createWorld: sealed genesis and laws, no occupancy. */
export function beingsGlobal(genesis: Genesis, life: LifeConfig): BeingsGlobal {
  return {
    genesis,
    genesisSeal: genesisSeal(genesis),
    life,
    lifeSeal: lifeSeal(life),
    occupancy: [],
    prunedDay: 0,
  };
}
