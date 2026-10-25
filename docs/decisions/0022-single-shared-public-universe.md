# 0022. A single public universe, shared and synchronized in real time

- Status: Accepted
- Date: 2026-10-25

## Context

On 2026-10-25 the maintainer set a permanent decision ([tracker](../roadmap/v0.1-tracker.md) S17,
L37): the public universe is single, shared, and synchronized in real time.

- Everyone shares one state and one clock.
- No user can speed it up, pause it, rewind it, or change its speed.
- The speed is fixed and managed by the server alone.
- Everyone sees the same public events, with normal network latency.
- Cameras and visual preferences never modify the simulation.
- Historical replays may come later, without affecting the active universe.
- Private simulations may have their own time controls.

Most of this was already implied:

- Vision §5 asks for a global simulation clock and synchronization between players. It separates
  server time from simulation time, and asks that payments never create discontinuities in shared
  time.
- Plan §I.3 sends every client snapshots, deltas, and events that carry their tick; clients apply
  them in order and interpolate.
- Crashes pause the world, because time is ticks (plan O-3,
  [0007](0007-persistence-atomic-tick-batches-and-recovery.md)).
- Presentation may differ per client but never writes to the world (P9,
  [0005](0005-observer-independence.md)).
- The engine advances only through `step` ([0003](0003-authoritative-deterministic-engine.md)).
  `simSecondsPerTick` is world configuration inside the hashed state, and `TICK_RATE_HZ`, which paces
  ticks in real time, belongs to the scheduler of T6 ([0020](0020-deterministic-core-design.md)).

Three things were missing: an explicit rule that no client controls time, how a public event reaches
viewers of other regions, and where replays and private simulations live.

Existing documents also need to be reconciled:

- The admin plane can pause the world ([0009](0009-public-and-private-admin-interfaces.md)), and
  the local admin panel offers simulation controls (plan §L).
- [0021](0021-procedural-world.md) fixes `simSecondsPerTick` for the life of a world.
- Plan §E.5 and [0008](0008-data-classification-and-audience-projections.md) reject broadcasting
  everything to everyone.
- An abrupt crash may lose up to 5 ticks that were never made durable
  ([0007](0007-persistence-atomic-tick-batches-and-recovery.md)), and the public may already have
  seen them.

## Decision

We will run the public universe as one authoritative world with one clock.

**One world, one state, one clock.** Every player and spectator observes the same world instance,
through projections. Its time is the tick, and only the server's scheduler advances it. Clients show
the server's tick and simulated time; they never compute or adjust a clock of their own.

**Fixed speed, managed by the server.** Two settings set the public universe's speed, and neither is
a runtime control.

- `simSecondsPerTick` is fixed for the life of the world
  ([0020](0020-deterministic-core-design.md), [0021](0021-procedural-world.md)).
- `TICK_RATE_HZ` is configuration of the server's scheduler. Changing it is a configuration change
  that opens a new epoch ([0009](0009-public-and-private-admin-interfaces.md)), never a runtime
  control.

No player, spectator, or client can speed the universe up, slow it down, pause it, step it, or
rewind it. The public protocol has no message that could, and a test of the allowlist of client
messages rejects any.

The scheduler keeps the fixed rate whenever it can. Under overload, the universe runs slower for
everyone alike, never for one client, and the scheduler records the shortfall.

**Stops are server-side events, for everyone.** The universe stops only through an event on the
server side: a crash, maintenance, or an audited operator pause
([0009](0009-public-and-private-admin-interfaces.md), plan O-3,
[0007](0007-persistence-atomic-tick-batches-and-recovery.md)). It stops for everyone at once and
resumes at the same tick. An operator pause goes through the authenticated admin plane and lands in
its audit log; no user has one.

The local admin panel's simulation controls (plan §L) are, for the public universe, this pause and
resume plus configuration changes that open an epoch. Changing speed, stepping, and seeking exist
only for private simulations.

**Crash recovery never retracts what the public saw.** This is an adopted technical default, under
the maintainer's delegation of technical decisions (tracker L11, L12). Recovery resumes from the last
durable tick ([0007](0007-persistence-atomic-tick-batches-and-recovery.md)), so the public plane
publishes a tick only once its batch is durable. A crash then delays the public view; it never
rewinds it.

The limits ADR 0007 declares still hold:

- a divergence stops the world for manual intervention;
- the loss of the storage volume has no protection in v0.1.

The cost is that the public view trails the simulation by up to one batch of F ticks, plus the
commit's own latency.

