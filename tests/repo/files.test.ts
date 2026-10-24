import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment, repoFiles } from "./files.ts";

const FILES_MODULE = Bun.fileURLToPath(new URL("./files.ts", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "open-origin-files-"));

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: scratch, env: gitEnvironment() });
  if (!result.success) throw new Error(result.stderr.toString());
}

beforeAll(() => {
  // An empty template, as with a custom init.templateDir, creates no .git/info directory.
  git("init", "-q", "--template=");
  writeFileSync(join(scratch, "tracked.md"), "a");
  writeFileSync(join(scratch, "untracked.md"), "b");
  writeFileSync(join(scratch, "ignored.md"), "c");
  writeFileSync(join(scratch, "excluded.md"), "d");
  mkdirSync(join(scratch, ".git", "info"), { recursive: true });
  writeFileSync(join(scratch, ".git", "info", "exclude"), "excluded.md\n");
  mkdirSync(join(scratch, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(scratch, "node_modules", "pkg", "index.md"), "e");
  writeFileSync(join(scratch, ".gitignore"), "ignored.md\nnode_modules/\n");
  git("add", "tracked.md");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("gitEnvironment", () => {
  test("drops every variable git reports as repository-local and keeps the rest", () => {
    const listed = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"]).stdout.toString();
    const names = listed.split("\n").filter((name) => name !== "");
    expect(names).toContain("GIT_DIR");
    const saved = names.map((name) => [name, process.env[name]] as const);
    for (const name of names) process.env[name] = "/nowhere";
    try {
      const env = gitEnvironment();
      expect(names.filter((name) => name in env)).toEqual([]);
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("repoFiles", () => {
  test("lists tracked and untracked files but skips ignored and locally excluded ones", () => {
    expect(repoFiles(scratch).sort()).toEqual([".gitignore", "tracked.md", "untracked.md"]);
  });

  test("ignores repository variables inherited from a git hook", () => {
    // A hook passes GIT_DIR in the process environment at startup; Bun.spawnSync without an
    // explicit env reuses that startup environment, so simulate it with a child process.
    const script = `import { repoFiles } from ${JSON.stringify(FILES_MODULE)};
console.log(JSON.stringify(repoFiles(${JSON.stringify(scratch)})));`;
    const child = Bun.spawnSync([process.execPath, "--eval", script], {
      env: { ...process.env, GIT_DIR: join(scratch, "not-a-repository") },
    });
    expect(child.stderr.toString()).toBe("");
    expect(JSON.parse(child.stdout.toString())).toContain("tracked.md");
  });

  test("fails loudly outside a git repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "open-origin-nogit-"));
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    // Stop git's upward search, so the result does not depend on where the temp dir lives.
    process.env.GIT_CEILING_DIRECTORIES = tmpdir();
    try {
      expect(() => repoFiles(outside)).toThrow("git ls-files failed");
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = saved;
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
