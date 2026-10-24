import { describe, expect, test } from "bun:test";

type Manifest = {
  packageManager: string;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
};

const manifest = (await Bun.file(
  new URL("../../package.json", import.meta.url),
).json()) as Manifest;

/** The commands of a script: the parts separated by `&&`, `||`, `;`, a pipe, or `&`. */
function commands(script = ""): string[] {
  return script
    .split(/&&|\|\||[;|&]/)
    .map((command) => command.trim())
    .filter((command) => command !== "");
}

// Without --no-install, bunx downloads a registry package when the tool is missing; without --bun,
// a tool whose launcher targets Node runs on Node. npx, node, npm and the like never pass.
const ALLOWED_COMMAND = /^(?:bun run |bun test(?: |$)|bunx --no-install --bun )/;
/** Command substitution runs a command the allowlist never sees. */
const SUBSTITUTION = /\$\(|`/;

/** The parts of a script that are not Bun or a locally installed tool run on Bun. */
function disallowedCommands(script: string): string[] {
  if (SUBSTITUTION.test(script)) return [script];
  return commands(script).filter((command) => !ALLOWED_COMMAND.test(command));
}

/** Project scripts joined by `&&`, so the chain stops at the first step that fails. */
const FAIL_FAST_CHAIN = /^bun run [\w:-]+(?: && bun run [\w:-]+)*$/;

/** The arguments of a `bun test` command that are not options: each one filters the test files. */
function testFilters(command: string): string[] {
  return command
    .split(/\s+/)
    .slice(2)
    .filter((arg) => !arg.startsWith("-"));
}

describe("script checks", () => {
  test("reject npx, node, bunx without its flags, and command substitution", () => {
    expect(disallowedCommands("bun run lint && bun test && bunx --no-install --bun tsc")).toEqual(
      [],
    );
    expect(disallowedCommands("echo hi; npx biome format .")).toEqual([
      "echo hi",
      "npx biome format .",
    ]);
    expect(disallowedCommands("bun run x & node evil.js | bun x tool")).toEqual([
      "node evil.js",
      "bun x tool",
    ]);
    expect(disallowedCommands("bunx biome check .")).toEqual(["bunx biome check ."]);
    expect(disallowedCommands("bun run $(echo lint)")).toEqual(["bun run $(echo lint)"]);
  });

  test("accept a chain only when every step must pass", () => {
    expect(FAIL_FAST_CHAIN.test("bun run typecheck && bun run lint && bun run test")).toBe(true);
    expect(FAIL_FAST_CHAIN.test("bun run typecheck; bun run lint; bun run test")).toBe(false);
    expect(FAIL_FAST_CHAIN.test("bun run typecheck || bun run lint && bun run test")).toBe(false);
  });

  test("tell options from test filters", () => {
    expect(testFilters("bun test --timeout=20000 --parallel")).toEqual([]);
    expect(testFilters("bun test tests/repo/markdown.test.ts")).toEqual([
      "tests/repo/markdown.test.ts",
    ]);
  });
});

describe("package.json", () => {
  test("pins Bun to an exact version", () => {
    expect(manifest.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
  });

  test("scripts run only Bun and locally installed tools", () => {
    const scripts = Object.values(manifest.scripts);
    expect(scripts.flatMap((script) => commands(script)).length).toBeGreaterThan(0);
    expect(scripts.flatMap(disallowedCommands)).toEqual([]);
  });

  test("check, which CI runs, runs the typecheck, the lint and the whole test suite", () => {
    const check = manifest.scripts.check ?? "";
    expect(check).toMatch(FAIL_FAST_CHAIN);
    expect(commands(check)).toEqual(
      expect.arrayContaining(["bun run typecheck", "bun run lint", "bun run test"]),
    );
    expect(manifest.scripts.typecheck).toMatch(
      /^bunx --no-install --bun tsc (?=.*--noEmit)(?=.*-p tsconfig\.json)/,
    );
    // Write option values as --option=value: any other argument filters the test files.
    const test = commands(manifest.scripts.test);
    expect(test).toEqual([expect.stringMatching(/^bun test(?: |$)/)]);
    expect(testFilters(test[0] ?? "")).toEqual([]);
  });

  test("lint runs both gates: Biome and the oxlint complexity rules", () => {
    expect(manifest.scripts.lint).toContain("bunx --no-install --bun biome check .");
    // --deny-warnings: a rule lowered to "warn" in .oxlintrc.json still fails CI.
    expect(manifest.scripts.lint).toContain(
      "bunx --no-install --bun oxlint -c .oxlintrc.json --deny-warnings",
    );
  });

  test("has no runtime dependencies and pins every dev dependency exactly (plan §P)", () => {
    expect(manifest.dependencies).toBeUndefined();
    const loose = Object.entries(manifest.devDependencies).filter(
      ([, version]) => !/^\d+\.\d+\.\d+$/.test(version),
    );
    expect(loose).toEqual([]);
  });
});

describe("bunfig.toml", () => {
  test("turns off Bun telemetry for every run of the repository (ADR 0018)", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../../bunfig.toml", import.meta.url)).text(),
    ) as { telemetry?: unknown };
    expect(config.telemetry).toBe(false);
  });
});
