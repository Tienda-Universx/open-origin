import { describe, expect, test } from "bun:test";
import { REPO_ROOT, repoFiles } from "./files.ts";

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { name: string; permissions?: unknown; uses?: string; steps?: Step[] };
type Workflow = {
  on: unknown;
  permissions: unknown;
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<string, Job>;
};

/** Builds a GitHub Actions expression such as ${{ github.ref }}. */
const expression = (body: string): string => `\${{ ${body} }}`;

const WORKFLOW = new URL("../../.github/workflows/ci.yml", import.meta.url);
const ci = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as Workflow;
const steps = Object.values(ci.jobs).flatMap((job) => job.steps ?? []);

/** Every workflow file, parsed, keyed by its repository-relative path. */
const workflows: Array<readonly [string, Workflow]> = [];
for (const path of repoFiles(REPO_ROOT)) {
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) continue;
  const file = Bun.file(`${REPO_ROOT}${path}`);
  // git still lists a tracked file deleted from the working tree; there is nothing to read.
  if (await file.exists()) workflows.push([path, Bun.YAML.parse(await file.text()) as Workflow]);
}

/** The events of an `on:` value, which may be one name, a list, or a map. */
function triggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on ?? {});
}

/** Whether a `permissions:` value grants write access to any scope. */
function grantsWrite(permissions: unknown): boolean {
  if (typeof permissions === "string") return permissions === "write-all";
  return Object.values(permissions ?? {}).includes("write");
}

/** Every `uses:` reference of a workflow: reusable workflows called by jobs, and step actions. */
function references(flow: Workflow): string[] {
  return Object.values(flow.jobs).flatMap((job) => [
    ...(job.uses === undefined ? [] : [job.uses]),
    ...(job.steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
  ]);
}

/**
 * A reference is pinned when it names a full commit SHA, a Docker image digest, or a local path
 * (versioned with the workflow itself).
 */
function isPinned(ref: string): boolean {
  return /^\.\/|@[0-9a-f]{40}$|^docker:\/\/[^@]+@sha256:[0-9a-f]{64}$/.test(ref);
}

// Both events run in the base repository with its secrets and a write token, even when a fork
// triggers them ("pwn requests"); a workflow that needs one is a reviewed exception.
const PRIVILEGED_EVENTS = ["pull_request_target", "workflow_run"];

describe("workflow checks", () => {
  test("read the events of every form of `on:`", () => {
    expect(triggers("push")).toEqual(["push"]);
    expect(triggers(["push", "pull_request_target"])).toEqual(["push", "pull_request_target"]);
    expect(triggers({ workflow_run: { workflows: ["CI"] } })).toEqual(["workflow_run"]);
  });

  test("find write access at any scope", () => {
    expect(grantsWrite("write-all")).toBe(true);
    expect(grantsWrite({ contents: "read", "pull-requests": "write" })).toBe(true);
    expect(grantsWrite("read-all")).toBe(false);
    expect(grantsWrite({ contents: "read" })).toBe(false);
    expect(grantsWrite(undefined)).toBe(false);
  });

  test("collect the references of jobs and steps, and accept only pinned ones", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const flow: Workflow = {
      on: "push",
      permissions: {},
      concurrency: { group: "", "cancel-in-progress": "" },
      jobs: {
        call: { name: "call", uses: `org/repo/.github/workflows/w.yml@${sha}` },
        build: { name: "build", steps: [{ uses: "actions/checkout@v7" }, { run: "bun test" }] },
      },
    };
    expect(references(flow)).toEqual([
      `org/repo/.github/workflows/w.yml@${sha}`,
      "actions/checkout@v7",
    ]);
    expect(references(flow).filter((ref) => !isPinned(ref))).toEqual(["actions/checkout@v7"]);
    expect(isPinned("./.github/actions/setup")).toBe(true);
    expect(isPinned(`docker://alpine@sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isPinned("docker://alpine:3.20")).toBe(false);
    expect(isPinned(`actions/checkout@${sha.slice(0, 7)}`)).toBe(false);
  });
});

describe("every workflow", () => {
  test("is found by the scan", () => {
    expect(workflows.map(([path]) => path)).toContain(".github/workflows/ci.yml");
  });

  test.each(workflows)("%s declares its permissions and grants no write access", (_path, flow) => {
    // Without a top-level block, the repository default applies, which a setting can widen.
    expect(flow).toHaveProperty("permissions");
    const scopes = [flow.permissions, ...Object.values(flow.jobs).map((job) => job.permissions)];
    expect(scopes.filter(grantsWrite)).toEqual([]);
  });

  test.each(workflows)("%s does not run untrusted code with secrets", (_path, flow) => {
    const events = triggers(flow.on);
    // A missing or unreadable `on:` would leave nothing to check.
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((event) => PRIVILEGED_EVENTS.includes(event))).toEqual([]);
  });

  test.each(workflows)("%s pins every action and reusable workflow", (_path, flow) => {
    expect(references(flow).filter((ref) => !isPinned(ref))).toEqual([]);
  });
});

describe("CI workflow", () => {
  test("names the job exactly as the required check of the main ruleset (ADR 0016)", () => {
    // Renaming the job would leave the ruleset waiting for a check that never runs, blocking merges.
    expect(Object.values(ci.jobs).map((job) => job.name)).toContain("Typecheck, lint and test");
  });

  test("gives every push to main its own concurrency group, so no main run is cancelled", () => {
    // A group keeps one running and one pending run; a third run cancels the pending one even
    // with cancel-in-progress off. A per-run group on pushes avoids that.
    expect(ci.concurrency.group).toBe(
      `ci-${expression("github.event_name == 'pull_request' && github.ref || github.run_id")}`,
    );
  });

  test("cancels superseded runs only on pull requests", () => {
    expect(ci.concurrency["cancel-in-progress"]).toBe(
      expression("github.event_name == 'pull_request'"),
    );
  });

  test("grants the workflow token read-only access to contents", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
  });

  test("installs from the frozen lockfile and runs the same check as local development", () => {
    const commands = steps.flatMap((step) => (step.run === undefined ? [] : [step.run.trim()]));
    expect(commands).toEqual(["bun install --frozen-lockfile", "bun run check"]);
  });

  test("uses actions, so the pinning check above is not vacuous", () => {
    expect(references(ci).length).toBeGreaterThan(0);
  });

  test("takes the Bun version from package.json", () => {
    const setup = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
    expect(setup?.with?.["bun-version-file"]).toBe("package.json");
  });

  test("does not persist the checkout credentials", () => {
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });
});
