# 0022. A single public universe, shared and synchronized in real time

- Status: Accepted
- Date: 2026-10-25

## Context

The maintainer set a permanent decision on 2026-10-25 ([tracker](../roadmap/v0.1-tracker.md) S17,
L37): the public universe is single, shared, and synchronized in real time. Everyone shares one
state and one clock. No user can speed it up, pause it, rewind it, or change its speed. The speed
is fixed and managed by the server alone. Everyone sees the same public events, with normal network
latency. Cameras and visual preferences never modify the simulation. Historical replays may come
later without affecting the active universe, and private simulations may have their own time
controls.

Most of this was already implied:

- Vision §5 asks for a global simulation clock and synchronization between players. It separates
  server time from simulation time and asks that payments never create discontinuities in shared
  time.
- Plan §I.3 sends every client snapshots, deltas, and events that carry their tick, which clients
  apply in order and interpolate.
- Crashes pause the world, because time is ticks (plan O-3,
  [0007](0007-persistence-atomic-tick-batches-and-recovery.md)).
- Presentation may differ per client but never writes to the world (P9,
  [0005](0005-observer-independence.md)).
- The engine advances only through `step` ([0003](0003-authoritative-deterministic-engine.md),
  [0020](0020-deterministic-core-design.md)), and pacing ticks in real time belongs to the scheduler
  of T6 ([0021](0021-procedural-world.md)).

Three things were missing: an explicit rule that no client controls time, how a public event reaches
viewers of other regions, and where replays and private simulations live. Two existing rules also
need precision. Operators can pause through the admin plane
([0009](0009-public-and-private-admin-interfaces.md)). And an abrupt crash may lose up to 5 ticks
that were never made durable ([0007](0007-persistence-atomic-tick-batches-and-recovery.md)), ticks
the public may already have seen.

## Decision

We will run the public universe as one authoritative world with one clock.

**One world, one state, one clock.** Every player and spectator observes the same world instance,
through projections. Its time is the tick, and only the server's scheduler advances it. Clients show
the server's tick and simulated time; they never compute or adjust a clock of their own.

**Fixed speed, managed by the server.** The public universe's tick rate (`TICK_RATE_HZ`) and
`simSecondsPerTick` are server configuration, not runtime controls. No player, spectator, or client
can speed it up, slow it down, pause it, step it, or rewind it. The public protocol has no message
that could, and a test of the allowlist of client messages rejects any. The scheduler keeps the
fixed rate whenever it can. Under overload, the universe runs slower for everyone alike, never for
one client, and the scheduler records the shortfall.

**Operators act on the server, for everyone.** The universe stops only when the server stops: a
crash or maintenance (plan O-3, [0007](0007-persistence-atomic-tick-batches-and-recovery.md)). It
stops for everyone at once and resumes at the same tick. An operator pause goes through the
authenticated, audited admin plane ([0009](0009-public-and-private-admin-interfaces.md)), and no
user has one. Changing the public universe's rate is a configuration change that opens a new epoch
([0009](0009-public-and-private-admin-interfaces.md)), never a runtime control.

**What the public saw is never retracted.** Recovery resumes from the last durable tick
([0007](0007-persistence-atomic-tick-batches-and-recovery.md)). So the public plane publishes a tick
only once its batch is durable: a crash may delay the public view, but never rewinds it.

**The same public events for everyone.** Public happenings (C0,
[0008](0008-data-classification-and-audience-projections.md)) reach every connected client, whatever
region it watches. Detail about a region (snapshots, deltas, positions, visible actions) follows its
chunk subscriptions. Clients differ only by network latency and their own presentation, and every
message carries its tick (plan §I.3).

**Cameras and preferences are presentation.** Camera, zoom, the followed being, layers,
interpolation, level of detail, and send rate belong to the presentation plane (P9,
[0005](0005-observer-independence.md)). They never become commands, nor inputs to the engine, the
minds, or the cognitive allocator.

**Historical replays, later and apart.** A replay is built from snapshots and the command log as a
separate world instance or a recorded stream of projections. It runs apart from the active universe
and never writes to it. Its controls (pause, speed, seek) belong to the replay alone, and it shows
only what the viewer's class allows.

**Private simulations, with their own clocks.** A private simulation (a research world, a control
world, or a nested simulation) is a separate world with its own world id, seed, and scheduler. It
may offer time controls to those authorized, and nothing in it reaches the public universe.

What each batch takes from this:

| Batch | What it builds |
|---|---|
| T6 | A scheduler at the fixed rate that records shortfalls. An allowlist of public client messages with no time control, and its rejection test. A channel of public events for every client. The observer-invariance test of [0005](0005-observer-independence.md), with clients that change camera, followed being, and subscriptions at random |
| T7 | Durable tick batches before publication, with the delay measured |
| T8 | No time controls in `apps/web`, which shows the server's clock and keeps cameras and preferences local. Operator actions in `apps/admin` are audited server operations; time controls appear only for private simulations |

## Consequences

- The engine is unaffected: it already advances only through `step`, so T3 changes nothing.
- One history for everyone keeps the universe fair: no client can see ahead by speeding up.
- The public view trails the simulation by at most one durable batch, F ticks (about 1 s at the
  default rates of [0007](0007-persistence-atomic-tick-batches-and-recovery.md)). T6 and T7 measure
  it.
- Under overload everyone sees the universe slow down together, and the shortfall is visible to
  operators rather than hidden.
- An operator pause stops every viewer at once and is recorded.
- Replays and private simulations need their own world instances, at their own cost.
- In v0.1 the public plane runs locally ([0013](0013-defer-hosting-v0-1-runs-locally.md)). These
  rules still apply to it, so the first public deployment changes nothing about time.
- Revisit:
  - in T6: the scheduler, the protocol, and the channel of public events;
  - in T7: publication after durability;
  - in T8: the interfaces;
  - when the first replay or private simulation is built.

## Alternatives considered

- **Time controls per user on the public universe.** Rejected: there would be no shared history,
  players could not interact in one present, and a viewer could see ahead of everyone else.
- **Client-side prediction of world state.** Rejected for the public plane: a client would show
  states the server never produced. Clients interpolate between ticks they received (plan §I.3).
- **Publishing ticks before they are durable.** Rejected: a crash would rewind what the public saw.
- **Pausing the universe while nobody watches.** Rejected: the universe must not depend on its
  watchers (vision §5, P9).
- **Replays inside the active world, by rewinding and simulating again.** Rejected: they would
  change the active universe.

## References

- Tracker `docs/roadmap/v0.1-tracker.md`: S17, L37.
- Vision `docs/vision/master-vision.es.md`: §5.
- Plan `docs/roadmap/v0.1-plan.es.md`: §E.4, §E.6, §I.1.1, §I.3, §K.6, O-3, O-10.
- [0003](0003-authoritative-deterministic-engine.md), [0005](0005-observer-independence.md),
  [0007](0007-persistence-atomic-tick-batches-and-recovery.md),
  [0008](0008-data-classification-and-audience-projections.md),
  [0009](0009-public-and-private-admin-interfaces.md),
  [0013](0013-defer-hosting-v0-1-runs-locally.md), [0020](0020-deterministic-core-design.md),
  [0021](0021-procedural-world.md).
