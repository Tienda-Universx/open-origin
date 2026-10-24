# AGENTS.md

Instructions for humans and AI agents working in this repository. They apply to every batch
("tanda"), not only to the current one.
The approved plan (`docs/roadmap/v0.1-plan.es.md`) and the ADRs (`docs/decisions/`) are the source
of truth. If this file and an ADR disagree, the ADR wins and this file must be fixed.

## Project in one paragraph

Open Origin is an open-source (AGPL-3.0) persistent universe where autonomous beings and humans
coexist. An authoritative, deterministic simulation engine is the only source of truth. AI models
only **propose** intentions; the engine validates, applies, records, and attributes them.

## Commands

Bun is the only runtime and package manager for project code. Do not use npm, yarn, or pnpm, do not
run project code with Node.js, and do not install global tools. Node-ecosystem tools that work under
Bun are allowed when they add value.

| Task | Command |
|---|---|
| Install | `bun install` (CI uses `bun install --frozen-lockfile`) |
| Everything CI runs | `bun run check` |
| Typecheck | `bun run typecheck` |
| Lint and format check | `bun run lint` |
| Apply formatting and safe fixes | `bun run format` |
| Tests | `bun test` |

CLIs whose launcher targets Node (for example `tsc`, `biome`) must run with `bunx --bun`.
Before relying on a tool, check that it exists and which version it is (`bun --version`,
`bunx --bun tsc --version`); do not assume.

## Architecture rules (do not break)

1. **The engine is reality.** Simulation state changes only through the engine's `step`.
   Clients, AI, and admin tools submit commands; they never write state.
2. **AI proposes, the engine decides.** Model output is validated, recorded as a command, and never
   trusted as a result. Experiment outcomes always come from the engine.
3. **Pure, runtime-agnostic core.** `packages/engine` and `packages/agents` must not use Bun,
   `node:*`, DOM APIs, `Math.random`, `Date`, `crypto.randomUUID`, or transcendental `Math`
   functions (`sin`, `cos`, `exp`, `pow`, `**`). State holds only safe integers
   (`Number.isSafeInteger`), strings, booleans, arrays, and plain records.
4. **Observer independence.** Nothing outside the world (who is watching, which UI is open, who
   pays) may influence the engine, the minds, or the cognitive budget allocator.
5. **No lexical censorship of ideas.** Inhabitants may think about anything. We control what enters
   prompts and we attribute provenance; we do not block words.
6. **Audience projections.** Clients receive explicit allow-listed DTOs per audience, never raw
   state. Data classes C0 public, C1 inhabitant-internal, C2 player-private, C3 operations/research,
   C4 secrets.
7. **Two interfaces, two planes.** `apps/web` (public) and `apps/admin` (private) never share a
   bundle, listener, or API. The admin plane is never exposed publicly without authentication and
   authorization; in v0.1 it binds to `127.0.0.1` and requires a token.
8. **UI stack.** React + Vite + native CSS, CSS Modules, and CSS custom properties via the shared
   `packages/ui` design system. No Tailwind, shadcn/ui, or CSS frameworks. PixiJS renders only the
   interactive universe; React renders every interface.
9. **AI is off by default.** `AI_MODE=off`. Paid usage requires an explicit server flag plus spend
   caps, and is never enabled by an agent.
10. **No empty packages.** Create a workspace package only in the batch that needs it.
11. **Scientific integrity.** Never claim that inhabitants are conscious, never inject the concepts
    we want to observe into prompts, and keep provenance for every belief (plan §C, §K).

## Change protocol (mandatory for every significant change)

A change is significant when it refactors, optimizes, upgrades a dependency, or modifies behavior,
contracts, CI, or security-relevant code. A change is complete only when there is evidence that the
expected behavior is preserved and the relevant checks pass. Compiling or a green suite alone is not
evidence.

### Phase A: examine the original state

1. Read the code involved, its callers, and its dependencies; list the contracts it must keep.
2. Inventory existing tests (unit, integration, functional, end-to-end).
3. Run them **before** modifying anything and record which pass, fail, or cannot run.
4. Investigate every pre-existing failure, so pre-existing problems are not confused with new ones.
5. Check that the tests assert real outcomes, not only that code runs without throwing.

