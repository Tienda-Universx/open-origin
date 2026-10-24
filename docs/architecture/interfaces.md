# Interfaces: public and admin

Open Origin has two interfaces: a public one (`apps/web`) to observe and, later, participate in the
universe, and a private admin panel (`apps/admin`) to manage AI providers and models, API keys,
endpoints, modes, budgets, simulations, inhabitants, metrics, and logs. They never share a bundle,
listener, or API. The admin panel is never exposed publicly without authentication and
authorization. Source: plan §E.6 (DF-1 to DF-4), §L, §M, §N; decisions in
[0009](../decisions/0009-public-and-private-admin-interfaces.md) and
[0010](../decisions/0010-ui-stack-react-vite-native-css.md).

## At a glance

| | Public: `apps/web` | Admin: `apps/admin` |
|---|---|---|
| Purpose | Observe the universe; later, participate | Manage AI providers and models, API keys, endpoints, modes, budgets, simulations, inhabitants, metrics, and logs |
| Audience | Spectators; later players | Operators and researchers |
| Data | C0 (plus the player's own C2, in the future) | C0, C1, C3. C4 write-only |
| Connection | Server public plane (public WS + HTTP) | Admin plane: **separate listener**. v0.1: binds to `127.0.0.1` and requires a local token, behind a flag (O-21). Before any public exposure: authentication, authorization (RBAC), and an audit log |
| Render | React UI + **PixiJS only for the universe** | React (no Pixi in v0.1; if it needs a map, it reuses the renderer extracted to a package) |
| Deploy | Static files on Pages, when authorized | **Never** on Pages or a public origin without authentication and authorization |

Data classes are defined in [Data classification](data-classification.md).

## Planes and listeners

```
apps/web ──(C0 DTOs, public WS/HTTP)──▶ server: public plane ──┐
                                                               ├─▶ projections ◀── world
apps/admin ─(admin DTOs + audited commands, 127.0.0.1 + token)─▶ server: admin plane ─┘
              └─ API keys: write-only ─▶ encrypted store (C4)
packages/ui ── shared by apps/web and apps/admin (presentational)
```

- **Public plane.** Server → client: `hello` (protocol version and audience), `snapshot` on chunk
  subscription, `delta` per tick or every N ticks, `events`. Client → server: `subscribe(chunks)`,
  `follow(beingId)`, `ping`. Clients are read-only in v0.1 (§I.3, §E.4).
- **Admin plane.** Own listener, own routes, own DTOs: `protocol` has `public` and `admin`
  audiences.
- **DTO entry points.** `packages/protocol` exposes two separate entry points,
  `@open-origin/protocol/public` and `@open-origin/protocol/admin`. `apps/web` may import only the
  public entry; `apps/admin` may import both. Decided 2026-10-24 and implemented in T6 and T8; T8
  enforces it with an import-boundary check and the public `dist/` scan (criterion 18).
- Both planes read the world only through projections. Watching from either interface changes
  nothing in the world (P9, [0005](../decisions/0005-observer-independence.md)).

## Admin security rules

| Rule | Detail |
|---|---|
| Separate bundles | No admin module ships in the public bundle; a test scans the public `dist/` for admin routes and modules |
| Separate API | Own listener, routes, and DTOs |
| Separate DTO entry points | `apps/web` imports only `@open-origin/protocol/public`; `apps/admin` may also import `@open-origin/protocol/admin` |
| Local only in v0.1 | Binds to `127.0.0.1` and requires a local token, behind a flag (O-21) |
| Before any public exposure | Authentication, authorization (RBAC), and an audit log |
| World-affecting actions | Pause, change AI mode, create world, adjust budget: commands with `admin` provenance, recorded in the log and in an append-only audit log. An experimental configuration change opens a new epoch |
| Double key for paid spend | The panel cannot enable `paid` unless the server started with `AI_ALLOW_PAID=true` ([0004](../decisions/0004-ai-proposes-engine-decides.md)) |
| Codespaces | A forwarded port can become public, so the token is required even locally and the panel listens only on `127.0.0.1` |

## API key handling

Adopted default (2026-10-24), configurable (O-25;
[0009](../decisions/0009-public-and-private-admin-interfaces.md)):

- Stored encrypted in the database with AES-GCM via WebCrypto; the master key lives in an
  environment variable.
- The panel is write-only: it can create, rotate, and delete keys, but only shows a fingerprint
  (last 4 characters).
- Keys never return to the client, logs, or snapshots; the admin API never returns a key value.
- An environment variable takes precedence over a stored key.

## Design system: `packages/ui`

React + native CSS + CSS Modules + CSS custom properties. No Tailwind, shadcn/ui, or CSS
frameworks.

| Aspect | Rule |
|---|---|
| Tokens (`tokens.css`) | Semantic color (surfaces, text, accent, states), typography, spacing, radii, shadows, motion. Light and dark themes via `prefers-color-scheme` and `data-theme` |
| Atomic design | Tokens → primitives (Button, Input, Badge) → composites (Field, Card, Table) → patterns (Sidebar, Inspector, DataTable) |
| Container-presentational | `ui` components are presentational (props, no fetch); data containers live in each app |
| Native HTML first | `<dialog>`, `popover`, `<details>`, native forms |
| Accessibility | WCAG 2.2 AA target, visible focus, full keyboard operation, `prefers-reduced-motion`, verified contrast |
| Responsive | Mobile-first, with container queries where they help |

Both apps share it, so the visual identity is consistent.

## PixiJS ↔ React boundary

- Pixi draws only the universe: terrain, entities, day/night, camera.
- It mounts inside a React boundary component and never draws UI (buttons, panels, interface text).
- React and Pixi communicate through a view store and typed events (inhabitant selection, camera).
- PixiJS is imported only in the universe module of `apps/web` (import test, criterion 21).

## Acceptance criteria

From plan §N (first prototype).

| # | Criterion | Delivered in |
|---|---|---|
| 17 | The admin panel listens only on `127.0.0.1`, rejects every request without a valid token (test), and records every action in the audit log | T8 |
| 18 | The public `dist/` contains no admin panel code, routes, or DTOs (scan test) | T8 |
| 19 | The admin API never returns an API key value, only its fingerprint (test, T9) | T9 |
| 20 | Both interfaces use only `packages/ui` (CSS Modules + variables), with no CSS framework dependencies; fully keyboard-operable; respect `prefers-reduced-motion` and the light/dark theme | T8 |
| 21 | PixiJS is imported only in the universe module of `apps/web` (import test) | T8 |

## Roadmap

| Batch | Delivers (plan §M, §L) |
|---|---|
| T1 | This architecture, for both interfaces |
| T8 | Three chained PRs: `packages/ui` (tokens and components with CSS Modules) → public `apps/web` (React + PixiJS only for the universe) → local `apps/admin` (world state, simulation controls, inhabitants (C1), metrics, logs) with its admin plane in the server (`127.0.0.1` + token, audit). Key tests: public bundle without admin code or secrets; admin rejects without token; full keyboard navigation |
| T9 | AI controls in the panel: providers, models, endpoints, encrypted write-only API keys, modes with double key, budgets, and usage. Key test: the admin API never returns a key |

New T8 dependencies: `react`, `react-dom`, `pixi.js`, `pixi-viewport`, `vite`, and the Vite React
plugin.

**Open questions**

| Question | Decided in |
|---|---|
| Accessibility audit tool (plan §M row T8) | T8 |
| Router and data fetching for the panel; preference: no libraries while a few views suffice (O-26) | T8 |
