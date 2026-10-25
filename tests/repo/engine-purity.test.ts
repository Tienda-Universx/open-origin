import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkEngineSource,
  ENGINE_SRC,
  isEngineSource,
  type PurityIssue,
} from "./engine-purity.ts";
import { REPO_ROOT, repoFiles } from "./files.ts";

const FILE = `${ENGINE_SRC}/world/state.ts`;

function issues(content: string, path = FILE): PurityIssue[] {
  return checkEngineSource({ path, content });
}

function messages(content: string, path = FILE): string[] {
  return issues(content, path).map((issue) => issue.message);
}

describe("checkEngineSource", () => {
  test("accepts relative imports and exports that stay inside src", () => {
    const content = [
      'import { a } from "./a.ts";',
      'import type { B } from "../canonical/value.ts";',
      "import {",
      "  c,",
      "  type D,",
      '} from "../../src/rng/random.ts";',
      'export * from "./chunk-index.ts";',
      'export { e } from "../index.ts";',
      'export type F = typeof import("./contracts.ts");',
      'import "./register.ts";',
      // `declare` as a property name is not the modifier.
      "export const flags = { declare: true };",
      "export const call = (f: { declare(): number }): number => f.declare();",
      "",
    ].join("\n");
    expect(issues(content)).toEqual([]);
  });

  test("ignores imports and declarations that only appear in comments", () => {
    const content = [
      '// import { x } from "some-package";',
      "/* declare global { const Bun: unknown } */",
      "/**",
      ' * export * from "bun";',
      " */",
      "export const n = 1;",
      "",
    ].join("\n");
    expect(issues(content)).toEqual([]);
  });

  test.each([
    [
      "a reference directive to types",
      '/// <reference types="bun" />',
      "`/// <reference>` directives add declarations the engine tsconfig excludes",
    ],
    [
      "a reference directive to a library",
      '///<reference lib="dom" />',
      "`/// <reference>` directives add declarations the engine tsconfig excludes",
    ],
    [
      "a global augmentation",
      "declare global {\n  const Bun: unknown;\n}",
      "`declare global` adds ambient declarations the engine tsconfig excludes",
    ],
    [
      "an ambient module",
      'declare module "host" {\n  export const clock: number;\n}',
      "`declare module` adds ambient declarations the engine tsconfig excludes",
    ],
    [
      "an ambient const",
      "declare const Bun: { nanoseconds(): number };",
      "`declare const` adds ambient declarations the engine tsconfig excludes",
    ],
    [
      "an ambient let",
      "declare let console: { log(text: string): void };",
      "`declare let` adds ambient declarations the engine tsconfig excludes",
    ],
    [
      "an ambient var",
      "declare var process: { exit(code: number): never };",
      "`declare var` adds ambient declarations the engine tsconfig excludes",
    ],
    [
      "an ambient function",
      "declare function setTimeout(run: () => void, ms: number): number;",
      "`declare function` adds ambient declarations the engine tsconfig excludes",
    ],
    [
      "an ambient class",
      "declare class TextEncoder {}",
      "`declare class` adds ambient declarations the engine tsconfig excludes",
    ],
    [
      "an ambient namespace",
      "declare namespace crypto {}",
      "`declare namespace` adds ambient declarations the engine tsconfig excludes",
    ],
    [
      "an ambient enum",
      "declare enum Mode {}",
      "`declare enum` adds ambient declarations the engine tsconfig excludes",
    ],
    [
      "an exported ambient declaration",
      "export declare const performance: { now(): number };",
      "`declare const` adds ambient declarations the engine tsconfig excludes",
    ],
    [
      "a declare class field",
      "export class Clock { declare now: () => number }",
      "a `declare` field declares a value that no engine code provides",
    ],
    [
      "a ts-nocheck comment",
      "// @ts-nocheck",
      "`@ts-nocheck` can silently disable the engine's type gate: fix the type error instead",
    ],
    [
      "a ts-expect-error comment",
      "// @ts-expect-error host API",
      "`@ts-expect-error` can silently disable the engine's type gate: fix the type error instead",
    ],
    [
      "a ts-ignore block comment",
      "/* @ts-ignore */",
      "`@ts-ignore` can silently disable the engine's type gate: fix the type error instead",
    ],
    [
      "a package import",
      'import { a } from "some-package";',
      '"some-package" is not a relative import: the engine depends on nothing',
    ],
    [
      "a side-effect import",
      "import 'polyfill';",
      '"polyfill" is not a relative import: the engine depends on nothing',
    ],
    [
      "a multi-line import of a Node.js module",
      'import {\n  readFileSync,\n  writeFileSync,\n} from "node:fs";',
      '"node:fs" is not a relative import: the engine depends on nothing',
    ],
    [
      "a re-export of a host module",
      'export * from "bun";',
      '"bun" is not a relative import: the engine depends on nothing',
    ],
    [
      "a type-level import of a host module",
      'export type File = typeof import("bun");',
      '"bun" is not a relative import: the engine depends on nothing',
    ],
    [
      "an import-equals declaration",
      'import fs = require("fs");',
      '"fs" is not a relative import: the engine depends on nothing',
    ],
    [
      "an absolute path",
      'import { a } from "/workspaces/open-origin/tests/repo/files.ts";',
      '"/workspaces/open-origin/tests/repo/files.ts" is not a relative import: the engine depends on nothing',
    ],
    [
      "a dynamic import with a computed specifier",
      "export const load = (name: string) => import(name);",
      "a dynamic import with a computed specifier cannot be checked",
    ],
    [
      "a relative import that leaves src",
      'import { a } from "../../package.json";',
      '"../../package.json" resolves outside packages/engine/src',
    ],
    [
      "a line suppression",
      "// biome-ignore lint/style/noRestrictedGlobals: needed here",
      "`biome-ignore` can silently disable a purity rule: add a reviewed override in biome.json instead",
    ],
    [
      "a file suppression in a block comment",
      "/* biome-ignore-all lint/plugin: needed here */",
      "`biome-ignore-all` can silently disable a purity rule: add a reviewed override in biome.json instead",
    ],
    [
      "the start of a range suppression",
      "// biome-ignore-start lint/plugin: needed here",
      "`biome-ignore-start` can silently disable a purity rule: add a reviewed override in biome.json instead",
    ],
    [
      "the end of a range suppression",
      "// biome-ignore-end lint/plugin: needed here",
      "`biome-ignore-end` can silently disable a purity rule: add a reviewed override in biome.json instead",
    ],
    [
      "a suppression in a documentation comment",
      "/** biome-ignore lint/suspicious/noForIn: needed here */",
      "`biome-ignore` can silently disable a purity rule: add a reviewed override in biome.json instead",
    ],
    [
      "a relative import into the engine tests",
      'export { b } from "../../test/support/sfc32.ts";',
      '"../../test/support/sfc32.ts" resolves outside packages/engine/src',
    ],
  ])("reports %s", (_name, content, message) => {
    expect(issues(`export const before = 1;\n${content}\n`)).toEqual([
      { file: FILE, line: 2, message },
    ]);
  });

  test("allows the reviewed oxlint complexity comment and @ts-check", () => {
    const content = [
      "// oxlint-disable-next-line eslint/complexity -- lookup table, reviewed",
      "export const pick = (x: number): number => x;",
      "// @ts-check only turns checking on.",
      "",
    ].join("\n");
    expect(issues(content)).toEqual([]);
  });

  // A comment inside a template substitution looks like template text to a lexical scan, so the
  // gate tokens are rejected anywhere in the file, strings included.
  test("reports gate tokens hidden in a template substitution or written in a string", () => {
    const content = [
      "export const late = `${",
      "  // @ts-expect-error",
      "  missing",
      "}`;",
      'export const note = "biome-ignore";',
      "",
    ].join("\n");
    expect(issues(content)).toEqual([
      {
        file: FILE,
        line: 2,
        message:
          "`@ts-expect-error` can silently disable the engine's type gate: fix the type error instead",
      },
      {
        file: FILE,
        line: 5,
        message:
          "`biome-ignore` can silently disable a purity rule: add a reviewed override in biome.json instead",
      },
    ]);
  });

  test.each(["host.d.ts", "host.d.mts", "host.d.cts", "host.d.json.ts"])(
    "reports the declaration file %s, which can declare globals without `declare`",
    (name) => {
      expect(issues("export const n = 1;\n", `${ENGINE_SRC}/${name}`)).toEqual([
        {
          file: `${ENGINE_SRC}/${name}`,
          line: 1,
          message: "declaration files can declare globals: write a .ts module instead",
        },
      ]);
    },
  );

  test("accepts a module whose name only contains `d.`", () => {
    expect(issues("export const n = 1;\n", `${ENGINE_SRC}/cardinal.ts`)).toEqual([]);
  });

  test("reports every finding of a file, each on its own line", () => {
    const content = [
      '/// <reference types="node" />',
      'import { a } from "./a.ts";',
      'import { b } from "pkg";',
      "",
      "declare global {}",
      'export * from "../../index.ts";',
      "/*",
      " * biome-ignore lint/plugin: inside a multi-line comment",
      " */",
      "",
    ].join("\n");
    expect(issues(content).map(({ line }) => line)).toEqual([1, 3, 5, 6, 8]);
    expect(messages(content)).toHaveLength(5);
  });
});

