import { describe, expect, test } from "bun:test";
import { REPO_ROOT } from "./files.ts";

type Update = {
  "package-ecosystem": string;
  directory: string;
  schedule: { interval: string };
  cooldown?: { "default-days"?: number };
  "commit-message"?: { prefix?: string };
  groups?: Record<string, { patterns: string[]; "update-types"?: string[] }>;
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
    "%s: weekly updates at the root, two weeks after a release, as build commits (ADRs 0015, 0016)",
    (ecosystem) => {
      const update = config.updates.find((entry) => entry["package-ecosystem"] === ecosystem);
      expect(update?.directory).toBe("/");
      expect(update?.schedule.interval).toBe("weekly");
      expect(update?.cooldown?.["default-days"]).toBeGreaterThanOrEqual(14);
      expect(update?.["commit-message"]?.prefix).toBe("build");
      // One group for minor and patch updates; each major update gets its own pull request.
      expect(Object.values(update?.groups ?? {})).toEqual([
        { patterns: ["*"], "update-types": ["minor", "patch"] },
      ]);
    },
  );
});
