import {
  type CanonicalValue,
  type ChunkKey,
  type Command,
  type Digest,
  EngineError,
  type Issue,
  type ReadView,
  type Rejection,
  type Ruleset,
  type TickContext,
} from "../../src/index.ts";
import {
  chunkKeyIssues,
  dayPosition,
  type Genesis,
  generateChunk,
  type Instant,
  instantOf,
  lightPeriod,
  type ObservableQuery,
  observe,
  type PreparedGenesis,
  prepareGenesis,
  sealedGenesisIssues,
  terrainDigest,
  WORLDGEN_VERSION,
} from "../../src/worldgen/index.ts";

/**
 * probe: the test-only ruleset that runs worldgen inside the kernel (ADR 0021, "Proof without a
 * production ruleset"; plan §12, test 13). No production ruleset exists in T3, so this one is the
 * proof that worldgen keeps the kernel deterministic:
 *
 * - `probe.materialize { x, y }`, from the admin plane, materializes a chunk: a cause inside the
 *   world. `check` rejects, never faults, a chunk outside the world (chunkKeyIssues), a chunk
 *   already materialized, and a command from an inhabitant. The chunk stores the digest of its
 *   terrain, computed inside the tick, never the terrain itself, and joins the watch list while
 *   the list has room.
 * - `probe.measure { id, cell }` emits `probe.reading { id, cell, value }`, the observable `id` at
 *   `cell` at the tick's instant, instantOf(ctx); `check` rejects a query that observe rejects.
 * - The system `probe.daylight` emits `probe.boundary { day, light }` and adds 1 to the readings
 *   of every watched chunk at exactly the ticks where the light state flips (dusk) or the day
 *   changes (dawn), so calendar boundaries change chunks.
 *
 * Its global value is `{ genesis, genesisSeal, watch }`; validateGlobal calls sealedGenesisIssues,
 * so the genesis stays sealed (ADR 0021, the seal). It keeps no module or ruleset state: each
 * system and handler prepares the genesis from the global value it reads, inside its own run.
 */

type Value = CanonicalValue;
type Ctx = TickContext<Value, Value>;
type View = ReadView<Value, Value>;

/** The global value of a probe world: its sealed genesis and the chunks it watches. */
export type ProbeGlobal = {
  readonly genesis: Genesis;
  readonly genesisSeal: Digest;
  readonly watch: ChunkKey[];
};

/**
 * A materialized chunk: the tick it was materialized at, the digest of its terrain, and how many
 * calendar boundaries it has seen while watched.
 */
export type ProbeChunk = { readonly at: number; readonly terrain: Digest; readings: number };

const PROBE_VERSIONS = Object.freeze({
  ruleset: "probe@1",
  generator: WORLDGEN_VERSION,
  brain: "none@1",
});

/** How many chunks the watch list holds at most: the first ones materialized. */
export const WATCH_LIMIT = 16;

/** How the probe digests the terrain of the chunk `key`: terrainDigest, unless a test varies it. */
export type TerrainOf = (prepared: PreparedGenesis, key: ChunkKey) => Digest;

/** The terrain digest of the chunk `key`, generated under `prepared`. */
export const generatedTerrain: TerrainOf = (prepared, key) =>
  terrainDigest(generateChunk(prepared, key));

/** The live global value that `view` reads; the probe writes it only through writeGlobal. */
const globalOf = (view: View) => view.readGlobal() as unknown as ProbeGlobal;

/** The genesis of the world `view` reads, prepared for this run of a system or handler alone. */
const preparedOf = (view: View) => prepareGenesis(globalOf(view).genesis);

/** The payload of `command` as a record, or an empty one. */
function payloadOf(command: Command): { readonly [key: string]: Value } {
  const { payload } = command;
  if (typeof payload !== "object" || Array.isArray(payload)) return {};
  // Array.isArray does not narrow a readonly array type: what is left is a canonical record.
  return payload as { readonly [key: string]: Value };
}

/**
 * The chunk key that the payload `{ x, y }` of `command` names, or "" when x or y is not a number,
 * which chunkKeyIssues rejects. Payload numbers are safe integers, so the text is canonical.
 */
function keyOf(command: Command): string {
  const { x, y } = payloadOf(command);
  return typeof x === "number" && typeof y === "number" ? `${x},${y}` : "";
}

function checkMaterialize(view: View, command: Command): Rejection | undefined {
  if (command.origin.kind !== "admin") return { reason: "admin_only" };
  const key = keyOf(command);
  const problems = chunkKeyIssues(key).map(({ message }) => message);
  if (problems.length > 0) return { reason: "outside_world", details: { key, problems } };
  if (view.readChunk(key) !== undefined) return { reason: "materialized", details: { key } };
  return undefined;
}

/** The handler of probe.materialize, whose chunks store the digest that `terrainOf` gives. */
function materialize(terrainOf: TerrainOf) {
  return {
    check: checkMaterialize,
    apply(ctx: Ctx, command: Command): undefined {
      const key = keyOf(command);
      const chunk: ProbeChunk = {
        at: ctx.tick,
        terrain: terrainOf(preparedOf(ctx), key),
        readings: 0,
      };
      ctx.createChunk(key, chunk);
      if (globalOf(ctx).watch.length < WATCH_LIMIT) {
        (ctx.writeGlobal() as unknown as ProbeGlobal).watch.push(key);
      }
      return undefined;
    },
  };
}

/** The query of the probe.measure `command`, at the instant of `view`: observe validates it. */
function queryOf(view: View, command: Command): ObservableQuery {
  const { id, cell } = payloadOf(command);
  return { id, cell, instant: instantOf(view) } as unknown as ObservableQuery;
}

