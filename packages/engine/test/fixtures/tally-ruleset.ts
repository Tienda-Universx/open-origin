import {
  type CanonicalValue,
  type Command,
  type CommandOrigin,
  createWorld,
  type Issue,
  parseChunkKey,
  type ReadView,
  type Rejection,
  type Ruleset,
  type Seed,
  type TickContext,
  type World,
} from "../../src/index.ts";

/**
 * tally: a deterministic ruleset for the golden, fuzz, and isolation tests (plan §8). Its parts
 * exercise what a real ruleset will do:
 *
 * - four systems in a fixed order, three of them drawing from streams of their own;
 * - commands whose `check` rejects (a missing chunk, too much, an empty name), one with a stream;
 * - a chunk created every 7 ticks, in the middle of a run, with an id from newEntityId;
 * - a permutation that orders the chunks contending for a market each tick;
 * - events from systems and handlers;
 * - text with non-ASCII and astral characters, written as escapes; records whose keys look like
 *   integers, inserted out of canonical order; and integers near 2^53 in magnitude.
 *
 * It keeps no module state: everything it computes comes from the world, the commands, and its
 * draws, so worlds that share it in one process never affect each other.
 */

type Value = CanonicalValue;
type Ctx = TickContext<Value, Value>;

/** A chunk of tally. */
type TallyChunk = {
  id: number;
  label: string;
  tally: number;
  counts: { [bucket: string]: number };
  depth: number;
};

/** The global value of tally. */
type TallyGlobal = {
  census: number;
  ledger: number;
  markets: number;
  names: { [entity: string]: string };
  born: number[];
};

export const TALLY_VERSIONS = { ruleset: "tally@1", generator: "tally-grid@1", brain: "none@1" };

/** The largest amount one plant command may add to a chunk. */
const MAX_PLANT = 100;

/** How many buckets a chunk's counts have: keys "0" to "11", which sort as text, not numbers. */
const BUCKETS = 12;

/** How many chunks at most contend for a market. */
const BIDDERS = 6;

/** Where the ledger starts: close to 2^53, with room for every tick's sales and prizes. */
const LEDGER_START = Number.MAX_SAFE_INTEGER - 10_000_000;

/** Labels and names with non-ASCII and astral characters, all in NFC. */
export const LABELS = ["meadow", "pr\u00e9", "\u68ee", "\u{1F331} sprout", "caf\u00e9 \u{1F375}"];
export const NAMES = ["Ana", "Zo\u00eb", "\u674e\u534e", "\u{1F98A}", "\u00c5sa \u{10348}"];

const chunkOf = (ctx: Ctx, key: string) => ctx.writeChunk(key) as TallyChunk;
const globalOf = (ctx: Ctx) => ctx.writeGlobal() as TallyGlobal;

/** Adds one to the bucket of `chunk`'s tally, inserting the bucket key where it first appears. */
function count(chunk: TallyChunk): void {
  const bucket = `${chunk.tally % BUCKETS}`;
  chunk.counts[bucket] = (chunk.counts[bucket] ?? 0) + 1;
}

/** Three chunks drawn at random grow by 1 to 3. */
function growth(ctx: Ctx): undefined {
  const keys = ctx.chunkKeys();
  for (let round = 0; round < 3; round += 1) {
    const key = keys[ctx.random.int("growth", 0, keys.length)] as string;
    const chunk = chunkOf(ctx, key);
    chunk.tally += 1 + ctx.random.int("growth", chunk.id, 3);
    count(chunk);
  }
  return undefined;
}

/** Every 7 ticks, a new chunk settles at a random x on the row of the tick. */
function migration(ctx: Ctx): undefined {
  const { tick } = ctx;
  if (tick % 7 !== 3) return undefined;
  const key = `${ctx.random.int("migration", 0, 2001) - 1000},${tick}`;
  const id = ctx.newEntityId();
  const label = LABELS[tick % LABELS.length] as string;
  const depth = -(Number.MAX_SAFE_INTEGER - tick);
  ctx.createChunk(key, { id, label, tally: 0, counts: {}, depth });
  ctx.emit("migrated", { key, id, label });
  return undefined;
}

