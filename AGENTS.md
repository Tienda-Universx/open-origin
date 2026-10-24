# AGENTS.md

Instructions for humans and AI agents working in this repository.
The approved plan (`docs/roadmap/v0.1-plan.es.md`) and the ADRs (`docs/decisions/`) are the source
of truth. If this file and an ADR disagree, the ADR wins and this file must be fixed.

## Project in one paragraph

Open Origin is an open-source (AGPL-3.0) persistent universe where autonomous beings and humans
coexist. An authoritative, deterministic simulation engine is the only source of truth. AI models
only **propose** intentions; the engine validates, applies, records, and attributes them.

## Commands

Bun is the only runtime and package manager. Do not use npm, yarn, pnpm, or Node.js to run project
code, and do not install global tools.

| Task | Command |
|---|---|
| Install | `bun install` (CI uses `bun install --frozen-lockfile`) |
| Everything CI runs | `bun run check` |
| Typecheck | `bun run typecheck` |
| Lint and format check | `bun run lint` |
| Apply formatting and safe fixes | `bun run format` |
| Tests | `bun test` |

CLIs whose launcher targets Node (for example `tsc`) must run with `bunx --bun`.

## Architecture rules (do not break)

1. **The engine is reality.** Simulation state changes only through the engine's `step`.
   Clients, AI, and admin tools submit commands; they never write state.
2. **AI proposes, the engine decides.** Model output is validated, recorded as a command, and never
   trusted as a result. Experiment outcomes always come from the engine.
3. **Pure, runtime-agnostic core.** `packages/engine` and `packages/agents` must not use Bun,
   `node:*`, DOM APIs, `Math.random`, `Date`, `crypto.randomUUID`, or transcendental `Math`
   functions (`sin`, `cos`, `exp`, `pow`, `**`). State holds only safe integers, strings, booleans,
   arrays, and plain records.
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

## Secrets and safety

- Never commit, log, print, or send secrets to a client, prompt, or snapshot. `.env*` files are
  ignored; only `.env.example` is versioned.
- Never deploy, activate paid services, or create cloud resources without explicit maintainer
  authorization.
- This repository is public: everything pushed is public.

## Workflow

- Work in batches ("tandas") from `docs/roadmap/v0.1-tracker.md`; one branch per batch, merged
  through pull requests. Never commit directly to `main`.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `build:`, `ci:`, `chore:`), small and
  descriptive. No AI attribution trailers.
- Tests and docs ship with the behavior they cover. Write the failing test first when a
  deterministic test is possible.
- Architectural changes add or supersede an ADR in the same pull request.

## Documentation map

| Path | Content | Language |
|---|---|---|
| `docs/vision/master-vision.es.md` | Original master vision, verbatim | Spanish |
| `docs/roadmap/v0.1-plan.es.md` | Approved v0.1 plan, verbatim | Spanish |
| `docs/roadmap/v0.1-tracker.md` | Batch tracker: specs, tasks, log | Spanish |
| `docs/decisions/` | Architecture Decision Records | English |
| `docs/architecture/` | Technical architecture | English |

Code, identifiers, comments, commit messages, ADRs, and technical docs are written in English.