/**
 * Worldgen's layering and statelessness (ADR 0021, "Kernel additions"): the kernel never imports
 * worldgen, worldgen imports only an allowlist of kernel modules, and worldgen modules keep no
 * module-level `let` or `var`. The fixtures need no worldgen module to exist.
 */
describe("checkEngineSource: worldgen", () => {
  const WORLDGEN = `${ENGINE_SRC}/worldgen`;
  const TERRAIN = `${WORLDGEN}/terrain.ts`;

  const intoWorldgen = (specifier: string) =>
    `"${specifier}" imports worldgen: the kernel never depends on worldgen, which only ${ENGINE_SRC}/index.ts re-exports (ADR 0021)`;
  const outOfAllowlist = (specifier: string) =>
    `"${specifier}" is not a module worldgen may import: it may import int.ts, errors.ts, rng/chacha.ts, time/tick.ts, world/chunk.ts, world/members.ts, world/contracts.ts, and the modules under canonical/, digest/, worldgen/ (ADR 0021)`;
  const moduleState = (keyword: string) =>
    `a top-level \`${keyword}\` declares module state: worldgen modules keep no state between calls (ADR 0021)`;

  test.each([
    ["an import", 'import { cell } from "../worldgen/space.ts";', "../worldgen/space.ts"],
    [
      "a type-only import",
      'import type { G } from "../worldgen/genesis.ts";',
      "../worldgen/genesis.ts",
    ],
    ["a re-export", 'export * from "../worldgen/index.ts";', "../worldgen/index.ts"],
    ["a side-effect import", 'import "../worldgen/register.ts";', "../worldgen/register.ts"],
    [
      "a type-level import",
      'export type Terrain = typeof import("../worldgen/terrain.ts");',
      "../worldgen/terrain.ts",
    ],
    [
      "a dynamic import",
      'export const load = () => import("../worldgen/x.ts");',
      "../worldgen/x.ts",
    ],
    ["an import of the directory", 'import "../worldgen";', "../worldgen"],
    [
      "a path that enters worldgen late",
      'import "../step/../worldgen/a.ts";',
      "../step/../worldgen/a.ts",
    ],
  ])("reports a kernel module that imports worldgen through %s", (_name, content, specifier) => {
    expect(issues(`export const before = 1;\n${content}\n`)).toEqual([
      { file: FILE, line: 2, message: intoWorldgen(specifier) },
    ]);
  });

  test.each([
    [`${ENGINE_SRC}/world/index.ts`, "../worldgen/index.ts"],
    [`${ENGINE_SRC}/index/index.ts`, "../worldgen/index.ts"],
    [`${ENGINE_SRC}/indexes.ts`, "./worldgen/index.ts"],
  ])("reports %s, which only looks like the entry point, when it imports worldgen", (path, to) => {
    expect(messages(`export * from "${to}";\n`, path)).toEqual([intoWorldgen(to)]);
  });

  test("lets src/index.ts re-export worldgen, and a kernel module import a lookalike directory", () => {
    const entry = 'export * as worldgen from "./worldgen/index.ts";\n';
    expect(issues(entry, `${ENGINE_SRC}/index.ts`)).toEqual([]);
    const lookalikes = [
      'import { a } from "../worldgenerator/a.ts";',
      'import { b } from "../worldgen.ts";',
      'import { c } from "./worldgen/c.ts";',
      "",
    ].join("\n");
    // `./worldgen/c.ts` from world/state.ts is world/worldgen/c.ts, not src/worldgen.
    expect(issues(lookalikes)).toEqual([]);
  });

  test("lets worldgen import its allowlist and its own modules, at any depth", () => {
    const content = [
      'import { imul } from "../int.ts";',
      'import { EngineError } from "../errors.ts";',
      'import { chachaBlock } from "../rng/chacha.ts";',
      'import type { CanonicalValue } from "../canonical/value.ts";',
      'import { sortedKeys } from "../canonical/order.ts";',
      'import { digest } from "../digest/digest.ts";',
      'import { tickProblem } from "../time/tick.ts";',
      'import { parseChunkKey } from "../world/chunk.ts";',
      'import { readText } from "../world/members.ts";',
      'import type { ReadView } from "../world/contracts.ts";',
      'import { cell } from "./space.ts";',
      'export { lattice } from "./noise/lattice.ts";',
      'export type Genesis = typeof import("./genesis.ts");',
      "",
    ].join("\n");
    expect(issues(content, TERRAIN)).toEqual([]);
    const nested = 'import { imul } from "../../int.ts";\nimport { cell } from "../space.ts";\n';
    expect(issues(nested, `${WORLDGEN}/noise/lattice.ts`)).toEqual([]);
  });

  test.each([
    ["the world model", 'import { healthyState } from "../world/world.ts";', "../world/world.ts"],
    ["the host view", 'import { readView } from "../world/view.ts";', "../world/view.ts"],
    ["the kernel's random streams", 'import { mix32 } from "../rng/mix32.ts";', "../rng/mix32.ts"],
    ["the step", 'export { step } from "../step/step.ts";', "../step/step.ts"],
    ["the entry point", 'import "../index.ts";', "../index.ts"],
    [
      "a type-level import of the snapshots",
      'export type S = typeof import("../snapshot/snapshot.ts");',
      "../snapshot/snapshot.ts",
    ],
    ["a module without its extension", 'import { imul } from "../int";', "../int"],
    [
      "a lookalike of an allowed module",
      'import { a } from "../rng/chacha2.ts";',
      "../rng/chacha2.ts",
    ],
    [
      "a lookalike of an allowed directory",
      'import { b } from "../digests/b.ts";',
      "../digests/b.ts",
    ],
  ])("reports a worldgen module that imports %s", (_name, content, specifier) => {
    expect(issues(`export const before = 1;\n${content}\n`, TERRAIN)).toEqual([
      { file: TERRAIN, line: 2, message: outOfAllowlist(specifier) },
    ]);
  });

  test("reports a worldgen import that leaves src with the engine's own rule, once", () => {
    expect(messages('import { file } from "bun";\nimport "../../../x.ts";\n', TERRAIN)).toEqual([
      '"bun" is not a relative import: the engine depends on nothing',
      '"../../../x.ts" resolves outside packages/engine/src',
    ]);
  });

  test("reports every top-level let and var of a worldgen module", () => {
    const content = [
      // An opening brace in a comment or a string does not hide what follows it.
      "// The terrain caches {",
      'export const opening = "{";',
      "let counter = 0;",
      "var cache = {};",
      "export let seed = 1;",
      "export var legacy = [counter, cache, seed];",
      "let first = 1,",
      "  second = 2;",
      "",
    ].join("\n");
    expect(issues(content, TERRAIN)).toEqual([
      { file: TERRAIN, line: 3, message: moduleState("let") },
      { file: TERRAIN, line: 4, message: moduleState("var") },
      { file: TERRAIN, line: 5, message: moduleState("let") },
      { file: TERRAIN, line: 6, message: moduleState("var") },
      { file: TERRAIN, line: 7, message: moduleState("let") },
    ]);
  });

  test("accepts let and var inside functions, and the words elsewhere", () => {
    const content = [
      // A closing brace in a comment or a string does not make a nested `let` look top level.
      "/* } */",
      'export const closing = "}";',
      "export const LIMIT = 3;",
      "export function count(values: readonly number[]): number {",
      "  let total = 0;",
      "  for (let index = 0; index < values.length; index += 1) total += values[index] ?? 0;",
      "  return total;",
      "}",
      "export const sum = (a: number) => {",
      "  var doubled = a * 2;",
      "  return doubled;",
      "};",
      "export class Field {",
      "  read(): number {",
      "    let value = 1;",
      "    return value;",
      "  }",
      "}",
      'export const words = { let: "let x = 1", var: `var y = 2` };',
      "export const letter = words.let + words.var;",
      "// let commented = 1;",
      "/* var blocked = 1; */",
      "export const variance = 1;",
      "",
    ].join("\n");
    expect(issues(content, TERRAIN)).toEqual([]);
  });

  test.each([FILE, `${ENGINE_SRC}/worldgen.ts`, `${ENGINE_SRC}/worldgenerator/a.ts`])(
    "leaves the module state of %s, outside worldgen, to the kernel's own review",
    (path) => {
      expect(issues("let stateOf = 0;\nexport const read = () => stateOf;\n", path)).toEqual([]);
    },
  );
});

