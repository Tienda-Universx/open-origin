# 0025. A real-time world host: fixed-rate scheduler, publication gate, and the observer boundary

- Status: Accepted
- Date: 2026-11-02

## Context

T6 builds the server (plan §M): "Host Bun, ticks, protocolo por audiencia, interés por chunk, frontera
P9", with the key tests "Invariancia del observador; lista permitida de DTOs". The maintainer's request
is in the [tracker](../roadmap/v0.1-tracker.md) as S20 and L66, and its approval and corrections are in
L67. The world must stop being an engine that only runs inside tests. It becomes one authoritative
universe that many spectators watch at once, with their presence changing nothing.

What binds this decision:

- **[0022](0022-single-shared-public-universe.md)** asks T6 for four things:
  - a scheduler at a fixed rate that records shortfalls;
  - a public client protocol with no time control;
  - a feed for every client;
  - the invariance test of [0005](0005-observer-independence.md), with cameras, followed beings, and
    subscriptions that change at random.

  It also forbids publishing a tick a restart could lose.
- **[0007](0007-persistence-atomic-tick-batches-and-recovery.md)** sets batches of F = 5 ticks,
  checkpoints every K = 300 ticks, increasing order, and a single writer. Postgres arrives in T7.
- **[0009](0009-public-and-private-admin-interfaces.md)** gives the admin listener, its token, and
  its audit to T8.
- **[0020](0020-deterministic-core-design.md)** makes every read the host does a detached copy.
- **[0024](0024-mind-memory-beliefs-and-speech.md)** gives T6 the host's handling of a promise a
  brain leaves rejected.

What the code and Bun 1.4.4 show:

- **The brain runs inside `step`.** The ruleset captures the brains, and `step(world, commands)` calls
  them synchronously. A host only steps and reads.
- **Beings arrive by admin commands.** Every initial being is spawned by a `beings.spawn` command at
  tick 1.
- **Checksums are C3.** A tick's checksum, the state root, and the engine snapshot contain the seed
  ([data classification](../architecture/data-classification.md)).
- **Terrain is not stored.** It is generated from a C3 seed, at about 0.5 ms per chunk.
- **Publishing to a topic hides who lagged.** Bun's `server.publish` reports backpressure or a drop if
  it happened for *any* subscriber, without saying which.

