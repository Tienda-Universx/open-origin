/**
 * Variables that point git at a specific repository (`git rev-parse --local-env-vars`).
 * Git hooks set them, so a check started from a hook would otherwise read, or write, the wrong
 * repository.
 */
const REPOSITORY_VARIABLES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

/** The current environment without the variables that redirect git to another repository. */
export function gitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !REPOSITORY_VARIABLES.has(key)) env[key] = value;
  }
  return env;
}

/**
 * Repository-relative paths of the files git tracks or would track: committed, staged, and
 * untracked files, minus everything .gitignore or .git/info/exclude ignores.
 * Scanning these instead of the whole directory keeps local-only files out of repository checks.
 */
export function repoFiles(root: string): string[] {
  const result = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, env: gitEnvironment() },
  );
  if (!result.success) {
    throw new Error(`git ls-files failed in ${root}: ${result.stderr.toString()}`);
  }
  return [...new Set(result.stdout.toString().split("\0"))].filter((path) => path !== "");
}
