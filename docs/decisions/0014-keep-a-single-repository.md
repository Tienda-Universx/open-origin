# 0014. Keep a single repository for the backend and the interfaces

- Status: Accepted
- Date: 2026-10-24

## Context

The maintainer asked whether Open Origin should split into two repositories, one for the backend
and one for the frontend ("storefront"), and delegated the decision (tracker L14).

The plan builds one Bun workspace (plan §G, [0002](0002-bun-and-typescript-as-main-stack.md)):
`apps/server`, `apps/web` and `apps/admin`, plus shared packages. The interfaces depend on code
the server also uses:

- `packages/protocol` defines the DTOs of both planes, with separate public and admin entry points
  ([0009](0009-public-and-private-admin-interfaces.md));
- `packages/ui` is the design system both interfaces share
  ([0010](0010-ui-stack-react-vite-native-css.md));
- the observer-invariance, determinism and audience-projection tests span engine, server and
  protocol ([0003](0003-authoritative-deterministic-engine.md),
  [0005](0005-observer-independence.md), [0008](0008-data-classification-and-audience-projections.md)).

v0.1 has no storefront: players, accounts and payments are out of scope (plan §L).

## Decision

We will keep the backend and both interfaces in this single repository. Boundaries between them are
enforced in code, not by repository walls:

- separate apps, bundles and listeners for the public and admin planes (0009);
- package dependency rules and import-boundary checks (plan §E.2; Biome rules from T2; the public
  `dist/` scan in T8);
- one CI run that checks every package against the same lockfile.

We will revisit this decision when one of these holds: separate teams need independent release
cadences; a part of the code needs a different license or must stay private; a commercial
storefront becomes a separate product; or CI time stays above 10 minutes even with per-path jobs.

## Consequences

- A change to a protocol DTO, its server projection and the interface that renders it lands in one
  pull request, reviewed and tested together; DTOs never drift between repositories.
- One toolchain, one lockfile, one CI workflow and one license (AGPL-3.0) to maintain.
- Every contributor clones the whole project, and CI checks every package on each change; at the
  size of v0.1 this costs seconds.
- Security does not depend on repository separation: the repository is public, so the admin plane
  stays protected by authentication, authorization and separate listeners (0009), never by hiding
  its code.

## Alternatives considered

- **Two repositories, backend and frontend.** Rejected: `packages/protocol` would have to be
  published and versioned, every DTO change would need coordinated pull requests in both
  repositories, contracts could drift, and tooling and CI would be duplicated. It adds no security,
  because both repositories would be public under the AGPL.
- **A private repository for the admin interface.** Rejected: it would rely on secrecy instead of
  authentication and authorization, and it would split the open project the vision describes.
- **Git submodules or subtrees.** Rejected: they add synchronization steps without solving the
  versioning problem of a shared protocol.

## References

- Plan: §E.2, §E.6, §G, §L, §M.
- Tracker `docs/roadmap/v0.1-tracker.md`: L14.
