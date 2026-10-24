/**
 * Repository-relative paths of the files git tracks or would track: committed, staged, and
 * untracked files, minus everything .gitignore or .git/info/exclude ignores.
 * Scanning these instead of the whole directory keeps local-only files out of repository checks.
 */
export function repoFiles(root: string): string[] {
  const result = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root },
  );
  if (!result.success) {
    throw new Error(`git ls-files failed in ${root}: ${result.stderr.toString()}`);
  }
  return [...new Set(result.stdout.toString().split("\0"))].filter((path) => path !== "");
}
