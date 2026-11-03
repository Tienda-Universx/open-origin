/**
 * The boundary of the server's planes on its transitive import graph (ADR 0025, rules 1 to 4), and
 * the imports Biome cannot check in packages/scenarios/src and packages/protocol/src. The real tree
 * keeps every rule; each rule rejects a planted violation, direct and transitive, in a synthetic
 * tree whose legal version passes, so every rule is proved whatever the real tree holds.
 */
import { describe, expect, test } from "bun:test";
import { REPO_ROOT, repoFiles } from "./files.ts";
import {
  checkPackageImports,
  checkServerBoundaries,
  importsOf,
  type PackagePolicy,
  PROTOCOL_POLICY,
  readModules,
  SCENARIOS_POLICY,
  SERVER_SRC,
  type SourceFile,
} from "./server-boundaries.ts";

const read = (path: string) => Bun.file(`${REPO_ROOT}${path}`).text();

const RULE_1 =
  "from outside presentation/ and transport/, only compose.ts and main.ts import them (ADR 0025, rule 1)";
const RULE_2 =
  "presentation/ and transport/ import only @open-origin/protocol/*, each other, and, as a type only, world/published.ts (ADR 0025, rule 2)";
const RULE_3 = "world/ and projection/ import no bun and name no WebSocket (ADR 0025, rule 3)";
const RULE_4 = "config/ is imported only by compose.ts and main.ts (ADR 0025, rule 4)";
const COMPUTED = "a dynamic import or a require with a computed specifier cannot be checked";
const REFERENCE = "a triple-slash reference directive cannot be checked: use an import";

/** A legal tree of every plane of ADR 0025, by path relative to apps/server/src. */
const LEGAL: Readonly<Record<string, string>> = {
  "compose.ts": [
    'import { parseConfig } from "./config/config.ts";',
    'import { WorldHost } from "./world/host.ts";',
    'import { playout } from "./presentation/playout.ts";',
    'import { serve } from "./transport/serve.ts";',
  ].join("\n"),
  "main.ts": [
    'import { compose } from "./compose.ts";',
    'import { parseConfig } from "./config/config.ts";',
    'import { systemClock } from "./adapters/clock.ts";',
  ].join("\n"),
  "config/config.ts": 'import { z } from "zod";',
  "adapters/clock.ts": 'import type { Clock } from "../world/time.ts";',
  "world/time.ts": "export type Clock = { now(): number };",
  "world/host.ts": [
    'import { step } from "@open-origin/engine";',
    'import { publishedTick } from "./published.ts";',
    "// A WebSocket named in a comment is no WebSocket.",
  ].join("\n"),
  "world/published.ts": "export type PublishedTick = { readonly tick: number };",
  "projection/terrain.ts": 'import { worldgen } from "@open-origin/engine";',
  "presentation/playout.ts": [
    'import type { PublishedTick } from "../world/published.ts";',
    'import { parseClientMessage } from "@open-origin/protocol/public";',
    'import { fanOut } from "./fan-out.ts";',
    'export type Later = typeof import("../world/published.ts");',
  ].join("\n"),
  "presentation/fan-out.ts": "export const fanOut = (socket: WebSocket) => socket;",
  "transport/serve.ts": [
    'import { playout } from "../presentation/playout.ts";',
    "export const serve = () => Bun.serve({ fetch: () => new Response() });",
  ].join("\n"),
};

/** The tree of `files` (paths relative to src), with `changes` applied: text, or null to drop. */
function treeOf(changes: Readonly<Record<string, string | null>> = {}): SourceFile[] {
  const merged: Record<string, string | null> = { ...LEGAL, ...changes };
  return Object.entries(merged).flatMap(([path, content]) =>
    content === null ? [] : [{ path: `${SERVER_SRC}/${path}`, content }],
  );
}

/** The findings of the legal tree with `changes`, by path relative to src. */
function findingsOf(changes: Readonly<Record<string, string | null>>) {
  return checkServerBoundaries(treeOf(changes)).map(({ file, line, message }) => ({
    file: file.slice(SERVER_SRC.length + 1),
    line,
    message,
  }));
}

