import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  decodeSnapshot,
  type EngineErrorCode,
  encodeSnapshot,
  fullChecksum,
  type Issue,
  stateRoot,
  step,
  worldStatus,
} from "../src/index.ts";
import { STALE_CHUNK, STALE_GLOBAL } from "./support/barrier-rulesets.ts";
import { engineErrorOf } from "./support/engine-error.ts";
import { revokedProxy } from "./support/revoked.ts";
import {
  type Data,
  type StepRuleset,
  stepRuleset,
  stepWorld,
  system,
} from "./support/step-rulesets.ts";

/**
 * Snapshot decoding (ADR 0020, snapshots; plan §4, §5.2 "Versiones", §8 "Ida y vuelta"): only
 * canonical text, the schema gate with every problem at once, then the ruleset's validators and
 * the state root, also all at once.
 */

/** A snapshot as a mutable tree, to break one part of it. */
type Tree = { [key: string]: Tree | number | string | boolean | Tree[] | number[] };

const world = stepWorld(stepRuleset());
step(world, []);
const TEXT = encodeSnapshot(world);
const ROOT = stateRoot(world);

/** The canonical text of the snapshot with `change` made to its tree. */
function changed(change: (snapshot: Tree) => void): string {
  const snapshot = JSON.parse(TEXT) as Tree;
  change(snapshot);
  return canonicalize(snapshot);
}

const part = (snapshot: Tree, key: string) => snapshot[key] as Tree;
const header = (snapshot: Tree) => part(snapshot, "header");
const worldOf = (snapshot: Tree) => part(snapshot, "world");

/** The code and issues of decoding `text` with `ruleset`, which must throw. */
function rejection(text: unknown, ruleset: StepRuleset = stepRuleset()) {
  const error = engineErrorOf(() => decodeSnapshot(text as string, ruleset));
  return { code: error.code, issues: error.issues };
}

const invalid = (issues: Issue[]): { code: EngineErrorCode; issues: Issue[] } => ({
  code: "invalid_snapshot",
  issues,
});

const MISSING = "the member is missing";
const EXTRA = "the member is not part of a version 1 snapshot";

describe("the schema version", () => {
  test.each([0, 2])("%d is unsupported_schema, reported alone", (version) => {
    const text = changed((snapshot) => {
      header(snapshot).snapshotSchemaVersion = version;
      worldOf(snapshot).regions = 1;
    });
    expect(rejection(text)).toEqual({
      code: "unsupported_schema",
      issues: [
        {
          path: "/header/snapshotSchemaVersion",
          message: `${version} is not a supported snapshot schema version: this engine reads version 1`,
        },
      ],
    });
  });

  test.each([
    ["an extra member at the top", (snapshot: Tree) => (snapshot.regions = 1)],
    ["a missing member at the top", (snapshot: Tree) => delete snapshot.stateRoot],
  ])("version 2 with %s is unsupported_schema: the version is gated first", (_name, change) => {
    const text = changed((snapshot) => {
      header(snapshot).snapshotSchemaVersion = 2;
      change(snapshot);
    });
    expect(rejection(text).code).toBe("unsupported_schema");
  });

  test("a version that is not a number is unsupported too", () => {
    const text = changed((snapshot) => {
      header(snapshot).snapshotSchemaVersion = "1";
    });
    expect(rejection(text).code).toBe("unsupported_schema");
  });

  test("a missing version, or a header that is not a record, is an invalid snapshot", () => {
    const missing = changed((snapshot) => {
      delete header(snapshot).snapshotSchemaVersion;
    });
    expect(rejection(missing)).toEqual(
      invalid([{ path: "/header/snapshotSchemaVersion", message: MISSING }]),
    );
    const notRecord = changed((snapshot) => {
      snapshot.header = [1];
    });
    expect(rejection(notRecord)).toEqual(
      invalid([{ path: "/header", message: "the header must be a record" }]),
    );
  });
});

