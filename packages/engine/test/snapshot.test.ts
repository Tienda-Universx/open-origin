import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  decodeSnapshot,
  ENGINE_VERSION,
  encodeSnapshot,
  fullChecksum,
  readView,
  type Seed,
  snapshotBytes,
  stateRoot,
  step,
  type World,
  worldStatus,
} from "../src/index.ts";
import { worldState } from "../src/world/world.ts";
import { tallyRuleset, tallyWorld } from "./fixtures/tally-ruleset.ts";
import {
  BARRIER_CASES,
  BARRIER_ROWS,
  STALE_CHUNK,
  STALE_GLOBAL,
} from "./support/barrier-rulesets.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { Sfc32 } from "./support/sfc32.ts";
import { type Data, stepRuleset, stepWorld, system, writable } from "./support/step-rulesets.ts";
import { validCommands } from "./support/tally-fuzz.ts";

/**
 * Snapshot encoding (ADR 0020, snapshots and ownership; plan §2.2, §4, §8 "Ida y vuelta"): the
 * version 1 text, the round trip, the integrity check that finds writes behind the barrier
 * without audit, and isolation from the host.
 */

describe("encodeSnapshot", () => {
  test("writes version 1 as canonical text, with the header, the state root, and the world", () => {
    const world = stepWorld(stepRuleset());
    const expected = canonicalize({
      header: {
        snapshotSchemaVersion: 1,
        engineVersion: ENGINE_VERSION,
        rulesetVersion: "step-test@1",
        generatorVersion: "flat@1",
        brainVersion: "none@1",
      },
      stateRoot: stateRoot(world),
      world: {
        epoch: 0,
        tick: 0,
        nextEntityId: 1,
        rng: { algorithm: "ctr-mix32@1", seed: [1, 2] },
        config: { simSecondsPerTick: 60 },
        global: { population: 0 },
        chunks: { "0,0": { grass: 1 }, "1,0": { grass: 2 } },
      },
    });
    expect(encodeSnapshot(world)).toBe(expected);
  });

  test("snapshotBytes gives the UTF-8 bytes of the same text, in a fresh array each time", () => {
    const world = tallyWorld([3, 4]);
    for (let tick = 1; tick <= 5; tick += 1) step(world, []);
    const bytes = snapshotBytes(world);
    expect(bytes).toEqual(new TextEncoder().encode(encodeSnapshot(world)));
    expect(snapshotBytes(world)).not.toBe(bytes);
  });
});

/** A tally world of `seed` after a random number of ticks with random valid commands. */
function fuzzedWorld(seed: number): World {
  const random = new Sfc32(seed);
  const worldSeed: Seed = [random.next(), random.next()];
  const world = tallyWorld(worldSeed);
  const ticks = random.below(61);
  for (let tick = 1; tick <= ticks; tick += 1) step(world, validCommands(random, tick));
  return world;
}

describe("encode, decode, encode", () => {
  test("is byte-identical on 40 fuzzed tally worlds, with equal roots", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const world = fuzzedWorld(seed);
      const text = encodeSnapshot(world);
      const decoded = decodeSnapshot(text, tallyRuleset());
      expect(encodeSnapshot(decoded)).toBe(text);
      expect(stateRoot(decoded)).toBe(stateRoot(world));
      expect(fullChecksum(decoded)).toBe(fullChecksum(world));
      expect(worldStatus(decoded)).toEqual(worldStatus(world));
      expect(snapshotBytes(decoded)).toEqual(new TextEncoder().encode(text));
    }
  });
});

describe("an epoch other than 0", () => {
  test("round-trips, and a decoded world steps on in it", () => {
    const world = tallyWorld([11, 12]);
    step(world, []);
    // Opening an epoch arrives with T7: here the engine's internals set one, as it will.
    const state = worldState(world);
    state.kernel.epoch = 7;
    state.digests.stateRoot = fullChecksum(world);
    const text = encodeSnapshot(world);
    expect(text).toContain(',"epoch":7,');
    const decoded = decodeSnapshot(text, tallyRuleset());
    expect(encodeSnapshot(decoded)).toBe(text);
    expect(step(decoded, [])).toEqual(step(world, []));
  });
});

