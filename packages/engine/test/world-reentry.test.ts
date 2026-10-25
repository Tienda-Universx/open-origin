import { describe, expect, test } from "bun:test";
import {
  chunkHashes,
  EngineError,
  type EngineErrorCode,
  encodeSnapshot,
  fullChecksum,
  type Issue,
  readView,
  snapshotBytes,
  stateRoot,
  step,
  versionDifferences,
  type World,
  worldStatus,
} from "../src/index.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { type TrapPlace, trappedWorld } from "./support/trapped-world.ts";

/**
 * Reentry while a world is read (ADR 0020, ownership and failures): every function that reads a
 * value of the state, and so can run a Proxy's traps, marks the world busy while it reads. A use
 * of the world from a trap is then refused with world_busy, as during a step, and the world stays
 * as it was. A read that throws after it refused a use throws that first refusal and poisons
 * nothing; a read that completes is judged by its result.
 */

type Reader = {
  readonly api: string;
  /** What the refusal says the world is: "read", or "encoded" by the encoders. */
  readonly verb: string;
  readonly read: (world: World) => unknown;
  /** Where the Proxy must be for this read to run its traps. */
  readonly places: readonly TrapPlace[];
};

const READERS: readonly Reader[] = [
  { api: "fullChecksum", verb: "read", read: fullChecksum, places: ["chunk"] },
  {
    api: "view.readChunk",
    verb: "read",
    read: (world) => readView(world).readChunk("0,0"),
    places: ["chunk"],
  },
  {
    api: "view.readGlobal",
    verb: "read",
    read: (world) => readView(world).readGlobal(),
    places: ["global"],
  },
  { api: "encodeSnapshot", verb: "encoded", read: encodeSnapshot, places: ["chunk"] },
  { api: "snapshotBytes", verb: "encoded", read: snapshotBytes, places: ["chunk"] },
];

const CALLEES: readonly (readonly [string, (world: World) => unknown])[] = [
  ["step", (world) => step(world, [])],
  ["readView", readView],
  ["encodeSnapshot", encodeSnapshot],
];

const ROWS = READERS.flatMap((reader) =>
  CALLEES.map(([callee, call]) => [reader.api, callee, reader, call] as const),
);

/** The refusal of `callee` while `reader` reads the world. */
function refusal(callee: string, reader: Reader) {
  const message = `${callee} was called while ${reader.api} read this world: no function may use a world while it is ${reader.verb}`;
  return { code: "world_busy" as const, issues: [{ path: "", message }] };
}

/** What a refused use must leave unchanged, read with the hook unset. */
const observe = (world: World) => ({
  status: worldStatus(world),
  root: stateRoot(world),
  full: fullChecksum(world),
  text: encodeSnapshot(world),
});

/** The world of `reader`, what it reads there without a trap, and its observation. */
function setUp(reader: Reader) {
  const { world, hook } = trappedWorld(reader.places);
  return { world, hook, expected: reader.read(world), before: observe(world) };
}

/** The error that `reader` throws on `world`, as code and issues. */
function failure(reader: Reader, world: World) {
  const error = engineErrorOf(() => reader.read(world));
  return { code: error.code, issues: error.issues };
}

describe("a Proxy in the state that uses the world while it is read is refused", () => {
  test.each(ROWS)("%s refuses %s from a trap that catches it", (_api, callee, reader, call) => {
    const { world, hook, expected, before } = setUp(reader);
    let inner: unknown;
    hook.run = () => {
      try {
        call(world);
      } catch (error) {
        inner ??= error;
      }
    };
    expect(reader.read(world)).toEqual(expected);
    hook.run = undefined;
    expect(inner).toMatchObject(refusal(callee, reader));
    expect(observe(world)).toEqual(before);
  });

  test.each(ROWS)(
    "%s throws the refusal of %s that escapes the trap, and changes nothing",
    (_api, callee, reader, call) => {
      const { world, hook, expected, before } = setUp(reader);
      hook.run = () => call(world);
      expect(failure(reader, world)).toEqual(refusal(callee, reader));
      hook.run = undefined;
      expect(observe(world)).toEqual(before);
      expect(reader.read(world)).toEqual(expected);
    },
  );
});