describe("the schema gate", () => {
  test("reports every missing and extra member, at every level, at once", () => {
    const text = changed((snapshot) => {
      snapshot.extra = 1;
      delete header(snapshot).brainVersion;
      header(snapshot).extra = 1;
      const data = worldOf(snapshot);
      delete data.epoch;
      data.extra = 1;
      delete part(data, "rng").seed;
      part(data, "rng").extra = 1;
      delete part(data, "config").simSecondsPerTick;
      part(data, "config").extra = 1;
    });
    expect(rejection(text)).toEqual(
      invalid([
        { path: "/extra", message: EXTRA },
        { path: "/header/brainVersion", message: MISSING },
        { path: "/header/extra", message: EXTRA },
        { path: "/world/epoch", message: MISSING },
        { path: "/world/extra", message: EXTRA },
        { path: "/world/rng/seed", message: MISSING },
        { path: "/world/rng/extra", message: EXTRA },
        { path: "/world/config/simSecondsPerTick", message: MISSING },
        { path: "/world/config/extra", message: EXTRA },
      ]),
    );
  });

  test("reports in schema order: at each record, missing members first, then extra ones", () => {
    const text = changed((snapshot) => {
      const data = worldOf(snapshot);
      delete data.tick;
      delete data.config;
      data.aaa = 1;
    });
    expect(rejection(text).issues).toEqual([
      { path: "/world/tick", message: MISSING },
      { path: "/world/config", message: MISSING },
      { path: "/world/aaa", message: EXTRA },
    ]);
  });

  test("a snapshot that is not a record, and members that are missing at the top", () => {
    expect(rejection("[]")).toEqual(
      invalid([
        { path: "", message: "the snapshot must be a record { header, stateRoot, world }" },
      ]),
    );
    const text = changed((snapshot) => {
      delete snapshot.stateRoot;
      delete snapshot.world;
    });
    expect(rejection(text)).toEqual(
      invalid([
        { path: "/stateRoot", message: MISSING },
        { path: "/world", message: MISSING },
      ]),
    );
  });

  const fields: [string, (snapshot: Tree) => void, Issue[]][] = [
    [
      "a version that is not a string",
      (snapshot) => {
        header(snapshot).engineVersion = 1;
      },
      [{ path: "/header/engineVersion", message: "the version must be a string, not number" }],
    ],
    [
      "an empty version",
      (snapshot) => {
        header(snapshot).rulesetVersion = "";
      },
      [{ path: "/header/rulesetVersion", message: "the version must not be empty" }],
    ],
    [
      "a state root that is not a digest",
      (snapshot) => {
        snapshot.stateRoot = ROOT.slice(1);
      },
      [
        {
          path: "/stateRoot",
          message: "the state root must be a digest: 32 lowercase hexadecimal digits",
        },
      ],
    ],
    [
      "a state root in uppercase",
      (snapshot) => {
        snapshot.stateRoot = "A".repeat(32);
      },
      [
        {
          path: "/stateRoot",
          message: "the state root must be a digest: 32 lowercase hexadecimal digits",
        },
      ],
    ],
    [
      "a negative epoch",
      (snapshot) => {
        worldOf(snapshot).epoch = -1;
      },
      [{ path: "/world/epoch", message: "-1 is not an epoch: epochs are safe integers from 0" }],
    ],
    [
      "a tick that is not a tick",
      (snapshot) => {
        worldOf(snapshot).tick = "one";
      },
      [
        {
          path: "/world/tick",
          message: "a value of type string is not a tick: ticks are safe integers from 0",
        },
      ],
    ],
    [
      "a next entity id of 0",
      (snapshot) => {
        worldOf(snapshot).nextEntityId = 0;
      },
      [
        {
          path: "/world/nextEntityId",
          message: "0 is not an entity id: the next entity id is a safe integer from 1",
        },
      ],
    ],
    [
      "another random algorithm",
      (snapshot) => {
        part(worldOf(snapshot), "rng").algorithm = "ctr-mix32@2";
      },
      [
        {
          path: "/world/rng/algorithm",
          message: 'the random algorithm must be "ctr-mix32@1", the only one this engine runs',
        },
      ],
    ],
    [
      "a seed of one word",
      (snapshot) => {
        part(worldOf(snapshot), "rng").seed = [1];
      },
      [{ path: "/world/rng/seed", message: "the seed must be an array of two words" }],
    ],
    [
      "a seed word beyond u32",
      (snapshot) => {
        part(worldOf(snapshot), "rng").seed = [1, 2 ** 32];
      },
      [{ path: "/world/rng/seed/1", message: "4294967296 is not an integer in [0, 4294967295]" }],
    ],
    [
      "zero seconds per tick",
      (snapshot) => {
        part(worldOf(snapshot), "config").simSecondsPerTick = 0;
      },
      [
        {
          path: "/world/config/simSecondsPerTick",
          message: "0 seconds per tick is not a positive safe integer",
        },
      ],
    ],
    [
      "chunks that are not a record",
      (snapshot) => {
        worldOf(snapshot).chunks = [1];
      },
      [{ path: "/world/chunks", message: "the chunks must be a record of chunks by chunk key" }],
    ],
    [
      "chunk keys that are not chunk keys",
      (snapshot) => {
        const chunks = part(worldOf(snapshot), "chunks");
        chunks["01,0"] = 1;
        chunks.x = 2;
      },
      [
        {
          path: "/world/chunks/01,0",
          message: "the x of the chunk key is not a safe integer in canonical decimal",
        },
        {
          path: "/world/chunks/x",
          message: 'the chunk key must be two integers joined by one comma, as in "-1,0"',
        },
      ],
    ],
  ];

  test.each(fields)("rejects %s", (_name, change, issues) => {
    expect(rejection(changed(change))).toEqual(invalid(issues));
  });

  test("reports problems of different members together", () => {
    const text = changed((snapshot) => {
      worldOf(snapshot).epoch = -1;
      part(worldOf(snapshot), "rng").algorithm = "x";
      header(snapshot).brainVersion = "";
    });
    expect(rejection(text).issues.map(({ path }) => path)).toEqual([
      "/header/brainVersion",
      "/world/epoch",
      "/world/rng/algorithm",
    ]);
  });
});