/** `path`'s legal text with `line` added at its end. */
const plus = (path: string, line: string) => ({ [path]: `${LEGAL[path] ?? ""}\n${line}` });

/** The number of lines of `path`'s legal text, plus one: the line `plus` adds. */
const added = (path: string) => (LEGAL[path] ?? "").split("\n").length + 1;

/**
 * For each rule, a module it covers and a target that would break it if the graph followed an
 * absolute path or a URL there: such a specifier joins the graph as a package, out of every rule's
 * reach, so it is rejected on its own.
 */
const ESCAPES = [
  ["rule 1", "world/host.ts", "apps/server/src/presentation/fan-out.ts"],
  ["rule 2", "presentation/playout.ts", "apps/server/src/world/host.ts"],
  ["rule 3", "projection/terrain.ts", "node_modules/bun/index.js"],
  ["rule 4", "adapters/clock.ts", "apps/server/src/config/config.ts"],
] as const;

describe("the server's planes", () => {
  test("the real tree keeps every rule, and the scan reads every module of src", async () => {
    const files = await readModules(SERVER_SRC, repoFiles(REPO_ROOT), read);
    // An empty list would pass without checking anything.
    expect(files.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        `${SERVER_SRC}/compose.ts`,
        `${SERVER_SRC}/config/config.ts`,
        `${SERVER_SRC}/world/host.ts`,
        `${SERVER_SRC}/world/published.ts`,
        `${SERVER_SRC}/adapters/timer.ts`,
        `${SERVER_SRC}/transport/transport.ts`,
        `${SERVER_SRC}/main.ts`,
      ]),
    );
    expect(checkServerBoundaries(files)).toEqual([]);
  });

  test("the legal synthetic tree keeps every rule", () => {
    expect(findingsOf({})).toEqual([]);
  });

  describe("rule 1: only compose.ts and main.ts import presentation/ and transport/", () => {
    test("rejects a world module that imports the presentation plane", () => {
      const line = 'import { fanOut } from "../presentation/fan-out.ts";';
      expect(findingsOf(plus("world/host.ts", line))).toEqual([
        {
          file: "world/host.ts",
          line: added("world/host.ts"),
          message: `reaches presentation/fan-out.ts: ${RULE_1}`,
        },
        // The presentation plane names a WebSocket, which the world plane may not reach either.
        {
          file: "world/host.ts",
          line: added("world/host.ts"),
          message: `reaches a WebSocket in presentation/fan-out.ts: ${RULE_3}`,
        },
      ]);
    });

    test("rejects a type-only import of the transport from an adapter", () => {
      const line = 'import type { serve } from "../transport/serve.ts";';
      expect(findingsOf(plus("adapters/clock.ts", line))).toEqual([
        {
          file: "adapters/clock.ts",
          line: added("adapters/clock.ts"),
          message: `reaches transport/serve.ts: ${RULE_1}`,
        },
      ]);
    });

    test("rejects a world module that reaches the planes through compose.ts", () => {
      const line = 'import { compose } from "../compose.ts";';
      const at = added("world/host.ts");
      expect(findingsOf(plus("world/host.ts", line))).toEqual([
        {
          file: "world/host.ts",
          line: at,
          message: `reaches presentation/playout.ts through compose.ts: ${RULE_1}`,
        },
        {
          file: "world/host.ts",
          line: at,
          message: `reaches transport/serve.ts through compose.ts: ${RULE_1}`,
        },
        {
          file: "world/host.ts",
          line: at,
          message: `reaches a WebSocket in presentation/fan-out.ts through compose.ts, presentation/playout.ts: ${RULE_3}`,
        },
        {
          file: "world/host.ts",
          line: at,
          message: `reaches config/config.ts through compose.ts: ${RULE_4}`,
        },
      ]);
    });
  });

  describe("rule 2: presentation/ and transport/ import only the protocol, each other, and published types", () => {
    test.each([
      ['import { step } from "@open-origin/engine";', 'reaches "@open-origin/engine"'],
      ['import { WorldHost } from "../world/host.ts";', "reaches world/host.ts"],
      ['import type { WorldHost } from "../world/host.ts";', "reaches world/host.ts"],
      ['import { ScenarioSource } from "../world/source.ts";', "reaches world/source.ts"],
      [
        'import { publishedTick } from "../world/published.ts";',
        "imports world/published.ts as a value",
      ],
      [
        'import { type PublishedTick } from "../world/published.ts";',
        "imports world/published.ts as a value",
      ],
      [
        'export const later = () => import("../world/published.ts");',
        "imports world/published.ts as a value",
      ],
      ['import { ServerStatus } from "@open-origin/protocol";', 'reaches "@open-origin/protocol"'],
      ['import { serve } from "bun";', 'reaches "bun"'],
      ['import { parseConfig } from "../config/config.ts";', "reaches config/config.ts"],
    ])("rejects %p in presentation/", (line, how) => {
      const findings = findingsOf({
        ...plus("presentation/playout.ts", line),
        "world/source.ts": "export const ScenarioSource = 1;",
      });
      expect(findings).toContainEqual({
        file: "presentation/playout.ts",
        line: added("presentation/playout.ts"),
        message: `${how}: ${RULE_2}`,
      });
      // A config import also breaks rule 4; anything else breaks rule 2 alone.
      expect(findings).toHaveLength(line.includes("config") ? 2 : 1);
    });

    test("rejects what world/published.ts would let the planes reach", () => {
      const findings = findingsOf(
        plus("world/published.ts", 'import { step } from "@open-origin/engine";'),
      );
      expect(findings).toEqual([
        {
          file: "presentation/playout.ts",
          line: 1,
          message: `reaches "@open-origin/engine" through world/published.ts: ${RULE_2}`,
        },
      ]);
    });

    test("rejects bun in the transport, as in any module of the planes", () => {
      expect(findingsOf(plus("transport/serve.ts", 'import type { Server } from "bun";'))).toEqual([
        {
          file: "transport/serve.ts",
          line: added("transport/serve.ts"),
          message: `reaches "bun": ${RULE_2}`,
        },
      ]);
    });
  });

  describe("rule 3: world/ and projection/ import no bun and name no WebSocket", () => {
    test.each([
      ["world/host.ts", 'import { serve } from "bun";', 'reaches "bun"'],
      ["world/host.ts", 'import { jscDescribe } from "bun:jsc";', 'reaches "bun:jsc"'],
      ["projection/terrain.ts", 'export type Socket = typeof import("bun");', 'reaches "bun"'],
      [
        "projection/terrain.ts",
        "export const open = () => new WebSocket('ws://x');",
        "names a WebSocket",
      ],
      ["world/host.ts", "type Peer = ServerWebSocket<unknown>;", "names a WebSocket"],
      ["world/host.ts", 'const kind = "WebSocket";', "names a WebSocket"],
    ])("rejects in %s: %p", (path, line, how) => {
      expect(findingsOf(plus(path, line))).toEqual([
        { file: path, line: added(path), message: `${how}: ${RULE_3}` },
      ]);
    });

    test.each([
      ['import { serve } from "bun";', 'reaches "bun" through adapters/clock.ts'],
      ["export let socket: WebSocket | undefined;", "reaches a WebSocket in adapters/clock.ts"],
    ])("rejects a world module that reaches, through an adapter, %p", (adapter, how) => {
      const line = 'import { systemClock } from "../adapters/clock.ts";';
      expect(findingsOf({ ...plus("world/host.ts", line), "adapters/clock.ts": adapter })).toEqual([
        { file: "world/host.ts", line: added("world/host.ts"), message: `${how}: ${RULE_3}` },
      ]);
    });
  });

  describe("rule 4: only compose.ts and main.ts import config/", () => {
    test.each([
      ["world/host.ts", 'import { parseConfig } from "../config/config.ts";'],
      ["adapters/clock.ts", 'import type { Config } from "../config/config.ts";'],
      ["projection/terrain.ts", 'export type Config = import("../config/config.ts").Config;'],
    ])("rejects in %s: %p", (path, line) => {
      expect(findingsOf(plus(path, line))).toEqual([
        { file: path, line: added(path), message: `reaches config/config.ts: ${RULE_4}` },
      ]);
    });

    test("lets config/ import its own modules", () => {
      expect(
        findingsOf({
          ...plus("config/config.ts", 'import { bounds } from "./bounds.ts";'),
          "config/bounds.ts": "export const bounds = 1;",
        }),
      ).toEqual([]);
    });
  });

  describe("every form that loads a module, under every rule", () => {
    test.each([
      [
        "world/host.ts",
        'const { fanOut } = require("../presentation/fan-out.ts");',
        [
          `reaches presentation/fan-out.ts: ${RULE_1}`,
          `reaches a WebSocket in presentation/fan-out.ts: ${RULE_3}`,
        ],
      ],
      [
        "adapters/clock.ts",
        'const { serve } = import.meta.require("../transport/serve.ts");',
        [`reaches transport/serve.ts: ${RULE_1}`],
      ],
      [
        "presentation/playout.ts",
        'const { WorldHost } = require("../world/host.ts");',
        [`reaches world/host.ts: ${RULE_2}`],
      ],
      [
        "transport/serve.ts",
        'const published = import.meta.require("../world/published.ts");',
        [`imports world/published.ts as a value: ${RULE_2}`],
      ],
      ["world/host.ts", 'const { serve } = require("bun");', [`reaches "bun": ${RULE_3}`]],
      [
        "projection/terrain.ts",
        'const jsc = import.meta.require("bun:jsc");',
        [`reaches "bun:jsc": ${RULE_3}`],
      ],
      [
        "world/host.ts",
        'const { parseConfig } = require("../config/config.ts");',
        [`reaches config/config.ts: ${RULE_4}`],
      ],
      [
        "adapters/clock.ts",
        'const config = import.meta.require("../config/config.ts");',
        [`reaches config/config.ts: ${RULE_4}`],
      ],
    ])("rejects in %s: %p", (path, line, messages) => {
      expect(findingsOf(plus(path, line))).toEqual(
        messages.map((message) => ({ file: path, line: added(path), message })),
      );
    });

    test.each(
      ESCAPES.flatMap(([rule, path, target]) => [
        [rule, path, `/repo/${target}`, "is an absolute path"],
        [rule, path, `file:///repo/${target}`, "is a URL"],
      ]),
    )("rejects under %s, in %s, the specifier %p", (_rule, path, specifier, what) => {
      for (const line of [
        `import { a } from "${specifier}";`,
        `const a = require("${specifier}");`,
      ]) {
        expect(findingsOf(plus(path, line))).toEqual([
          {
            file: path,
            line: added(path),
            message: `"${specifier}" ${what}: import the modules of ${SERVER_SRC} by relative path`,
          },
        ]);
      }
    });

    test.each([
      ["world/host.ts", '/// <reference path="../presentation/fan-out.ts" />'],
      ["presentation/playout.ts", '/// <reference path="../world/host.ts" />'],
      ["projection/terrain.ts", '/// <reference types="bun" />'],
      ["adapters/clock.ts", '///<reference path="../config/config.ts"/>'],
    ])("rejects a triple-slash reference directive in %s: %p", (path, directive) => {
      expect(findingsOf({ [path]: `${directive}\n${LEGAL[path]}` })).toEqual([
        { file: path, line: 1, message: REFERENCE },
      ]);
    });

    test("keeps bun: and node: specifiers as packages, which the rules then judge", () => {
      expect(findingsOf(plus("config/config.ts", 'import { stat } from "node:fs";'))).toEqual([]);
      expect(findingsOf(plus("world/host.ts", 'import { gc } from "bun:jsc";'))).toEqual([
        {
          file: "world/host.ts",
          line: added("world/host.ts"),
          message: `reaches "bun:jsc": ${RULE_3}`,
        },
      ]);
    });
  });

  test("rejects imports the graph cannot follow", () => {
    const lines = [
      "export const later = (name: string) => import(name);",
      'import { step } from "../../../packages/engine/src/index.ts";',
      'import { missing } from "./missing.ts";',
      'import { host } from "./host";',
      'import { compose } from "@open-origin/server/src/compose.ts";',
    ];
    const findings = findingsOf({ "world/host.ts": [LEGAL["world/host.ts"], ...lines].join("\n") });
    expect(findings).toEqual([
      { file: "world/host.ts", line: 4, message: COMPUTED },
      {
        file: "world/host.ts",
        line: 5,
        message: `"../../../packages/engine/src/index.ts" resolves outside ${SERVER_SRC}`,
      },
      {
        file: "world/host.ts",
        line: 6,
        message: `"./missing.ts" resolves to no module of ${SERVER_SRC}`,
      },
      {
        file: "world/host.ts",
        line: 7,
        message: `"./host" resolves to no module of ${SERVER_SRC}`,
      },
      {
        file: "world/host.ts",
        line: 8,
        message:
          '"@open-origin/server/src/compose.ts" names the server\'s own package: import its modules by relative path',
      },
    ]);
  });
});