Expected from Codespaces' documentation, and left unmeasured in T6-7, which had no access to the
forwarded URL from outside the machine: Codespaces forwards the ports that listen on localhost, and
forwarded connections are expected to arrive from 127.0.0.1. How its proxy sets `Host` is unmeasured
too ([server](../architecture/server.md#transport)).

## Decision

We will run the public universe in one Bun process, `apps/server`. Its world plane steps the engine at a
fixed rate and makes ticks durable before they are published. Its presentation plane only receives
frozen C0 records, through one channel that runs in one direction.

### Packages

```
engine      → (nothing)
agents      → engine
protocol    → zod                       per-audience DTOs, usable in a browser (T8)
scenarios   → engine, agents            preregistered world recipes (Bun-specific)
apps/server → engine, agents, protocol, scenarios
```

`packages/scenarios` receives the recipes of T4 and T5, which today live in the agents test support, so
the server can run the studied default world without importing test code. It holds a copy of `Sfc32`,
checked by a parity test. The engine keeps its own copy, so engine tests never depend on scenarios. The
old support files become re-exports.

### Planes and the boundary

`apps/server/src` is split by plane:

| Folder | Plane | What it holds |
|---|---|---|
| `world/` | World | Scheduler, world host, world sources, journal, publication gate, and `published.ts`, the types of what is published |
| `projection/` | World | Pure C0 projections of detached reads |
| `presentation/` | Presentation | Playout, mirror, interest, transactions, sessions, fan-out, terrain queue, feed, observation telemetry |
| `transport/` | Presentation | The `Bun.serve` adapter |
| `adapters/` | — | Real clock and timer |
| `compose.ts`, `main.ts` | — | Wiring and process entry |

The boundary is checked on the transitive import graph, by `tests/repo/server-boundaries.ts`, which has
negative tests of its own:

1. From outside `presentation/` and `transport/`, only `compose.ts` and `main.ts` import them.
2. `presentation/` and `transport/` import only `@open-origin/protocol/*`, each other, and, as a type
   only, `world/published.ts`. They cannot reach the engine, the agents, the host, or a source.
3. `world/` and `projection/` import no `bun` and name no WebSocket.
4. `config/` is imported only by `compose.ts` and `main.ts`. The planes receive their settings as
   parameters.

`tools/` and `bench/` sit outside `src/`; the terminal probe imports only the public protocol.

Rule 1 realizes control 2 of [0005](0005-observer-independence.md) for the cognitive allocator of T9
anywhere in `apps/server`. T9 extends the scan to the AI gateway's package.

The presentation plane never receives the `World`, the host, or a source. It receives three
functions only:

- `subscribeToPublished(listener)`, which delivers deep-frozen C0 records. Their return value is
  ignored and their exceptions are isolated;
- `readTerrain(chunk)`, a pure closure in `projection/` over the prepared genesis. It returns surface
  observables and never materializes a chunk;
- the world's state (`running`, `paused`, `stalled`, or `halted`), which every client shares, for
  `hello.state` and `status` (T6-6b refined this list, which held the first two).

What enters the world comes only from a `WorldSource`, whose type admits no presentation data:

- in T6, the spawns of tick 1, through `ScenarioSource`, and scripted commands in tests, through
  `ScriptedSource`;
- later, the admin plane and the AI gateway.

Observation telemetry (followers per being, subscriber-ticks per chunk) is C3 and lives in
`presentation/`, where the world cannot import it.

### Time and the scheduler

Real time, simulated time, and ticks are separate:

- real time is `Clock.now()`, monotonic, read only in the adapter;
- simulated time is `tick × simSecondsPerTick`, fixed for the life of the world;
- the engine sees ticks only.

The tick `n` has the deadline `d_n = t0 + n·P`, with `P = 1000 / TICK_RATE_HZ` ms. The scheduler sets a
`setTimeout` for each deadline, never a `setInterval`, runs one tick per callback, and always yields
the event loop. It handles lateness like this:

- **Late by one period or less** (`now − d_n ≤ P`): the schedule holds, and the next tick runs at
  `max(d_{n+1}, now)`. Ticks may then run back to back, but only to recover less than one period.
- **Late by more than a period** (`now − d_n > P`): first `shortfall += ⌊(now − d_n) / P⌋`, from the
  deadline before the rebase; then the schedule is rebased with `t0 ← now − n·P`.
- The tick always advances by exactly 1: there are no bursts, skipped ticks, or jumps. Under overload,
  the world runs slower for everyone alike.
- `lateness`, `shortfallTicks`, `rebases`, and `achievedHz` are recorded as C3 metrics.

Stops are counted apart from shortfall:

| Stop | What it is |
|---|---|
| `journalStall` | The scheduler holds while `E − C > W` (W = 4F = 20 ticks) |
| `paused` | An internal pause, used by tests and by shutdown |
| `halted` | The world stopped on a fault |

Resuming resets `t0`, so a stop never counts as shortfall. Every stop is announced to every client with
a `status` message.

T6 exposes no operator control at run time: the audited operator pause arrives with T8's admin plane.

### Faults

- **Engine error.** When `step` throws `EngineError`, the host first appends the valid ticks it has not
  appended yet (up to `E`, never the faulted tick), then halts. It logs codes only.
- **Unhandled rejection.** With `AI_MODE=off`, an `unhandledRejection` also halts the world. Async work
  in a brain is a wall-clock channel. The decision is a pure function with its own test; the real handler
  is tested in a child process.

### Executed, committed, published

Three monotonic counters, with `E ≥ C ≥ P`:

| Counter | Meaning | Held by |
|---|---|---|
| `E` | Executed | the host |
| `C` | Committed | the journal's acknowledgement |
| `P` | Published | the gate |

The gate publishes exactly `(P, C]`, in order. At boot `P = C = E = L`, and the mirror is built from a
full projection, so a recovery source of T7 fits without change.

The `TickJournal` port is
`append(batch: {fromTick, toTick, records[{tick, checksum, commands, events}], checkpoint?})` returning
`Promise<void>`, with `level: "none" | "durable"`:

- `events` is complete, including the C3 provenance ledger T7 will persist;
- one append is in flight at a time, in increasing tick order, and the gate asserts it;
- partial batches are allowed, to flush on SIGTERM (RPO 0) and before a halt;
- the checkpoint already runs in T6: at every K-th tick the host encodes the snapshot, and the
  ephemeral journal discards it. T7 does not have to change the loop;
- a journal failure halts the world, and nothing uncommitted is published.

### Ephemeral mode

T6 has no durable journal. Its `EphemeralJournal` acknowledges in a microtask and declares
`level: "none"`. The server:

- refuses to start unless `OPEN_ORIGIN_DURABILITY=ephemeral` is set, with "no durable journal is
  available until T7";
- refuses a host other than loopback;
- announces `durability: "ephemeral"` to every client;
- warns at start when `CODESPACES=true` that the forwarded port must stay private;
- starts a new world, with a new random `world.id`, at every boot.

This refines [0022](0022-single-shared-public-universe.md) for this development mode. Its guarantee
("never publish what a restart can lose") holds trivially: a restart is a new, announced world, never
a rewind of the same one. A public universe needs T7's durable journal.

### Playout

The gate releases up to F ticks at a time. A playout queue in the presentation plane hands at most
**one** published tick to the mirror per period. When the queue holds more than F, it releases the
newest tick, after the mirror has applied every tick before it in order; the rings of speech and feed
keep every tick. Fan-out runs in its own macrotask, never inside the step's callback, with a budget of
40 ms per period: clients that do not fit move to the next period, in rotating order.

A client that is up to date therefore receives one `commit` per period, about F periods behind
publication, with no bursts. A client whose transaction spans several periods sees fewer, larger steps
([0026](0026-public-protocol-v1.md)).

The delay from execution to playout is at most 2F ticks plus the acknowledgement. This refines
[0022](0022-single-shared-public-universe.md), which bounds the public lag at one batch of F ticks
plus the commit. The playout adds up to F periods, and a client's own multi-period transaction adds
its duration.

### Configuration

Configuration comes from the environment. It is parsed with zod at start and deep-frozen:

- `OPEN_ORIGIN_DURABILITY`;
- `OPEN_ORIGIN_HOST`, `127.0.0.1` by default, and `OPEN_ORIGIN_PORT`;
- `TICK_RATE_HZ`, 5 by default;
- `PUBLICATION_BATCH_TICKS`, F = 5 by default;
- `PUBLIC_ORIGINS` and the allowed hosts;
- the connection caps;
- `AI_MODE`: `off` by default, and any other value refuses to start until T9.

`TICK_RATE_HZ` is fixed at start; T7 records an epoch when it changes. Logs are JSON lines with no
payloads and no IP addresses, which are C2.

### Verification

The invariance test runs the same `compose()` that production runs, with a fake clock. A reference run
with 0 observers is compared with runs with 1 and 32 observers in CI, and with 300 in the bench. The
observers:

- change camera and followed being at random;
- all follow the same being;
- churn their subscriptions;
- drain slowly;
- disconnect.

For **every tick**, these must be equal across the runs:

- the fake-clock time it ran at;
- the full command list, rejected commands included;
- the checksum;
- the bytes of its C0 `PublishedTick`.

At the end, the snapshot bytes must be equal. A WebSocket variant with 10 real clients runs too. The
checksums are read in process, never through the protocol.

This refines control 1 of [0005](0005-observer-independence.md), which compares hashes at every tick.
A hash cannot see an extra tick or a rejected command, so the test also compares the timeline and the
commands.

Three permanent negative controls must make this test fail at their exact tick:

| Control | Leak |
|---|---|
| NC1 | A source that adds an admin command when a being is followed, even one the engine rejects |
| NC2 | A brain wrapper that reads an "observed" flag the presentation sets |
| NC3 | A scheduler that runs one extra tick per `subscribe` |

A planted forbidden import must also fail the boundary scan.

## Consequences

- Observing cannot change the world through the code: the presentation plane cannot import the engine,
  and nothing it holds reaches a step. The invariance test and its negative controls check the
  behavior.
- Spectators can slow the world only as any load does, for everyone alike, and the shortfall is
  recorded. The presentation work runs outside the step and within budgets per period.
- T7 replaces the journal (`PostgresJournal`) and the source (`RecoverySource`), and adds the lock per
  world and epochs. The scheduler, the gate, projections, presentation, and transport stay as they are.
- In T6 the server is a local development server. It is not a public universe, and says so on every
  connection.
- The view trails execution by about 2F ticks, plus the duration of a client's own multi-period
  transaction.
- A constraint passes to T9: an AI result must apply at a deterministic tick (trigger + k), and
  whether it is accepted must never depend on wall-clock time that spectator load affects. T9 chooses
  between waiting for due results and moving presentation to a Worker.
- Revisit:
  - when the server tick's p99 passes half a period in a real world: move presentation to a Worker;
  - in T7: the durable journal, recovery, and epochs;
  - in T8: the operator pause and the admin listener.

## Alternatives considered

- **Bun topics (`server.publish`) per chunk.** Rejected: the aggregate status cannot tell which client
  lagged, so the plan's "resync that client" cannot be built on it.
- **Projections in the presentation plane, reading engine state.** Rejected: the presentation plane
  would hold the engine, and the boundary could only be checked by review.
- **Catch-up bursts after lateness.** Rejected: the world would jump in real time, and
  [0022](0022-single-shared-public-universe.md) asks it to run slower for everyone instead.
- **Publishing each tick as soon as it is acknowledged.** Rejected: batches of F would reach clients
  as one-second bursts and slow the step's callback. The playout paces them.
- **A Worker thread for presentation from the start.** Deferred: the default world's step costs well
  under a millisecond. Measure first.
- **The admin listener in T6, as the plan's folder map shows.** Rejected:
  [0009](0009-public-and-private-admin-interfaces.md) gives it to T8. T6 builds only its contracts.
- **Moving `Sfc32` into scenarios.** Rejected: about 40 engine tests import it, and the engine would
  come to depend on a package that depends on the engine.

## References

- Tracker `docs/roadmap/v0.1-tracker.md`: S17, S20, L66, L67.
- Plan `docs/roadmap/v0.1-plan.es.md`: §E.1–§E.6, §I.1.1, §I.2, §I.3, §K.6, §M, §N.
- [0003](0003-authoritative-deterministic-engine.md), [0005](0005-observer-independence.md),
  [0007](0007-persistence-atomic-tick-batches-and-recovery.md),
  [0008](0008-data-classification-and-audience-projections.md),
  [0009](0009-public-and-private-admin-interfaces.md),
  [0013](0013-defer-hosting-v0-1-runs-locally.md), [0019](0019-end-to-end-testing-strategy.md),
  [0020](0020-deterministic-core-design.md), [0022](0022-single-shared-public-universe.md),
  [0024](0024-mind-memory-beliefs-and-speech.md), [0026](0026-public-protocol-v1.md).
