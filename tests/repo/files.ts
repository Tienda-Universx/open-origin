let repositoryVariables: ReadonlySet<string> | undefined;

/**
 * Variables that point git at a specific repository, as the installed git reports them
 * (`git rev-parse --local-env-vars`). Git hooks set them, so a check started from a hook would
 * otherwise read, or write, the wrong repository.
 */
function localEnvVars(): ReadonlySet<string> {
  if (repositoryVariables === undefined) {
    const result = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"]);
    if (!result.success) {
      throw new Error(`git rev-parse --local-env-vars failed: ${result.stderr.toString()}`);
    }
    repositoryVariables = new Set(
      result.stdout
        .toString()
        .split("\n")
        .filter((name) => name !== ""),
    );
  }
  return repositoryVariables;
}

/** The current environment without the variables that redirect git to another repository. */
export function gitEnvironment(): Record<string, string> {
  const local = localEnvVars();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !local.has(key)) env[key] = value;
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
