/**
 * The ruleset of the beings (ADR 0023, ADR 0024), `beings@1` and, beside it, `beings@2`: one
 * system, `beings`, and one command, `beings.spawn`, over a global value that holds the sealed
 * genesis of worldgen, the sealed laws of life, and the occupancy index, and chunks that hold
 * beings and the food they took. The host gives one brain per species; the ruleset captures them
 * when it is made, so they cannot change later. Each version follows its own rules (rules.ts):
 * beings@2 requires life@2, spawns beings with six traits and an empty mind, and caps the beings of
 * a chunk.
 */
import type { IssueSink } from "../canonical/value.ts";
import { type Issue, IssueList } from "../errors.ts";
import { floorDiv } from "../int.ts";
import { newMind } from "../mind/index.ts";
import { simSeconds } from "../time/tick.ts";
import type { ChunkKey } from "../world/chunk.ts";
import type { Command, ReadView, Rejection, Ruleset, TickContext } from "../world/contracts.ts";
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
import { BEING_BOUNDS, type Being, type Being2, type Traits2 } from "./being.ts";
import { brainVersion, type Controllers, captureControllers } from "./capture.ts";
import { type BeingsChunk, beingsChunkIssues, dueOf } from "./chunk.ts";
import type { Controller, Controller2 } from "./contracts.ts";
import type { BeingsGlobal } from "./env.ts";
import { type LifeConfig, lifeSeal, type Species, sealedLifeIssues } from "./laws.ts";
import { LIFE2_RULES, LIFE2_VERSION, type LifeConfig2 } from "./life2.ts";
import { insertOccupied, isOccupied, occupancyIssues } from "./occupancy.ts";
import { NEED_MAX } from "./rates.ts";
import {
  BEINGS_RULES,
  BEINGS_RULESET_VERSION,
  BEINGS2_RULES,
  BEINGS2_RULESET_VERSION,
  type BeingsRules,
} from "./rules.ts";
import { range, readFields, readId, readInt, readList, TICKS } from "./schema.ts";
import { runBeings } from "./system.ts";

/**
 * What the host gives the ruleset beings@1: one brain per species of the world's laws of life, and
 * no rules, or "beings@1".
 */
export type BeingsRulesetOptions = {
  readonly controllers: { readonly [species: string]: Controller };
  readonly rules?: typeof BEINGS_RULESET_VERSION;
};

/** What the host gives the ruleset beings@2: one brain of beings@2 per species of life@2. */
export type Beings2RulesetOptions = {
  readonly controllers: { readonly [species: string]: Controller2 };
  readonly rules: typeof BEINGS2_RULESET_VERSION;
};

/** The neutral trait, in permille. */
const NEUTRAL_TRAIT = 1000;

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

