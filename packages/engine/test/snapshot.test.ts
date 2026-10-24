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
import { tallyRuleset, tallyWorld } from "./fixtures/tally-ruleset.ts";
import { BARRIER_CASES, bypassTick } from "./support/barrier-rulesets.ts";
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

describe("encoding finds writes behind the barrier without audit", () => {
  test.each(BARRIER_CASES)(
    "%s: integrity_violation, poisoned, and no text",
    (name, ruleset, issues) => {
      const at = 3;
      const world = stepWorld(ruleset(at));
      const tick = bypassTick(name, at);
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

  test("snapshotBytes runs the same check", () => {
    const [, ruleset, issues] = BARRIER_CASES[0] ?? [];
    if (ruleset === undefined || issues === undefined) throw new Error("no barrier case");
    const world = stepWorld(ruleset(1));
    step(world, []);
    const error = engineErrorOf(() => snapshotBytes(world));
    expect({ code: error.code, issues: error.issues }).toEqual({
      code: "integrity_violation",
      issues,
    });
  });
});

describe("a world is busy while it is encoded", () => {
  test("a Proxy in the state whose trap steps the world is refused, and the text is unchanged", () => {
    let hook: (() => void) | undefined;
    const world = stepWorld(
      stepRuleset([
        system("trapper", (ctx) => {
          if (ctx.tick !== 1) return;
          writable(ctx, "0,0").inner = new Proxy<Data>(
            { a: 1 },
            {
              getOwnPropertyDescriptor(target, key) {
                hook?.();
                return Reflect.getOwnPropertyDescriptor(target, key);
              },
            },
          );
        }),
      ]),
    );
    step(world, []);
    const before = encodeSnapshot(world);
    let inner: unknown;
    hook = () => {
      try {
        step(world, []);
      } catch (error) {
        inner = error;
      }
    };
    expect(encodeSnapshot(world)).toBe(before);
    hook = undefined;
    expect(inner).toMatchObject({
      code: "world_busy",
      issues: [
        {
          path: "",
          message:
            "step was called while encodeSnapshot read this world: no function may use a world while it is encoded",
        },
      ],
    });
    expect(worldStatus(world)).toEqual({ kind: "ok", tick: 1 });
  });
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