/** Traps that fail after a refused step, in the ways that hide the refusal's identity. */
const AFTER_REFUSAL: readonly (readonly [string, (world: World) => void])[] = [
  [
    "catches the refusal and throws another value",
    (world) => {
      try {
        step(world, []);
      } catch {
        // Caught: the trap then fails in a way of its own.
      }
      throw new Error("trap");
    },
  ],
  [
    "rethrows a copy of the refusal",
    (world) => {
      try {
        step(world, []);
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
        throw new EngineError(error.code, error.issues);
      }
    },
  ],
  [
    "is refused twice, catches the first, and lets the second escape",
    (world) => {
      try {
        step(world, []);
      } catch {
        // The first refusal, of step, is caught; the second, of readView, escapes.
      }
      readView(world);
    },
  ],
];

const AFTER_ROWS = READERS.flatMap((reader) =>
  AFTER_REFUSAL.map(([what, trap]) => [reader.api, what, reader, trap] as const),
);

describe("a read that fails after it refused a use throws its first refusal", () => {
  test.each(AFTER_ROWS)("%s, when a trap %s", (_api, _what, reader, trap) => {
    const { world, hook, expected, before } = setUp(reader);
    hook.run = () => trap(world);
    expect(failure(reader, world)).toEqual(refusal("step", reader));
    hook.run = undefined;
    expect(observe(world)).toEqual(before);
    expect(reader.read(world)).toEqual(expected);
  });
});

describe("a trap that throws without using the world keeps each read's own classification", () => {
  const thrown = "the object threw while being read: Error: trap";
  const stale = `the chunk changed without writeChunk, and it is not canonical: at /inner: ${thrown}`;

  test.each<[string, Reader, { code: EngineErrorCode; issues: Issue[] }]>([
    [
      "fullChecksum: invalid_value at the value's path in the world",
      READERS[0] as Reader,
      { code: "invalid_value", issues: [{ path: "/chunks/0,0/inner", message: thrown }] },
    ],
    [
      "view.readChunk: invalid_value at the path in the chunk",
      READERS[1] as Reader,
      { code: "invalid_value", issues: [{ path: "/inner", message: thrown }] },
    ],
    [
      "view.readGlobal: invalid_value at the path in the global value",
      READERS[2] as Reader,
      { code: "invalid_value", issues: [{ path: "/inner", message: thrown }] },
    ],
    [
      "encodeSnapshot: integrity_violation, which poisons the world",
      READERS[3] as Reader,
      { code: "integrity_violation", issues: [{ path: "/chunks/0,0", message: stale }] },
    ],
  ])("%s", (_name, reader, expected) => {
    const { world, hook } = setUp(reader);
    hook.run = () => {
      throw new Error("trap");
    };
    expect(failure(reader, world)).toEqual(expected);
    const poisoned = expected.code === "integrity_violation";
    expect(worldStatus(world).kind).toBe(poisoned ? "faulted" : "ok");
  });
});

describe("functions that read no value of the state run no trap", () => {
  test.each<[string, (world: World) => unknown]>([
    ["chunkHashes", chunkHashes],
    ["stateRoot", stateRoot],
    ["worldStatus", worldStatus],
    ["versionDifferences", versionDifferences],
    ["view.chunkKeys", (world) => readView(world).chunkKeys()],
    ["view.tick", (world) => readView(world).tick],
  ])("%s", (_name, use) => {
    const { world, hook } = trappedWorld(["chunk", "global"]);
    hook.run = () => {
      throw new Error("a trap ran");
    };
    const reads = hook.reads;
    use(world);
    expect(hook.reads).toBe(reads);
  });
});
