import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { AGENTS_SRC, ENGINE_SRC } from "./engine-purity.ts";
import { REPO_ROOT } from "./files.ts";
import { createLintHarness, type DeniedGlobals, pluginPaths } from "./lint-harness.ts";

/**
 * Proves that each engine purity control fires under packages/engine/src and only there, that each
 * reviewed exception covers exactly its file and its rule, and that the engine's compiler settings
 * reject host globals. It also proves that packages/agents/src shares every purity rule of the
 * engine, with no exception, and has its own import rule (ADR 0023). Every fixture is checked with
 * the repository's own configuration.
 */

// One linter run checks many fixtures; a cold CI runner can exceed Bun's 5-second default.
setDefaultTimeout(60_000);

const { biomeConfig, cleanup, run, scratch } = await createLintHarness();
afterAll(cleanup);

const ENGINE_TEST = "packages/engine/test";
const AGENTS_TEST = "packages/agents/test";

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
  "Proxy",
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

/**
 * Fixture file names and the diagnostics each one must raise under packages/engine/src and
 * packages/agents/src alike: every purity rule but the import rule, which each package has its own.
 */
const SHARED_CASES: Record<string, PurityCase> = {
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
};

/** Host modules: both packages reject them through noRestrictedImports with the same message. */
const HOST_IMPORT_CASES: Record<string, PurityCase> = {
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
};

/** Imports of packages: one source, rejected by each package's own import rule. */
const PACKAGE_IMPORTS = [
  'import { parse } from "some-package";',
  'export { helper } from "@scope/tools";',
  "export const read = parse;\n",
].join("\n");

/** Fixture file names and the diagnostics each one must raise under packages/engine/src. */
const PURITY_CASES: Record<string, PurityCase> = {
  ...SHARED_CASES,
  ...HOST_IMPORT_CASES,
  "package.ts": {
    source: PACKAGE_IMPORTS,
    rules: RESTRICTED_IMPORT,
    message: "The engine depends on nothing",
    matches: 2,
  },
};

/** Starts the diagnostic of the agents' import rule, which no engine diagnostic contains. */
const AGENTS_IMPORT_MESSAGE = "packages/agents imports only relative paths";

/**
 * The agents' import rule (ADR 0023): only relative paths and exactly `@open-origin/engine`.
 * A deep path into the engine, a lookalike of its name, the agents' own name, and the engine
 * itself are rejected; so is every other package.
 */
const AGENTS_IMPORT_CASES: Record<string, PurityCase> = {
  ...HOST_IMPORT_CASES,
  "package.ts": {
    source: PACKAGE_IMPORTS,
    rules: RESTRICTED_IMPORT,
    message: AGENTS_IMPORT_MESSAGE,
    matches: 2,
  },
  "engine-deep.ts": {
    source: [
      'import { floorDiv } from "@open-origin/engine/src/int.ts";',
      'export type { Seed } from "@open-origin/engine/src/rng/mix32.ts";',
      'import "@open-origin/engine/";',
      'import manifest from "@open-origin/engine/package.json";',
      "export const parts = [floorDiv, manifest];\n",
    ].join("\n"),
    rules: RESTRICTED_IMPORT,
    message: AGENTS_IMPORT_MESSAGE,
    matches: 4,
  },
  "engine-lookalike.ts": {
    source: [
      'import { a } from "@open-origin/engines";',
      'import { b } from "@open-origin/engine-tools";',
      'import { c } from "@open-origin/agents";',
      'import { d } from "engine";',
      "export const parts = [a, b, c, d];\n",
    ].join("\n"),
    rules: RESTRICTED_IMPORT,
    message: AGENTS_IMPORT_MESSAGE,
    matches: 4,
  },
};

/** Fixture file names and the diagnostics each one must raise under packages/agents/src. */
const AGENTS_CASES: Record<string, PurityCase> = { ...SHARED_CASES, ...AGENTS_IMPORT_CASES };

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

