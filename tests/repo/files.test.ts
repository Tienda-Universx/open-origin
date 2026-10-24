import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoFiles } from "./files.ts";

const scratch = mkdtempSync(join(tmpdir(), "open-origin-files-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: scratch });
  if (!result.success) throw new Error(result.stderr.toString());
}

describe("repoFiles", () => {
  test("lists tracked and untracked files but skips ignored and locally excluded ones", () => {
    git("init", "-q");
    writeFileSync(join(scratch, "tracked.md"), "a");
    writeFileSync(join(scratch, "untracked.md"), "b");
    writeFileSync(join(scratch, "ignored.md"), "c");
    writeFileSync(join(scratch, "excluded.md"), "d");
    writeFileSync(join(scratch, ".git", "info", "exclude"), "excluded.md\n");
    mkdirSync(join(scratch, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(scratch, "node_modules", "pkg", "index.md"), "e");
    writeFileSync(join(scratch, ".gitignore"), "ignored.md\nnode_modules/\n");
    git("add", "tracked.md");

    expect(repoFiles(scratch).sort()).toEqual([".gitignore", "tracked.md", "untracked.md"]);
  });

  test("fails loudly outside a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "open-origin-nogit-"));
    try {
      expect(() => repoFiles(outside)).toThrow("git ls-files failed");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
