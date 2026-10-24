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
    expect(manifest.scripts.lint).toContain("bunx --no-install --bun oxlint -c .oxlintrc.json");
  });

  test("has no runtime dependencies and pins every dev dependency exactly (plan §P)", () => {
    expect(manifest.dependencies).toBeUndefined();
    const loose = Object.entries(manifest.devDependencies).filter(
      ([, version]) => !/^\d+\.\d+\.\d+$/.test(version),
    );
    expect(loose).toEqual([]);
  });
});
