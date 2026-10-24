/**
 * Where a problem is, as a JSON Pointer (RFC 6901) into the value at fault ("" is the whole
 * value), and what it is.
 */
export type Issue = { readonly path: string; readonly message: string };

/** Why the engine refused an operation. Later batches add their codes here. */
export type EngineErrorCode = "invalid_value";

/** How many issues an EngineError keeps; it still counts the ones it drops. */
export const MAX_ISSUES = 50;

export type EngineErrorOptions = {
  /** Issues found in all, when a collector already dropped some of them. */
  readonly issueCount?: number;
  readonly cause?: unknown;
};

/** `path` for a message: the empty JSON Pointer names the whole value. */
export function describePath(path: string): string {
  return path === "" ? "the root" : path;
}

function summarize(code: EngineErrorCode, kept: readonly Issue[], count: number): string {
  const first = kept[0];
  if (first === undefined) return code;
  const headline = `${code} at ${describePath(first.path)}: ${first.message}`;
  if (count === 1) return headline;
  const dropped = count - kept.length;
  const drops = dropped > 0 ? `, ${dropped} dropped beyond the first ${MAX_ISSUES}` : "";
  return `${headline}; ${count} issues in all${drops}`;
}

/** The engine's only error type: a code, and the issues found (up to MAX_ISSUES). */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly issues: readonly Issue[];
  readonly #brand = true;

  /**
   * Whether `value` is an EngineError. Unlike `instanceof`, the private brand check runs no Proxy
   * trap, so it cannot throw whatever value it is given.
   */
  static isEngineError(value: unknown): value is EngineError {
    return typeof value === "object" && value !== null && #brand in value;
  }

  constructor(code: EngineErrorCode, issues: readonly Issue[], options: EngineErrorOptions = {}) {
    const kept = Object.freeze(
      issues.slice(0, MAX_ISSUES).map(({ path, message }) => Object.freeze({ path, message })),
    );
    const { issueCount = 0, cause } = options;
    let count = issues.length;
    if (issueCount > count) count = issueCount;
    super(summarize(code, kept, count), "cause" in options ? { cause } : undefined);
    this.name = "EngineError";
    this.code = code;
    this.issues = kept;
  }
}

/**
 * Collects issues for an EngineError: it keeps the first MAX_ISSUES, counts them all, and keeps
 * the first cause reported with one.
 */
export class IssueList {
  readonly issues: Issue[] = [];
  count = 0;
  #cause: { readonly error: unknown } | undefined;

  report(path: string, message: string, cause?: unknown): void {
    this.count += 1;
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path, message });
    if (cause !== undefined && this.#cause === undefined) this.#cause = { error: cause };
  }

  /** Throws an EngineError with `code` and the collected issues, if there are any. */
  throwIfAny(code: EngineErrorCode): void {
    if (this.count === 0) return;
    const issueCount = this.count;
    const options =
      this.#cause === undefined ? { issueCount } : { issueCount, cause: this.#cause.error };
    throw new EngineError(code, this.issues, options);
  }
}
