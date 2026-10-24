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

/** The commands of a script: the parts separated by `&&`, `||`, `;`, a pipe, `&`, or a newline. */
function commands(script = ""): string[] {
  return script
    .split(/&&|\|\||[;|&\n]/)
    .map((command) => command.trim())
    .filter((command) => command !== "");
}

/** Command substitution runs a command the allowlist never sees. */
const SUBSTITUTION = /\$\(|`/;

/**
 * Whether a command runs on Bun: the test runner, a script of this package, or a tool forced onto
 * Bun. `bun run <tool>` and `bunx <tool>` follow the tool's `#!/usr/bin/env node` line and run it on
 * Node; `bunx` without `--no-install` also downloads a registry package when the tool is missing.
 */
function runsOnBun(command: string, scripts: ReadonlySet<string>): boolean {
  if (/^(?:bun test|bunx --no-install --bun|bun run --bun)(?: |$)/.test(command)) return true;
  const script = /^bun run ([\w:-]+)$/.exec(command)?.[1];
  return script !== undefined && scripts.has(script);
}

/** The parts of a script that do not run on Bun, given the names of the package's scripts. */
function disallowedCommands(script: string, scripts: ReadonlySet<string>): string[] {
  if (SUBSTITUTION.test(script)) return [script];
  return commands(script).filter((command) => !runsOnBun(command, scripts));
}

/** Project scripts joined by `&&`, so the chain stops at the first step that fails. */
const FAIL_FAST_CHAIN = /^bun run [\w:-]+(?: && bun run [\w:-]+)*$/;

describe("script checks", () => {
  const scripts = new Set(["lint", "typecheck"]);

  test("accept the test runner, project scripts, and tools forced onto Bun", () => {
    const script = "bun run lint && bun test --watch && bunx --no-install --bun tsc";
    expect(disallowedCommands(`${script} && bun run --bun vite build`, scripts)).toEqual([]);
  });

  test("reject npx, node, tools run without --bun, and command substitution", () => {
    expect(disallowedCommands("echo hi; npx biome format .", scripts)).toEqual([
      "echo hi",
      "npx biome format .",
    ]);
    expect(disallowedCommands("bun run lint & node evil.js | bun x tool", scripts)).toEqual([
      "node evil.js",
      "bun x tool",
    ]);
    // Both follow tsc's `#!/usr/bin/env node` line and run it on Node.
    expect(disallowedCommands("bun run tsc --noEmit\nbunx biome check .", scripts)).toEqual([
      "bun run tsc --noEmit",
      "bunx biome check .",
    ]);
    expect(disallowedCommands("bun run unknown-script && bun testx", scripts)).toEqual([
      "bun run unknown-script",
      "bun testx",
    ]);
    expect(disallowedCommands("bun run $(echo lint)", scripts)).toEqual(["bun run $(echo lint)"]);
  });

  test("accept a chain only when every step must pass", () => {
    expect(FAIL_FAST_CHAIN.test("bun run typecheck && bun run lint && bun run test")).toBe(true);
    expect(FAIL_FAST_CHAIN.test("bun run typecheck; bun run lint; bun run test")).toBe(false);
    expect(FAIL_FAST_CHAIN.test("bun run typecheck || bun run lint && bun run test")).toBe(false);
  });
});

describe("package.json", () => {
  test("pins Bun to an exact version", () => {
    expect(manifest.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
  });

  test("scripts run only Bun and locally installed tools", () => {
    const names = new Set(Object.keys(manifest.scripts));
    const scripts = Object.values(manifest.scripts);
    expect(scripts.flatMap((script) => commands(script)).length).toBeGreaterThan(0);
    expect(scripts.flatMap((script) => disallowedCommands(script, names))).toEqual([]);
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
    // Any argument, a path or an option such as --test-name-pattern, can narrow the suite CI runs.
    expect(manifest.scripts.test).toBe("bun test");
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
