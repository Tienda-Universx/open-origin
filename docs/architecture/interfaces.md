# Interfaces: public and admin

Open Origin has two interfaces: a public one (`apps/web`) to observe and, later, participate in the
universe, and a private admin panel (`apps/admin`) for operators and researchers. The rules are
decided in [0009](../decisions/0009-public-and-private-admin-interfaces.md) and
[0010](../decisions/0010-ui-stack-react-vite-native-css.md); this page adds the planes diagram, the
message flow, the acceptance criteria, and the delivery roadmap. Source: plan §E.6 (DF-1 to DF-4),
§L, §M, §N.

## Where each rule lives

| Topic | Decided in |
|---|---|
| Purpose, audience, data classes, connection, and deploy of each interface | [0009, Decision](../decisions/0009-public-and-private-admin-interfaces.md#decision) |
| Admin security rules: separate bundles, API, and DTO entry points; local token; audit log; double key for paid spend; Codespaces | [0009, Decision](../decisions/0009-public-and-private-admin-interfaces.md#decision) |
| API key storage and display | [0009, Decision](../decisions/0009-public-and-private-admin-interfaces.md#decision) |
| Design system `packages/ui`: tokens, atomic design, container-presentational, accessibility, responsiveness | [0010, Decision](../decisions/0010-ui-stack-react-vite-native-css.md#decision) |
| PixiJS ↔ React boundary, and which interface renders with Pixi | [0010, Decision](../decisions/0010-ui-stack-react-vite-native-css.md#decision) |
| Data classes C0–C4 | [Data classification](data-classification.md) |

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
- **One shared universe.** No client message controls time, and a test of the allowlist rejects
  any that would. The public feed of happenings reaches every client, while everything tied to a
  place follows chunk subscriptions. The plane publishes only durable ticks
  ([0022](../decisions/0022-single-shared-public-universe.md)).
- **Admin plane.** Own listener, own routes, own DTOs: `protocol` has `public` and `admin`
  audiences.
- **DTO entry points.** `packages/protocol` exposes a public and an admin entry point; which app
  may import which, and how T8 checks it, is decided in
  [0009](../decisions/0009-public-and-private-admin-interfaces.md#decision).
- Both planes read the world only through projections. Watching from either interface changes
  nothing in the world (P9, [0005](../decisions/0005-observer-independence.md)).

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
| T8 | Three chained PRs: `packages/ui` (tokens and components with CSS Modules) → public `apps/web` (React + PixiJS only for the universe) → local `apps/admin` (world state, simulation controls, which for the public universe are an audited pause and resume and configuration changes that open an epoch ([0022](../decisions/0022-single-shared-public-universe.md)), inhabitants (C1), metrics, logs) with its admin plane in the server (`127.0.0.1` + token, audit). Key tests: public bundle without admin code or secrets; admin rejects without token; full keyboard navigation |
| T9 | AI controls in the panel: providers, models, endpoints, encrypted write-only API keys, modes with double key, budgets, and usage. Key test: the admin API never returns a key |

New T8 dependencies: `react`, `react-dom`, `pixi.js`, `pixi-viewport`, `vite`, and the Vite React
plugin.

**Open questions**

| Question | Decided in |
|---|---|
| Accessibility audit tool (plan §M row T8) | T8 |
| Router and data fetching for the panel; preference: no libraries while a few views suffice (O-26) | T8 |