/**
 * Code that keeps every purity rule: integers, ordered loops, a frozen record, a class, and the
 * names of plugin globals where they are not the globals. Each package adds its own imports.
 */
const PURE_STYLE = [
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
];

/** A package whose sources keep the purity rules: where they live and what they may import. */
type PurePackage = {
  name: string;
  src: string;
  /** A directory of the same package outside src, where none of these rules applies. */
  outside: string;
  cases: Record<string, PurityCase>;
  /** The imports of a module that keeps every rule; they bring in `double`. */
  imports: string[];
};

const PURE_PACKAGES: PurePackage[] = [
  {
    name: "engine",
    src: ENGINE_SRC,
    outside: ENGINE_TEST,
    cases: PURITY_CASES,
    imports: ['import { double } from "./integers/double.ts";'],
  },
  {
    name: "agents",
    src: AGENTS_SRC,
    outside: AGENTS_TEST,
    cases: AGENTS_CASES,
    imports: [
      'import { EngineError, type Issue } from "@open-origin/engine";',
      'import type { Tick } from "@open-origin/engine";',
      'import { double } from "./integers/double.ts";',
      'export { ENGINE_VERSION } from "@open-origin/engine";',
      'export type Engine = typeof import("@open-origin/engine");',
      "export const fail = (issues: Issue[], tick: Tick) =>",
      '  new EngineError("invalid_value", issues, { issueCount: tick });',
    ],
  },
];