describe("encoding finds writes behind the barrier without audit", () => {
  test.each(BARRIER_ROWS)(
    "%s: integrity_violation, poisoned, and no text",
    (_name, { ruleset, lag, issues }) => {
      const at = 3;
      const world = stepWorld(ruleset(at));
      const tick = at + lag;
      for (let ticks = 1; ticks <= tick; ticks += 1) step(world, []);
      expect(worldStatus(world)).toEqual({ kind: "ok", tick });
      let text: string | undefined;
      const error = engineErrorOf(() => {
        text = encodeSnapshot(world);
      });
      expect({ code: error.code, issues: error.issues }).toEqual({
        code: "integrity_violation",
        issues,
      });
      expect(text).toBeUndefined();
      expect(worldStatus(world)).toEqual({
        kind: "faulted",
        tick,
        code: "integrity_violation",
        issues,
      });
      expect(engineErrorOf(() => snapshotBytes(world)).code).toBe("world_faulted");
    },
  );

  test("every stale chunk and the global value are named, at encoding and by audit", () => {
    const ruleset = stepRuleset([
      system("sneaky", (ctx) => {
        for (const key of ["0,0", "1,0"]) (ctx.readChunk(key) as Data).grass = 50;
        (ctx.readGlobal() as Data).population = 50;
      }),
    ]);
    const issues = [
      { path: "/chunks/0,0", message: STALE_CHUNK },
      { path: "/chunks/1,0", message: STALE_CHUNK },
      { path: "/global", message: STALE_GLOBAL },
    ];
    const plain = stepWorld(ruleset);
    step(plain, []);
    const encoding = engineErrorOf(() => encodeSnapshot(plain));
    expect({ code: encoding.code, issues: encoding.issues }).toEqual({
      code: "integrity_violation",
      issues,
    });
    const audited = engineErrorOf(() => step(stepWorld(ruleset, {}, true), []));
    expect({ code: audited.code, issues: audited.issues }).toEqual({
      code: "integrity_violation",
      issues,
    });
  });

  test("snapshotBytes runs the same check", () => {
    const [first] = BARRIER_CASES;
    if (first === undefined) throw new Error("no barrier case");
    const { ruleset, issues } = first;
    const world = stepWorld(ruleset(1));
    step(world, []);
    const error = engineErrorOf(() => snapshotBytes(world));
    expect({ code: error.code, issues: error.issues }).toEqual({
      code: "integrity_violation",
      issues,
    });
  });
});

/**
 * A world whose chunk 0,0 holds, from tick 1, a Proxy whose trap runs `hook.run` on every read of
 * a property, and the snapshot text it has while the hook is unset.
 */
