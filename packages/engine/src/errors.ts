/**
 * Where a problem is, as a JSON Pointer (RFC 6901) into the value at fault ("" is the whole
 * value), and what it is.
 */
export type Issue = { readonly path: string; readonly message: string };

/**
 * Why the engine refused an operation:
 *
 * - `invalid_value` for a value or argument it cannot accept;
 * - `invalid_input` for a world definition, or anything else the host gives a world, that it
 *   cannot accept, and for an object that is not a world;
 * - `invalid_ruleset` for a ruleset that breaks the rules of captureRuleset;
 * - `invalid_snapshot` for a snapshot that decodeSnapshot cannot accept: text that is not
 *   canonical, a schema it breaks, data the ruleset's validators reject, or a state root that is
 *   not the root of its state;
 * - `unsupported_schema` for a snapshot whose schema version this engine does not read;
 * - `version_mismatch` for a step of a world whose snapshot header records other versions than
 *   the running engine's and its ruleset's, which replay requires to be equal;
 * - `tick_overflow` for simulation time that would pass Number.MAX_SAFE_INTEGER;
 * - `system_fault` for a tick that failed after it began: ruleset code that threw, returned a
 *   value, or misused the tick context, and data that is not canonical or that the ruleset's
 *   validators reject at the commit;
 * - `integrity_violation` for a state that disagrees with its incremental digests, which audit
 *   and encodeSnapshot find after a write that bypassed the barrier;
 * - `world_faulted` for any use but worldStatus of a world whose tick failed;
 * - `world_busy` for any use of a world, read or step, while a step runs on it or while
 *   encodeSnapshot reads it: from ruleset code during the tick, which also faults the tick, or
 *   from a host Proxy while step reads commands or a Proxy in the state while it is encoded;
 * - `context_expired` for a tick context, or the view `check` receives, used after its step;
 * - `id_exhausted` for an entity id that would leave nextEntityId beyond the safe integers.
 *
 * Later batches add their codes here.
 */
export type EngineErrorCode =
  | "invalid_value"
  | "invalid_input"
  | "invalid_ruleset"
  | "invalid_snapshot"
  | "unsupported_schema"
  | "version_mismatch"
  | "tick_overflow"
  | "system_fault"
  | "integrity_violation"
  | "world_faulted"
  | "world_busy"
  | "context_expired"
  | "id_exhausted";

/** How many issues an EngineError keeps; it still counts the ones it drops. */
export const MAX_ISSUES = 50;

export type EngineErrorOptions = {
  /** Issues found in all, when a collector already dropped some of them. */
  readonly issueCount?: number;
  readonly cause?: unknown;
};

/**
 * `value` for a message, without running any of its code: a number as JavaScript writes it, but
 * -0 as "-0", and anything else by its type alone.
 */
export function describeValue(value: unknown): string {
  if (typeof value !== "number") return `a value of type ${typeof value}`;
  return Object.is(value, -0) ? "-0" : `${value}`;
}

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

  /**
   * A new EngineError with `code`, the issues kept, the count of every issue reported, and the
   * first cause any issue was reported with, which need not be the first issue's. It does not
   * throw: callers throw what it returns, or call throwIfAny.
   */
  toError(code: EngineErrorCode): EngineError {
    const issueCount = this.count;
    const options =
      this.#cause === undefined ? { issueCount } : { issueCount, cause: this.#cause.error };
    return new EngineError(code, this.issues, options);
  }

  /** Throws an EngineError with `code` and the collected issues, if there are any. */
  throwIfAny(code: EngineErrorCode): void {
    if (this.count > 0) throw this.toError(code);
  }
}