describe("importsOf", () => {
  test("reads every form of import, with its line and whether it is type-only", () => {
    const source = [
      'import { a } from "./a.ts";',
      'import type { B } from "./b.ts";',
      'import { type C } from "./c.ts";',
      'export * from "./d.ts";',
      'export type { E } from "./e.ts";',
      'import "./f.ts";',
      'import g = require("./g.ts");',
      'import type h = require("./h.ts");',
      'export const i = () => import("./i.ts");',
      'export type J = typeof import("./j.ts");',
      "export const k = (name: string) => import(name);",
      '// import { l } from "./l.ts";',
      '/* export * from "./m.ts"; */',
      "import {",
      "  n,",
      '} from "./n.ts";',
      'const o = require("./o.ts");',
      'const p = import.meta.require("./p.ts");',
      "const q = (name: string) => require(name);",
      'const r = loader.require("./r.ts");',
    ].join("\n");
    expect(importsOf(source)).toEqual([
      { specifier: "./a.ts", typeOnly: false, line: 1 },
      { specifier: "./b.ts", typeOnly: true, line: 2 },
      { specifier: "./c.ts", typeOnly: false, line: 3 },
      { specifier: "./d.ts", typeOnly: false, line: 4 },
      { specifier: "./e.ts", typeOnly: true, line: 5 },
      { specifier: "./f.ts", typeOnly: false, line: 6 },
      { specifier: "./g.ts", typeOnly: false, line: 7 },
      { specifier: "./h.ts", typeOnly: true, line: 8 },
      { specifier: "./i.ts", typeOnly: false, line: 9 },
      { specifier: "./j.ts", typeOnly: true, line: 10 },
      { specifier: undefined, typeOnly: false, line: 11 },
      { specifier: "./n.ts", typeOnly: false, line: 14 },
      { specifier: "./o.ts", typeOnly: false, line: 17 },
      { specifier: "./p.ts", typeOnly: false, line: 18 },
      // A require of a computed name; a method that is only named require is no import.
      { specifier: undefined, typeOnly: false, line: 19 },
    ]);
  });
});