**The same public events for everyone.** The public feed of happenings (plan §L, C0 in
[0008](0008-data-classification-and-audience-projections.md)) reaches every connected client,
whatever region it watches. Everything tied to a place follows chunk subscriptions, as plan §E.5
asks: snapshots, deltas, positions, visible actions, and local speech. T6 decides which happenings
enter the feed, together with the projections. Clients differ only by network latency and their own
presentation, and every message carries its tick (plan §I.3).

**Cameras and preferences are presentation.** Camera, zoom, the followed being, layers,
interpolation, level of detail, and send rate belong to the presentation plane (P9,
[0005](0005-observer-independence.md)). They never become commands, nor inputs to the engine, the
minds, or the cognitive allocator.

**Historical replays, later and apart.** A replay is built from snapshots and the command log, as a
separate world instance or as a recorded stream of projections. It runs apart from the active
universe and never writes to it.

- Its controls (pause, speed, seek) belong to the replay alone.
- It never reaches past the last tick the active universe published, so nobody sees ahead.
- It shows only what the viewer's class allows.

**Private simulations, with their own clocks.** A private simulation, such as a research world or a
control world, is a separate world with its own world id, seed, and scheduler. It may offer time
controls to those authorized, and nothing in it reaches the public universe. Nested simulations
(vision §22) are outside this decision and need their own.

What each batch takes from this:

| Batch | What it builds |
|---|---|
| T6 | A scheduler at the fixed rate that records shortfalls. An allowlist of public client messages with no time control, and its rejection test. The public feed of happenings for every client. The observer-invariance test of [0005](0005-observer-independence.md), with clients that change camera, followed being, and subscriptions at random |
| T7 | Durable tick batches before publication, with the delay measured |
| T8 | No time controls in `apps/web`, which shows the server's clock and keeps cameras and preferences local. In `apps/admin`, for the public universe, an audited pause and resume and epoch-opening configuration; changing speed, stepping, and seeking only for private simulations |

## Consequences

- The engine is unaffected, because it already advances only through `step`. T3 changes nothing.
- One history for everyone keeps the universe fair: no client and no replay can see ahead.
- The public view trails the simulation by up to one durable batch. That is F ticks plus the commit
  latency: about 1 s at the default rates of [0007](0007-persistence-atomic-tick-batches-and-recovery.md),
  but about 5 s on a host that needs F ≥ 25, such as Durable Objects
  ([0013](0013-defer-hosting-v0-1-runs-locally.md)). T7 measures it.
- Under overload everyone sees the universe slow down together, and the shortfall is visible to
  operators instead of hidden.
- An operator pause stops every viewer at once and is recorded.
- Replays and private simulations need their own world instances, at their own cost.
- In v0.1 the public plane runs locally ([0013](0013-defer-hosting-v0-1-runs-locally.md)), and these
  rules already apply to it. A public deployment keeps them, and only the publication delay depends
  on its host.
- Revisit:
  - in T6: the scheduler, the protocol, and which happenings the feed carries;
  - in T7: publication after durability;
  - in T8: the interfaces;
  - when players arrive: client-side prediction;
  - when the first replay, private simulation, or nested simulation is built.

## Alternatives considered

- **Time controls per user on the public universe.** Rejected: there would be no shared history,
  players could not interact in one present, and a viewer could see ahead of everyone else.
- **Client-side prediction of world state, for the read-only clients of v0.1.** Rejected: a client
  would show states the server never produced. Clients interpolate between ticks they received
  (plan §I.3). Players acting in the world may need prediction of their own actions; that is
  revisited when they arrive.
- **Publishing ticks before they are durable.** Rejected: a crash would rewind what the public saw.
- **Pausing the universe while nobody watches.** Rejected: the universe must not depend on its
  watchers (vision §5, P9).
- **Replays inside the active world, by rewinding and simulating again.** Rejected: they would
  change the active universe.

## References

- Tracker `docs/roadmap/v0.1-tracker.md`: S17, L37, L11, L12.
- Vision `docs/vision/master-vision.es.md`: §5, §22.
- Plan `docs/roadmap/v0.1-plan.es.md`: §E.4, §E.5, §E.6, §I.1.1, §I.3, §K.6, §L, O-3, O-10.
- [0003](0003-authoritative-deterministic-engine.md), [0005](0005-observer-independence.md),
  [0007](0007-persistence-atomic-tick-batches-and-recovery.md),
  [0008](0008-data-classification-and-audience-projections.md),
  [0009](0009-public-and-private-admin-interfaces.md),
  [0013](0013-defer-hosting-v0-1-runs-locally.md), [0020](0020-deterministic-core-design.md),
  [0021](0021-procedural-world.md).