describe("checkEngineSource: beings", () => {
  const BEINGS = `${ENGINE_SRC}/beings`;
  const BODY = `${BEINGS}/body.ts`;
  const TERRAIN = `${ENGINE_SRC}/worldgen/terrain.ts`;

  const intoBeings = (specifier: string) =>
    `"${specifier}" imports the beings layer: the kernel never depends on it, which only ${ENGINE_SRC}/index.ts re-exports (ADR 0023)`;
  const outOfAllowlist = (specifier: string) =>
    `"${specifier}" is not a module the beings layer may import: it may import int.ts, errors.ts, time/tick.ts, world/chunk.ts, world/members.ts, world/contracts.ts, worldgen/index.ts, and the modules under canonical/, digest/, beings/ (ADR 0023)`;
  const outOfWorldgen = (specifier: string) =>
    `"${specifier}" is not a module worldgen may import: it may import int.ts, errors.ts, rng/chacha.ts, time/tick.ts, world/chunk.ts, world/members.ts, world/contracts.ts, and the modules under canonical/, digest/, worldgen/ (ADR 0021)`;
  const TYPES_ONLY =
    "world/contracts.ts holds only types: import it with `import type` or re-export it with `export type`";
  const reason =
    "beings modules keep no state between calls, so the worlds that share a ruleset stay independent (ADR 0023)";
  const moduleState = (keyword: string) =>
    `a top-level \`${keyword}\` declares module state: ${reason}`;
  const mutableConst = (start: string) =>
    `a top-level \`const\` bound to \`${start}…\` holds a value that can change: ${reason}; freeze it with Object.freeze, or build it inside a function`;

  test.each([
    ["an import", 'import { body } from "../beings/body.ts";', "../beings/body.ts"],
    ["a type-only import", 'import type { B } from "../beings/being.ts";', "../beings/being.ts"],
    ["a re-export", 'export * from "../beings/index.ts";', "../beings/index.ts"],
    ["a side-effect import", 'import "../beings/register.ts";', "../beings/register.ts"],
    [
      "a type-level import",
      'export type Body = typeof import("../beings/body.ts");',
      "../beings/body.ts",
    ],
    ["a dynamic import", 'export const load = () => import("../beings/x.ts");', "../beings/x.ts"],
    [
      "a path that enters the layer late",
      'import "../step/../beings/a.ts";',
      "../step/../beings/a.ts",
    ],
  ])(
    "reports a kernel module that imports the beings layer through %s",
    (_name, content, specifier) => {
      expect(issues(`export const before = 1;\n${content}\n`)).toEqual([
        { file: FILE, line: 2, message: intoBeings(specifier) },
      ]);
    },
  );

  test("reports worldgen importing the beings layer with worldgen's own rule", () => {
    expect(messages('import { body } from "../beings/body.ts";\n', TERRAIN)).toEqual([
      outOfWorldgen("../beings/body.ts"),
    ]);
  });

  test("lets src/index.ts re-export the layer, and a kernel module import a lookalike directory", () => {
    const entry = 'export * as beings from "./beings/index.ts";\n';
    expect(issues(entry, `${ENGINE_SRC}/index.ts`)).toEqual([]);
    const lookalikes = [
      'import { a } from "../beingsx/a.ts";',
      'import { b } from "../beings.ts";',
      'import { c } from "./beings/c.ts";',
      "",
    ].join("\n");
    // `./beings/c.ts` from world/state.ts is world/beings/c.ts, not src/beings.
    expect(issues(lookalikes)).toEqual([]);
  });

  test("lets the layer import its allowlist and its own modules, at any depth", () => {
    const content = [
      'import { floorDiv } from "../int.ts";',
      'import { EngineError } from "../errors.ts";',
      'import { simSeconds } from "../time/tick.ts";',
      'import { chunkKey } from "../world/chunk.ts";',
      'import { readMember } from "../world/members.ts";',
      'import type { TickContext } from "../world/contracts.ts";',
      'import { sampleRegion } from "../worldgen/index.ts";',
      'import { copyCanonical } from "../canonical/copy.ts";',
      'import { digest } from "../digest/digest.ts";',
      'import { needAt } from "./needs.ts";',
      'export { senses } from "./senses/window.ts";',
      "",
    ].join("\n");
    expect(issues(content, BODY)).toEqual([]);
    const nested = 'import { imul } from "../../int.ts";\nimport { needAt } from "../needs.ts";\n';
    expect(issues(nested, `${BEINGS}/senses/window.ts`)).toEqual([]);
  });

  test.each([
    ["the kernel's random streams", 'import { mix32 } from "../rng/mix32.ts";', "../rng/mix32.ts"],
    ["the draw sequences", 'import { DrawSequence } from "../rng/random.ts";', "../rng/random.ts"],
    [
      "the terrain's cipher",
      'import { chacha20Block } from "../rng/chacha.ts";',
      "../rng/chacha.ts",
    ],
    ["the tick context", 'import { openTick } from "../step/context.ts";', "../step/context.ts"],
    [
      "the snapshots",
      'export { encodeSnapshot } from "../snapshot/snapshot.ts";',
      "../snapshot/snapshot.ts",
    ],
    ["the world model", 'import { healthyState } from "../world/world.ts";', "../world/world.ts"],
    ["world creation", 'import { createWorld } from "../world/create.ts";', "../world/create.ts"],
    ["the host view", 'import { readView } from "../world/view.ts";', "../world/view.ts"],
    ["the entry point", 'import "../index.ts";', "../index.ts"],
    [
      "a worldgen module behind its index",
      'import { liquidLevel } from "../worldgen/terrain.ts";',
      "../worldgen/terrain.ts",
    ],
    ["a module without its extension", 'import { floorDiv } from "../int";', "../int"],
    [
      "a lookalike of an allowed directory",
      'import { b } from "../digests/b.ts";',
      "../digests/b.ts",
    ],
  ])("reports a beings module that imports %s", (_name, content, specifier) => {
    expect(issues(`export const before = 1;\n${content}\n`, BODY)).toEqual([
      { file: BODY, line: 2, message: outOfAllowlist(specifier) },
    ]);
  });

  test.each([
    ["beings", BODY, "../world/contracts.ts"],
    ["worldgen", TERRAIN, "../world/contracts.ts"],
  ])("makes %s import the kernel's contracts as types only", (_layer, path, specifier) => {
    const allowed = [
      `import type { ReadView } from "${specifier}";`,
      `export type { Command } from "${specifier}";`,
      `export type View = typeof import("${specifier}");`,
      "",
    ].join("\n");
    expect(issues(allowed, path)).toEqual([]);
    const rejected = [
      `import { ReadView } from "${specifier}";`,
      `import { type Command } from "${specifier}";`,
      `export { type Ruleset } from "${specifier}";`,
      `import "${specifier}";`,
      `export const load = () => import("${specifier}");`,
      "",
    ].join("\n");
    expect(issues(rejected, path)).toEqual(
      [1, 2, 3, 4, 5].map((line) => ({ file: path, line, message: TYPES_ONLY })),
    );
  });

  test("lets kernel modules import the contracts as they like", () => {
    expect(
      issues('import { ReadView } from "./contracts.ts";\n', `${ENGINE_SRC}/world/view.ts`),
    ).toEqual([]);
  });

  test("reports every top-level let, var, and constant bound to a mutable value", () => {
    const content = [
      "let counter = 0;",
      "export var legacy = 1;",
      "const cache = {};",
      "export const STEPS = [1, 2, 3];",
      "const scratch = new Int32Array(64);",
      "const pattern = /a+/g;",
      "const typed: number[] = [];",
      "const LAWS = { awake: 3 } as const;",
      "",
    ].join("\n");
    expect(issues(content, BODY)).toEqual([
      { file: BODY, line: 1, message: moduleState("let") },
      { file: BODY, line: 2, message: moduleState("var") },
      { file: BODY, line: 3, message: mutableConst("{") },
      { file: BODY, line: 4, message: mutableConst("[") },
      { file: BODY, line: 5, message: mutableConst("new") },
      { file: BODY, line: 6, message: mutableConst("/") },
      { file: BODY, line: 7, message: mutableConst("[") },
      { file: BODY, line: 8, message: mutableConst("{") },
    ]);
  });

  test("accepts frozen, primitive, and function constants, and mutable values inside functions", () => {
    const content = [
      "export const LIMIT = 64;",
      'export const STREAM = "beings.contest";',
      "export const RATE = LIMIT / 2;",
      "export const DIRECTIONS = Object.freeze([0, 1, 2]);",
      "export const BOUNDS = Object.freeze({ min: 0, max: 1 });",
      "export const double = (value: number) => value * 2;",
      "export const scale = Math2(LIMIT);",
      "export function window(side: number): Int32Array {",
      "  const cells = new Int32Array(side * side);",
      "  const seen = { count: 0 };",
      "  const queue: number[] = [];",
      "  return cells.fill(seen.count + queue.length);",
      "}",
      "const { a, b } = BOUNDS_PAIR;",
      "// const commented = [];",
      'export const text = "const x = []";',
      "",
    ].join("\n");
    expect(issues(content, BODY)).toEqual([]);
  });

  test("leaves worldgen's constant tables to review, as ADR 0021 promises only let and var", () => {
    expect(issues("const TABLE = [1, 2];\nexport const read = () => TABLE;\n", TERRAIN)).toEqual(
      [],
    );
  });
});