/**
 * Rejects a query that observe rejects, with its issues; any other error is a fault. It validates
 * by measuring, with the one reader of a query, so an accepted measurement is computed twice.
 */
function checkMeasure(view: View, command: Command): Rejection | undefined {
  try {
    observe(preparedOf(view), queryOf(view, command));
    return undefined;
  } catch (error) {
    if (!EngineError.isEngineError(error) || error.code !== "invalid_value") throw error;
    const issues = error.issues.map(({ path, message }) => ({ path, message }));
    return { reason: "invalid_query", details: { issues } };
  }
}

function applyMeasure(ctx: Ctx, command: Command): undefined {
  const query = queryOf(ctx, command);
  const value = observe(preparedOf(ctx), query);
  const { x, y } = query.cell;
  ctx.emit("probe.reading", { id: query.id, cell: { x, y }, value });
  return undefined;
}

/**
 * The day of `instant` and whether it falls in the light period, which lasts `light` seconds from
 * dawn, the day's second 0.
 */
function phaseOf(prepared: PreparedGenesis, light: number, instant: Instant) {
  const { dayIndex, secondOfDay } = dayPosition(prepared, instant);
  return { day: dayIndex, light: secondOfDay < light };
}

/**
 * At a tick whose phase differs from the previous tick's, a calendar boundary: emits it and adds 1
 * to the readings of every watched chunk.
 */
function daylight(ctx: Ctx): undefined {
  const global = globalOf(ctx);
  const prepared = prepareGenesis(global.genesis);
  const light = lightPeriod(global.genesis.laws.day);
  const { tick, simSecondsPerTick } = ctx;
  const now = phaseOf(prepared, light, instantOf(ctx));
  const before = phaseOf(prepared, light, { tick: tick - 1, simSecondsPerTick });
  if (now.day === before.day && now.light === before.light) return undefined;
  ctx.emit("probe.boundary", now);
  for (const key of global.watch) (ctx.writeChunk(key) as unknown as ProbeChunk).readings += 1;
  return undefined;
}

/** Whether `value` is a record: not null, not an array. */
const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const GLOBAL_MEMBERS = ["genesis", "genesisSeal", "watch"];

/** The problems of the watch list: an array of at most WATCH_LIMIT distinct chunks of the world. */
function watchIssues(watch: unknown): Issue[] {
  if (!Array.isArray(watch)) {
    return [{ path: "/watch", message: "the watch list must be an array of chunk keys" }];
  }
  const issues: Issue[] = [];
  if (watch.length > WATCH_LIMIT) {
    const message = `the watch list has ${watch.length} keys: it holds at most ${WATCH_LIMIT}`;
    issues.push({ path: "/watch", message });
  }
  const seen = new Set<unknown>();
  watch.forEach((key, index) => {
    const path = `/watch/${index}`;
    for (const { message } of chunkKeyIssues(key)) issues.push({ path, message });
    if (seen.has(key)) issues.push({ path, message: "the chunk is watched twice" });
    seen.add(key);
  });
  return issues;
}

/** The problems of a global value: its sealed genesis, its members, and its watch list. */
function validateGlobal(global: unknown): Issue[] {
  const issues = sealedGenesisIssues(global);
  if (!isRecord(global)) return issues;
  for (const key of Object.keys(global)) {
    if (!GLOBAL_MEMBERS.includes(key)) issues.push({ path: `/${key}`, message: "unknown member" });
  }
  return [...issues, ...watchIssues(global.watch)];
}

const CHUNK_MEMBERS = ["at", "terrain", "readings"];

/** Whether `value` is a safe integer of at least `min`. */
const isCount = (value: unknown, min: number) =>
  Number.isSafeInteger(value) && Number(value) >= min;

/** The problems of the members of a chunk record. */
function chunkMemberIssues(chunk: { readonly [key: string]: unknown }): Issue[] {
  const issues: Issue[] = [];
  for (const key of Object.keys(chunk)) {
    if (!CHUNK_MEMBERS.includes(key)) issues.push({ path: `/${key}`, message: "unknown member" });
  }
  if (!isCount(chunk.at, 1)) issues.push({ path: "/at", message: "must be a tick from 1" });
  if (typeof chunk.terrain !== "string" || !/^[0-9a-f]{32}$/.test(chunk.terrain)) {
    issues.push({ path: "/terrain", message: "must be a terrain digest, 32 hex digits" });
  }
  if (!isCount(chunk.readings, 0)) {
    issues.push({ path: "/readings", message: "must be a safe integer from 0" });
  }
  return issues;
}

/** The problems of a chunk: a key outside the world, and its schema. */
function validateChunk(key: ChunkKey, chunk: unknown): Issue[] {
  const issues = chunkKeyIssues(key);
  if (isRecord(chunk)) return [...issues, ...chunkMemberIssues(chunk)];
  const message = "a probe chunk must be a record { at, terrain, readings }";
  return [...issues, { path: "", message }];
}

/** A fresh probe ruleset whose chunks store the terrain digest that `terrainOf` gives. */
export function probeRulesetWith(terrainOf: TerrainOf): Ruleset<Value, Value> {
  return {
    versions: { ...PROBE_VERSIONS },
    systems: [{ name: "probe.daylight", streams: [], run: daylight }],
    commands: {
      "probe.materialize": materialize(terrainOf),
      "probe.measure": { check: checkMeasure, apply: applyMeasure },
    },
    validateGlobal,
    validateChunk,
  };
}

/** A fresh probe ruleset, the determinism suite's T3 subject. */
export function probeRuleset(): Ruleset<Value, Value> {
  return probeRulesetWith(generatedTerrain);
}
