import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./files.ts";

/**
 * Proves that each automated quality control fires: every fixture breaks one rule and is
 * linted with the repository's own configuration. A control that stops firing fails here.
 */

// Each test spawns up to three linters; a cold CI runner can exceed Bun's 5-second default.
setDefaultTimeout(60_000);

const scratch = mkdtempSync(join(tmpdir(), "open-origin-lint-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Biome reads the repository configuration from the scratch directory, outside git.
const biomeConfig = await Bun.file(`${REPO_ROOT}biome.json`).json();
writeFileSync(
  join(scratch, "biome.json"),
  JSON.stringify({ ...biomeConfig, vcs: { enabled: false } }),
);

type Tool = "biome" | "oxlint" | "tsc";

/** How long a linter may run before it is killed and reported as timed out. */
const TOOL_TIMEOUT_MS = 30_000;

/** `exitCode` is null when the tool was killed (a timeout), whatever the Bun types say. */
type LintResult = { exitCode: number | null; output: string };

/** The command line that checks the fixture `paths` with the repository's own settings. */
function commandLine(tool: Tool, paths: string[]): string[] {
  if (tool === "biome") return ["biome", "lint", `--config-path=${scratch}`, ...paths];
  if (tool === "oxlint") {
    return ["oxlint", "-c", `${REPO_ROOT}.oxlintrc.json`, "--format", "unix", ...paths];
  }
  // tsc checks exactly these files with the compiler options every package shares.
  const config = join(scratch, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({ extends: `${REPO_ROOT}tsconfig.base.json`, files: paths }),
  );
  return ["tsc", "--noEmit", "-p", config];
}

function run(tool: Tool, files: Record<string, string>): LintResult {
  for (const [name, source] of Object.entries(files)) writeFileSync(join(scratch, name), source);
  const args = commandLine(
    tool,
    Object.keys(files).map((name) => join(scratch, name)),
  );
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
