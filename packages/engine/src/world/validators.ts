/**
 * Running the ruleset's validators (ADR 0020, failures), at createWorld and at every commit. A
 * validator returns every problem it finds as a list of { path, message } records whose paths are
 * JSON Pointers into the value it checked.
 */
import { copyCanonicalReported } from "../canonical/copy.ts";
import { describeThrown } from "../canonical/value.ts";
import { type Issue, IssueList } from "../errors.ts";
import { isRecord } from "./members.ts";

const MALFORMED = "must return a list of issues, each a record { path, message } of strings";

/** Whether `issue`, part of a canonical copy, is a record { path, message } with a JSON Pointer. */
function isIssue(issue: unknown): issue is Issue {
  if (!isRecord(issue) || !("path" in issue) || !("message" in issue)) return false;
  const { path, message } = issue;
  const pointerLike = typeof path === "string" && (path === "" || path.startsWith("/"));
  return pointerLike && typeof message === "string";
}

/**
 * Runs the validator `name` of the ruleset and reports what it returns at `path`: each issue under
 * that path, or one issue when it throws or returns anything but a list of issues.
 */
export function runValidator(
  name: string,
  path: string,
  validate: () => unknown,
  issues: IssueList,
): void {
  let result: unknown;
  try {
    result = validate();
  } catch (error) {
    issues.report(path, `${name} threw: ${describeThrown(error)}`, error);
    return;
  }
  const problems = new IssueList();
  const found = copyCanonicalReported(result, problems);
  if (problems.count > 0 || !Array.isArray(found) || !found.every(isIssue)) {
    issues.report(path, `${name} ${MALFORMED}`);
    return;
  }
  for (const issue of found) issues.report(`${path}${issue.path}`, issue.message);
}
