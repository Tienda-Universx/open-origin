# 0009. Two interfaces: public `apps/web` and private `apps/admin`

- Status: Accepted
- Date: 2026-10-24

## Context

The maintainer decided (plan DF-1) that Open Origin has two interfaces: a public one to observe
and participate in the universe, and a private, modern, visual admin panel to manage AI models and
providers, API keys, endpoints, modes, budgets, simulations, inhabitants, metrics, and logs. Both
architectures are documented from T1; the panel must never be exposed publicly without
authentication and authorization (DF-4). An admin panel inside the public bundle would leak
operational code and data (plan §E.5).

## Decision

**P11 Two interfaces, two planes, two bundles.** The public and admin interfaces share no bundle,
listener, or API (plan §E.6).

| | Public: `apps/web` | Admin: `apps/admin` |
|---|---|---|
| Purpose | Observe the universe; later, participate | Manage AI providers and models, API keys, endpoints, modes, budgets, simulations, inhabitants, metrics, and logs |
| Audience | Spectators; later players | Operators and researchers |
| Data | C0 (plus the player's own C2, in the future) | C0, C1, C3. C4 write-only |
| Connection | Server public plane (public WS + HTTP) | Admin plane: **separate listener**. v0.1: `127.0.0.1` + local token. Public phases: authentication, roles (RBAC), and audit |
| Deploy | Static files on Pages, when authorized | **Never** on Pages or a public origin without authentication and authorization |

Admin security rules:
- **Separate bundles.** No admin module ships in the public bundle; a test scans the public
  `dist/` for admin routes and modules.
- **Separate admin API**: own listener, routes, and DTOs (`protocol` with `public` and `admin`
  audiences).
- **World-affecting actions** (pause, change AI mode, create world, adjust budget) are commands
  with `admin` provenance, recorded in the log and in an append-only audit log. An experimental
  configuration change opens a new epoch. Watching from the panel affects nothing (P9).
- **API keys** are stored encrypted with AES-GCM via WebCrypto, with the master key in an
  environment variable. The panel can create, rotate, and delete them but only shows a fingerprint
  (last 4 characters). They never return to the client, logs, or snapshots.
- **Double key for paid spend.** The panel cannot enable `paid` unless the server started with
  `AI_ALLOW_PAID=true` ([0004](0004-ai-proposes-engine-decides.md)).
- **Codespaces.** A forwarded port can become public, so the panel requires the token even locally
  and listens only on `127.0.0.1`.

Roadmap: T8 builds the public view and a first local admin panel (world, simulation, inhabitants,
metrics, logs) with its admin plane in the server; T9 adds the AI controls (providers, models,
endpoints, write-only encrypted API keys, double-key modes, budgets, and usage).

## Consequences

- Two apps to build and test. They share `packages/ui`
  ([0010](0010-ui-stack-react-vite-native-css.md)) and the `protocol` package with separate
  audiences, never a bundle, listener, or API.
- Exposing the panel beyond `127.0.0.1` requires authentication, RBAC, and audit first (DF-4).
- Plan §N criteria 17–19 verify the listener, token, audit, bundle scan, and key fingerprint.
- Pending: whether an environment variable takes precedence over a stored key is marked [D] in
  §E.6 (recommendation O-25: it does). The panel's router and data fetching are decided in T8
  (O-26).

## References

- Plan: DF-1, DF-4, P11 (§E.1), §E.4, §E.5, §E.6, §L, §M, O-23, O-25, O-26, §N.
- [Interfaces architecture](../architecture/interfaces.md).