describe("the imports Biome cannot check in packages/scenarios and packages/protocol", () => {
  test.each([
    ["packages/scenarios/src", SCENARIOS_POLICY, "scenario.ts"],
    ["packages/protocol/src", PROTOCOL_POLICY, "public/reducer.ts"],
  ] as const)("the real modules of %s keep their rule", async (src, policy, module) => {
    const files = await readModules(src, repoFiles(REPO_ROOT), read);
    expect(files.map(({ path }) => path)).toContain(`${src}/${module}`);
    expect(checkPackageImports(policy, files)).toEqual([]);
  });

  const check = (policy: PackagePolicy, line: string) =>
    checkPackageImports(policy, [
      { path: `${policy.src}/later.ts`, content: `export const a = 1;\n${line}` },
    ]);

  test.each([
    [
      SCENARIOS_POLICY,
      'import type { Brain } from "../../agents/src/index.ts";',
      '"../../agents/src/index.ts" resolves outside packages/scenarios/src',
    ],
    [
      SCENARIOS_POLICY,
      'export type Hasher = typeof import("bun");',
      '"bun" is neither a relative path nor @open-origin/engine or @open-origin/agents: packages/scenarios/src imports nothing else',
    ],
    [
      SCENARIOS_POLICY,
      'export type Sfc = import("@open-origin/engine/src/rng/sfc32.ts").Sfc32;',
      '"@open-origin/engine/src/rng/sfc32.ts" is neither a relative path nor @open-origin/engine or @open-origin/agents: packages/scenarios/src imports nothing else',
    ],
    [
      PROTOCOL_POLICY,
      'export type Tick = import("../../engine/src/time/tick.ts").Tick;',
      '"../../engine/src/time/tick.ts" resolves outside packages/protocol/src',
    ],
    [
      PROTOCOL_POLICY,
      'export type Fs = typeof import("node:fs");',
      '"node:fs" is neither a relative path nor zod: packages/protocol/src imports nothing else',
    ],
    [PROTOCOL_POLICY, "export const later = (name: string) => import(name);", COMPUTED],
    [
      SCENARIOS_POLICY,
      'const engine = require("../../engine/src/index.ts");',
      '"../../engine/src/index.ts" resolves outside packages/scenarios/src',
    ],
    [
      PROTOCOL_POLICY,
      'const tick = import.meta.require("../../engine/src/time/tick.ts");',
      '"../../engine/src/time/tick.ts" resolves outside packages/protocol/src',
    ],
    [
      PROTOCOL_POLICY,
      'const fs = require("node:fs");',
      '"node:fs" is neither a relative path nor zod: packages/protocol/src imports nothing else',
    ],
    [SCENARIOS_POLICY, "export const later = (name: string) => require(name);", COMPUTED],
    [
      SCENARIOS_POLICY,
      'import { step } from "/repo/packages/engine/src/index.ts";',
      '"/repo/packages/engine/src/index.ts" is neither a relative path nor @open-origin/engine or @open-origin/agents: packages/scenarios/src imports nothing else',
    ],
    [
      PROTOCOL_POLICY,
      'import { z } from "file:///repo/node_modules/zod/index.js";',
      '"file:///repo/node_modules/zod/index.js" is neither a relative path nor zod: packages/protocol/src imports nothing else',
    ],
  ])("rejects %#: %p", (policy, line, message) => {
    expect(check(policy, line)).toEqual([{ file: `${policy.src}/later.ts`, line: 2, message }]);
  });

  test.each([SCENARIOS_POLICY, PROTOCOL_POLICY].map((policy) => [policy.src, policy] as const))(
    "rejects a triple-slash reference directive in %s",
    (_src, policy) => {
      const file = `${policy.src}/later.ts`;
      const content = '/// <reference path="../../engine/src/index.ts" />\nexport const a = 1;';
      expect(checkPackageImports(policy, [{ path: file, content }])).toEqual([
        { file, line: 1, message: REFERENCE },
      ]);
    },
  );

  test("allows relative paths inside src and the packages each rule names", () => {
    expect(
      check(
        SCENARIOS_POLICY,
        'import { Sfc32 } from "./sfc32.ts";\nexport type V = typeof import("@open-origin/engine");',
      ),
    ).toEqual([]);
    expect(
      check(
        PROTOCOL_POLICY,
        'import { z } from "zod";\nexport type T = import("./public/dto.ts").Tick;',
      ),
    ).toEqual([]);
  });
});
