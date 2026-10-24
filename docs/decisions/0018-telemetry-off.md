# 0018. Telemetry off for the tools the repository runs

- Status: Accepted
- Date: 2026-10-24

## Context

The maintainer asked to turn off all telemetry (tracker L18). The tools the repository runs were
checked on 2026-10-24:

- **Bun 1.4.4.** The `telemetry` setting of `bunfig.toml` is enabled by default. Today it only sends
  anonymous crash reports; Bun plans to collect which APIs are used and how long builds take.
  `telemetry = false` is equivalent to `DO_NOT_TRACK=1`.
- **TypeScript 7.0.2, Biome 2.6.2, oxlint 1.87.0.** `bun run check` runs all three plus the tests:
  traced with `strace`, its 166 processes opened no network connection. The telemetry strings in
  the TypeScript and oxlint binaries belong to the editor protocol (`telemetry/event`), not to an
  upload.
- **Candidate tools.** tester-army `e2e`, evaluated for end-to-end tests, sends usage data to
  PostHog by default.

## Decision

We will keep telemetry off for every tool the repository runs:

- `bunfig.toml`, in the project root next to `package.json`, sets `telemetry = false`. It is
  versioned, so it applies on every clone and in CI. `tests/repo/package.test.ts` checks it.
- A tool that sends usage data is adopted only with its telemetry turned off in a versioned file
  (its configuration or the CI environment), and the pull request that adds it says how.

Telemetry of tools installed on a contributor's machine, outside the repository, is each person's
choice.

## Consequences

- Running the repository sends no usage data or crash reports to tool vendors.
- Bun's developers do not learn about crashes we hit; we report them by hand.
- Choosing a new tool includes checking whether it collects data and how to turn that off.

## Alternatives considered

- **`DO_NOT_TRACK=1` in the CI workflow only.** Rejected: local runs would still send crash reports.
- **Environment variables on each developer's machine.** Rejected: nothing versioned enforces them,
  so a fresh clone sends by default.

## References

- `bunfig.toml` `telemetry`: https://bun.com/docs/runtime/bunfig
- tester-army `e2e` telemetry: https://e2e.tester.army/docs/telemetry
- Tracker `docs/roadmap/v0.1-tracker.md`: L18, L19.
