# 0002. Bun and TypeScript as the main stack

- Status: Accepted
- Date: 2026-10-24

## Context

Open Origin needs a main runtime, a main language, and one toolchain for the engine, the server,
the interfaces, and the tests. The master vision (§24) asks not to use Node.js as the main runtime and
names strict TypeScript, Bun workspaces, and Bun test. The maintainer later confirmed (plan DF-5):
Bun and TypeScript stay the main stack; Go is optional in the future, only if performance tests
justify it. Plan §D evaluated the stack with npm `latest` versions and official docs as of
2026-10-24.

## Decision

We will use Bun as the main runtime and the package manager, and strict TypeScript as the main
language.

Versions are recorded as of 2026-10-24. `package.json` is the source of truth for versions; this
table does not override it.

| Tool | Version and rule | Source |
|---|---|---|
| Bun | 1.4.4, pinned (`packageManager: bun@1.4.4`) in local and CI | Plan §D, §P |
| TypeScript | 7.0.2, pinned in `package.json` (the plan only asks for the stable version current at implementation time); `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `moduleResolution: "bundler"`, `noEmit` | Version: `package.json`, tracker L5. Options: plan §D, §P |
| Biome | 2.6.2, single config at the repository root (nested configs have acknowledged memory issues) | Plan §D |
| Tests | `bun test` | Plan §D |

- Node 24.21 is present in the Codespace but is not used as a runtime (plan §B).
- Scripts never depend on Node. CLIs with a Node shebang (for example `tsc`) run with
  `bunx --no-install --bun`, which runs the locally installed CLI with Bun and never downloads a
  registry package when it is missing (`package.json` scripts, `AGENTS.md`,
  tracker L5; plan §P writes it as `bun --bun`).
- CI reads the Bun version from `package.json` through `oven-sh/setup-bun` (`bun-version-file`).
- Go is not adopted. It may be proposed only through a new ADR backed by reproducible benchmarks
  that show a bottleneck Bun/TypeScript cannot solve (plan §D, O-24).

## Consequences

- One language end to end: the deterministic core can run in Bun, browsers, and workerd, because
  it uses no runtime APIs (P5, plan §C.2 tension 12).
- Bun 1.4 is a recent Rust rewrite with listed breaking changes (isolated linker by default in
  workspaces, `bun.lock` v2). We accept that risk and mitigate it by pinning the same version in
  local and CI (plan §P risks).
- A Go engine would prevent reusing the TypeScript core in the browser or workerd, and would force
  verifying determinism across two implementations (plan §D).

## Alternatives considered

- Node.js as runtime: rejected by the master vision §24.
- Go for the engine now: no benchmark shows a need; it breaks core reuse (plan §D, DF-5).

## References

- Plan `docs/roadmap/v0.1-plan.es.md`: DF-5, §B, §D, §P, O-24.
- Master vision `docs/vision/master-vision.es.md` §24.
- [0003. Authoritative deterministic engine](0003-authoritative-deterministic-engine.md).