/** Every problem of `value` as the global value of a world of beings of `rules`. */
function globalIssues(value: unknown, controllers: Controllers, rules: BeingsRules): Issue[] {
  const issues = new IssueList();
  const global = readFields(
    value,
    "",
    { required: ["genesis", "genesisSeal", "life", "lifeSeal", "occupancy", "prunedDay"] },
    issues,
  );
  if (global === undefined) return issues.issues;
  for (const issue of [...sealedGenesisIssues(value), ...sealedLifeIssues(value, rules.life)])
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

/** The validated payload of a spawn: the traits of beings@1, or the six of beings@2. */
type Spawn = {
  readonly species: Species;
  readonly cell: readonly [number, number];
  readonly needs: { readonly nutrition: number; readonly rest: number };
  readonly traits: Being["traits"] | Traits2;
};

/** Every problem of the payload of a spawn by `rules`, or the spawn it asks for. */
function readSpawn(
  view: ReadView<BeingsGlobal, BeingsChunk>,
  payload: unknown,
  rules: BeingsRules,
  issues: IssueList,
): Spawn | undefined {
  const fields = readFields(payload, "", SPAWN_MEMBERS, issues);
  if (fields === undefined) return undefined;
  const species = readSpecies(view, fields.value("species"), issues);
  const cell = readCell(fields.value("cell"), issues);
  const needs = readNeeds(fields.value("needs"), issues);
  const traits = readTraits(fields.value("traits"), { species, rules }, issues);
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
 * The traits of the version of `of.rules` that `value` gives within the species' bounds, all
 * neutral when it is omitted; undefined after an issue at /traits. Without a species, each trait
 * is still checked against the widest bounds a being may have, so that its other problems are
 * reported too.
 */
function readTraits(
  value: unknown,
  of: { readonly species: Species | undefined; readonly rules: BeingsRules },
  issues: IssueList,
): Spawn["traits"] | undefined {
  const traits: { [name: string]: number } = {};
  if (value === undefined) {
    for (const name of of.rules.traits) traits[name] = NEUTRAL_TRAIT;
    // The neutral value of every trait of the version.
    return traits as Spawn["traits"];
  }
  const required = of.rules.traitMembers;
  const fields = readFields(value, "/traits", { required }, issues);
  const bounds = of.species?.traits ?? BEING_BOUNDS.trait;
  let complete = fields !== undefined;
  for (const name of of.rules.traits) {
    const trait = fields?.int(name, bounds);
    if (trait === undefined) complete = false;
    else traits[name] = trait;
  }
  // Each trait of the version was read within its bounds.
  return complete ? (traits as Spawn["traits"]) : undefined;
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

/**
 * `check` of `beings.spawn`: a rejection for a spawn that is not the admin's, a malformed one, a
 * cell the species cannot stand on, or a chunk already full.
 */
function checkSpawn(
  view: ReadView<BeingsGlobal, BeingsChunk>,
  command: Command,
  rules: BeingsRules,
): Rejection | undefined {
  // Beings come from the admin plane only (AGENTS.md, rule 7); an inhabitant cannot create them.
  if (command.origin.kind !== "admin") return { reason: "admin_only" };
  const issues = new IssueList();
  const spawn = readSpawn(view, command.payload, rules, issues);
  if (spawn === undefined)
    return {
      reason: "invalid_spawn",
      details: { issues: issues.issues.map(({ path, message }) => ({ path, message })) },
    };
  const blocked = spawnBlocked(view, spawn) ?? spawnCrowded(view, spawn, rules);
  return blocked === undefined
    ? undefined
    : { reason: "invalid_spawn", details: { issues: [{ path: "/cell", message: blocked }] } };
}

/**
 * Why a spawn at `cell` cannot happen: under beings@1, its chunk already holds as many beings as a
 * chunk may, so the spawn would make the chunk invalid and poison the world at commit (tracker
 * L53); under beings@2, the chunk holds its capacity, a law of life@2. The view is live, so the
 * spawns of the same tick count as they apply.
 */
function spawnCrowded(
  view: ReadView<BeingsGlobal, BeingsChunk>,
  spawn: Spawn,
  rules: BeingsRules,
): string | undefined {
  const [x, y] = spawn.cell;
  const held = view.readChunk(`${chunkOfCell(x)},${chunkOfCell(y)}`)?.beings.length ?? 0;
  if (!rules.minds)
    return held >= rules.chunkBeings.max
      ? "the chunk of the cell holds as many beings as a chunk may"
      : undefined;
  // validateGlobal accepted the laws of life@2, which hold the capacity.
  const { capacity } = view.readGlobal().life as LifeConfig2;
  return held >= capacity
    ? `the chunk of the cell holds its capacity, ${capacity} beings`
    : undefined;
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

/**
 * A new being of beings@2 for `spawn`, born at the tick of `ctx`: the being of beings@1 with an
 * empty mind, whose quota counts the simulated day of its birth as the daily prune counts days.
 */
function newBeing2(id: number, spawn: Spawn, ctx: TickContext<BeingsGlobal, BeingsChunk>): Being2 {
  const day = floorDiv(
    simSeconds(ctx.tick, ctx.simSecondsPerTick),
    ctx.readGlobal().genesis.laws.day.length,
  );
  // readSpawn read the six traits of beings@2.
  return {
    ...newBeing(id, spawn, ctx.tick),
    traits: { ...spawn.traits } as Traits2,
    mind: newMind(day),
  };
}

/** `apply` of `beings.spawn`: the being in the chunk of its cell, and the chunk in the occupancy index. */
function applySpawn(
  ctx: TickContext<BeingsGlobal, BeingsChunk>,
  command: Command,
  rules: BeingsRules,
): undefined {
  const spawn = readSpawn(ctx, command.payload, rules, new IssueList()) as Spawn;
  const id = ctx.newEntityId();
  const being = rules.minds ? newBeing2(id, spawn, ctx) : newBeing(id, spawn, ctx.tick);
  const [x, y] = spawn.cell;
  const key: ChunkKey = `${chunkOfCell(x)},${chunkOfCell(y)}`;
  if (ctx.readChunk(key) === undefined)
    ctx.createChunk(key, { beings: [], depletion: [], due: Number.MAX_SAFE_INTEGER });
  const chunk = ctx.writeChunk(key);
  chunk.beings = [...chunk.beings, being].sort((a, b) => a.id - b.id);
  chunk.due = dueOf(chunk.beings);
  // Searched first, so that a chunk already listed leaves the global value unwritten.
  if (!isOccupied(ctx.readGlobal().occupancy, key))
    insertOccupied(ctx.writeGlobal().occupancy, key);
  ctx.emit("being.spawned", { id: being.id, species: being.species, cell: [x, y] });
  return undefined;
}

/** The rules the member `rules` of the options names: beings@1 when it is absent or names it. */
function readRules(value: unknown, issues: IssueList): BeingsRules | undefined {
  if (value === UNREAD) return undefined;
  if (value === undefined || value === BEINGS_RULESET_VERSION) return BEINGS_RULES;
  if (value === BEINGS2_RULESET_VERSION) return BEINGS2_RULES;
  issues.report(
    "/rules",
    `the rules are "${BEINGS_RULESET_VERSION}", the same as absent, or "${BEINGS2_RULESET_VERSION}"`,
  );
  return undefined;
}

/**
 * The beings ruleset over the brains of `options`, one per species: beings@1 when `rules` is absent
 * or names it, and beings@2 when it names beings@2. Throws EngineError("invalid_ruleset") with
 * every problem of the options and the brains.
 */
export function createBeingsRuleset(
  options: BeingsRulesetOptions | Beings2RulesetOptions,
): Ruleset<BeingsGlobal, BeingsChunk> {
  const issues = new IssueList();
  const given: unknown = options;
  const record = typeof given === "object" && given !== null ? given : undefined;
  const raw =
    record === undefined ? undefined : readMember(record, "controllers", "/controllers", issues);
  const rules = readRules(
    record === undefined ? undefined : readMember(record, "rules", "/rules", issues),
    issues,
  );
  issues.throwIfAny("invalid_ruleset");
  // readRules reported nothing, so it named the rules.
  return rulesetOf(
    captureControllers(raw === UNREAD ? undefined : raw, rules as BeingsRules),
    rules as BeingsRules,
  );
}

/** The ruleset of `rules` over the captured `controllers`. */
function rulesetOf(
  controllers: Controllers,
  rules: BeingsRules,
): Ruleset<BeingsGlobal, BeingsChunk> {
  const species = Object.freeze(readRecordKeys(controllers, "", "", new IssueList())?.keys ?? []);
  return {
    versions: {
      ruleset: rules.version,
      generator: WORLDGEN_VERSION,
      brain: brainVersion(controllers, species),
    },
    systems: [
      {
        name: "beings",
        streams: rules.streams,
        run: (ctx) => {
          runBeings(ctx, controllers, rules);
          return undefined;
        },
      },
    ],
    commands: {
      "beings.spawn": {
        check: (view, command) => checkSpawn(view, command, rules),
        apply: (ctx, command) => applySpawn(ctx, command, rules),
      },
    },
    validateGlobal: (value) => globalIssues(value, controllers, rules),
    validateChunk: (key, value) =>
      beingsChunkIssues(key, value, rules.minds ? BEINGS2_RULESET_VERSION : BEINGS_RULESET_VERSION),
  };
}

/**
 * The global value of a new world of beings, for createWorld: sealed genesis and laws, no
 * occupancy. Laws of life@2 are sealed with their own version.
 */
export function beingsGlobal(genesis: Genesis, life: LifeConfig | LifeConfig2): BeingsGlobal {
  return {
    genesis,
    genesisSeal: genesisSeal(genesis),
    life,
    lifeSeal: life.version === LIFE2_VERSION ? LIFE2_RULES.seal(life) : lifeSeal(life),
    occupancy: [],
    prunedDay: 0,
  };
}