describe("only canonical text is decoded", () => {
  const offsets: [string, string][] = [
    ["whitespace", TEXT.replace('"header":', '"header": ')],
    [
      "reordered keys",
      TEXT.replace(/^\{("header":\{[^}]*\}),("stateRoot":"[0-9a-f]{32}")/, "{$2,$1"),
    ],
  ];

  test.each(offsets)("rejects %s as invalid_snapshot", (_name, text) => {
    expect(text).not.toBe(TEXT);
    const { code, issues } = rejection(text);
    expect(code).toBe("invalid_snapshot");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toStartWith("the text is not canonical: it first differs");
  });

  test("rejects a float, with its path", () => {
    const text = TEXT.replace('"tick":1', '"tick":1.5');
    expect(rejection(text)).toEqual(
      invalid([{ path: "/world/tick", message: "1.5 is not a safe integer" }]),
    );
  });

  test("keeps the true count of the parser's issues beyond the 50 it keeps", () => {
    const floats = `[${Array.from({ length: 60 }, () => "0.5").join(",")}]`;
    const text = TEXT.replace('"global":{"population":0}', `"global":${floats}`);
    const error = engineErrorOf(() => decodeSnapshot(text, stepRuleset()));
    expect(error.code).toBe("invalid_snapshot");
    expect(error.issues).toHaveLength(50);
    expect(error.issueCount).toBe(60);
    expect(error.message).toEndWith("; 60 issues in all, 10 dropped beyond the first 50");
  });

  test("rejects text that is not JSON, and a value that is not text", () => {
    expect(rejection("{").code).toBe("invalid_snapshot");
    expect(rejection(7)).toEqual(
      invalid([{ path: "", message: "the canonical text must be a string, not number" }]),
    );
  });
});