describe("isEngineSource", () => {
  test("selects the TypeScript files under packages/engine/src only", () => {
    const paths = [
      `${ENGINE_SRC}/index.ts`,
      `${ENGINE_SRC}/world/world.ts`,
      `${ENGINE_SRC}/host.d.ts`,
      `${ENGINE_SRC}/legacy.mts`,
      `${ENGINE_SRC}/data.json`,
      "packages/engine/test/version.test.ts",
      "packages/engine/package.json",
      "packages/engine/src-copy/index.ts",
      "tests/repo/files.ts",
    ];
    expect(paths.filter(isEngineSource)).toEqual([
      `${ENGINE_SRC}/index.ts`,
      `${ENGINE_SRC}/world/world.ts`,
      `${ENGINE_SRC}/host.d.ts`,
      `${ENGINE_SRC}/legacy.mts`,
    ]);
  });
});

describe("packages/engine", () => {
  test("every source file passes the purity scan", async () => {
    const paths = repoFiles(REPO_ROOT).filter(isEngineSource);
    // An empty list would make the scan pass without checking anything.
    expect(paths).toContain(`${ENGINE_SRC}/index.ts`);
    const files = await Promise.all(
      paths.map(async (path) => ({ path, content: await Bun.file(`${REPO_ROOT}${path}`).text() })),
    );
    expect(files.flatMap(checkEngineSource)).toEqual([]);
  });

  test("tsconfig.json checks only src, with ECMAScript libraries and no ambient types", async () => {
    const config = (await Bun.file(`${REPO_ROOT}packages/engine/tsconfig.json`).json()) as {
      extends?: string;
      compilerOptions?: { lib?: string[]; types?: string[] };
      include?: string[];
      files?: string[];
      references?: unknown[];
    };
    // The base config carries the strict options every package shares.
    expect(config.extends).toBe("../../tsconfig.base.json");
    expect(config.compilerOptions?.types).toEqual([]);
    const lib = config.compilerOptions?.lib ?? [];
    expect(lib.length).toBeGreaterThan(0);
    // Only ECMAScript libraries: no DOM, WebWorker, or ScriptHost declarations.
    expect(lib.filter((entry) => !/^es(?:5|6|20\d\d|next)(?:\.[a-z0-9]+)*$/i.test(entry))).toEqual(
      [],
    );
    expect(config.include?.length).toBeGreaterThan(0);
    expect(config.include?.filter((entry) => !/^src(?:\/|$)/.test(entry))).toEqual([]);
    expect(config.files).toBeUndefined();
    expect(config.references).toBeUndefined();
  });

  // A module nothing imports is still engine source; if the program skipped it, the type gate
  // would never see it. The engine's include settings are applied to a scratch src directory.
  test("tsconfig.json typechecks every TypeScript module under src, imported or not", async () => {
    const config = await Bun.file(`${REPO_ROOT}packages/engine/tsconfig.json`).json();
    const scratch = mkdtempSync(join(tmpdir(), "open-origin-engine-tsconfig-"));
    try {
      const modules = ["src/plain.ts", "src/nested/esm.mts", "src/nested/cjs.cts"];
      for (const module of modules) {
        mkdirSync(dirname(join(scratch, module)), { recursive: true });
        writeFileSync(join(scratch, module), "export const value = 1;\n");
      }
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({ ...config, extends: `${REPO_ROOT}tsconfig.base.json` }),
      );
      const result = Bun.spawnSync(
        ["bunx", "--no-install", "--bun", "tsc", "-p", scratch, "--listFilesOnly"],
        { cwd: REPO_ROOT, timeout: 30_000 },
      );
      expect(result.exitCode).toBe(0);
      const listed = result.stdout.toString().split("\n");
      expect(modules.filter((module) => !listed.includes(join(scratch, module)))).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("package.json is private, exports only its entry point, and has no dependencies", async () => {
    const manifest = (await Bun.file(`${REPO_ROOT}packages/engine/package.json`).json()) as Record<
      string,
      unknown
    >;
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.exports).toEqual({ ".": "./src/index.ts" });
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      expect(manifest[field]).toBeUndefined();
    }
  });
});
