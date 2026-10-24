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

describe("package.json", () => {
  test("pins Bun to an exact version", () => {
    expect(manifest.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
  });

  test("scripts run only locally installed tools, on Bun", () => {
    const calls = Object.values(manifest.scripts)
      .flatMap((script) => script.split("&&"))
      .map((command) => command.trim())
      .filter((command) => command.startsWith("bunx"));
    expect(calls.length).toBeGreaterThan(0);
    // Without --no-install, bunx downloads a registry package when the tool is missing.
    expect(calls.filter((command) => !command.startsWith("bunx --no-install --bun "))).toEqual([]);
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
