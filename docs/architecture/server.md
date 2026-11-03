# Server: the world plane and the presentation core

`apps/server` runs the public universe in one Bun process. Its world plane steps the engine at a fixed
rate, makes each tick durable before it publishes it, and hands the rest of the server only frozen
published records. Its presentation plane turns those records into each client's view.
[ADR 0025](../decisions/0025-real-time-world-host.md) and
[ADR 0026](../decisions/0026-public-protocol-v1.md) record the design and why; this document
describes what the code implements as of T6-6a: the configuration, the scheduler, the world host
and its sources, the C0 projection, the journal port, the publication gate, the presentation core
(playout, mirror, interest, and transactions), their composition, and the test of observer
invariance. Sessions and the limits that act on clients (T6-6b), the transport, and the entry point
(T6-7) arrive in later batches.

Code: `apps/server/src/` (`@open-origin/server`). Tests: `apps/server/test/` (`config`,
`scheduler`, `fault`, `adapters`, `publication`, `host`, `rejection`, `compose`, `projection`,
`leak`, `presentation-mirror`, `presentation`, `presentation-reconstruction`,
`presentation-sizes`, and `observer-invariance`), and `tests/repo/server-boundaries.test.ts`.

## Layout

| Path | Plane | What it holds |
|---|---|---|
| `src/config/` | — | `parseConfig`: the environment, parsed and deep-frozen |
| `src/world/` | World | `time.ts` (the `Clock` and `Timer` ports), `scheduler.ts`, `samples.ts`, `host.ts`, `source.ts`, `journal.ts`, `publication.ts`, `published.ts`, `rejection.ts`, and `fault.ts` (what a fault leaves to log) |
| `src/projection/` | World | `projection.ts` (`BeingsProjection`), `being.ts`, `events.ts`, `clock.ts`, and `terrain.ts`: the C0 projection of a world of beings |
| `src/presentation/` | Presentation | `presentation.ts` (`Presentation`), `playout.ts`, `mirror.ts`, `version.ts`, `ring.ts`, `interest.ts`, `txn.ts`, `parts.ts`, `frames.ts`, and `terrain.ts`: the presentation core |
| `src/adapters/` | — | `systemClock` (`performance.now()`, in whole microseconds) and `systemTimer` (one `setTimeout` per deadline) |
| `src/compose.ts` | — | `compose(config, deps)`: the wiring of the world plane; `composeServer(config, deps)`: both planes |

The package depends on `@open-origin/engine`, `@open-origin/agents`, `@open-origin/scenarios`,
`@open-origin/protocol`, and zod 4.6.7, pinned exactly.

## Configuration

`parseConfig(env)` is a pure function of an environment record. It returns a deep-frozen `Config`
and the warnings to show at start, or every problem at once: one message per variable at fault,
naming the variable and its rule, never its value.

| Variable | Default | Rule |
|---|---|---|
| `OPEN_ORIGIN_DURABILITY` | none: required | Only `ephemeral`; anything else, or nothing, is refused with "no durable journal is available until T7" |
| `OPEN_ORIGIN_HOST` | `127.0.0.1` | A loopback address, IPv4 `127.0.0.0/8` or `::1`. Names, `localhost` included, are refused: they resolve outside the check |
| `OPEN_ORIGIN_PORT` | `8080` | An integer from 1 to 65535 |
| `TICK_RATE_HZ` | `5` | An integer from 1 to 1000, the bounds of the admin contract's `tickRateHz` |
| `PUBLICATION_BATCH_TICKS` | `5` | F, an integer from 1 to 300, so a batch never spans more than one checkpoint interval |
| `PUBLIC_ORIGINS` | empty | A comma-separated list of exact `http` or `https` origins |
| `ALLOWED_HOSTS` | `localhost:<port>` and `<host>:<port>`, with an IPv6 host in brackets | A non-empty comma-separated list of `Host` header values, each port from 1 to 65535. An empty list, which would let no `Host` header through, is refused; unset, the default applies |
| `MAX_CONNECTIONS` | `1024` | An integer from 1 to 65536 |
| `MAX_CONNECTIONS_PER_IP` | `16`, or `MAX_CONNECTIONS` when that is lower | An integer from 1 to 65536; when set, at most `MAX_CONNECTIONS`, compared only when both are valid, so a cap at fault is reported alone |
| `AI_MODE` | `off` | Only `off`: any other value refuses to start until T9 |