function trappedWorld() {
  const hook: { run: (() => void) | undefined } = { run: undefined };
  const world = stepWorld(
    stepRuleset([
      system("trapper", (ctx) => {
        if (ctx.tick !== 1) return;
        writable(ctx, "0,0").inner = new Proxy<Data>(
          { a: 1 },
          {
            getOwnPropertyDescriptor(target, key) {
              hook.run?.();
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          },
        );
      }),
    ]),
  );
  step(world, []);
  return { world, hook, text: encodeSnapshot(world) };
}

const ENCODERS = [
  ["encodeSnapshot", encodeSnapshot],
  ["snapshotBytes", (world: World) => new TextDecoder().decode(snapshotBytes(world))],
] as const;

/** The refusal of a step made while `api` encodes the world. */
const refusedStep = (api: string) => ({
  code: "world_busy" as const,
  issues: [
    {
      path: "",
      message: `step was called while ${api} read this world: no function may use a world while it is encoded`,
    },
  ],
});

describe("a world is busy while it is encoded", () => {
  test.each(ENCODERS)(
    "a Proxy in the state whose trap steps the world during %s is refused",
    (api, encode) => {
      const { world, hook, text } = trappedWorld();
      let inner: unknown;
      hook.run = () => {
        try {
          step(world, []);
        } catch (error) {
          inner = error;
        }
      };
      expect(encode(world)).toBe(text);
      hook.run = undefined;
      expect(inner).toMatchObject(refusedStep(api));
      expect(worldStatus(world)).toEqual({ kind: "ok", tick: 1 });
    },
  );

  test.each(ENCODERS)(
    "a refusal that escapes the trap fails %s with world_busy, not an integrity violation",
    (api, encode) => {
      const { world, hook, text } = trappedWorld();
      hook.run = () => step(world, []);
      let encoded: string | undefined;
      const error = engineErrorOf(() => {
        encoded = encode(world);
      });
      expect({ code: error.code, issues: error.issues }).toEqual(refusedStep(api));
      expect(encoded).toBeUndefined();
      expect(worldStatus(world)).toEqual({ kind: "ok", tick: 1 });
      hook.run = undefined;
      expect(encode(world)).toBe(text);
    },
  );

  const throwers: [string, (world: World) => void][] = [
    [
      "throws",
      () => {
        throw new Error("trap");
      },
    ],
    [
      "catches the refusal and then throws",
      (world) => {
        try {
          step(world, []);
        } catch {
          // The refusal is caught; what the trap throws next is what reading the value gives.
        }
        throw new Error("trap");
      },
    ],
  ];
  const throwingRows = ENCODERS.flatMap(([api, encode]) =>
    throwers.map(([what, thrower]) => [api, what, encode, thrower] as const),
  );

  test.each(throwingRows)(
    "during %s, a trap that %s leaves a value that is not canonical",
    (_api, _what, encode, thrower) => {
      const { world, hook } = trappedWorld();
      hook.run = () => thrower(world);
      const issues = [
        {
          path: "/chunks/0,0",
          message:
            "the chunk changed without writeChunk, and it is not canonical: at /inner: the object threw while being read: Error: trap",
        },
      ];
      const error = engineErrorOf(() => encode(world));
      expect({ code: error.code, issues: error.issues }).toEqual({
        code: "integrity_violation",
        issues,
      });
      expect(worldStatus(world)).toEqual({
        kind: "faulted",
        tick: 1,
        code: "integrity_violation",
        issues,
      });
    },
  );
});

describe("snapshots share nothing with the host", () => {
  test("changing the bytes after encoding changes neither the world nor later bytes", () => {
    const world = tallyWorld([5, 6]);
    step(world, []);
    const root = stateRoot(world);
    const bytes = snapshotBytes(world);
    const copy = bytes.slice();
    bytes.fill(0);
    expect(snapshotBytes(world)).toEqual(copy);
    expect(stateRoot(world)).toBe(root);
  });

  test("changing the ruleset after decoding changes nothing", () => {
    const text = encodeSnapshot(tallyWorld([7, 8]));
    const ruleset = tallyRuleset();
    const decoded = decodeSnapshot(text, ruleset);
    const control = decodeSnapshot(text, tallyRuleset());
    const mutable = ruleset as unknown as { systems: unknown[]; versions: Data; commands: Data };
    mutable.systems.length = 0;
    mutable.versions.ruleset = "other@1";
    mutable.commands.plant = 0;
    const commands = [
      {
        applyTick: 1,
        seq: 0,
        type: "plant",
        origin: { kind: "admin" },
        payload: { at: "0,0", amount: 3 },
      },
    ] as const;
    expect(step(decoded, commands)).toEqual(step(control, commands));
    expect(encodeSnapshot(decoded)).toBe(encodeSnapshot(control));
  });

  test("two worlds decoded from one text are independent", () => {
    const text = encodeSnapshot(tallyWorld([9, 10]));
    const first = decodeSnapshot(text, tallyRuleset());
    const second = decodeSnapshot(text, tallyRuleset());
    step(first, []);
    expect(encodeSnapshot(second)).toBe(text);
    expect(readView(second).tick).toBe(0);
  });
});