describe("after the schema, the ruleset and the state root", () => {
  test("a tampered state root names both roots", () => {
    const other = `${ROOT.slice(0, 31)}${ROOT.endsWith("0") ? "1" : "0"}`;
    const text = changed((snapshot) => {
      snapshot.stateRoot = other;
    });
    expect(rejection(text)).toEqual(
      invalid([
        {
          path: "/stateRoot",
          message: `the state root ${other} is not ${ROOT}, the root of the state the snapshot holds`,
        },
      ]),
    );
  });

  test("a changed value, with its root unchanged, fails the root check", () => {
    const text = changed((snapshot) => {
      part(part(worldOf(snapshot), "chunks"), "0,0").grass = 5;
    });
    expect(rejection(text).issues.map(({ path }) => path)).toEqual(["/stateRoot"]);
  });

  test("the validators run on the global value and every chunk, with the root, at once", () => {
    const strict: StepRuleset = {
      ...stepRuleset(),
      validateGlobal: (value) =>
        (value as Data).population === 0 ? [{ path: "", message: "empty" }] : [],
      validateChunk: (key, value) =>
        (value as Data).grass === 2 ? [{ path: "/grass", message: `too much in ${key}` }] : [],
    };
    const tampered = changed((snapshot) => {
      snapshot.stateRoot = "0".repeat(32);
    });
    expect(rejection(tampered, strict)).toEqual(
      invalid([
        { path: "/world/global", message: "empty" },
        { path: "/world/chunks/1,0/grass", message: "too much in 1,0" },
        {
          path: "/stateRoot",
          message: `the state root ${"0".repeat(32)} is not ${ROOT}, the root of the state the snapshot holds`,
        },
      ]),
    );
  });

  test("validators that change what they check are detected, not prevented, as in createWorld", () => {
    let kept: Data | undefined;
    const meddling: StepRuleset = {
      ...stepRuleset(),
      validateGlobal: (value) => {
        (value as Data).population = 5;
        return [];
      },
      validateChunk: (key, value) => {
        if (key === "0,0") kept = value as Data;
        else if (kept !== undefined) kept.grass = 99;
        (value as Data).checked = true;
        return [];
      },
    };
    const decoded = decodeSnapshot(TEXT, meddling);
    expect(stateRoot(decoded)).toBe(ROOT);
    expect(fullChecksum(decoded)).not.toBe(ROOT);
    const error = engineErrorOf(() => encodeSnapshot(decoded));
    expect({ code: error.code, issues: error.issues }).toEqual({
      code: "integrity_violation",
      issues: [
        { path: "/chunks/0,0", message: STALE_CHUNK },
        { path: "/chunks/1,0", message: STALE_CHUNK },
        { path: "/global", message: STALE_GLOBAL },
      ],
    });
  });

  test("a broken ruleset is invalid_ruleset, after the schema", () => {
    const broken = { ...stepRuleset(), validateChunk: 1 } as unknown as StepRuleset;
    expect(rejection(TEXT, broken).code).toBe("invalid_ruleset");
    const both = changed((snapshot) => {
      worldOf(snapshot).epoch = -1;
    });
    expect(rejection(both, broken).code).toBe("invalid_snapshot");
  });
});

describe("options", () => {
  const NOT_RECORD = "the options must be a record";
  const options = (value: unknown) => {
    const error = engineErrorOf(() =>
      decodeSnapshot(TEXT, stepRuleset(), value as { audit: boolean }),
    );
    return { code: error.code, issues: error.issues };
  };

  test.each([
    ["null", null],
    ["a number", 1],
    ["a string", "audit"],
    ["an array", [true]],
  ])("%s is not a record: invalid_input at /options", (_name, value) => {
    expect(options(value)).toEqual({
      code: "invalid_input",
      issues: [{ path: "/options", message: NOT_RECORD }],
    });
  });

  test("options that throw while read, or an accessor audit, are invalid_input", () => {
    const revoked = options(revokedProxy());
    expect(revoked.code).toBe("invalid_input");
    expect(revoked.issues.map(({ path }) => path)).toEqual(["/options"]);
    expect(revoked.issues[0]?.message).toStartWith("the object threw while being read: TypeError");
    expect(
      options({
        get audit() {
          return true;
        },
      }),
    ).toEqual({
      code: "invalid_input",
      issues: [
        {
          path: "/options/audit",
          message: "the property is an accessor: only data properties are read",
        },
      ],
    });
  });

  test("are checked before the text", () => {
    const error = engineErrorOf(() => decodeSnapshot("{", stepRuleset(), null as never));
    expect(error.code).toBe("invalid_input");
  });

  test("audit must be a boolean", () => {
    const error = engineErrorOf(() =>
      decodeSnapshot(TEXT, stepRuleset(), { audit: 1 } as unknown as { audit: boolean }),
    );
    expect({ code: error.code, issues: error.issues }).toEqual({
      code: "invalid_input",
      issues: [{ path: "/options/audit", message: "audit must be a boolean, not number" }],
    });
  });

  test("audit makes every later tick recompute every digest", () => {
    const sneaky = stepRuleset([
      system("sneaky", (ctx) => {
        (ctx.readChunk("0,0") as Data).grass = ctx.tick;
      }),
    ]);
    const audited = decodeSnapshot(TEXT, sneaky, { audit: true });
    expect(engineErrorOf(() => step(audited, [])).code).toBe("integrity_violation");
    const plain = decodeSnapshot(TEXT, sneaky);
    step(plain, []);
    expect(worldStatus(plain)).toEqual({ kind: "ok", tick: 2 });
  });
});
