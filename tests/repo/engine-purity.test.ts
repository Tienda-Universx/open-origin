import { describe, expect, test } from "bun:test";
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

  test("allows the reviewed oxlint complexity comment and strings that mention suppressions", () => {
    const content = [
      "// oxlint-disable-next-line eslint/complexity -- lookup table, reviewed",
      "export const pick = (x: number): number => x;",
      'export const note = "a // biome-ignore inside a string is not a comment";',
      "// @ts-check only turns checking on.",
      'export const pragma = "// @ts-nocheck inside a string is not a comment";',
      "",
    ].join("\n");
    expect(issues(content)).toEqual([]);
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
    expect(config.include).toEqual(["src/**/*.ts"]);
    expect(config.files).toBeUndefined();
    expect(config.references).toBeUndefined();
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