### Phase B: check that the tests can fail

1. Where it adds value, introduce a controlled defect in an isolated copy (never in the working
   tree you will commit, never in production): break an expected result or a key condition.
2. The related test must fail. If it keeps passing, the test is insufficient and must be improved.
3. Restore the original code and confirm the suite passes again. Never keep a deliberate defect.
4. When an important behavior has no test, first add characterization or regression tests that pin
   the correct behavior, then change the code.

### Phase C: make the change

1. State what will improve and why; list risks and side effects.
2. Choose the simplest maintainable solution; avoid duplication, coupling, and over-engineering.
3. Make small, reviewable changes; keep public interfaces and behavior unless a functional change
   is explicitly justified.
4. Never weaken or edit tests just to make them pass. When behavior changes on purpose, document it
   and update the tests to the new requirement.

### Phase D: validate

1. Run the relevant tests, then the full suite, and compare with the Phase A baseline.
2. Run typecheck, lint, format check, builds, and integration tests when they exist.
3. Confirm the original problem is fixed and no regression appeared; probe edge cases, invalid
   input, race conditions, and recovery paths where they apply.
4. Measure performance or resource use when the change can affect them; do not assume.
5. Repeat Phase B for new tests: they must detect real defects.
6. Get an independent review of the final result for high-risk changes.

If a check fails, find and fix the cause. Never hide, skip, or disable a failure without a
documented justification.

## Engineering principles

Apply them when they improve the solution, never mechanically: SOLID where it adds real value; DRY
without premature abstraction; KISS; YAGNI; separation of concerns; strict typing and explicit
contracts; input and output validation; security by design and least privilege; deterministic,
reproducible tests; explicit error handling; compatibility and versioning; up-to-date
documentation; observability and diagnostics; measured (not assumed) performance; cost and
dependency control; critical review of every change.

## Honest reporting

- Never claim a test, build, or check ran unless it ran; report the command and the observed result.
- Separate observed results from assumptions and estimates; say "unverified" when you could not
  check something.
- Do not finish significant work while a blocking error remains; report it instead.
- Keep code, tests, documentation, and ADRs consistent; a change to an architectural rule adds or
  supersedes an ADR in the same pull request.

## Secrets and safety

- Never commit, log, print, or send secrets to a client, prompt, or snapshot. `.env*` files are
  ignored; only `.env.example` is versioned. Do not name credentials in public documents.
- Never deploy, activate paid services, or create cloud resources without explicit maintainer
  authorization.
- This repository is public: everything pushed is public.
- Write invisible or bidirectional control characters only as escapes; `tests/repo/hygiene.test.ts`
  rejects them in text files.

## Workflow

- Work in batches ("tandas") from `docs/roadmap/v0.1-tracker.md`; one branch per batch, merged
  through pull requests. Never commit directly to `main`.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `build:`, `ci:`, `chore:`), small and
  descriptive. Commit messages carry no AI attribution trailers (such as `Co-Authored-By`).
- Pull requests are merged with a merge commit (no squash), parent first in stacked PRs; see
  `docs/decisions/0012-branching-commits-and-pull-requests.md`.
- Push and open pull requests with a user-authenticated token: events created with a Codespace's
  built-in token do not start GitHub Actions workflows.
- Tests and docs ship with the behavior they cover.

## Documentation map

| Path | Content | Language |
|---|---|---|
| `docs/vision/master-vision.es.md` | Original master vision, verbatim | Spanish |
| `docs/roadmap/v0.1-plan.es.md` | Approved v0.1 plan, verbatim | Spanish |
| `docs/roadmap/v0.1-tracker.md` | Batch tracker: specs, tasks, log | Spanish |
| `docs/decisions/` | Architecture Decision Records | English |
| `docs/architecture/` | Technical architecture | English |

Code, identifiers, comments, commit messages, ADRs, and technical docs are written in English.
