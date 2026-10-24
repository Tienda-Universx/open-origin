# 0015. Automated quality gates with Biome and oxlint

- Status: Accepted
- Date: 2026-10-24

## Context

The maintainer made a set of engineering practices permanent (tracker L14): guard clauses,
cyclomatic and cognitive complexity limits, DRY, single responsibility, fail fast, type safety,
testability and determinism, and a review checklist. They asked to automate the controls where it
is viable and justified, without claiming that a tool checks what it does not.

Tools checked on 2026-10-24:

| Need | Biome 2.6.2 (already in use) | Other options |
|---|---|---|
| Cognitive complexity | `noExcessiveCognitiveComplexity` | — |
| Cyclomatic complexity | No rule | oxlint `eslint/complexity`; ESLint `complexity` |
| Nesting depth | No rule | oxlint `eslint/max-depth` |
| Function length, parameter count | `noExcessiveLinesPerFunction`, `useMaxParams` | — |
| Guard clauses, nested ternaries | `noUselessElse`, `noNestedTernary` | — |
| Type safety | `noExplicitAny`, `noTsIgnore`, `noNonNullAssertion` | `tsc` strict mode |
| Import cycles, unused code | `noImportCycles`, `noUnused*` | — |

TypeScript 7.0.2 is the native compiler and exposes no JavaScript compiler API, so a cyclomatic
complexity script of our own would need yet another parser.

## Decision

We will enforce, in `bun run lint` (part of `bun run check` and CI):

- Biome with the recommended preset plus: cognitive complexity above 15, functions over 50 lines
  (tests excluded), more than 4 parameters, `else` after `return`, nested ternaries, non-null
  assertions, parameter reassignment, import cycles, explicit `any`, `@ts-ignore`, and unused
  variables, imports, and function parameters, all as errors;
- oxlint, pinned to 1.87.0, restricted to cyclomatic complexity above 10 and nesting deeper than 4;
  its default rule categories stay off so it never duplicates Biome.

New dev dependencies are pinned to an exact version published at least two weeks earlier, so a
compromised or broken release has time to be detected and withdrawn before adoption (oxlint 1.87.0
was chosen this way).

A function may exceed the cyclomatic limit only with an inline
`oxlint-disable-next-line eslint/complexity -- <reason>` accepted in review. `tests/repo/lint.test.ts`
lints one fixture per rule with the repository configuration, so a rule that stops firing fails the
suite. Duplicated code, dead exports, race conditions and performance regressions have no automated
check yet and stay on the review checklist in `AGENTS.md`.

## Consequences

- Complexity limits are enforced on every change instead of being remembered. When adopted, four
  functions exceeded a cyclomatic complexity of 10 (14 each) and two exceeded a cognitive
  complexity of 15 (39 and 24); they were split before the gate was turned on.
- One more pinned dev dependency (oxlint and its platform binary) to keep up to date; it runs on Bun
  through `bunx --no-install --bun`.
- Thresholds are tools for review, not goals: the practices in `AGENTS.md` forbid refactoring only to
  move a metric.
- Hexagonal boundaries get Biome `noRestrictedImports` rules when the first package exists (T2).

## Alternatives considered

- **Biome only, without a cyclomatic limit.** Rejected: the maintainer asked to measure cyclomatic
  complexity, and Biome has no such rule.
- **ESLint with typescript-eslint.** Rejected: a second full linter with many dependencies, only to
  obtain two rules.
- **An in-house complexity script.** Rejected: TypeScript 7 offers no compiler API to build it on,
  and a hand-written parser would be one more thing to verify.
- **Report-only metrics.** Rejected: a report nobody must act on does not keep the limits.

## References

- `AGENTS.md`: engineering practices, review checklist, automated controls.
- Biome rules: https://biomejs.dev/linter/javascript/rules/
- oxlint `eslint/complexity`: https://oxc.rs/docs/guide/usage/linter/rules/eslint/complexity
- Tracker `docs/roadmap/v0.1-tracker.md`: L14.