Integers are plain decimal text: no sign, fraction, exponent, or leading zero. With `CODESPACES=true`
the result carries a warning that the forwarded port must stay private.

## Scheduler

`FixedRateScheduler` runs one tick per timer callback, over the injected `Clock` and `Timer` ports;
only `src/adapters/` touches real time. Times are whole microseconds.

- **Deadlines.** The tick `n` has the deadline `d_n = t0 + n·P`, with `P = 1,000,000 / TICK_RATE_HZ`
  microseconds. `t0` is kept as an anchor, a time and the tick due at it, and every deadline is
  `anchorTime + ⌊(n − anchorTick) · 1,000,000 / TICK_RATE_HZ⌋`, so deadlines stay whole and exact for
  rates whose period is not, such as 3 Hz.
- **One tick per callback.** Each deadline gets a one-shot timer. `start` only arms it, and each
  callback runs one tick at most, so the event loop runs between any two ticks. A timer that fires
  before its deadline waits again.
- **Lateness of one period or less** (`now − d_n ≤ P`): the schedule holds, and the next tick runs
  at `max(d_{n+1}, now)`.
- **Lateness of more than a period:** first `shortfallTicks += ⌊(now − d_n) / P⌋`, then the schedule
  is rebased so that `d_n = now`, and `rebases` grows by one. The tick still advances by exactly one.
- **Stops.** Before each tick and after it, the scheduler asks its hold:

  | Stop | When |
  |---|---|
  | `journalStall` | `E − C > W`, with `W = 4F`; the scheduler resumes when an acknowledgement brings the lag back within `W` |
  | `paused` | `pause`, used by tests and by `stop`; `start` resumes |
  | `halted` | The host halted or the journal failed; nothing resumes it |

  Resuming sets the anchor to now, so a stop is never shortfall. A tick that halts the world stops
  the scheduler before another timer is armed; `wake`, called after each journal acknowledgement
  or failure and after an unhandled rejection, stops a world halted between ticks at once. Only
  one timer is ever pending: a tick that pauses and starts the scheduler again leaves one chain.
- **A tick that throws** halts the scheduler, counted as one `halted` stop, with no timer left, and
  its metrics keep what it threw as `fault`: an engine error's code alone, as the host keeps it, or
  another value's message and string `code`.
- **Metrics** (C3): the state, the ticks run, `shortfallTicks`, `rebases`, the count of each stop,
  the p50, p95, and p99 of lateness and of step duration over the last 1,024 ticks, the rate
  achieved over the last 64 tick starts, in millihertz, and the `fault` that halted it, if any.

## World host and sources

A `WorldSource` gives the host a world and, for each tick, the commands to apply at it, as intents
without a tick or an order. Nothing else enters the world.

| Source | World | Commands |
|---|---|---|
| `ScenarioSource` | The preregistered scenario of `@open-origin/scenarios`, `open-origin/t5/default` unless another label is given | Its eight admin spawns at tick 1 |
| `ScriptedSource` | A world a test gives | The script's commands of tick `t`, at index `t − 1` |

`WorldHost.stepOnce` runs the next tick:

1. it stamps the source's commands with `applyTick` = the tick and `seq` from 0;
2. it calls the engine's `step`, and at every K-th tick (K = 300) `encodeSnapshot`;
3. it asks its `Projector` for the tick's published record, read from the world after the step;
4. it hands the gate the tick's record (`tick`, `checksum`, every command it gave, rejected ones
   included, and every event), its published record, and the checkpoint when there is one.

The host reads nothing else and changes nothing in what `step` computes: over the `mind@1` subject
of T5 and its script, projected, it reproduces the frozen trail of the determinism suite
(`edb4c527…`), and over the default scenario every checksum of a direct step loop.

When the source's `commandsAt`, `step`, the snapshot, or the projection throws, the host has the
gate flush the ticks it holds, never the faulted one, and halts. A halt records its code, the first
tick the world did not execute, and, for a fault that is not an engine error, its `cause`:

| Code | Cause |
|---|---|
| An `EngineError`'s | None: its issues can name C3 data, so only the code is kept |
| `unexpected_error` | What the source, `step`, the snapshot, or the projection threw: its message, and its `code` when it carries a string one |
| `journal_failed` | What the journal threw or rejected with, kept the same way |
| `unhandled_rejection` | None |

