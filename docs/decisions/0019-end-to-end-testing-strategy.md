# 0019. End-to-end testing strategy

- Status: Accepted
- Date: 2026-10-24

## Context

The maintainer asked to install Playwright and tester-army `e2e`, an AI testing framework built on
Playwright (tracker L18). Both were installed and run in throwaway directories on 2026-10-24.

The end-to-end tests the plan requires (§I.2, §K.6, §M, §N) are of two kinds:

- **Process level**, from T6: several clients see the same tick, observer invariance, allow-listed
  public DTOs, backpressure resync (T6); `kill -9` and SIGTERM recovery with RPO ≤ 5 ticks and
  RTO ≤ 10 s, and a tampered checksum stopping the world (T7); a public bundle with no admin code,
  and an admin plane that rejects requests without a token (T8); a fake paid provider receiving no
  calls (T9).
- **Browser level**, from T8: keyboard-only operation, `prefers-reduced-motion`, light and dark
  themes, and two browsers showing the same tick.

Findings:

- **Playwright Test 1.64.0** (the newest release that meets [0015](0015-automated-quality-gates.md))
  runs on Bun 1.4.4 with `bunx --bun playwright test`: with a fake `node` first in `PATH`, neither
  the runner nor its workers called it. Without `--bun`, its `#!/usr/bin/env node` launcher runs it
  on Node. `bun test` also collects `*.spec.ts` files, Playwright's default suffix. Chromium's
  headless shell takes about 278 MB, and the Codespace lacks 12 system libraries it needs.
- **tester-army `e2e` 0.19.0** (the newest that meets 0015) installs with Bun but refuses to run on
  it: Bun 1.4.4 has no `module.registerHooks`, and the CLI reference states that it runs on Node.js,
  not Bun. It is pre-1.0, with breaking changes in four of its last seven minor releases, and sends
  telemetry by default. Its agent steps need a model; agent checks call it on every run, and a run
  without a model fails instead of skipping them.

No user interface exists until T8, so no browser test can be written yet.

## Decision

We will:

- write process-level end-to-end tests with `bun test` under `tests/e2e/`, starting the server with
  `Bun.spawn` and connecting with the built-in WebSocket client, from T6; recovery tests set a
  per-test timeout above the 10 s RTO, because Bun's default is 5 s;
- add Playwright Test in the first T8 pull request that has a page to test, pinned per 0015, run
  with `bunx --no-install --bun playwright test`, with test files named `*.e2e.ts` so `bun test`
  does not collect them, and with browsers installed on each CI run rather than cached;
- choose the accessibility checker in that same pull request (plan §M);
- not adopt tester-army `e2e`. We will reconsider it when it runs on Bun and its telemetry can be
  turned off in a versioned file ([0018](0018-telemetry-off.md)).

## Consequences

- No dependency is added before it has something to test, so there is nothing for Dependabot to
  update and no browser to download in CI until T8.
- Most end-to-end tests need no new dependency.
- T8 must install the browser's system libraries in CI, and its pull request adds the Playwright
  configuration and the CI job.

## Alternatives considered

- **Install Playwright now.** Rejected: there is no page to test until T8, and an unused dependency
  would still be updated and audited every week.
- **tester-army `e2e`.** Rejected for now: the runner does not run on Bun, which breaks the Bun-only
  rule in `AGENTS.md`, and its agent checks are model judgments that cannot make CI deterministic.
- **Playwright MCP for coding agents, configured in the repository.** Rejected: it pins an alpha
  Playwright, its documentation says it is not a security boundary, and a committed `.mcp.json`
  would be public. A contributor can configure it on their own machine.

## References

- Plan `docs/roadmap/v0.1-plan.es.md`: §I.2, §K.6, §M, §N.
- Bun test discovery and timeouts: https://bun.com/docs/test
- Playwright system requirements: https://playwright.dev/docs/intro
- Playwright in CI: https://playwright.dev/docs/ci
- tester-army `e2e` CLI (runs on Node.js only): https://e2e.tester.army/docs/reference/cli
- tester-army `e2e` replay cache: https://e2e.tester.army/docs/cache
- tester-army `e2e` change that made Node required: https://github.com/tester-army/e2e/pull/790
- Tracker `docs/roadmap/v0.1-tracker.md`: L18, L19.
