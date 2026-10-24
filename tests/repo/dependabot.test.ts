import { describe, expect, test } from "bun:test";
import { REPO_ROOT } from "./files.ts";

type Update = {
  "package-ecosystem": string;
  directory: string;
  schedule: { interval: string };
  cooldown?: { "default-days"?: number };
  "commit-message"?: { prefix?: string };
};

const config = Bun.YAML.parse(await Bun.file(`${REPO_ROOT}.github/dependabot.yml`).text()) as {
  version: number;
  updates: Update[];
};

describe("Dependabot version updates", () => {
  test("cover the Bun dependencies and the workflow actions", () => {
    expect(config.version).toBe(2);
    expect(config.updates.map((update) => update["package-ecosystem"]).sort()).toEqual([
      "bun",
      "github-actions",
    ]);
  });

  test.each(["bun", "github-actions"])(
    "%s updates wait at least two weeks after a release (ADR 0015)",
    (ecosystem) => {
      const update = config.updates.find((entry) => entry["package-ecosystem"] === ecosystem);
      expect(update?.cooldown?.["default-days"]).toBeGreaterThanOrEqual(14);
    },
  );

  test("update commits follow Conventional Commits", () => {
    expect(config.updates.map((update) => update["commit-message"]?.prefix)).toEqual([
      "build",
      "build",
    ]);
  });
});