describe.each(PURE_PACKAGES)("$name purity controls ($src)", (pure) => {
  const { name, src, outside, cases, imports } = pure;
  // One Biome run lints every fixture, to bound CI time.
  let lintedSources: { exitCode: number | null; diagnostics: Diagnostic[] } | undefined;
  function srcRun(): { exitCode: number | null; diagnostics: Diagnostic[] } {
    if (lintedSources === undefined) {
      const { exitCode, output } = run("biome", {
        ...sourcesIn(src, cases),
        ...sourcesIn(src, EVAL_CASE),
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

  test.each(Object.entries({ ...cases, ...EVAL_CASE }))(
    "Biome rejects %s under src",
    (fixture, expected) => {
      const found = srcRun().diagnostics.filter(
        (diagnostic) => diagnostic.file === `${src}/${fixture}`,
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
      [`${src}/computed-keys.ts`]: [
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

  test(`the same sources pass outside src: the controls are scoped to the ${name} sources`, () => {
    const files = sourcesIn(outside, cases);
    expect(lintSummary(files)).toEqual({
      exitCode: 0,
      checked: Object.keys(files).length,
      diagnostics: [],
    });
  });

  test(`${name}-style code passes under src: its imports, integers, ordered loops`, () => {
    const summary = lintSummary({
      [`${src}/sum.ts`]: [...imports, "", ...PURE_STYLE].join("\n"),
      [`${src}/integers/double.ts`]: "export const double = (x: number): number => x * 2;\n",
    });
    expect(summary).toEqual({ exitCode: 0, checked: 2, diagnostics: [] });
  });
});

/**
 * The reviewed exceptions of ADR 0020 ("Determinism rules enforced by tools"). Each rule that has
 * one lives in a GritQL plugin of its own, registered for src minus its exception file, because
 * Biome adds up the plugins of every override that matches a file and cannot take one away:
 * canonical/order.ts may enumerate keys through `Object` (key-order.grit), canonical/encode.ts may
 * use the global `JSON` (global-json.grit), canonical/value.ts and step/context.ts the global `Map`
 * (global-map.grit), and int.ts the global `Math` (global-math.grit), but only through
 * `Math.imul` and `Math.floor`, which int-math.grit, registered for int.ts alone, enforces there
 * (ADR 0021). Each exception covers its exact file, and every other purity rule still applies to
 * it.
 */
const ORDER_TS = `${ENGINE_SRC}/canonical/order.ts`;
const ENCODE_TS = `${ENGINE_SRC}/canonical/encode.ts`;
const VALUE_TS = `${ENGINE_SRC}/canonical/value.ts`;
const CONTEXT_TS = `${ENGINE_SRC}/step/context.ts`;
const INT_TS = `${ENGINE_SRC}/int.ts`;

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

/** Starts the diagnostic of int-math.grit, which no other rule's diagnostic contains. */
const INT_MATH_MESSAGE = "int.ts may use only Math.imul and Math.floor";

/** int-math.grit: in int.ts, binding `Math` to a name is rejected, as is any other use of it. */
const INT_MATH_PROBE: Probe = {
  name: "Math in int.ts",
  source: pluginProbe("Math").source,
  message: INT_MATH_MESSAGE,
};

/**
 * Each excepted file, the one rule it may break, and the narrower rule that replaces it there, if
 * any: int.ts is excepted from global-math.grit and held to int-math.grit instead.
 */
const EXCEPTIONS: { file: string; probe: Probe; narrower?: Probe }[] = [
  { file: ORDER_TS, probe: KEY_ENUMERATION_PROBE },
  { file: ENCODE_TS, probe: pluginProbe("JSON") },
  { file: VALUE_TS, probe: pluginProbe("Map") },
  { file: CONTEXT_TS, probe: pluginProbe("Map") },
  { file: INT_TS, probe: pluginProbe("Math"), narrower: INT_MATH_PROBE },
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

/** The rules that have an exception: every path that looks like an excepted file breaks them all. */
const EXEMPTABLE = [KEY_ENUMERATION_PROBE, ...Object.values(PLUGIN_PROBES)];

const NEAR_MISSES = [
  `${ENGINE_SRC}/order.ts`,
  `${ENGINE_SRC}/encode.ts`,
  `${ENGINE_SRC}/value.ts`,
  `${ENGINE_SRC}/canonical/int.ts`,
  `${ENGINE_SRC}/digest/int.ts`,
  `${ENGINE_SRC}/ints.ts`,
  `${ENGINE_SRC}/int/int.ts`,
  `${ENGINE_SRC}/canonical/reorder.ts`,
  `${ENGINE_SRC}/canonical/encoder.ts`,
  `${ENGINE_SRC}/canonical/values.ts`,
  `${ENGINE_SRC}/canonical/order/order.ts`,
  `${ENGINE_SRC}/canonical/encode/encode.ts`,
  `${ENGINE_SRC}/canonical/value/value.ts`,
  `${ENGINE_SRC}/context.ts`,
  `${ENGINE_SRC}/world/context.ts`,
  `${ENGINE_SRC}/step/contexts.ts`,
  `${ENGINE_SRC}/step/step.ts`,
  `${ENGINE_SRC}/step/context/context.ts`,
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
        "./packages/engine/lint/int-math.grit",
        "./packages/engine/lint/global-map.grit",
      ]),
    );
    const { exitCode, checked } = exceptionRun();
    expect(exitCode).toBe(1);
    expect(checked).toBe(EXCEPTIONS.length + NEAR_MISSES.length);
  });

  test("one override denies globals, for all of both src, and it leaves the plugin globals out", () => {
    // An override replaces a rule's options, so a second list could shadow the first in a file.
    expect(GLOBAL_OVERRIDES.map((override) => [...(override.includes ?? [])].sort())).toEqual([
      [`${AGENTS_SRC}/**`, `${ENGINE_SRC}/**`],
    ]);
    const denied = Object.keys(ENGINE_DENIED);
    expect([...denied].sort()).toEqual([...DENIED_GLOBALS].sort());
    expect(PLUGIN_GLOBALS.filter(({ name }) => denied.includes(name))).toEqual([]);
  });

  test("int-math.grit is registered in one override, for int.ts alone", () => {
    const overrides = (biomeConfig.overrides ?? []).filter((override) =>
      pluginPaths({ overrides: [override] }).includes("./packages/engine/lint/int-math.grit"),
    );
    expect(overrides.map((override) => override.includes)).toEqual([[INT_TS]]);
  });

  test.each(EXCEPTIONS)(
    "$file may break only its own rule, and every other one applies",
    ({ file, probe, narrower }) => {
      expect(probeCounts(file, [...EVERY_RULE, INT_MATH_PROBE])).toEqual({
        ...expectedCounts(EVERY_RULE, probe.name),
        [INT_MATH_PROBE.name]: narrower === INT_MATH_PROBE ? 1 : 0,
      });
    },
  );

  test("each exception covers its exact path and no other file", () => {
    const counts = Object.fromEntries(
      NEAR_MISSES.map((path) => [path, probeCounts(path, [...EXEMPTABLE, INT_MATH_PROBE])]),
    );
    // global-math.grit, not int-math.grit, governs the paths that only look like int.ts.
    const allRejected = { ...expectedCounts(EXEMPTABLE, ""), [INT_MATH_PROBE.name]: 0 };
    expect(counts).toEqual(Object.fromEntries(NEAR_MISSES.map((path) => [path, allRejected])));
  });
});

/** An override as this file reads it: where it applies, its plugins, and its import rule. */
type ControlOverride = {
  includes?: string[];
  plugins?: (string | { path: string })[];
  linter?: { rules?: { style?: { noRestrictedImports?: unknown } } };
};

const CONTROL_OVERRIDES = (
  (await Bun.file(`${REPO_ROOT}biome.json`).json()) as { overrides?: ControlOverride[] }
).overrides;

/** The engine's purity plugins that apply to all of a src directory, with or without exception. */
const SHARED_PLUGINS = [
  "./packages/engine/lint/purity.grit",
  "./packages/engine/lint/key-order.grit",
  "./packages/engine/lint/global-json.grit",
  "./packages/engine/lint/global-math.grit",
  "./packages/engine/lint/global-map.grit",
];

/**
 * packages/agents/src shares the engine's rules with no reviewed exception (ADR 0023): no Math,
 * Map, JSON, or key enumeration at all, and int-math.grit does not apply there. Each path that
 * names an engine exception file breaks every rule, under the agents' own import rule.
 */
describe("packages/agents/src has no reviewed exception", () => {
  const AGENTS_EVERY_RULE: Probe[] = [
    ...EVERY_RULE.filter((probe) => probe.name !== "package imports"),
    {
      name: "package imports",
      source: 'import { parse } from "some-package";\nexport const parsePackage = parse;',
      message: AGENTS_IMPORT_MESSAGE,
    },
  ];
  const MIRRORS = [
    "canonical/order.ts",
    "canonical/encode.ts",
    "canonical/value.ts",
    "step/context.ts",
    "int.ts",
  ].map((path) => `${AGENTS_SRC}/${path}`);

  let linted: LintSummary | undefined;
  function mirrorRun(): LintSummary {
    if (linted === undefined) {
      const everyRule = `${[...new Set(AGENTS_EVERY_RULE.map((probe) => probe.source))].join("\n")}\n`;
      linted = lintSummary(Object.fromEntries(MIRRORS.map((path) => [path, everyRule])));
    }
    return linted;
  }

  test("Biome lints every mirror of an engine exception", () => {
    const { exitCode, checked } = mirrorRun();
    expect(exitCode).toBe(1);
    expect(checked).toBe(MIRRORS.length);
  });

  test.each(MIRRORS)("%s breaks every rule, and int-math.grit does not apply", (file) => {
    const found = mirrorRun().diagnostics.filter((diagnostic) => diagnostic.file === file);
    const counts = Object.fromEntries(
      [...AGENTS_EVERY_RULE, INT_MATH_PROBE].map(({ name, message }) => [
        name,
        found.filter((diagnostic) => diagnostic.text.includes(message)).length,
      ]),
    );
    expect(counts).toEqual({
      ...Object.fromEntries(AGENTS_EVERY_RULE.map(({ name }) => [name, 1])),
      [INT_MATH_PROBE.name]: 0,
    });
  });

  test("the overrides for agents sources register the engine's plugins, for all of src", () => {
    const covering = (CONTROL_OVERRIDES ?? []).filter((override) =>
      (override.includes ?? []).includes(`${AGENTS_SRC}/**`),
    );
    const plugins = covering.flatMap((override) =>
      (override.plugins ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path)),
    );
    expect([...plugins].sort()).toEqual([...SHARED_PLUGINS].sort());
    // A glob that names a path under agents src, negated or not, would make an exception there.
    const agentsGlobs = covering
      .flatMap((override) => override.includes ?? [])
      .filter((glob) => glob.replace(/^!/, "").startsWith(`${AGENTS_SRC}/`));
    expect(agentsGlobs).toEqual(covering.map(() => `${AGENTS_SRC}/**`));
  });

  test("each package has its own import rule, in one override for all of its src", () => {
    const imports = (CONTROL_OVERRIDES ?? []).filter(
      (override) => override.linter?.rules?.style?.noRestrictedImports !== undefined,
    );
    expect(imports.map((override) => override.includes)).toEqual(
      expect.arrayContaining([[`${ENGINE_SRC}/**`], [`${AGENTS_SRC}/**`]]),
    );
    expect(imports).toHaveLength(2);
  });
});

/**
 * int-math.grit (ADR 0021): int.ts may use only `Math.imul` and `Math.floor`, the members of `Math`
 * that ECMA-262 defines exactly, as calls or as values. Every other reference to `Math` there is
 * rejected, including the ones that would hide which member is used.
 */
describe("int.ts may use only Math.imul and Math.floor", () => {
  /** Each line references `Math` once outside an allowed member access: its last `Math`. */
  const REJECTED = [
    "export const sine = Math.sin(1);",
    "export const random = Math.random;",
    'export const computed = Math["imul"];',
    "export const quoted = Math[`floor`];",
    "export const alias = Math;",
    "export const { sin } = Math;",
    "export const kind = typeof Math;",
    "export const argument = String(Math);",
    "export const shorthand = { Math };",
    "export const cast = (Math as unknown) ?? 0;",
    "export const deep = Math.sin.floor;",
    "export const inside = Math.floor(Math.round(1.5));",
    "export const receiver = Math.imul.call(Math, 2, 3);",
    "export default Math;",
  ];

  test("rejects every other reference to Math in int.ts, and only with its own diagnostic", () => {
    // Biome's useLiteralKeys only informs about the computed keys, so the plugin is the gate.
    const { exitCode, output } = run("biome", { [INT_TS]: `${REJECTED.join("\n")}\n` });
    const plugin = biomeDiagnostics(output).filter(
      ({ file, category }) => file === INT_TS && category === "plugin",
    );
    expect(exitCode).toBe(1);
    // One diagnostic at each rejected reference, as `line:column`, and none at an allowed one.
    expect(plugin.map(({ text }) => /^\S+:(\d+:\d+) /.exec(text)?.[1]).sort()).toEqual(
      REJECTED.map((line, index) => `${index + 1}:${line.lastIndexOf("Math") + 1}`).sort(),
    );
    expect(plugin.filter(({ text }) => text.includes(INT_MATH_MESSAGE))).toHaveLength(
      REJECTED.length,
    );
  });

  test("accepts Math.imul and Math.floor, as calls and as values, and Math in types", () => {
    const summary = lintSummary({
      [INT_TS]: [
        "export const imul: (a: number, b: number) => number = Math.imul;",
        "export const floor = Math.floor;",
        "export const product = Math.imul(3, 5);",
        "export function half(value: number): number {",
        "  return Math.floor(Math.imul(value, 3) / 2) >>> 0;",
        "}",
        "export type Types = [Math, typeof Math, typeof Math.sin];",
        "export const holder = { Math: 1 };",
        "export const field = holder.Math;\n",
      ].join("\n"),
    });
    expect(summary).toEqual({ exitCode: 0, checked: 1, diagnostics: [] });
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