The first halt keeps its reason. The host records it before the flush, so a halt the flush itself
causes, from a journal that fails at once, does not replace it.

## Projection

`BeingsProjection` is the C0 projection of a world of beings@1 or beings@2
([ADR 0026](../decisions/0026-public-protocol-v1.md#projections-and-classification)). Composition
builds it over the source's world, and it runs once per executed tick in the world plane, whoever
observes. Over a world whose global value holds no genesis, which is not a world of beings, it
throws `the world is not a world of beings: its global value holds no genesis`, so composition
fails with that cause. It reads the world only through `readView`, whose reads are detached
copies, so a projection pass changes neither the state root nor the trail of checksums. Each tick
it publishes `{tick, clock, chunks, speech, feed}`, frozen at every level, and only C0:

| Member | What it holds |
|---|---|
| `clock` | `{tick, day, dayPermille}` from worldgen's calendar over the world's genesis: the day, and ⌊1000 · second of the day / day length⌋. The seconds of a tick and the day's length stay in the world plane |
| `chunks` | `{at, v, upsert, gone}` for each chunk whose C0 content changed: `v` is the tick, `upsert` the records whose bytes changed or that entered it, by id, and `gone` the ids that left it |
| `speech` | `{at, speech: {tick, speaker, to, act, text}}` for every `speech.uttered`, in the speaker's chunk, with the text of speech@1's `renderAct` |
| `feed` | `arrival` for every `being.spawned`, `death` for every `being.died`, and `greeting` for every `greet` act, each with its tick and chunk and no text |

- **Records.** `BEING_PUBLIC_SOURCES` maps each field of `BeingPublic` to the member of
  `BEING_CLASSES` it reads: `id`, `species`, `stage`, `born`, `cell`, the activity's `kind`, a
  talk's `to` and `act`, and `dir`, the direction of a walk's current step, the digit of `dirs` at
  `done`. A record is built field by field and encoded as JSON in the schema's order.
- **Versions.** The projection keeps the encoded record it last emitted for each being, by chunk.
  For each chunk the step changed it encodes the records of its beings again and emits only those
  whose bytes differ, and the ids that left, so engine dirtiness that changes nothing public, a
  being's needs or mind, emits nothing. A chunk with no such change is left out. Its work per tick
  grows with the beings of the changed chunks, and its memory with the beings of the world; boot
  reads every chunk once.
- **Boot record.** `boot()` returns the full projection of the tick the world booted at, frozen:
  every chunk that holds a being, with all its records at version `v` = that tick, the clock of
  that tick, and no speech or feed. It is built once, from the same pass that boot already makes,
  so the presentation's mirror can start from the whole world.
- **Checks.** Every record that goes out, and every record boot holds, is checked by the protocol's
  strict `BeingPublic`; one that fails throws, naming the being and the fields, never their values,
  and the host halts. That is the fail-safe of a walk whose `done` is not below the length of
  `dirs`, or whose step is not a direction's digit: the engine's validator never stores one, and
  should one reach the projection its `dir` is no direction, so the host halts rather than publish
  a guessed one. Each event's payload is read through a schema of the members it uses.
- **Events.** `C0_EVENT_DECISIONS` holds what the projection does with each event type the registry
  classifies C0: `being.spawned`, `being.died`, and `speech.uttered` are projected;
  `being.started` is excluded, since the kind of activity it reports is in the being's record.
  Events of other classes are never read.
- **Plain text.** A rendered text that is not `PlainText` is left out and counted in
  `omittedSpeech` (C3); the greeting of a `greet` still reaches the feed. The admin status does not
  carry the count yet.
- **Terrain.** `readTerrain(chunk)` is a pure closure over the prepared genesis: it generates the
  chunk with worldgen, never in the world's state, and returns `TerrainPublic` with only the
  `surface` observables that vary by cell, `elevation`, `liquidDepth` (max(0, L − elevation)), and
  `substrate`, each as wide as the world's declared range of it asks.

`projection.test.ts` checks the map against the registry both ways, the decision for every C0
event type, versions that move only on C0 changes, a crossing that leaves one chunk and enters the
other in the same tick, each walker's `dir` over 700 ticks of the default scenario against the step
it is on, the clock against the calendar and against values computed by hand, `readTerrain`
against worldgen, a wet chunk cell by cell included, and that a projection pass changes no state
root.

`leak.test.ts` runs the `mind@1` subject, the default scenario, and a canary world through the
host and the gate, reads every published tick back with the protocol's strict schemas, and finds
in its text no taint, seed, terrain seed, seal, checksum, state root, or canary planted in C1 and
C3 data.

## Journal

The `TickJournal` port is `append(batch) → Promise<void>` with `level: "none" | "durable"`. A batch
is `{fromTick, toTick, records, checkpoint?}`; the checkpoint is the encoded snapshot of `toTick`.
`append` resolves once the batch is committed and rejects when it cannot be.

`EphemeralJournal`, the only journal of T6, acknowledges each batch in a microtask, declares
`level: "none"`, and keeps nothing, the checkpoint included. A restart starts a new world, so
nothing it acknowledged can be lost. T7 adds a durable journal behind the same port.

## Publication gate

`PublicationGate` holds three counters, `E ≥ C ≥ P`, all at the world's tick `L` at boot:

| Counter | Moves when |
|---|---|
| `E`, executed | The host hands it the next tick, which must be `E + 1` |
| `C`, committed | The journal acknowledges a batch: `C` becomes its `toTick` |
| `P`, published | The gate delivers a tick to the listeners |

- **Batches.** The gate appends F ticks at a time, and closes a batch early at a tick that carries
  a checkpoint, so the snapshot of tick K travels with the batch that ends at K (ADR 0007).
  `OrderedJournal` asserts one append in flight and batches whose ticks follow on from the last;
  a violation throws before the journal sees the batch, and the gate takes it as a failure.
- **Publication.** On each acknowledgement the gate publishes exactly `(P, C]`, in order. Listeners
  receive the frozen `PublishedTick` records of the projection. Their return values are ignored;
  their exceptions and rejected promises are counted as `listenerFaults` and never stop
  publication.
- **Boot record.** A gate given the projection's boot record, whose tick must be `L`, hands it to
  each listener as the listener subscribes, before any published tick, so a listener starts from
  the whole world at `L` and then follows every tick. Once the gate published, it refuses a new
  listener, which would miss the ticks before its subscription, and drops the boot record.
- **Flush.** `flush` appends what is left as partial batches and resolves once all of it is
  committed and published, or once the journal failed; it never rejects.
- **Failure.** When an append rejects or throws, the gate fails: it keeps what the journal threw or
  rejected with as `failure`, drops the ticks it holds, appends and publishes nothing more, and
  refuses further ticks. Nothing uncommitted is published.
- **Window.** `stalled()` is `E − C > W`, with `W = 4F`.
- **Change callback.** `onChange` runs after each acknowledgement and after a failure, so the
  scheduler can ask its hold again. A throw from it is counted as `changeFaults` and reaches neither
  the caller of `accept` nor the append's promise, where it would be an unhandled rejection.

## Presentation plane

`Presentation` receives from the world plane two functions only: the subscription to published
ticks, which delivers the boot record first, and `readTerrain`. It holds nothing of the world but
those frozen C0 records, and no network: the transport of T6-7 will drive it through `connect(sink)`,
`subscribe`, `follow`, `resync`, `abort`, and `close`, where a sink is
`{send(frame), lagging(), end(cause)}`.

A throw while serving one client, from its sink's `send`, the terrain, or the start of its
transaction, drops that client alone: its interest, pins, and transaction go, the drop is counted as
`faults` (C3), and its sink's `end(cause)` tells the transport to close the connection, which must
not call `close` for it again. The period goes on with the next client. Any other throw of a
period, from the playout, the mirror, or a drop, is a fault of the whole plane, whose state may be
inconsistent: the presentation stops, `usage().failed` turns true, and the throw goes on to the
runtime. `stop()` stops the periods and unsubscribes from the world plane for good, so a stopped
presentation receives no published tick, holds no growing playout, and cannot start again. A
presentation whose boot record could not be applied unsubscribes and throws from its constructor:
the world plane counts a listener's throw and keeps the listener, so one that was never built must
leave no listener behind.

### Playout

The listener of published ticks only queues them. Each period, `period()` runs in a timer task of
its own, never inside a step's callback: the playout hands the mirror the oldest waiting tick, or,
when more than F wait, every waiting tick in order, and the period releases the newest; the rings
still receive every tick. `start()` runs a period every `1/TICK_RATE_HZ` seconds on the injected
timer, and a period that ran late resets the schedule rather than catching up. Then the fan-out
serves each client that is not lagging.

### Mirror

The mirror applies the boot record, then each released tick, in order.

- **Versions.** A chunk's content is an immutable `ChunkVersion`, `{v, records}`, its being records
  sorted by id and encoded once. A published change of a chunk makes a new version; every other
  chunk keeps its version, shared by every client that shows it. A chunk that never held a being
  reads as an empty version at the boot tick, and one that emptied keeps an empty version at the
  tick it emptied. The difference by id between two versions of a chunk is computed once per pair
  and shared.
- **Pins.** Clients pin the versions they show and those their transaction reads. Pins are counted
  per version; a version replaced while pinned is retained until its last pin goes, and the bytes
  of retained versions are counted exactly. A version replaced with no pin is freed at once. The
  limit of retained bytes that acts on that count is T6-6b's.
- **Index.** The chunk of every being, so the follow window and the followed record are found at
  once.
- **Rings.** Local speech, one stream per chunk, and the feed, one stream, are kept for the last
  H = 300 ticks, at most 2,048 items each ring, each item encoded once. At most 64 feed items of a
  tick are kept; the rest are counted. Each stream counts every item it ever had, and a client
  remembers the count of each stream at its visible tick, so what it can no longer read, evicted or
  never kept, is counted exactly as `missed` or `speechMissed`.

### Interest

A client's effective interest is its follow window, the followed being's chunk ± 1 clipped to the
world (at most 9 chunks), then its camera (at most 64 chunks), which each `subscribe` replaces, each
chunk once. The window moves to the followed being's chunk when a transaction starts. An inverted
index maps each chunk to the clients whose effective interest holds it, and `followers(being)` counts
the clients that follow a being: observation telemetry (C3) that lives in this plane, where the world
cannot import it.

### Transactions

Each client has a visible tick `L` and the versions it shows, pinned. A transaction starts only
after the previous one committed, never in the period of that commit, once the playout tick `L'`
passed the last commit's (for a connection's first, reached hello's), and while the client is not
lagging. It pins the versions of `L'` for the effective interest and fixes its whole content:

1. `drop` of the chunks that leave the view;
2. for each chunk that stays, the difference by id between its versions at `L` and at `L'`, sent when
   the version moved or there is speech, and its local speech of `(L, L']` with `speechMissed`;
3. the full content of the chunks that enter, with terrain, or of the whole view in a reset, and the
   followed being's record when the client does not show the being it follows;
4. the feed of `(L, L']`, with `missed`;
5. `commit`, with the clock of `L'`.

Every connection's first transaction is a reset, and so is the one after `resync`. Parts are at most
64 KiB, filled against an upper bound of their size with every integer at its widest, and broken on
record boundaries: a chunk's differences may span several parts, and a chunk that enters is cut into
fragments that each fit in a part, `frag{i, n}`, its terrain in the first. The parts read only pinned
versions, so content stays that of `L'` however many periods the transaction takes. `seq` grows by
one per message, written when the message is sent; the messages of a transaction carry `L'`, and
hello the client's visible tick. At the commit the view takes the pins of `L'` and releases those of
`L`. `abort` cancels the transaction in flight, whose pins go and which the client is told about
first; with `releaseView`, the view's pins go too and the next transaction is a reset (the hook of
T6-6b's memory guard). `close` releases the client's interest, index entries, following, pins, and
transaction.

The terrain of a chunk that enters is generated by `readTerrain` and kept, encoded, in an LRU of
2,048 entries. Hello says the world is `running` until T6-6b brings the world's stops to the
presentation.

### Fan-out

Each period, the fan-out sends a client that is not lagging its pending messages (hello, aborts),
then its transaction's parts, up to a budget of 256 KiB per client and period, every message counted.
A message that does not fit waits for the next period with its place in the order. The fan-out's
budget of time, its rotating order, the strikes, and the limits of view, memory, and terrain are
T6-6b's.

### Tests

The protocol's reducer, `applyMessage`, is every client in these tests, and every frame is parsed
with the strict schema.

- `presentation-mirror.test.ts`: versions made only for changed chunks and diffs computed once per
  pair; exact pins and retained bytes; rings bounded by H and 2,048 items with exact `missed`; 64
  feed items a tick; the playout's release.
- `presentation.test.ts`: hello and a reset first, and a late connection no feed from before its
  hello; one commit per period; the playout's skip beyond F with every tick's feed; a being crossing
  chunks for clients of one chunk, the other, both, and a follower (plan test 9); the same feed for
  clients of disjoint regions (plan test 10); a period's budget that counts hello and aborts; a lost
  message detected as a `seq` gap and healed by a resync (plan test 8); speech of `(L, L']` and the
  feed of `(L, L']` in every transaction, a reset included, and those released while a transaction
  spans periods in the next one; `speechMissed` and `missed` counted once however many parts the
  speech and the feed span; abort; periods on the timer; connect and close cycles that leave
  interest, index, followings, pins, and retained bytes at zero; and a presentation whose boot
  record cannot be applied, which leaves no listener.
- `presentation-reconstruction.test.ts` (plan test 7): a seeded model world of beings that walk,
  cross, arrive, leave, and speak, published in bursts now and then and with more feed than a tick
  keeps every 40 ticks, and clients that change camera and follow at random, resync, lag, lose a
  message, abort, and reconnect. After every commit each view equals the model at the commit's tick,
  terrain and followed record included; unless a lost message left the client behind, the commit
  brings exactly the feed of `(L, L']`, the items of a tick beyond 64 counted as `missed`, and the
  local speech of `(L, L']` of the chunks that stayed in view; and no client gets more than its
  budget or one commit in a period. The run must cover drops, re-entries, returns, fragments,
  multi-period transactions, crossings, playout skips, aborts, feed, missed feed, speech, resets
  after the first, and late connections.
- `presentation-sizes.test.ts` (plan test 7b): under parts of 64 KiB and 256 KiB a period, a chunk of
  1,024 beings of records near the widest spans parts and two periods, the view never shows a
  partial chunk, and the transaction commits at its tick while beings move, arrive, and leave. The
  largest view of `beings@2`, 73 such chunks, and one chunk of 65,536 such beings in parts of
  16 KiB, the smallest, each assemble in one transaction with no part past its limit and no period
  past its budget, within the reducer's 1,024 parts and the periods their bytes need, the view
  unchanged until the commit; these two skip the schema for time and keep the reducer's checks. One
  chunk of 65,536 narrow records also assembles.

## Composition

`compose(config, deps)` wires a source (the default scenario unless given), the projection of its
world (`BeingsProjection` unless given), the gate (over the ephemeral journal unless given), the
host, and the scheduler, and returns:

| Member | What it does |
|---|---|
| `start()` | Starts the scheduler, or resumes it after `stop` |
| `stop()` | Pauses the scheduler and flushes the gate: every executed tick is committed and published (RPO 0 once the journal is durable) |
| `subscribeToPublished(listener)` | Adds a listener of published ticks and returns the function that removes it. The listener receives the boot record first; after the first publication this throws |
| `readTerrain(chunk)` | The projection's `readTerrain`: the public terrain of a chunk, never materialized |
| `status()` | The server's status, shaped for `ServerStatus` of `@open-origin/protocol/admin` |
| `unhandledRejection()` | Asks `rejectionPolicy(AI_MODE)`; with `off`, the world halts |
| `halted()` | Why the world halted, for the entry point's log (C3): the host's halt, its code, tick, and cause, or `undefined` while it runs |

`deps` carries the clock and the timer, which the entry point of T6-7 takes from `src/adapters/`,
and, for tests, the journal, the source, the projection of its world, the scheduler (`schedulerOf`,
a `TickScheduler` over the options a `FixedRateScheduler` takes), and K. A journal failure
halts the host with `journal_failed` and the gate's `failure`. The status reads `E`, `C`, and `P`
from the gate; the state is `halted` once the host halted or the journal failed, and otherwise the
scheduler's (`journalStall` is `stalled`). `projectionMicros` holds the percentiles of each
projection's duration on the injected clock over the last 1,024 ticks; `stepMicros` covers the
whole tick, the projection included. `fanOutMicros` and `connections` are 0 until T6-6b measures
them.

`rejectionPolicy` is a pure function: with `AI_MODE=off` an unhandled rejection halts the world,
because no code of the world awaits anything, and async work in a brain would be a wall-clock
channel. T6-7's entry point installs the process handler that calls `unhandledRejection`.

`composeServer(config, deps)` wires both planes: it calls `compose`, then builds the `Presentation`
from the world plane's `subscribeToPublished` and `readTerrain` alone, with the same clock and
timer, the configured rate and F, and hello's world: a random id of 16 bytes, fresh at every boot
unless a test gives `worldId`, and the configured durability. Its `start()` starts the
presentation's periods, then the world's clock, so a presentation that cannot start leaves no
world running; `stop()` stops the periods and detaches the presentation, then
stops the world, resolving once every executed tick is published. T6-7's entry point calls it.

## Observer invariance

`observer-invariance.test.ts` checks P9 (ADR 0005, control 1 as ADR 0025 refines it) through
`composeServer`, on a fake clock, with a constant `readTerrain`, over the `mind@1` subject world of
T5: three beings that greet, tell, forage, and cross chunks, and a research injection, an admin
command, at tick 30. The default world sleeps from its second tick until past tick 260, too still
for a brain's leak to show in a run. A reference run with no observer is compared with runs of 100
ticks with 1 and 32 simulated observers, which act half a period after each tick: they connect,
all follow the same being, change camera and followed being at random, drain slowly by lagging
for periods, resync, and disconnect midway and come back. For every tick, the fake-clock time at
which the host asked for its commands, its full command list, rejected commands included, its
checksum, and the bytes of its `PublishedTick` must be equal, and so must the final snapshot. The
checksums are read from the journal's records, never through the protocol.

The run of 32 observers also checks plan test 9 in the subject world: four clients of the
protocol's reducer watch its first chunk crossing, the client of the chunk the being leaves, of the
chunk it enters, of both, and its follower. After every commit each view equals the world the gate
published at the commit's tick, and the crossing falls between two of each client's commits: the
being leaves one chunk and enters the other in one transaction, and the follower's window moves
with it.

Three permanent negative controls are test doubles injected through `compose`'s dependencies, never
production code:

| Control | Double | Where the comparison fails |
|---|---|---|
| NC1 | A source that adds an admin command, which the engine rejects, once a being is followed | Its command list, at the tick it adds it |
| NC2 | A brain wrapper that idles a being while `followers` counts a follower of it | Its checksum, at a tick at which the wrapper changed a decision, never before the first: the engine may discard a decision in the tick it is made, when the being's step loses the contest for room, so the change applies at a later decision |
| NC3 | A scheduler that runs one extra tick per subscribe | Its time, at the extra tick |

## The boundary

`tests/repo/server-boundaries.ts` checks the rules of ADR 0025 on the transitive import graph of
`src/`: a rule holds for every module an import reaches through any chain, type-only imports
included.

| Rule | What it rejects |
|---|---|
| 1 | A module outside `presentation/` and `transport/`, other than `compose.ts` and `main.ts`, that reaches either of them |
| 2 | A module of `presentation/` or `transport/` that reaches anything but `@open-origin/protocol/*`, those two folders, and `world/published.ts` through a type-only import |
| 3 | A module of `world/` or `projection/` that reaches `bun` or `bun:*`, or names a WebSocket, or reaches a module outside those folders that does |
| 4 | A module other than `compose.ts`, `main.ts`, and those of `config/` that reaches `config/` |

Every form that loads a module counts: static imports, re-exports, `import x = require("…")`,
`import("…")`, and the `require("…")` and `import.meta.require("…")` that Bun's types declare. A
type-only import is an `import type` or `export type` statement, an `import type x = require("…")`,
or a `typeof import("…")`; an import whose every specifier carries an inline `type` is still a
runtime import. Every relative specifier must name a module of `src/` with its extension; a path
that leaves `src/`, the server's own package name, an absolute path, a URL other than `bun:` and
`node:` (`file://` among them), a computed specifier, and a triple-slash reference directive are
rejected: a path or a URL would join the graph as a package, out of every rule's reach. The scan is
lexical, so a string that reads like an import or names a WebSocket counts, and a `require` reached
through another name (`const load = require`) is left to review. The real tree, `presentation/`
included, keeps every rule, and each rule is also proved on planted trees whose legal version
passes; `transport/` arrives in T6-7. The same
reader rejects, in `packages/scenarios/src` and `packages/protocol/src`, a relative path that leaves
`src`, a type-level `import()`, a `require()` or `import.meta.require()`, a computed specifier, and a
triple-slash reference directive, which their Biome rules cannot see.

`published.ts` imports only types of `@open-origin/protocol/public`, so a type-only import of it gives
the presentation plane no path to the engine: a published tick holds protocol records and numbers,
never an engine type.
