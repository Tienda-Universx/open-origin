import { describe, expect, test } from "bun:test";

type Step = { uses?: string; with?: Record<string, unknown> };
type Workflow = {
  permissions: unknown;
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<string, { steps: Step[] }>;
};

/** Builds a GitHub Actions expression such as ${{ github.ref }}. */
const expression = (body: string): string => `\${{ ${body} }}`;

const WORKFLOW = new URL("../../.github/workflows/ci.yml", import.meta.url);
const ci = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as Workflow;
const steps = Object.values(ci.jobs).flatMap((job) => job.steps);

describe("CI workflow", () => {
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

  test("pins every action to a full commit SHA", () => {
    const actions = steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses]));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.filter((uses) => !/@[0-9a-f]{40}$/.test(uses))).toEqual([]);
  });

  test("does not persist the checkout credentials", () => {
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });
});
