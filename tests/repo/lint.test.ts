import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ENGINE_SRC } from "./engine-purity.ts";
import { REPO_ROOT } from "./files.ts";

/**
 * Proves that each automated quality control fires: every fixture breaks one rule and is
 * linted with the repository's own configuration. A control that stops firing fails here.
 */

// Each test spawns up to three linters; a cold CI runner can exceed Bun's 5-second default.
setDefaultTimeout(60_000);

const scratch = mkdtempSync(join(tmpdir(), "open-origin-lint-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The absolute path of the scratch-relative path `name`, with its directories created. */
function scratchPath(name: string): string {
  const path = join(scratch, name);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** Writes `content` at the scratch-relative path `name` and returns its absolute path. */
function writeScratch(name: string, content: string): string {
  const path = scratchPath(name);
  writeFileSync(path, content);
  return path;
}

type PluginEntry = string | { path: string };
type DeniedGlobals = Record<string, string>;
type Override = {
  includes?: string[];
  plugins?: PluginEntry[];
  linter?: {
    rules?: { style?: { noRestrictedGlobals?: { options?: { deniedGlobals?: DeniedGlobals } } } };
  };
};
type BiomeConfig = { plugins?: PluginEntry[]; overrides?: Override[] };

/** Every GritQL plugin the configuration registers, at the top level or in an override. */
function pluginPaths(config: BiomeConfig): string[] {
  const overrides = (config.overrides ?? []).flatMap((override) => override.plugins ?? []);
  return [...(config.plugins ?? []), ...overrides].map((entry) =>
    typeof entry === "string" ? entry : entry.path,
  );
}

// Biome reads the repository configuration from the scratch directory, outside git. Override
// globs and plugin paths resolve from that directory, so fixtures and plugins keep their
// repository-relative paths there.
const biomeConfig = (await Bun.file(`${REPO_ROOT}biome.json`).json()) as BiomeConfig;
writeScratch("biome.json", JSON.stringify({ ...biomeConfig, vcs: { enabled: false } }));
for (const plugin of pluginPaths(biomeConfig)) {
  copyFileSync(join(REPO_ROOT, plugin), scratchPath(plugin));
}

/** `tsc` checks with the settings every package shares; `tsc-engine` with the engine's own. */
type Tool = "biome" | "oxlint" | "tsc" | "tsc-engine";

/** How long a linter may run before it is killed and reported as timed out. */
const TOOL_TIMEOUT_MS = 30_000;

/** `exitCode` is null when the tool was killed (a timeout), whatever the Bun types say. */
type LintResult = { exitCode: number | null; output: string };

/** A scratch tsconfig that checks exactly `paths` with the settings of the project `base`. */
function tscCommand(base: string, paths: string[]): string[] {
  const config = writeScratch(
    "tsconfig.json",
    // `include: []` drops the files the base project includes, such as the engine's own sources.
    JSON.stringify({ extends: `${REPO_ROOT}${base}`, include: [], files: paths }),
  );
  return ["tsc", "--noEmit", "-p", config];
}

/** The command line that checks the fixture `paths` with the repository's own settings. */
function commandLine(tool: Tool, paths: string[]): string[] {
  if (tool === "biome") {
    // Without --max-diagnostics=none, Biome prints only the first 20 diagnostics.
    return ["biome", "lint", "--max-diagnostics=none", `--config-path=${scratch}`, ...paths];
  }
  if (tool === "oxlint") {
    return ["oxlint", "-c", `${REPO_ROOT}.oxlintrc.json`, "--format", "unix", ...paths];
  }
  if (tool === "tsc-engine") return tscCommand("packages/engine/tsconfig.json", paths);
  return tscCommand("tsconfig.base.json", paths);
}

function run(tool: Tool, files: Record<string, string>): LintResult {
  const paths = Object.entries(files).map(([name, source]) => writeScratch(name, source));
  const args = commandLine(tool, paths);
  // Run from the repository root so bunx finds the locally installed tools.
  // A hung tool is killed and reported as timed out, instead of blocking the run
  // (Bun's per-test timeout cannot fire while spawnSync blocks the event loop).
  const result = Bun.spawnSync(["bunx", "--no-install", "--bun", ...args], {
    cwd: REPO_ROOT,
    timeout: TOOL_TIMEOUT_MS,
  });
  const timedOut = result.exitedDueToTimeout
    ? `${tool} timed out after ${TOOL_TIMEOUT_MS / 1000} seconds\n`
    : "";
  return {
    exitCode: result.exitCode,
    output: `${timedOut}${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

/** A function with `count` independent if statements: cyclomatic complexity count + 1. */
function branches(count: number): string {
  const checks = Array.from({ length: count }, (_, i) => `  if (x === ${i}) return ${i};`);
  return `export function f(x: number): number {\n${checks.join("\n")}\n  return -1;\n}\n`;
}

function nested(depth: number): string {
  const open = Array.from({ length: depth }, (_, i) => `${"  ".repeat(i + 1)}if (x > ${i}) {`);
  const close = Array.from({ length: depth }, (_, i) => `${"  ".repeat(depth - i)}}`);
  return `export function g(x: number): number {\n${open.join("\n")}\n${"  ".repeat(depth + 1)}return x;\n${close.join("\n")}\n  return 0;\n}\n`;
}

function longFunction(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `  total += ${i};`);
  return `export function h(): number {\n  let total = 0;\n${body.join("\n")}\n  return total;\n}\n`;
}

describe("automated quality controls", () => {
  test("a small, flat function passes every control", () => {
    const clean = {
      "clean.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    };
    // Exit code 0 also proves each tool ran with a valid configuration.
    expect(run("biome", clean)).toEqual({
      exitCode: 0,
      output: expect.not.stringContaining("lint/"),
    });
    expect(run("oxlint", clean)).toEqual({
      exitCode: 0,
      output: expect.not.stringContaining("eslint("),
    });
  });

  test.each([
    ["cyclomatic complexity above 10", { "cyclomatic.ts": branches(10) }, "eslint(complexity)"],
    ["blocks nested deeper than 4", { "depth.ts": nested(5) }, "eslint(max-depth)"],
  ] as const)("oxlint rejects %s", (_name, files, rule) => {
    // A non-zero exit proves the rule is an error that fails CI, not only a warning.
    expect(run("oxlint", files)).toEqual({ exitCode: 1, output: expect.stringContaining(rule) });
  });

  test("a reviewed disable comment lifts only the complexity limit, on the next line only", () => {
    const disable = "// oxlint-disable-next-line eslint/complexity -- lookup table, reviewed\n";
    expect(run("oxlint", { "justified.ts": disable + branches(10) }).exitCode).toBe(0);
    // The comment covers the first function only: a second complex function and a deep one still fail.
    const second = branches(10).replace("function f", "function f2");
    const deep = nested(5).replace("function g", "function k");
    const { exitCode, output } = run("oxlint", {
      "partly-justified.ts": `${disable}${branches(10)}${second}${deep}`,
    });
    expect(exitCode).toBe(1);
    expect(output.match(/eslint\(complexity\)/g)).toHaveLength(1);
    expect(output).toContain("eslint(max-depth)");
  });

  test("4 parameters sit exactly at the parameter limit", () => {
    // Only Biome limits parameters (useMaxParams); .oxlintrc.json has no parameter rule.
    const four =
      "export function q(a: number, b: number, c: number, d: number): number {\n  return a + b + c + d;\n}\n";
    expect(run("biome", { "four-params.ts": four }).exitCode).toBe(0);
  });

  test("a 50-line function body sits exactly at the length limit", () => {
    const source = longFunction(48);
    // Lines between the signature and the closing brace: 48 statements, `let` and `return`.
    expect(source.trimEnd().split("\n").slice(1, -1)).toHaveLength(50);
    expect(run("biome", { "at-limit.ts": source }).exitCode).toBe(0);
  });

  test("a 51-line function body fails on the length rule alone", () => {
    const { exitCode, output } = run("biome", { "over-limit.ts": longFunction(49) });
    expect(exitCode).toBe(1);
    expect([...new Set(output.match(/lint\/[a-z]+\/[A-Za-z]+/g))]).toEqual([
      "lint/complexity/noExcessiveLinesPerFunction",
    ]);
  });

  test("the 50-line limit is lifted for test files only", () => {
    expect(run("biome", { "long.test.ts": longFunction(55) }).exitCode).toBe(0);
    expect(run("biome", { "long-test-helper.ts": longFunction(55) }).exitCode).toBe(1);
  });

  test("oxlint accepts a cyclomatic complexity of exactly 10 and a nesting depth of exactly 4", () => {
    expect(run("oxlint", { "ten.ts": branches(9) }).exitCode).toBe(0);
    expect(run("oxlint", { "depth-four.ts": nested(4) }).exitCode).toBe(0);
  });

  test("a cognitive complexity of exactly 15 passes, and 16 fails on that rule alone", () => {
    // Each nested `if` adds 1 plus its depth: 1 + 2 + 3 + 4 + 5 = 15; one more top-level `if` is 16.
    expect(run("biome", { "cognitive-15.ts": nested(5) }).exitCode).toBe(0);
    const sixteen = nested(5).replace("  return 0;\n}", "  if (x < 0) return 1;\n  return 0;\n}");
    const { exitCode, output } = run("biome", { "cognitive-16.ts": sixteen });
    expect(exitCode).toBe(1);
    expect([...new Set(output.match(/lint\/[a-z]+\/[A-Za-z]+/g))]).toEqual([
      "lint/complexity/noExcessiveCognitiveComplexity",
    ]);
  });

  test.each([
    [
      "functions longer than 50 lines",
      { "long.ts": longFunction(55) },
      "lint/complexity/noExcessiveLinesPerFunction",
    ],
    [
      "more than 4 parameters",
      {
        "params.ts":
          "export function p(a: number, b: number, c: number, d: number, e: number): number {\n  return a + b + c + d + e;\n}\n",
      },
      "lint/complexity/useMaxParams",
    ],
    [
      "an else after a return (use a guard clause)",
      {
        "else.ts":
          "export function s(x: number): number {\n  if (x > 0) {\n    return 1;\n  } else {\n    return 2;\n  }\n}\n",
      },
      "lint/style/noUselessElse",
    ],
    [
      "nested ternaries",
      {
        "ternary.ts":
          "export function t(x: number): number {\n  return x > 0 ? 1 : x < 0 ? -1 : 0;\n}\n",
      },
      "lint/style/noNestedTernary",
    ],
    [
      "explicit any",
      { "any.ts": "export function a(x: any): number {\n  return x;\n}\n" },
      "lint/suspicious/noExplicitAny",
    ],
    [
      "ts-ignore suppressions",
      { "ignore.ts": "// @ts-ignore\nexport const n: number = 'x';\n" },
      "lint/suspicious/noTsIgnore",
    ],
    [
      "non-null assertions",
      { "bang.ts": "export function b(x: string | undefined): number {\n  return x!.length;\n}\n" },
      "lint/style/noNonNullAssertion",
    ],
    [
      "import cycles",
      {
        "cycle-a.ts":
          'import { b } from "./cycle-b.ts";\nexport const a = (): number => b() + 1;\n',
        "cycle-b.ts":
          'import { a } from "./cycle-a.ts";\nexport const b = (): number => a() + 1;\n',
      },
      "lint/suspicious/noImportCycles",
    ],
    [
      "parameter reassignment",
      { "reassign.ts": "export function r(x: number): number {\n  x = x + 1;\n  return x;\n}\n" },
      "lint/style/noParameterAssign",
    ],
    [
      "unused variables",
      { "unused-var.ts": "export function u(): number {\n  const unused = 1;\n  return 2;\n}\n" },
      "lint/correctness/noUnusedVariables",
    ],
    [
      "unused imports",
      {
        "unused-import.ts": 'import { readFileSync } from "node:fs";\nexport const x = 1;\n',
      },
      "lint/correctness/noUnusedImports",
    ],
    [
      "assignments to a builtin global",
      {
        "global-assign.ts":
          "export function reset(value: typeof Math): void {\n  Math = value;\n}\n",
      },
      "lint/suspicious/noGlobalAssign",
    ],
    [
      "unused parameters",
      { "unused-param.ts": "export function w(a: number, b: number): number {\n  return a;\n}\n" },
      "lint/correctness/noUnusedFunctionParameters",
    ],
  ] as const)("Biome rejects %s", (_name, files, rule) => {
    const { exitCode, output } = run("biome", files);
    // The fixture breaks exactly this rule, so the failing exit code comes from it alone.
    expect(exitCode).toBe(1);
    expect([...new Set(output.match(/lint\/[a-z]+\/[A-Za-z]+/g))]).toEqual([rule]);
  });
});

describe("TypeScript strict mode", () => {
  test("accepts code that handles a possibly missing element", () => {
    const typed = "export const first = (xs: readonly number[]): number | undefined => xs[0];\n";
    expect(run("tsc", { "typed.ts": typed })).toEqual({
      exitCode: 0,
      output: expect.not.stringContaining("error TS"),
    });
  });

  test.each([
    ["an implicit any (strict)", "export function f(a) {\n  return a;\n}\n", "TS7006"],
    [
      "an unchecked index access (noUncheckedIndexedAccess)",
      "export const first = (xs: number[]): number => xs[0];\n",
      "TS2322",
    ],
    [
      "an explicit undefined in an optional property (exactOptionalPropertyTypes)",
      "type A = { x?: number };\nexport const a: A = { x: undefined };\n",
      "TS2375",
    ],
  ] as const)("rejects %s", (_name, source, code) => {
    const { exitCode, output } = run("tsc", { "strict.ts": source });
    // The fixture breaks exactly this rule, so the failing exit code comes from it alone.
    expect(exitCode).not.toBe(0);
    expect([...new Set(output.match(/TS\d{4,5}/g))]).toEqual([code]);
  });
});

const ENGINE_TEST = "packages/engine/test";

/** One Biome diagnostic: the scratch-relative fixture, its rule (or `plugin`), and its text. */
type Diagnostic = { file: string; category: string; text: string };

/** A diagnostic starts with `<path>:<line>:<column> <category>` and runs to the next one. */
const DIAGNOSTIC_HEADER = /^(\S+):\d+:\d+ (\S+)[^\n]*━$/gm;

function biomeDiagnostics(output: string): Diagnostic[] {
  const headers = [...output.matchAll(DIAGNOSTIC_HEADER)];
  return headers.map((header, index) => ({
    file: (header[1] ?? "").replace(`${scratch}/`, ""),
    category: header[2] ?? "",
    text: output.slice(header.index, headers[index + 1]?.index ?? output.length),
  }));
}

/** Globals the engine core may not reference (ADR 0003 P5), as noRestrictedGlobals denies them. */
const DENIED_GLOBALS = [
  "Date",
  "Intl",
  "globalThis",
  "WeakRef",
  "FinalizationRegistry",
  "SharedArrayBuffer",
  "Atomics",
  "Promise",
  "Set",
  "WeakMap",
  "WeakSet",
  "Function",
  "Bun",
  "crypto",
  "performance",
  "structuredClone",
  "Reflect",
] as const;

/**
 * Globals that have, or will have, a reviewed per-file exception (ADR 0020): each is denied by a
 * GritQL plugin of its own, `call` is a typical use, and `message` starts its diagnostic.
 */
const PLUGIN_GLOBALS = [
  { name: "JSON", call: "JSON.stringify(0)" },
  { name: "Math", call: "Math.imul(2, 3)" },
  { name: "Map", call: "new Map<string, number>()" },
].map((global) => ({ ...global, message: `The global \`${global.name}\`` }));

/**
 * Every kind of value reference to the global `name`, one per line, that its plugin must report.
 * The parameter type `typeof name` is a type position, which it must not report.
 */
function valueReferences(name: string, call: string): string[] {
  return [
    `export const called = ${call};`,
    `export const member = ${name}.toString;`,
    `export const computed = (key: "toString") => ${name}[key];`,
    `export const alias = ${name};`,
    `export const { valueOf: unwrap } = ${name};`,
    `export const argument = String(${name});`,
    `export const shorthand = { ${name} };`,
    `export const kind = typeof ${name};`,
    `export const cast = (${name} as unknown) ?? 0;`,
    `export function same(value: typeof ${name}): boolean {\n  return value === ${name};\n}`,
    `export default ${name};`,
  ];
}

/**
 * A source that breaks purity rules: the rules it must trigger (sorted), and how many of its
 * diagnostics must carry `message` (one unless stated).
 */
type PurityCase = { source: string; rules: string[]; message: string; matches?: number };

const RESTRICTED_GLOBAL = ["lint/style/noRestrictedGlobals"];
const PLUGIN = ["plugin"];
const KEY_ORDER_MESSAGE = "Key enumeration through `Object`";
const LOCALE_MESSAGE = "Locale-sensitive methods depend on the host";
const CONSTRUCTOR_MESSAGE = "`.constructor` reaches the `Function` constructor";
const RESTRICTED_IMPORT = ["lint/style/noRestrictedImports"];

/** Fixture file names and the diagnostics each one must raise under packages/engine/src. */
const PURITY_CASES: Record<string, PurityCase> = {
  ...Object.fromEntries(
    DENIED_GLOBALS.map((name) => [
      `global-${name}.ts`,
      {
        source: `export const ref = ${name};\n`,
        rules: RESTRICTED_GLOBAL,
        message: `Do not use the global variable ${name}.`,
      },
    ]),
  ),
  ...Object.fromEntries(
    PLUGIN_GLOBALS.map(({ name, call, message }) => {
      const references = valueReferences(name, call);
      const source = `${references.join("\n")}\n`;
      return [
        `plugin-global-${name}.ts`,
        { source, rules: PLUGIN, message, matches: references.length },
      ];
    }),
  ),
  "exponent.ts": {
    source: "export const cube = 2 ** 3;\n",
    rules: PLUGIN,
    message: "`**` and `**=` are implementation-approximated",
  },
  "exponent-assignment.ts": {
    source:
      "export function square(x: number): number {\n  let y = x;\n  y **= 2;\n  return y;\n}\n",
    rules: PLUGIN,
    message: "`**` and `**=` are implementation-approximated",
  },
  "async.ts": {
    source: [
      "export async function load() {\n  return 1;\n}",
      "export const arrow = async () => 1;",
      "export const expression = async function (this: { n: number }) {\n  return this.n;\n};",
      "export class Loader {\n  private n = 1;\n  async read() {\n    return this.helper();\n  }",
      "  private async helper() {\n    return this.n;\n  }\n}",
      "export const methods = {\n  async read() {\n    return 1;\n  },\n};\n",
    ].join("\n"),
    rules: PLUGIN,
    message: "The engine is synchronous: `async` functions",
    matches: 6,
  },
  "await.ts": {
    source: "export const value = await 0;\nfor await (const item of [1]) {\n  value + item;\n}\n",
    rules: PLUGIN,
    message: "The engine is synchronous: `await`",
    matches: 2,
  },
  "locale.ts": {
    source: [
      'export const order = "a".localeCompare("b");',
      "export const text = (1).toLocaleString();",
      'export const upper = "a".toLocaleUpperCase();',
      'export const lower = "a".toLocaleLowerCase();',
      "type Day = { toLocaleDateString(): string; toLocaleTimeString(): string };",
      "export const date = (day: Day): string => day.toLocaleDateString();",
      "export const time = (day: Day): string => day.toLocaleTimeString();\n",
    ].join("\n"),
    rules: PLUGIN,
    message: LOCALE_MESSAGE,
    matches: 6,
  },
  "object-keys.ts": {
    source: [
      "export const keys = Object.keys({});",
      "export const values = Object.values({});",
      "export const entries = Object.entries({});",
      "export const names = Object.getOwnPropertyNames({});",
      "export const symbols = Object.getOwnPropertySymbols({});",
      "export const descriptors = Object.getOwnPropertyDescriptors({});\n",
    ].join("\n"),
    rules: PLUGIN,
    message: KEY_ORDER_MESSAGE,
    matches: 6,
  },
  "object-binding.ts": {
    source: [
      "export const O = Object;",
      "export const { keys } = Object;",
      "export function bind(seed: unknown): unknown {\n  let target = seed;\n  target = Object;\n  return target;\n}\n",
    ].join("\n"),
    rules: PLUGIN,
    message: "Binding `Object` to a name hides",
    matches: 3,
  },
  "constructor.ts": {
    source: [
      "export const make = (() => undefined).constructor;",
      "export class Clock {\n  kind(): unknown {\n    return this.constructor;\n  }\n}\n",
    ].join("\n"),
    rules: PLUGIN,
    message: CONSTRUCTOR_MESSAGE,
    matches: 2,
  },
  "for-in.ts": {
    source:
      "export function count(record: Record<string, number>): number {\n  let total = 0;\n  for (const key in record) total += key.length;\n  return total;\n}\n",
    rules: ["lint/suspicious/noForIn"],
    message: "Unexpected for-in loop.",
  },
  "console.ts": {
    source: 'console.log("tick");\n',
    rules: ["lint/suspicious/noConsole"],
    message: "Don't use console.",
  },
  "process.ts": {
    source: "export const env = process.env;\n",
    rules: ["lint/correctness/noProcessGlobal"],
    message: "Usage of the `process` global is discouraged.",
  },
  "node-fs.ts": {
    source: 'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
    rules: ["lint/correctness/noNodejsModules", ...RESTRICTED_IMPORT],
    message: "`node:*` modules are host APIs",
  },
  "bun.ts": {
    source: 'import { file } from "bun";\nexport const open = file;\n',
    rules: RESTRICTED_IMPORT,
    message: "`bun` and `bun:*` are host APIs",
  },
  "bun-test.ts": {
    source: 'import { test } from "bun:test";\nexport const check = test;\n',
    rules: RESTRICTED_IMPORT,
    message: "`bun` and `bun:*` are host APIs",
  },
  "package.ts": {
    source: [
      'import { parse } from "some-package";',
      'export { helper } from "@scope/tools";',
      "export const read = parse;\n",
    ].join("\n"),
    rules: RESTRICTED_IMPORT,
    message: "The engine depends on nothing",
    matches: 2,
  },
};

/** Recommended everywhere, so only the src run can prove the engine override turns it on. */
const EVAL_CASE: Record<string, PurityCase> = {
  "eval.ts": {
    source: 'export const one = eval("1");\n',
    rules: ["lint/security/noGlobalEval"],
    message: "Do not use eval().",
  },
};

/** The fixtures at `directory`, keyed by their scratch-relative paths. */
function sourcesIn(directory: string, cases: Record<string, PurityCase>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(cases).map(([name, { source }]) => [`${directory}/${name}`, source]),
  );
}

type LintSummary = { exitCode: number | null; checked: number; diagnostics: Diagnostic[] };

/** Lints `files`; `checked` proves Biome linted them all instead of skipping them. */
function lintSummary(files: Record<string, string>): LintSummary {
  const { exitCode, output } = run("biome", files);
  const checked = Number(/Checked (\d+) files?/.exec(output)?.[1]);
  return { exitCode, checked, diagnostics: biomeDiagnostics(output) };
}

describe("engine purity controls (packages/engine/src)", () => {
  // One Biome run lints every fixture, to bound CI time.
  let lintedSources: { exitCode: number | null; diagnostics: Diagnostic[] } | undefined;
  function srcRun(): { exitCode: number | null; diagnostics: Diagnostic[] } {
    if (lintedSources === undefined) {
      const { exitCode, output } = run("biome", {
        ...sourcesIn(ENGINE_SRC, PURITY_CASES),
        ...sourcesIn(ENGINE_SRC, EVAL_CASE),
      });
      lintedSources = { exitCode, diagnostics: biomeDiagnostics(output) };
    }
    return lintedSources;
  }

  test("fixtures under src fail the lint, every diagnostic as an error", () => {
    const { exitCode, diagnostics } = srcRun();
    expect(exitCode).toBe(1);
    expect(diagnostics.filter((diagnostic) => !diagnostic.text.includes("\n\n  × "))).toEqual([]);
  });

  test.each(Object.entries({ ...PURITY_CASES, ...EVAL_CASE }))(
    "Biome rejects %s under src",
    (name, expected) => {
      const found = srcRun().diagnostics.filter(
        (diagnostic) => diagnostic.file === `${ENGINE_SRC}/${name}`,
      );
      expect([...new Set(found.map((diagnostic) => diagnostic.category))].sort()).toEqual(
        expected.rules,
      );
      expect(found.filter((diagnostic) => diagnostic.text.includes(expected.message))).toHaveLength(
        expected.matches ?? 1,
      );
    },
  );

  test("a computed key, quoted or in backticks, does not hide a member from the plugin", () => {
    // Biome's useLiteralKeys only informs about these keys, so the plugin is the gate.
    const { exitCode, output } = run("biome", {
      [`${ENGINE_SRC}/computed-keys.ts`]: [
        'export const keys = Object["keys"]({});',
        "export const values = Object[`values`]({});",
        "export const names = Object['getOwnPropertyNames']({});",
        'export const order = "a"["localeCompare"]("b");',
        'export const text = "a"[`toLocaleString`]();',
        'export const make = (() => undefined)["constructor"];',
        "export const build = (() => undefined)[`constructor`];\n",
      ].join("\n"),
    });
    const plugin = biomeDiagnostics(output).filter(({ category }) => category === "plugin");
    expect(exitCode).toBe(1);
    expect(plugin.filter(({ text }) => text.includes(KEY_ORDER_MESSAGE))).toHaveLength(3);
    expect(plugin.filter(({ text }) => text.includes(LOCALE_MESSAGE))).toHaveLength(2);
    expect(plugin.filter(({ text }) => text.includes(CONSTRUCTOR_MESSAGE))).toHaveLength(2);
    expect(plugin).toHaveLength(7);
  });

  test("the same sources pass outside src: the controls are scoped to the engine core", () => {
    const files = sourcesIn(ENGINE_TEST, PURITY_CASES);
    expect(lintSummary(files)).toEqual({
      exitCode: 0,
      checked: Object.keys(files).length,
      diagnostics: [],
    });
  });

  test("engine-style code passes under src: relative imports, integers, ordered loops", () => {
    const summary = lintSummary({
      [`${ENGINE_SRC}/sum.ts`]: [
        'import { double } from "./integers/double.ts";',
        "",
        "export function sum(values: readonly number[]): number {",
        "  let total = 0;",
        "  for (const value of values) {",
        "    total += double(value);",
        "  }",
        "  return total;",
        "}",
        "",
        // A string that contains `**=` is not the operator.
        'export const label = { text: "" };',
        'label.text = "**=";',
        "",
        // Calling `Object` members that do not enumerate keys, and declaring a constructor, are fine.
        "export const frozen = Object.freeze({ total: 0 });",
        // Names of plugin globals as property names, as keys, and in types are not the globals;
        // nor are identifiers that only start or end like them.
        "export const holder = { Math: 1, JSON: 2, Map: 3 };",
        "export const fields = holder.Math + holder.JSON + holder.Map;",
        "export type Types = [Math, JSON, Map<string, number>, typeof Math, typeof JSON.parse];",
        "export interface Named {\n  Math: number;\n  Map(): void;\n}",
        "export const MathLike = 1;",
        "export const isJSON = MathLike > 0;",
        "export class Counter {",
        "  readonly start: number;",
        "  constructor(start: number) {",
        "    this.start = start;",
        "  }",
        "}\n",
      ].join("\n"),
      [`${ENGINE_SRC}/integers/double.ts`]: "export const double = (x: number): number => x * 2;\n",
    });
    expect(summary).toEqual({ exitCode: 0, checked: 2, diagnostics: [] });
  });
});

/**
 * The reviewed exceptions of ADR 0020 ("Determinism rules enforced by tools"). Each rule that has
 * one lives in a GritQL plugin of its own, registered for src minus its exception file, because
 * Biome adds up the plugins of every override that matches a file and cannot take one away:
 * canonical/order.ts may enumerate keys through `Object` (key-order.grit), canonical/encode.ts may
 * use the global `JSON` (global-json.grit), and canonical/value.ts the global `Map`
 * (global-map.grit). The global `Math` has a plugin of its own (global-math.grit) and no exception
 * yet. Each exception covers its exact file, and every other purity rule still applies to it.
 */
const ORDER_TS = `${ENGINE_SRC}/canonical/order.ts`;
const ENCODE_TS = `${ENGINE_SRC}/canonical/encode.ts`;
const VALUE_TS = `${ENGINE_SRC}/canonical/value.ts`;

/** The overrides that configure noRestrictedGlobals: biome.json keeps one list, in one override. */
const GLOBAL_OVERRIDES = (biomeConfig.overrides ?? []).filter(
  (override) => override.linter?.rules?.style?.noRestrictedGlobals !== undefined,
);

/** Denied in all of packages/engine/src, as biome.json says. */
const ENGINE_DENIED: DeniedGlobals =
  GLOBAL_OVERRIDES[0]?.linter?.rules?.style?.noRestrictedGlobals?.options?.deniedGlobals ?? {};

/** One broken purity rule: a source line and a text that only its diagnostic contains. */
type Probe = { name: string; source: string; message: string };

const KEY_ENUMERATION_PROBE: Probe = {
  name: "key enumeration",
  source: "export const ownKeys = Object.keys({});",
  message: KEY_ORDER_MESSAGE,
};

const globalProbe = (name: string): Probe => ({
  name: `the global ${name}`,
  source: `export const global${name} = ${name};`,
  message: `Do not use the global variable ${name}.`,
});

/** The probe of each plugin global, by name. */
const PLUGIN_PROBES: Record<string, Probe> = Object.fromEntries(
  PLUGIN_GLOBALS.map(({ name, message }) => [
    name,
    { name: `the global ${name}`, source: `export const global${name} = ${name};`, message },
  ]),
);

/** The probe for `name`, which must be a plugin global. */
function pluginProbe(name: string): Probe {
  const probe = PLUGIN_PROBES[name];
  if (probe === undefined) throw new Error(`${name} is not a plugin global`);
  return probe;
}

/** Each excepted file and the one rule it may break. */
const EXCEPTIONS: { file: string; probe: Probe }[] = [
  { file: ORDER_TS, probe: KEY_ENUMERATION_PROBE },
  { file: ENCODE_TS, probe: pluginProbe("JSON") },
  { file: VALUE_TS, probe: pluginProbe("Map") },
];

/** Two rules reject this import, so two probes share it; a fixture holds it once. */
const NODE_IMPORT = 'import { readFileSync } from "node:fs";\nexport const read = readFileSync;';

/** Every purity rule, through one probe each; the cases above cover their variants. */
const EVERY_RULE: Probe[] = [
  KEY_ENUMERATION_PROBE,
  ...Object.values(PLUGIN_PROBES),
  ...Object.keys(ENGINE_DENIED).map(globalProbe),
  { name: "**", source: "export const cube = 2 ** 3;", message: "`**` and `**=`" },
  {
    name: "async",
    source: "export async function load() {\n  return 1;\n}",
    message: "The engine is synchronous: `async`",
  },
  {
    name: "await",
    source: "export const awaited = await 0;",
    message: "The engine is synchronous: `await`",
  },
  {
    name: "locale methods",
    source: 'export const order = "a".localeCompare("b");',
    message: LOCALE_MESSAGE,
  },
  {
    name: "binding Object",
    source: "export const O = Object;",
    message: "Binding `Object` to a name hides",
  },
  {
    name: ".constructor",
    source: "export const make = (() => undefined).constructor;",
    message: CONSTRUCTOR_MESSAGE,
  },
  {
    name: "for...in",
    source:
      "export function count(record: Record<string, number>): number {\n  let total = 0;\n  for (const key in record) total += key.length;\n  return total;\n}",
    message: "Unexpected for-in loop.",
  },
  { name: "console", source: 'console.log("tick");', message: "Don't use console." },
  {
    name: "process",
    source: "export const env = process.env;",
    message: "Usage of the `process` global is discouraged.",
  },
  { name: "eval", source: 'export const one = eval("1");', message: "Do not use eval()." },
  { name: "Node.js modules", source: NODE_IMPORT, message: "references a Node.js builtin module" },
  { name: "node:* imports", source: NODE_IMPORT, message: "`node:*` modules are host APIs" },
  {
    name: "package imports",
    source: 'import { parse } from "some-package";\nexport const parsePackage = parse;',
    message: "The engine depends on nothing",
  },
];

/**
 * The rules that have, or will have, an exception. Every path that looks like an excepted file,
 * or like the future home of the integer helpers, must be rejected by all of them.
 */
const EXEMPTABLE = [KEY_ENUMERATION_PROBE, ...Object.values(PLUGIN_PROBES)];

const NEAR_MISSES = [
  `${ENGINE_SRC}/order.ts`,
  `${ENGINE_SRC}/encode.ts`,
  `${ENGINE_SRC}/value.ts`,
  `${ENGINE_SRC}/int.ts`,
  `${ENGINE_SRC}/canonical/reorder.ts`,
  `${ENGINE_SRC}/canonical/encoder.ts`,
  `${ENGINE_SRC}/canonical/values.ts`,
  `${ENGINE_SRC}/canonical/order/order.ts`,
  `${ENGINE_SRC}/canonical/encode/encode.ts`,
  `${ENGINE_SRC}/canonical/value/value.ts`,
];

describe("reviewed exceptions in packages/engine/src", () => {
  // One Biome run lints every fixture, to bound CI time.
  let linted: LintSummary | undefined;
  function exceptionRun(): LintSummary {
    if (linted === undefined) {
      const everyRule = `${[...new Set(EVERY_RULE.map((probe) => probe.source))].join("\n")}\n`;
      const nearMiss = `${EXEMPTABLE.map((probe) => probe.source).join("\n")}\n`;
      linted = lintSummary({
        ...Object.fromEntries(EXCEPTIONS.map(({ file }) => [file, everyRule])),
        ...Object.fromEntries(NEAR_MISSES.map((path) => [path, nearMiss])),
      });
    }
    return linted;
  }

  /** How many diagnostics of `file` contain each probe's message, by probe name. */
  function probeCounts(file: string, probes: readonly Probe[]): Record<string, number> {
    const found = exceptionRun().diagnostics.filter((diagnostic) => diagnostic.file === file);
    return Object.fromEntries(
      probes.map(({ name, message }) => [
        name,
        found.filter((diagnostic) => diagnostic.text.includes(message)).length,
      ]),
    );
  }

  /** One diagnostic per probe, and none for the probe named `exempt`. */
  function expectedCounts(probes: readonly Probe[], exempt: string): Record<string, number> {
    return Object.fromEntries(probes.map(({ name }) => [name, name === exempt ? 0 : 1]));
  }

  test("Biome lints every fixture, with every plugin copied next to purity.grit", () => {
    expect(pluginPaths(biomeConfig)).toEqual(
      expect.arrayContaining([
        "./packages/engine/lint/key-order.grit",
        "./packages/engine/lint/global-json.grit",
        "./packages/engine/lint/global-math.grit",
        "./packages/engine/lint/global-map.grit",
      ]),
    );
    const { exitCode, checked } = exceptionRun();
    expect(exitCode).toBe(1);
    expect(checked).toBe(EXCEPTIONS.length + NEAR_MISSES.length);
  });

  test("one override denies globals, for all of src, and it leaves the plugin globals out", () => {
    expect(GLOBAL_OVERRIDES.map((override) => override.includes)).toEqual([[`${ENGINE_SRC}/**`]]);
    const denied = Object.keys(ENGINE_DENIED);
    expect([...denied].sort()).toEqual([...DENIED_GLOBALS].sort());
    expect(PLUGIN_GLOBALS.filter(({ name }) => denied.includes(name))).toEqual([]);
  });

  test.each(EXCEPTIONS)(
    "$file may break only its own rule, and every other one applies",
    ({ file, probe }) => {
      expect(probeCounts(file, EVERY_RULE)).toEqual(expectedCounts(EVERY_RULE, probe.name));
    },
  );

  test("each exception covers its exact path and no other file", () => {
    const counts = Object.fromEntries(
      NEAR_MISSES.map((path) => [path, probeCounts(path, EXEMPTABLE)]),
    );
    const allRejected = expectedCounts(EXEMPTABLE, "");
    expect(counts).toEqual(Object.fromEntries(NEAR_MISSES.map((path) => [path, allRejected])));
  });
});

describe("engine compiler settings (packages/engine/tsconfig.json)", () => {
  /** Host APIs outside ECMAScript: the engine's `lib` and `types` must not declare them. */
  const HOST_GLOBALS = ["console", "Bun", "process", "TextEncoder", "setTimeout", "crypto"];

  test("reject host globals", () => {
    const { exitCode, output } = run(
      "tsc-engine",
      Object.fromEntries(
        HOST_GLOBALS.map((name) => [
          `${ENGINE_SRC}/host-${name}.ts`,
          `export const ref = ${name};\n`,
        ]),
      ),
    );
    expect(exitCode).not.toBe(0);
    // Each fixture fails on its own global, and nothing else fails (no configuration error).
    const errors = output.match(/error TS\d+: [^\n]*/g) ?? [];
    expect(errors).toHaveLength(HOST_GLOBALS.length);
    for (const name of HOST_GLOBALS) {
      expect(output).toMatch(
        new RegExp(`host-${name}\\.ts\\(1,20\\): error TS\\d+: Cannot find name '${name}'`),
      );
    }
  });

  test("accept ECMAScript 2024 (String.prototype.isWellFormed)", () => {
    const es2024 = {
      [`${ENGINE_SRC}/es2024.ts`]: 'export const wellFormed = "x".isWellFormed();\n',
    };
    expect(run("tsc-engine", es2024)).toEqual({
      exitCode: 0,
      output: expect.not.stringContaining("error TS"),
    });
  });
});
