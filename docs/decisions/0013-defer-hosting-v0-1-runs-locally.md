# 0013. Hosting deferred; v0.1 runs locally only

- Status: Accepted
- Date: 2026-10-24

## Context

A 24/7 world needs an always-on host, and no zero cost is guaranteed (plan §C.2, tension 6).
Codespaces cannot host a 24/7 world, so in v0.1 "persistent" means the world survives restarts
(plan §B). The maintainer asked to compare the execution and persistence limits of Cloudflare
Workers, Durable Objects, and a traditional Bun server, without activating infrastructure. Plan
§J.3 made that comparison with sources verified on 2026-10-24.

| Aspect | Workers | Durable Objects (SQLite) | Bun + Postgres |
|---|---|---|---|
| In-memory state | No guarantees; evictable isolates | Lost on hibernation (10 s idle), eviction (70–140 s), **every deploy**, or an error | Lasts as long as the process |
| Persistence | None of its own | SQLite with atomic grouped writes, PITR 30 days, row ≤ 2 MB | ACID across tables, durable at commit |
| 5 Hz ticks | Cron only | `setInterval` prevents hibernation ⇒ continuous billed duration | Own loop |
| Runtime | V8 | V8 | JavaScriptCore |

Durable Objects estimates [E]: a world object ticking at 5 Hz never hibernates (10,800 GB-s/day,
inside the 13,000 free for ~1 object); F = 5 exceeds the free 100,000 rows/day if a batch writes
more than one row, so F ≥ 25 (RPO ≈ 5 s) or a paid plan would be needed; every deploy restarts the
world.

## Decision

We will defer the choice of host (O-1). v0.1 runs locally only: Bun + Postgres in Docker, nothing
activated, nothing deployed. The frontend compiles to static files but is not deployed (plan §L).

Conclusions recorded from plan §J.3:
- **Bun + Postgres is the reference** for the engine: zero adaptation and no platform limits.
- **Durable Objects is viable** for a small world, with adjustments: larger batches, snapshots per
  chunk, recovery on every deploy, and a V8 test.
- **Workers** fits a public API, static files, or a proxy, not the engine.
- **Containers** (GA, paid only, `sleepAfter` of 10 min by default, ephemeral disk) is not
  recommended for the engine.
- For the frontend, the existing Pages project would be reused when authorized; its v3 build
  image ships Bun 1.2.15, so `BUN_VERSION=1.4.4` must be set or the build done in Actions.

## Consequences

- No host to pay for in v0.1. Even so, v0.1 costs US$0 only while Codespaces usage stays within
  the quota or a budget blocks the excess (plan §J.1).
- The world stops when the Codespace stops; a stopped Codespace is deleted after 30 days, with its
  Docker volume and world data (plan §I.2.6, §J.1).
- Moving to Durable Objects would make the cross-runtime test (V8 vs. JavaScriptCore) mandatory.

**Open question for a future ADR:** which host runs the 24/7 world, and at what cost. That ADR must
revalidate the sources before deciding (plan §L), require configured spend budgets (O-22), and
require backups before any public world (plan §I.2.6).

## References

- Plan: §B, §C.2, §I.2.6, §J.1, §J.2, §J.3, §L, O-1, O-22.
- [0007. Persistence](0007-persistence-atomic-tick-batches-and-recovery.md).