/** The first chunks contend for one of 5 markets; a permutation orders them, and the first sells. */
function market(ctx: Ctx): undefined {
  const keys = ctx.chunkKeys().slice(0, BIDDERS);
  const resource = ctx.tick % 5;
  const order = ctx.random.permutation("market", resource, keys.length);
  const winner = keys[order[0] as number] as string;
  chunkOf(ctx, winner).tally += 2;
  const global = globalOf(ctx);
  global.ledger += 1 + (order[0] as number);
  global.markets += 1;
  ctx.emit("market.sold", { resource, order, winner });
  return undefined;
}

/** Counts the chunks, from the world alone. */
function census(ctx: Ctx): undefined {
  const chunks = ctx.chunkKeys().length;
  globalOf(ctx).census = chunks;
  if (ctx.tick % 10 === 0) ctx.emit("census", { chunks, tick: ctx.tick });
  return undefined;
}

/** The payload of `command` as a record, or an empty one. */
function payloadOf(command: Command): { readonly [key: string]: Value } {
  const { payload } = command;
  if (typeof payload !== "object" || Array.isArray(payload)) return {};
  // Array.isArray does not narrow a readonly array type: what is left is a canonical record.
  return payload as { readonly [key: string]: Value };
}

/** The acting entity: the inhabitant who sent `origin`, or 0 for the admin plane. */
const actorOf = (origin: CommandOrigin) => (origin.kind === "inhabitant" ? origin.actor : 0);

/** Whether `at` is a chunk key: a key from a command is checked before the world is read with it. */
function isChunkKey(at: Value | undefined): at is string {
  try {
    parseChunkKey(at as string);
    return true;
  } catch {
    return false;
  }
}

function checkPlant(view: ReadView<Value, Value>, command: Command): Rejection | undefined {
  const { at, amount } = payloadOf(command);
  if (!isChunkKey(at) || view.readChunk(at) === undefined) {
    return { reason: "no_chunk", details: { at: typeof at === "string" ? at : "" } };
  }
  if (typeof amount !== "number" || amount < 1 || amount > MAX_PLANT) {
    return { reason: "too_much", details: { max: MAX_PLANT } };
  }
  return undefined;
}

function applyPlant(ctx: Ctx, command: Command): undefined {
  const { at, amount } = payloadOf(command);
  const chunk = chunkOf(ctx, at as string);
  chunk.tally += amount as number;
  count(chunk);
  return undefined;
}

function checkName(_view: ReadView<Value, Value>, command: Command): Rejection | undefined {
  const { entity, name } = payloadOf(command);
  if (typeof name !== "string" || name === "") return { reason: "empty_name" };
  return typeof entity === "number" ? undefined : { reason: "no_entity" };
}

function applyName(ctx: Ctx, command: Command): undefined {
  const { entity, name } = payloadOf(command);
  globalOf(ctx).names[`${entity}`] = name as string;
  return undefined;
}

function applyBirth(ctx: Ctx, command: Command): undefined {
  const id = ctx.newEntityId();
  globalOf(ctx).born.push(id);
  ctx.emit("born", { id, parent: actorOf(command.origin) });
  return undefined;
}

function applyLottery(ctx: Ctx, command: Command): undefined {
  const actor = actorOf(command.origin);
  const prize = ctx.random.int("lottery", actor, 1000);
  globalOf(ctx).ledger += prize;
  ctx.emit("lottery.won", { actor, prize });
  return undefined;
}

