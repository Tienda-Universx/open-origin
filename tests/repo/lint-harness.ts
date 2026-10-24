import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "./files.ts";

/**
 * The harness of the lint control tests (lint.test.ts and engine-lint.test.ts): a scratch
 * directory with copies of the repository's Biome configuration and plugins, where `run` checks
 * fixtures with the repository's own settings. Importing this module has no side effects; each
 * test file creates its own harness and removes its own scratch directory, because Bun's test
 * runner may share one module instance between test files.
 */

type PluginEntry = string | { path: string };
export type DeniedGlobals = Record<string, string>;
type Override = {
  includes?: string[];
  plugins?: PluginEntry[];
  linter?: {
    rules?: { style?: { noRestrictedGlobals?: { options?: { deniedGlobals?: DeniedGlobals } } } };
  };
};
type BiomeConfig = { plugins?: PluginEntry[]; overrides?: Override[] };

/** Every GritQL plugin the configuration registers, at the top level or in an override. */
export function pluginPaths(config: BiomeConfig): string[] {
  const overrides = (config.overrides ?? []).flatMap((override) => override.plugins ?? []);
  return [...(config.plugins ?? []), ...overrides].map((entry) =>
    typeof entry === "string" ? entry : entry.path,
  );
}

/** `tsc` checks with the settings every package shares; `tsc-engine` with the engine's own. */
type Tool = "biome" | "oxlint" | "tsc" | "tsc-engine";

/** How long a linter may run before it is killed and reported as timed out. */
const TOOL_TIMEOUT_MS = 30_000;

/** `exitCode` is null when the tool was killed (a timeout), whatever the Bun types say. */
type LintResult = { exitCode: number | null; output: string };

/** The absolute path of the `scratch`-relative path `name`, with its directories created. */
function scratchPath(scratch: string, name: string): string {
  const path = join(scratch, name);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** Writes `content` at the `scratch`-relative path `name` and returns its absolute path. */
function writeScratch(scratch: string, name: string, content: string): string {
  const path = scratchPath(scratch, name);
  writeFileSync(path, content);
  return path;
}

/** A scratch tsconfig that checks exactly `paths` with the settings of the project `base`. */
function tscCommand(scratch: string, base: string, paths: string[]): string[] {
  const config = writeScratch(
    scratch,
    "tsconfig.json",
    // `include: []` drops the files the base project includes, such as the engine's own sources.
    JSON.stringify({ extends: `${REPO_ROOT}${base}`, include: [], files: paths }),
  );
  return ["tsc", "--noEmit", "-p", config];
}

/** The command line that checks the fixture `paths` with the repository's own settings. */
function commandLine(scratch: string, tool: Tool, paths: string[]): string[] {
  if (tool === "biome") {
    // Without --max-diagnostics=none, Biome prints only the first 20 diagnostics.
    return ["biome", "lint", "--max-diagnostics=none", `--config-path=${scratch}`, ...paths];
  }
  if (tool === "oxlint") {
    return ["oxlint", "-c", `${REPO_ROOT}.oxlintrc.json`, "--format", "unix", ...paths];
  }
  if (tool === "tsc-engine") return tscCommand(scratch, "packages/engine/tsconfig.json", paths);
  return tscCommand(scratch, "tsconfig.base.json", paths);
}

function run(scratch: string, tool: Tool, files: Record<string, string>): LintResult {
  const paths = Object.entries(files).map(([name, source]) => writeScratch(scratch, name, source));
  const args = commandLine(scratch, tool, paths);
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

/** One scratch directory set up for linting, owned by the test file that created it. */
type LintHarness = {
  /** The absolute path of the scratch directory; fixture names are relative to it. */
  readonly scratch: string;
  /** The repository's biome.json, as the harness read it. */
  readonly biomeConfig: BiomeConfig;
  /** Writes `files` (scratch-relative name to source) and checks them with `tool`. */
  readonly run: (tool: Tool, files: Record<string, string>) => LintResult;
  /** Removes the scratch directory; the test file registers it with `afterAll`. */
  readonly cleanup: () => void;
};

/** Creates a scratch directory holding the repository's Biome configuration and plugins. */
export async function createLintHarness(): Promise<LintHarness> {
  const biomeConfig = (await Bun.file(`${REPO_ROOT}biome.json`).json()) as BiomeConfig;
  const scratch = mkdtempSync(join(tmpdir(), "open-origin-lint-"));
  const cleanup = (): void => rmSync(scratch, { recursive: true, force: true });
  // Biome reads the repository configuration from the scratch directory, outside git. Override
  // globs and plugin paths resolve from that directory, so fixtures and plugins keep their
  // repository-relative paths there.
  try {
    writeScratch(
      scratch,
      "biome.json",
      JSON.stringify({ ...biomeConfig, vcs: { enabled: false } }),
    );
    for (const plugin of pluginPaths(biomeConfig)) {
      copyFileSync(join(REPO_ROOT, plugin), scratchPath(scratch, plugin));
    }
  } catch (error) {
    // The caller gets no harness to clean up, so a failed setup removes its own directory.
    cleanup();
    throw error;
  }
  return { scratch, biomeConfig, run: (tool, files) => run(scratch, tool, files), cleanup };
}
