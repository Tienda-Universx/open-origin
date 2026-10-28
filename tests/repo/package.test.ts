import { describe, expect, test } from "bun:test";
import { REPO_ROOT, repoFiles } from "./files.ts";

type Manifest = {
  packageManager: string;
  workspaces: string[];
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** The fields this file checks in a workspace package's manifest. */
type WorkspaceManifest = {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const manifest = (await Bun.file(
  new URL("../../package.json", import.meta.url),
).json()) as Manifest;

/** Repository-relative paths of the files named `name` at the root of a workspace package. */
function workspaceFiles(name: string): string[] {
  const files = repoFiles(REPO_ROOT);
  return manifest.workspaces.flatMap((workspace) => {
    const glob = new Bun.Glob(`${workspace}/${name}`);
    return files.filter((path) => glob.match(path));
  });
}

const workspaceManifests = await Promise.all(
  workspaceFiles("package.json").map(async (path) => ({
    path,
    manifest: (await Bun.file(`${REPO_ROOT}${path}`).json()) as WorkspaceManifest,
  })),
);

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

/** The dependencies whose version is not an exact `major.minor.patch` pin (plan §P). */
function looselyPinned(dependencies: Record<string, string> = {}): string[] {
  return Object.entries(dependencies)
    .filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version))
    .map(([name, version]) => `${name}@${version}`);
}

/** One step of the typecheck script: tsc, forced onto Bun, on one project. */
const TSC_STEP = /^bunx --no-install --bun tsc --noEmit -p (\S+)$/;

/**
 * The least time CI's test script gives a test that sets none of its own: about six times the
 * slowest such test measured on CI, 5.1 s, where Bun's default of 5 s failed it (2026-10-28).
 */
const TEST_BUDGET_MS = 30_000;

/**
 * The most it may give: the largest default a test file sets with setDefaultTimeout; a test that
 * needs more sets its own, as survival.test.ts does (180 s). A far larger value, such as 2^32 - 1,
 * would in effect turn the deadline off and leave only the CI job's timeout to stop a hang.
 */
const TEST_BUDGET_MAX_MS = 60_000;

/**
 * CI's test script: the whole suite, one worker per core, with a time for tests that set none, but
 * for the one file it then runs alone in a step of its own.
 */
const TEST_SCRIPT =
  /^bun test --parallel --timeout (\d+) --path-ignore-patterns=(\S+) && bun test --timeout (\d+) (\S+)$/;

/**
 * The file CI's test script runs alone, after the rest: the preregistered evaluation of T5, whose
 * two child processes run 63,000 ticks each. Among the other files under --parallel, it took 31 to
 * 44 s of a suite that reached 76.1 s on a slow runner, past the budget of 70 s (plan §11.4).
 */
const SEQUENTIAL_TEST = "packages/agents/test/mind-evaluation.test.ts";

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

  test("report every dependency that is not pinned to an exact version", () => {
    expect(
      looselyPinned({
        exact: "1.2.3",
        caret: "^1.2.3",
        tilde: "~1.2.3",
        range: ">=1.0.0",
        tag: "latest",
        prerelease: "1.2.3-rc.1",
      }),
    ).toEqual([
      "caret@^1.2.3",
      "tilde@~1.2.3",
      "range@>=1.0.0",
      "tag@latest",
      "prerelease@1.2.3-rc.1",
    ]);
    expect(looselyPinned(undefined)).toEqual([]);
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

  test("check, which CI runs, runs the typecheck, the lint and the whole test suite", async () => {
    const check = manifest.scripts.check ?? "";
    expect(check).toMatch(FAIL_FAST_CHAIN);
    expect(commands(check)).toEqual(
      expect.arrayContaining(["bun run typecheck", "bun run lint", "bun run test"]),
    );
    expect(manifest.scripts.typecheck).toMatch(
      /^bunx --no-install --bun tsc (?=.*--noEmit)(?=.*-p tsconfig\.json)/,
    );
    // Only --parallel, which runs every file on one worker per core, --timeout, and the one file the
    // second step runs alone: any other argument, a path or an option such as --test-name-pattern,
    // can narrow the suite CI runs.
    const script = manifest.scripts.test ?? "";
    expect(script).toMatch(TEST_SCRIPT);
    const [, timeout, ignored, aloneTimeout, alone] = TEST_SCRIPT.exec(script) ?? [];
    // What the first step leaves out is exactly what the second runs, so together they run all.
    expect([ignored, alone]).toEqual([SEQUENTIAL_TEST, SEQUENTIAL_TEST]);
    expect(await Bun.file(new URL(`../../${SEQUENTIAL_TEST}`, import.meta.url)).exists()).toBe(
      true,
    );
    // Under --parallel a test's wall time varies with the runner's load: on CI the same test took
    // from 1.8 to 5.0 s across seven runs, and Bun's default of 5 s failed two tests at 5.0 and 5.1 s.
    for (const budget of [timeout, aloneTimeout]) {
      expect(Number(budget)).toBeGreaterThanOrEqual(TEST_BUDGET_MS);
      expect(Number(budget)).toBeLessThanOrEqual(TEST_BUDGET_MAX_MS);
    }
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
    expect(looselyPinned(manifest.devDependencies)).toEqual([]);
  });

  test("typecheck runs every workspace's own tsconfig, stopping at the first failure", () => {
    const script = manifest.scripts.typecheck ?? "";
    const steps = script.split(" && ");
    // Any other separator (`;`, `||`, a pipe) would let a failing project pass the check.
    expect(steps.filter((step) => !TSC_STEP.test(step))).toEqual([]);
    const projects = steps.map((step) => TSC_STEP.exec(step)?.[1]);
    expect(projects).toEqual(
      expect.arrayContaining(["tsconfig.json", ...workspaceFiles("tsconfig.json")]),
    );
  });
});

describe("tsconfig.json", () => {
  test("the root program typechecks every workspace test and benchmark file", () => {
    const result = Bun.spawnSync(
      ["bunx", "--no-install", "--bun", "tsc", "-p", "tsconfig.json", "--listFilesOnly"],
      { cwd: REPO_ROOT, timeout: 30_000 },
    );
    expect(result.exitCode).toBe(0);
    const program = new Set(
      result.stdout
        .toString()
        .split("\n")
        .filter((path) => path.startsWith(REPO_ROOT))
        .map((path) => path.slice(REPO_ROOT.length)),
    );
    const tests = workspaceFiles("test/**/*.ts");
    const benchmarks = workspaceFiles("bench/**/*.ts");
    // An empty list would make the check pass without checking anything.
    expect(tests).toContain("packages/engine/test/version.test.ts");
    expect(benchmarks).toContain("packages/engine/bench/step.ts");
    expect([...tests, ...benchmarks].filter((path) => !program.has(path))).toEqual([]);
  });
});

describe("workspace package manifests", () => {
  test("include the engine, so the checks below cannot pass on an empty list", () => {
    expect(workspaceManifests.map(({ path }) => path)).toContain("packages/engine/package.json");
  });

  test("scripts run only Bun and locally installed tools", () => {
    const disallowed = workspaceManifests.flatMap(({ path, manifest: { scripts = {} } }) => {
      const names = new Set(Object.keys(scripts));
      return Object.values(scripts)
        .flatMap((script) => disallowedCommands(script, names))
        .map((command) => `${path}: ${command}`);
    });
    expect(disallowed).toEqual([]);
  });

  test("pin every dev dependency exactly (plan §P)", () => {
    const loose = workspaceManifests.flatMap(({ path, manifest: { devDependencies } }) =>
      looselyPinned(devDependencies).map((dependency) => `${path}: ${dependency}`),
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