function validateChunk(_key: string, chunk: unknown): Issue[] {
  const { tally, label } = chunk as TallyChunk;
  const issues: Issue[] = [];
  if (!Number.isSafeInteger(tally) || tally < 0) issues.push({ path: "/tally", message: "bad" });
  if (typeof label !== "string") issues.push({ path: "/label", message: "not text" });
  return issues;
}

function validateGlobal(global: unknown): Issue[] {
  const { census: chunks } = global as TallyGlobal;
  return chunks >= 0 ? [] : [{ path: "/census", message: "negative" }];
}

const accept = () => undefined;

/** A fresh tally ruleset. */
export function tallyRuleset(): Ruleset<Value, Value> {
  return {
    versions: { ...TALLY_VERSIONS },
    systems: [
      { name: "growth", streams: ["growth"], run: growth },
      { name: "migration", streams: ["migration"], run: migration },
      { name: "market", streams: ["market"], run: market },
      { name: "census", streams: [], run: census },
    ],
    commands: {
      plant: { check: checkPlant, apply: applyPlant },
      name: { check: checkName, apply: applyName },
      birth: { check: accept, apply: applyBirth },
      lottery: { streams: ["lottery"], check: accept, apply: applyLottery },
    },
    validateChunk,
    validateGlobal,
  };
}

/**
 * A tally world at tick 0 with `seed`: four chunks with negative ids, inserted out of order, and
 * `ruleset`, a fresh tally ruleset unless given.
 */
export function tallyWorld(seed: Seed, audit = false, ruleset = tallyRuleset()): World {
  const chunk = (id: number, label: string): TallyChunk => ({
    id,
    label,
    tally: 0,
    counts: { "10": 0, "2": 0 },
    depth: -Number.MAX_SAFE_INTEGER,
  });
  const global: TallyGlobal = {
    census: 4,
    ledger: LEDGER_START,
    markets: 0,
    names: { "10": "Ten", "9": "Nine" },
    born: [],
  };
  return createWorld(
    {
      seed,
      simSecondsPerTick: 60,
      global,
      chunks: {
        "1,0": chunk(-2, LABELS[1] as string),
        "-1,0": chunk(-1, LABELS[0] as string),
        "0,1": chunk(-4, LABELS[3] as string),
        "0,0": chunk(-3, LABELS[2] as string),
      },
      ruleset,
    },
    { audit },
  );
}

/** A command for `tick` with `seq`, from `origin`. */
function tallyCommand(tick: number, seq: number, type: string, payload: Value): Command {
  const origin: CommandOrigin =
    seq % 2 === 0 ? { kind: "admin" } : { kind: "inhabitant", actor: (tick % 9) + 1 };
  return { applyTick: tick, seq, type, origin, payload };
}

/** The scripted commands of the golden run at `tick`, valid and in seq order. */
export function tallyCommands(tick: number): Command[] {
  const commands: Command[] = [
    tallyCommand(tick, 0, "plant", { at: "0,0", amount: (tick % 7) + 1 }),
  ];
  if (tick % 3 === 0) commands.push(tallyCommand(tick, 1, "plant", { at: "9,9", amount: 1 }));
  if (tick % 5 === 0) commands.push(tallyCommand(tick, 2, "plant", { at: "1,0", amount: 500 }));
  if (tick % 11 === 0) {
    const name = NAMES[tick % NAMES.length] as string;
    commands.push(tallyCommand(tick, 3, "name", { entity: (tick % 4) + 1, name }));
  }
  if (tick % 17 === 0) commands.push(tallyCommand(tick, 4, "name", { entity: 1, name: "" }));
  if (tick % 13 === 0) commands.push(tallyCommand(tick, 5, "birth", {}));
  if (tick % 19 === 0) commands.push(tallyCommand(tick, 6, "name", { entity: "one", name: "Ana" }));
  if (tick % 2 === 0) commands.push(tallyCommand(tick, 7, "lottery", {}));
  if (tick % 97 === 0) commands.push(tallyCommand(tick, 8, "unknown.command", [tick]));
  return commands;
}
