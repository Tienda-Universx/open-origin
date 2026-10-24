# 0007. Persistence: atomic tick batches, checkpoints, idempotency, and recovery targets

- Status: Accepted
- Date: 2026-10-24

## Context

In v0.1 "persistent" means the world survives restarts; Codespaces cannot host a 24/7 world
(plan §B). Recovery must be exact for what was committed, must never continue from a divergent
state, and must not promise to recover data that was only in memory. Writing one row per entity
and tick does not scale; two processes writing the same world would corrupt it (plan §E.5).

## Decision

We will persist the world in PostgreSQL (Docker in development) with atomic tick batches,
checkpoints written in the same transaction, idempotent commands, and a single writer (plan §I.2).

- **Tick batch.** Every F ticks, one Postgres transaction writes the applied commands, the produced
  events, one `tick_batches(world, from_tick, to_tick, checksums[])` row, and the update of
  `world_head.last_tick`. All or nothing.
- **Checkpoint.** Every K ticks, the snapshot of tick K is written **in the same transaction** as
  the batch that ends at K, so a checkpoint can never be ahead of the logs.
- **Order.** External inputs get `(applyTick, seq)` on arrival; the engine applies in that order and
  produces deterministic `(tick, seq)` events; batches are written in increasing tick order.
- **Idempotency.** Each command carries an `idempotency_key`: deterministic for AI decisions
  (hash(world, inhabitant, trigger tick, type)), a session nonce for future clients.
  `UNIQUE(world_id, idempotency_key)` + `INSERT … ON CONFLICT DO NOTHING`. The snapshot keeps a
  bounded set of recent keys. Events use PK `(world_id, tick, seq)`; a rewrite conflict with
  different content raises a divergence alarm.
- **Single writer.** A Postgres advisory lock per `world_id` (plan §I.1.7).
- **Recovery.** (1) Read `world_head`: last committed tick L and last checkpoint C ≤ L. (2) Load
  snapshot C and verify its SHA-256. (3) Replay C+1..L from persisted commands, comparing each
  checksum with `tick_batches`. (4) If everything matches, resume at L+1. (5) On any mismatch,
  **stop the world**, try the previous checkpoint, and if it persists require manual intervention.
- **Crashes pause the world:** time is ticks (O-3).

Measurable v0.1 targets (one node, local Docker):

| Situation | Target | Measured by |
|---|---|---|
| Abrupt crash (`kill -9`) | **RPO ≤ 5 ticks** (≤ 1 s real, ≈ 1 simulated minute) | Crash test at a random tick |
| Orderly shutdown (SIGTERM) | **RPO = 0** (flush + checkpoint) | Shutdown test |
| Recovery | **RTO ≤ 10 s** with ≤ 300 ticks of replay [E] | Timed in the test |
| Divergence | 0 silent continuations | Test with a tampered checksum |

**Declared limits (not promised).** Whatever was only in memory at the crash is lost: uncommitted
ticks, LLM responses received but not written, and in-flight requests (not resent automatically).
Durability depends on Postgres defaults `fsync=on` and `synchronous_commit=on`. Loss of the
Codespace disk or the Docker volume has **no protection in v0.1**; backups (dump/PITR/R2) are
required before any public world.

**Adopted defaults (2026-10-24), configurable.** The plan marked these parameters [D] (§I.2.1,
§I.2.7, O-12); they are now defaults adopted under the maintainer's delegation of technical
decisions ([tracker](../roadmap/v0.1-tracker.md) L11, L12), revisited with measurements in T7
(plan §M).

| Parameter | Adopted default |
|---|---|
| Batch size F | 5 ticks (≈ 1 s real) |
| Checkpoint interval K | 300 ticks (1 simulated hour) |
| Snapshot retention | Last 10, plus 1 per hour for 7 days |

## Consequences

- Plan §N criteria 7 and 8 verify the targets and the stop on divergence; T7 builds it.
- Estimated storage is ≈ 0.4 GB/month with continuous use [E] (plan §I.2.7).
- Drizzle's `bun-sql` driver has open bugs with jsonb and timestamps; T7 tests those columns first,
  with `postgres-js` as the fallback driver (plan §D).
- Backups, PITR, and multi-region are future requirements (plan §L).

## Alternatives considered

- One database row update per entity and tick: compromises scalability; replaced by per-tick
  batches plus checkpoints (plan §E.5).
- Two processes writing the same world: replaced by a Postgres advisory lock per world (plan §E.5,
  §I.1.7).
- Larger batches (F ≥ 25, RPO ≈ 5 s): needed only to fit the Durable Objects free row limit; not
  adopted while the world runs on Bun + Postgres (plan §J.3,
  [0013](0013-defer-hosting-v0-1-runs-locally.md)).
- The `postgres-js` driver: kept as the fallback if the `bun-sql` driver's open jsonb and timestamp
  bugs affect T7 (plan §D).

## References

- Plan: §B, §D, §E.5, §I.1.7, §I.2, §J.3, §L, §M, O-2, O-3, O-12, §N.
- Tracker `docs/roadmap/v0.1-tracker.md`: L11, L12.
- [0003. Authoritative deterministic engine](0003-authoritative-deterministic-engine.md).
