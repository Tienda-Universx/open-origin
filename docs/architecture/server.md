# Server: the world plane and the presentation plane

`apps/server` runs the public universe in one Bun process. Its world plane steps the engine at a fixed
rate, makes each tick durable before it publishes it, and hands the rest of the server only frozen
published records. Its presentation plane turns those records into each client's view.
[ADR 0025](../decisions/0025-real-time-world-host.md) and
[ADR 0026](../decisions/0026-public-protocol-v1.md) record the design and why; this document
describes what the code implements as of T6-8: the configuration, the scheduler, the world host
and its sources, the C0 projection, the journal port, the publication gate, the presentation plane
(playout, mirror, interest, transactions, sessions, the send discipline, the fan-out, and the
limits of memory and terrain), the transport, their composition, the entry point, the tests of
observer invariance, the terminal probe, and the benchmarks with the budgets they measured.

Code: `apps/server/src/` (`@open-origin/server`), `apps/server/tools/` (the probe), and
`apps/server/bench/` (the benchmarks). Tests: `apps/server/test/` (`config`, `scheduler`, `fault`,
`adapters`, `publication`, `host`, `rejection`, `compose`, `projection`, `leak`,
`presentation-mirror`, `presentation`, `presentation-reconstruction`, `presentation-sizes`,
`presentation-input`, `presentation-backpressure`, `presentation-limits`, `presentation-terrain`,
`presentation-liveness`, `observer-invariance`, `transport`, `ws-world`, `main`, `probe`, and
`bench`),
`tests/e2e/server.test.ts`, and `tests/repo/server-boundaries.test.ts`.

## Layout

| Path | Plane | What it holds |
|---|---|---|
| `src/config/` | — | `parseConfig`: the environment, parsed and deep-frozen |
| `src/world/` | World | `time.ts` (the `Clock` and `Timer` ports), `scheduler.ts`, `samples.ts`, `host.ts`, `source.ts`, `journal.ts`, `publication.ts`, `published.ts`, `rejection.ts`, and `fault.ts` (what a fault leaves to log) |
| `src/projection/` | World | `projection.ts` (`BeingsProjection`), `being.ts`, `events.ts`, `clock.ts`, and `terrain.ts`: the C0 projection of a world of beings |
| `src/presentation/` | Presentation | `presentation.ts` (`Presentation`), `playout.ts`, `mirror.ts`, `version.ts`, `ring.ts`, `interest.ts`, `txn.ts`, `parts.ts`, `frames.ts`, `client.ts` (a client and its sink), `session.ts` (input limits), `view.ts` (the view's limit), `retention.ts` (the memory guard), `terrain.ts` (the terrain cache and queue), and `telemetry.ts` |
| `src/transport/` | Presentation | `transport.ts` (`serveTransport`: the `Bun.serve` adapter), `http.ts` (routing and refusals), and `capacity.ts` (the connection caps) |
| `src/adapters/` | — | `systemClock` (`performance.now()`, in whole microseconds) and `systemTimer` (one `setTimeout` per deadline) |
| `src/compose.ts` | — | `compose(config, deps)`: the wiring of the world plane; `composeServer(config, deps)`: both planes |
| `src/main.ts` | — | `start(env, deps)` and `main()`: the process entry point |

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
| `OPEN_ORIGIN_PORT` | `8080` | An integer from 0 to 65535; 0 lets the system choose a free port |
| `TICK_RATE_HZ` | `5` | An integer from 1 to 1000, the bounds of the admin contract's `tickRateHz` |
| `PUBLICATION_BATCH_TICKS` | `5` | F, an integer from 1 to 300, so a batch never spans more than one checkpoint interval |
| `PUBLIC_ORIGINS` | empty | A comma-separated list of exact `http` or `https` origins |
| `ALLOWED_HOSTS` | The listener's own: `localhost:<port>` and `<host>:<port>` at the port it bound, with an IPv6 host in brackets; the transport derives it once it listens, so port 0 works | A non-empty comma-separated list of `Host` header values, each port from 1 to 65535. An empty list, which would let no `Host` header through, is refused; unset, the default applies |
| `MAX_CONNECTIONS` | `1024` | An integer from 1 to 65536 |
| `MAX_CONNECTIONS_PER_IP` | `16`, or `MAX_CONNECTIONS` when that is lower | An integer from 1 to 65536; when set, at most `MAX_CONNECTIONS`, compared only when both are valid, so a cap at fault is reported alone |
| `MAX_RETAINED_BYTES` | `134217728` (128 MiB) | The limit of replaced chunk versions clients keep pinned, in all: an integer from 1,048,576 (1 MiB) to 17,179,869,184 (16 GiB) |
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
  `omittedSpeech` (C3), which the server's status reports; the greeting of a `greet` still reaches
  the feed.
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

`Presentation` receives from the world plane three functions only: the subscription to published
ticks, which delivers the boot record first; `readTerrain`; and the world's state. It holds nothing
of the world but those frozen C0 records and that state, which every client shares, and no network:
the transport of T6-7 drives it through `connect(sink)`, `receive(client, text)` for each raw text
message, `drained(client)` when a socket's buffer drains, and `close(client)` when a socket closes.
`subscribe`, `follow`, `resync`, and `abort` act on a client directly, for tests; the transport
never calls them.

A sink is `{send(frame), buffered(), end(ending)}`. `buffered()` is the bytes the client's socket
holds and has not written, Bun's `getBufferedAmount()`. `end` closes the connection, once: the
presentation already released the client, so the transport must not call `receive`, `drained`, or
`close` for it again. Its `ending` says why: `strikes`, with close code 1008; `too_slow`, with 1013;
or `fault`, with what serving the client threw and no code, since the protocol fixes none (T6-7
chooses one).

A throw while serving one client, from its sink's `send`, the terrain, the start of its
transaction, or the reading of one of its messages, drops that client alone: its interest, pins,
transaction, and terrain go, the drop is counted as `faults` (C3), and its sink's `end` gets the
fault. The period goes on with the next client. Any other throw of a period, from the playout, the
mirror, or a drop, is a fault of the whole plane, whose state may be inconsistent: the presentation
stops, `usage().failed` turns true, and the throw goes on to the runtime. `stop()` stops the
periods and unsubscribes from the world plane for good, so a stopped presentation receives no
published tick, holds no growing playout, and cannot start again. A presentation whose boot record
could not be applied unsubscribes and throws from its constructor: the world plane counts a
listener's throw and keeps the listener, so one that was never built must leave no listener behind.

### Playout

The listener of published ticks only queues them. Each period, `period()` runs in a timer task of
its own, never inside a step's callback: the playout hands the mirror the oldest waiting tick, or,
when more than F wait, every waiting tick in order, and the period releases the newest; the rings
still receive every tick. `start()` runs a period every `1/TICK_RATE_HZ` seconds on the injected
timer, and a period that ran late resets the schedule rather than catching up. Then a period
announces a change of the world's state, serves the terrain queue, runs the fan-out, and checks the
retained versions, in that order.

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
  of retained versions are counted exactly, in the order the versions were replaced. A version
  replaced with no pin is freed at once.
- **Index.** The chunk of every being, so the follow window and the followed record are found at
  once.
- **Rings.** Local speech, one stream per chunk, and the feed, one stream, are kept for the last
  H = 300 ticks, at most 2,048 items each ring, each item encoded once. At most 64 feed items of a
  tick are kept; the rest are counted. Each stream counts every item it ever had, and a client
  remembers the count of each stream at its visible tick, so what it can no longer read, evicted or
  never kept, is counted exactly as `missed` or `speechMissed`.

### Interest

A client's effective interest is its follow window, the followed being's chunk ± 1 clipped to the
world (at most 9 chunks, the being's own chunk first), then its camera (at most 64 chunks), which
each `subscribe` replaces, each chunk once. The window moves to the followed being's chunk when a
transaction starts. An inverted index maps each chunk to the clients whose effective interest holds
it, and `followers(being)` counts the clients that follow a being: observation telemetry (C3) that
lives in this plane, where the world cannot import it.

### Sessions and input

`receive(client, text)` takes one raw text message, which the transport already held to 4 KiB and
to text frames, and applies, in order:

1. `parseClientMessage`: `JSON.parse` in a try, then the strict schema, which rejects `__proto__`,
   extra keys, and every type but the four;
2. the bucket of messages, 10 a second with a burst of 20;
3. the bucket of new chunks, 64 every 2 s: for a `subscribe`, the chunks new to the camera; for a
   `follow` of a being the mirror holds, the chunks its window adds to the effective interest. The
   window's moves with the followed being, which the client did not ask for, take nothing from it:
   the terrain's budget bounds them;
4. the message itself: `subscribe` replaces the camera; `follow` of a being the mirror does not hold
   is `unknown_being`, checked before the bucket of new chunks; `ping` gets `pong{nonce}`; `resync`
   within 2 s of the last one allowed is `resync_too_soon`, and otherwise makes the next transaction
   a reset.

A rejected message gets `error{code}`, the code alone, never anything of the input, and a strike,
unless a correct client may meet the code too: `unknown_being`, after a being it saw died, and
`resync_too_soon`, after two anomalies close together. The third strike within 10 s ends the client
with 1008 and no `error` for it. Both buckets are counted in whole microseconds on the injected
clock, so every timing is exact: a message costs 100,000 µs of a bucket of 2,000,000, and a chunk
31,250 µs of a bucket of 2,000,000. A message the schema refuses takes no token; every other one
takes a token of the bucket of messages whatever its outcome, so a refusal that earns no strike is
still paced; a `subscribe` or a `follow` the bucket of chunks refuses takes no chunk and changes
nothing. A strike counts while it is younger than 10 s, and a resync waits 2 s from the last one
allowed.

### Send budget and backpressure

A client gets at most 256 KiB a period, every message counted: hello, parts, commits, `pong`,
`status`, `error`, `notice`, `abort`, and what a drain sends. The period's budget runs from one
period to the next, so answers sent at once by `receive` and parts sent by `drained` between two
periods take from the budget of the period before them; a drain never renews it. A message goes out
only while the client's socket buffers less than 256 KiB, checked before each message, and a message
is at most 64 KiB, so the buffer stays under 320 KiB, within the 512 KiB the ADR bounds and far from
Bun's limit of 1 MiB. A client whose buffer is full at its turn in the fan-out gets nothing and
starts no transaction; `drained` sends what waits of its messages and of its transaction in flight,
and never starts a transaction.

Messages that are not parts of a transaction wait in the client's outbox and go before any part. The
outbox stays small whatever a client sends while it does not read: a pending `pong`, `status`, or
`notice` is replaced by a newer one, and an `error` waits once per code, so it holds at most hello,
one abort, and one message of each other kind. A transaction starts only when the outbox is empty.

A period that leaves part of a transaction unsent sent more than the budget less a part, since the
fan-out stops only when the next message does not fit. A transaction of B bytes, every message of
its periods counted, therefore commits within ⌊B / (256 KiB − 64 KiB)⌋ + 1 periods while its client
drains and its turn comes each period, plus the periods its parts wait for terrain the LRU evicted
(see Terrain). ⌈B / 256 KiB⌉ periods is the floor; the ceiling cannot reach it with whole messages.

### Transactions

Each client has a visible tick `L` and the versions it shows, pinned. A transaction starts only
after the previous one committed, never in the period of that commit, once the playout tick `L'`
passed the last commit's (for a connection's first, reached hello's), and while the client's buffer
has room. It pins the versions of `L'` for the effective interest, trimmed to the view's limit, less
the chunks that would enter but whose terrain is not at hand: those are neither trimmed nor dropped
from the interest, and enter, whole, in a later transaction once the terrain queue brings their
terrain. It fixes its whole content:

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
versions, so content stays that of `L'` however many periods the transaction takes. Terrain is a pure
function of the genesis, so a transaction keeps only the bytes of its chunks' terrain, which plan its
parts, and reads the text from the terrain's LRU as it writes each chunk's first fragment, checking
that it has the bytes planned. A part whose terrain the LRU no longer has waits, as a client the
fan-out deferred does, never counted as lagging, until the terrain queue serves it (see Terrain). `seq` grows by
one per message, written when the message is sent; the messages of a transaction carry `L'`, and
every other message the client's visible tick. At the commit the view takes the pins of `L'` and
releases those of `L`. `abort` cancels the transaction in flight, whose pins go and which the client
is told about first; with `releaseView`, the view's pins go too and the next transaction is a reset.
`close` releases the client's interest, index entries, following, pins, transaction, and terrain.

### Fan-out

Each period, the fan-out serves the clients in the order they connected, starting from the first
client the last fan-out could not serve: its pending messages, then its transaction's parts, within
its budget of bytes and while its buffer has room. Before each client but the first, it reads the
injected clock: once 40 ms have passed since the fan-out began, that client and those after it wait
for the next period, which serves them first. The first client of a period is always served, and a
client deferred one period is first in the next, so a client waits only while the clients ahead of
it in the rotation are served. The fan-out never runs inside the world's step and never touches
it: under load, clients see fewer, larger steps, and the world runs on. Each fan-out's duration
goes to `recordFanOut`, which `composeServer` keeps for the status's percentiles.

### The world's state

Hello carries the world's state as the last period read it. Each period reads the world plane's
state first: when it changed, every client gets `status{state}` at its visible tick, before anything
else of its period. A client the fan-out served, whose buffer has room, that got nothing else in a
period gets `status` with the state again, whatever the state: the heartbeat that keeps it from
taking the silence for a dead connection. While the world is stopped its playout soon gives no new
tick and so no commit; while the world runs, a client whose next part waits for terrain gets no part.
T6 sends no `reason`; T8's operator pause brings one.

### Memory limits

- **View.** At most 32 MiB, measured at `L'` when a transaction starts. A chunk counts the bytes of
  its being records at the playout tick, one comma between two of them, and the widest terrain,
  12,401 bytes: an upper bound of what its content adds to the view that needs no terrain
  generated. An interest that passes the limit keeps the longest prefix that fits, in its order,
  the follow window first, then the camera in the order the client sent it; that chunk and every one
  after it are left out. The client gets `notice{code: "interest_trimmed", chunks}` with them when
  the chunks left out change, with none when nothing is left out any more. Each transaction started with a trimmed interest counts
  one trim (C3).
- **Retained versions.** After each period's fan-out, while the replaced versions clients pin pass
  `MAX_RETAINED_BYTES` (128 MiB unless set), the version replaced first is taken, and every client
  that pins it is aborted: its transaction's pins go, and `abort` goes before its next message; when
  it pins that version in its view at `L`, its view's pins go too, and its next transaction is a
  reset. The version replaced first is pinned by the clients furthest behind, never by a client
  whose view and transaction are newer than its replacement. Each client aborted counts one abort a
  check; the third within 60 s on the injected clock ends it with 1013. A version still pinned once
  every client that pinned it was aborted is a fault of the plane, never a guard that loops. A check
  under the limit reads no client; one over it indexes the clients that pin each retained version
  in one pass over their pins, so it costs the pins plus the versions it frees, never a pass over
  the clients per version freed.
- **Per client**, outside what is shared: references to its pinned versions, its interest, its
  outbox of at most 13 small messages, its transaction's cursor with the text of the part it writes
  or has ready, its terrain while it waits at the head of the terrain queue, at most one chunk of
  terrain served to its transaction, and counters.

### Terrain

At most 16 chunks of terrain are generated a period, across all clients, and kept, encoded, in an
LRU of 2,048 entries; a cache hit generates nothing and costs no budget. A transaction brings only
the entering chunks whose terrain is at hand, so terrain never holds up the rest of a view: a client
gets its transaction each period, and what it cannot have from the LRU waits in a queue served first
come, first served, its chunks entering later transactions as their terrain comes. A waiting client
asks again at each of its turns in the fan-out and keeps its place whatever it needs then: its
chunks change by themselves when the followed being moves its window or a trim moves with the size
of chunks.

A transaction in flight reads its terrain from the LRU as it writes its parts; at its start the
terrain it took goes back in the LRU, its first chunks used last. A chunk the LRU evicted meanwhile
is generated at once while the budget lasts and no client waits; otherwise it waits in the lane, in
the order the transactions asked, and is held until its transaction reads it, one chunk per
transaction. Meanwhile the transaction stays in flight, its next part waiting, and the client hears
`status` in a period with nothing else.

Each period the budget B goes first to the lane, at most L = min(⌈B / 4⌉, B − 1) generations of it,
4 at 16; then to the head of the queue; in the fan-out only the head generates at once, or any
client while none waits; and what is left after the fan-out goes to the lane, then to the waiting
clients in the order they arrived. Terrain is held apart from the LRU for the head and the lane
alone: the head's hold keeps only the chunks it still needs, at most those of a full view, 73
(`MAX_VIEW_CHUNKS`, which the queue checks), and the lane one chunk per transaction, each of at most
12,401 bytes: at most 905,273 bytes and 12,401 more per transaction in flight, whatever the number
of waiting clients. The clients behind the head hold nothing: what the queue serves them goes to the
LRU, and a chunk the LRU evicts before they take it waits for them again, in their turn. A
transaction holds no other terrain than in the text of the one snapshot part it writes or has
ready: a lagging client holds at most 64 KiB of terrain text, not the 905,273 bytes of a full view.

The head's turn lasts T = ⌈2 · 73 / (B − L)⌉ periods, 13 at 16: the periods in which it is served
right after the lane's share, with at least B − L generations each. A head that still waits for
chunks then goes to the back with nothing held; what was generated for it stays in the LRU, so its
next turn needs only what changed or was evicted. B is at least 2, which the queue checks: a budget
of 1 would leave the lane nothing while a client waits, and a transaction whose chunk the LRU
evicted would wait as long. So L and B − L are each at least 1, and:

- A client with k clients ahead is the head within k · (T + 1) periods, whatever any client's chunks
  or the lane do: each head keeps the head at most T periods after the one in which it became the
  head, the lane never takes more than its share of a period, and the clients that arrive later or
  go to the back wait behind it. A client that changes its chunks on purpose holds the others for a
  turn at most.
- A head whose chunks gain at most d new ones a period has them all within ⌈73 / (B − L − d)⌉
  periods, when its turn in the fan-out comes each period: the queue's pass and its own take at once
  generate at least B − L a period for it, d of which go to what changed. A follow window that moves
  one chunk a period gains at most 5, so the head has its chunks within 11 periods, inside its turn
  of 13.
- A chunk a transaction in flight missed, behind m others in the lane, is served within
  ⌈(m + 1) / L⌉ periods, sooner when the fan-out leaves budget, and held until read. A transaction
  of N bytes therefore commits within ⌊N / (256 KiB − 64 KiB)⌋ + 1 periods while its client drains
  and its turn comes each period, plus that wait for each of its chunks the LRU evicted before it
  wrote them.

### Telemetry

`telemetry()` reports, as C3 for the admin status: `connections`; `laggingClients`, the clients with
a full buffer at the last fan-out, those its time budget deferred included; `retainedBytes`;
`terrainQueue`, the chunks waiting clients and transactions in flight wait for; and the counts since
start of `aborts`, `trims`, `strikes`, `strikeCloses`, `slowCloses`, and `faults`. No public message
carries any of them: every public frame is built from the protocol's strict schemas. `usage()`
reports, for tests, what the presentation holds: clients, interest, index entries, followings, pins,
retained bytes and versions, and the terrain waited for and kept, every count zero once every client
is gone.

### Tests

The protocol's reducer, `applyMessage`, is every client in these tests, and every frame is parsed
with the strict schema.

- `presentation-mirror.test.ts`: versions made only for changed chunks and diffs computed once per
  pair; exact pins and retained bytes; rings bounded by H and 2,048 items with exact `missed`; 64
  feed items a tick; the playout's release.
- `presentation.test.ts`: hello and a reset first, and a late connection no feed from before its
  hello; one commit per period, and `status` instead while the playout holds; the playout's skip
  beyond F with every tick's feed; a being crossing chunks for clients of one chunk, the other,
  both, and a follower (plan test 9); the same feed for clients of disjoint regions (plan test 10);
  a period's budget that counts hello and aborts; a lost message detected as a `seq` gap and healed
  by a resync (plan test 8); speech of `(L, L']` and the feed of `(L, L']` in every transaction, a
  reset included, and those released while a transaction spans periods in the next one;
  `speechMissed` and `missed` counted once however many parts the speech and the feed span; abort,
  which waits apart from a pending `status`, so a lagging client gets both; periods on the timer;
  connect and close cycles that leave interest, index, followings, pins, and retained bytes at zero;
  and a presentation whose boot record cannot be applied, which leaves no listener.
- `presentation-reconstruction.test.ts` (plan test 7): a seeded model world of beings that walk,
  cross, arrive, leave, and speak, published in bursts now and then and with more feed than a tick
  keeps every 40 ticks, and clients that change camera and follow at random, resync, lag, lose a
  message, abort, and reconnect, over a terrain LRU of 8 entries filled 4 chunks a period. After
  every commit each view equals the model at the commit's tick, terrain and followed record
  included, but for chunks whose terrain was not at hand, which enter a later commit and are never
  ones the view showed; unless a lost message left the client behind, the commit brings exactly the
  feed of `(L, L']`, the items of a tick beyond 64 counted as `missed`, and the local speech of
  `(L, L']` of the chunks that stayed in view; and no client gets more than its budget or one commit
  in a period. The run must cover drops, re-entries, returns, fragments, multi-period transactions,
  crossings, playout skips, aborts, feed, missed feed, speech, resets after the first, late
  connections, and commits that left out a chunk waiting for its terrain. Then every client asks
  once more for a camera and a followed being, and nothing changes after: within the periods the
  terrain and transaction bounds give, every view holds exactly its whole interest, though commits
  of that phase left out chunks waiting for their terrain.
- `presentation-sizes.test.ts` (plan test 7b): under parts of 64 KiB and 256 KiB a period, a chunk of
  1,024 beings of records near the widest spans parts and two periods, the view never shows a
  partial chunk, and the transaction commits at its tick while beings move, arrive, and leave. The
  largest view of `beings@2`, 73 such chunks, and one chunk of 65,536 such beings in parts of
  16 KiB, the smallest, each assemble in one transaction with no part past its limit and no period
  past its budget, within the reducer's 1,024 parts and the periods their bytes need, the view
  unchanged until the commit, every frame read with the strict schema. One chunk of 65,536 narrow
  records also assembles. These views have their terrain generated at once.
- `presentation-input.test.ts` (plan test 12 in process): `pong` with its nonce; 21 hostile messages
  (text that is no JSON or looks binary, values that are not records, the types `pause`, `speed`,
  `step`, `seek`, `rewind`, `tick`, and `rate`, extra keys, `__proto__`, a nonce past 2³¹ − 1, a
  repeated chunk, 65 chunks, a chunk outside the world, and 5 KB of text), each with its exact code,
  no byte of its input, and a strike; a strike 10 s old no longer counting, a third strike exactly
  10 s after the first closing nothing, and a third strike within 9.999999 s closing with 1008 and
  no `error`; 20 messages at once, then one at 100 ms and none at 99.999 ms, and 20 at most after a
  minute idle; no token taken by a message the schema rejects; 64 new chunks, then one at 31.25 ms;
  follows alternating between beings 10 chunks apart refused once their windows spent the bucket,
  with nothing changed, and passed again 250 ms later, not 1 µs sooner, while a follow of nothing
  and the window's move with its being take no chunk; resyncs at most every 2 s,
  `resync_too_soon` and `unknown_being` with no strike; and the answers to a lagging client
  coalesced and sent first once it drains.
- `presentation-backpressure.test.ts` (plan tests 7b and 13 in process): exactly 256 KiB buffered
  stops a client, and one byte less lets one message through; a message that pushes the buffer to
  256 KiB lets no transaction start after it; a drain sends only what is left of a
  period's budget and starts no transaction, and every period that leaves a transaction unsent sent
  more than the budget less a part. The fan-out serves four clients of ten a period when each takes
  10 ms on the injected clock, in the rotation 1–4, 5–8, 9, 10, 1, 2, and so on, and records each
  period's 40 ms. The world's state reaches hello, every client's `status` on each change, and a
  client of a stopped world each period.
  A seeded property runs sockets that drain at random rates, from none to all, and call `drained`
  as they cross the threshold; clients that change camera and follow, ping, resync, send rejected
  messages, are aborted by hand and by the memory guard, close with 1013, and come back; and a world
  that stops and resumes. No client gets more than its budget between two periods, every message
  counted; no message goes out at or above 256 KiB buffered, so no buffer passes 256 KiB and a part;
  and every kind of message, a lagging socket, a drain, and a close for slowness occur. Then, while
  every socket drains, every period that leaves a transaction unsent sent more than the budget less
  a part, and every client ends up to date.
- `presentation-limits.test.ts` (plan tests 7b and 14 in process): a view trimmed to its limit keeps
  the follow window, then the camera's prefix that fits, and a later chunk that would fit is left
  out with the rest; the notice goes once while the chunks left out stay the same, an empty one when
  none are left out any more, which clears the client's list, and again when chunks are left out
  after that; a followed being's chunk that alone passes the limit drops the whole view, a notice
  listing every chunk, while the followed record stays; a trim counts once its transaction starts,
  so a client whose terrain throws first counts none; hello announces the limit. The memory guard
  aborts a client that pins the oldest version in its transaction, keeping its view, and one that
  pins it at `L` with its view, whose next transaction is a reset; of two clients behind, only the
  one furthest behind; and closes a client with 1013 at a third abort within 60 s, at 60.999999 s,
  and not at a third when the first is 60 s old. The guard itself, over a mirror and clients modeled
  in the test, reads each client once a check, however many versions it frees, and no client under
  the limit; a client that pins one retained version in its transaction and another at `L` is
  aborted twice in a check, its view going at the second, and counted once, while one whose first
  abort released its pin of the next version is not aborted for it; and a version its clients'
  aborts do not free throws. Six cycles of clients closed by a fault, by strikes, and by slowness,
  aborted, and waiting for terrain leave every count at zero.
- `presentation-terrain.test.ts`: the queue gives its head the period's generations until it needs
  nothing more, then the next client; the head's terrain survives a cache that evicts it, and a
  client behind it gets an evicted chunk generated again; a waiting client keeps its place when its
  chunks change and takes what it holds; a head whose chunks change every period gives up the head
  after its turn of 13 periods, and the client behind it is served in the next; while clients wait
  only the head generates at once; a chunk a transaction cannot read is served first the next period
  and held until it reads it, and one whose generation throws drops its client; the lane takes at
  most a quarter of a period's budget before the head, and is served first from what the fan-out
  leaves; at the smallest budget, 2, a chunk the cache evicted before a transaction read it is
  served the next period while a client still waits; a generation that throws removes its client
  from the queue whatever the fault callback does, and the queue serves the next client in the same
  period; no client may need more than 73 chunks; and a budget below 2 builds no queue and no
  presentation. In the presentation, a flood of ten clients, each entering 64 new chunks, generates
  16 chunks a period, each chunk once, and grows each view as its terrain comes, the clients whole
  four periods apart, the last at period 40; a follower whose window moves every tick, behind one
  client and ahead of 49 that flood the queue, shows its whole window in period 5; six lagging
  clients whose transactions are in flight over distinct chunks hold no terrain while a cache of 8
  evicts theirs, and once they drain, the terrain of the chunks they had not written yet is
  generated again ahead of a flooded queue, and each commits within three periods; a terrain read
  again with other bytes than planned drops its client alone; an aborted transaction that waited for
  terrain leaves nothing in the queue, and its client keeps its place; and a queued generation that
  throws drops the client waiting for it alone, counted as a fault, while the others are served and
  the plane runs on.
- `presentation-liveness.test.ts` (ADR 0026, "Ordering and liveness"): four clients, each entering
  64 new chunks, hear from the server in every one of the 17 periods their terrain takes, and end up
  showing their whole cameras; a client that pans to 64 new chunks while three others wait for
  terrain hears from the server every period, and its view shows its followed being's move at every
  tick; a follower whose being moves into chunks whose terrain waits shows none of them yet keeps
  the being's record every period. A client whose transaction's next part waits for terrain the LRU
  evicted hears `status` in that period, its transaction in flight and uncommitted, and never goes a
  period in silence until it commits; a transaction whose part waits says so with `TERRAIN_PENDING`,
  keeps its pins, and goes on once the terrain comes.

## Transport

`serveTransport(options)` (`src/transport/transport.ts`) is the public listener, a `Bun.serve`
adapter. It reaches Bun through the global `Bun`, never an import of `bun`, so rule 2 of the
boundary holds, and it drives the presentation through `connect`, `receive`, `drained`, and `close`
only. Its options are the presentation, the address and port to bind (0 lets the system choose),
`PUBLIC_ORIGINS`, `ALLOWED_HOSTS` or nothing, the connection caps, and the log.

- **HTTP.** `http.ts` routes each request with a pure function, `route(facts, policy)`: the order
  of its checks and its answers are the protocol's [HTTP surface](protocol.md#http-surface).
  `capacity.ts` holds the caps: an upgrade takes a slot, in all and for its address, which
  `server.requestIP` gives, before Bun upgrades it, and the slot goes back when its socket closes.
  Bun runs the open handler within `upgrade`, so two upgrades never pass a cap together.
- **Socket limits.** `SOCKET_OPTIONS`, one constant that `websocketOptions` spreads after the
  handlers, so no handler's key can override a limit: `maxPayloadLength` is 4,096 bytes, so Bun closes a larger frame with 1009 before any of it reaches the presentation;
  `backpressureLimit` is 1 MiB with `closeOnBackpressureLimit`, a backstop, since the presentation
  keeps a buffer under about 320 KiB: Bun closes a socket that reaches it (its close handler sees
  1006); `idleTimeout` is 120 s, with `sendPings`. A binary frame is closed with 1003. Nothing is
  compressed.
- **The sink.** `send` is `sendText`; `buffered()` is `getBufferedAmount()`; `end(ending)` marks the
  socket ended and closes it with the ending's code (`closeCodeOf`): 1008 for strikes, 1013 for
  slowness, and 1011 for a fault. The protocol fixes no code for a fault of the server, and 1011
  is the WebSocket code for an internal error (ADR 0026).
- **Lifecycle.** `open` connects the client; when `connect` throws, the socket is closed with 1011
  at once, where Bun would end it with no close frame, and its slot comes back through the close
  handler. `drain` calls `drained`. A close gives the slot back and calls `close`, unless the
  presentation ended the client itself. That call runs in a microtask: Bun runs a close handler
  synchronously within the call that closes the socket, and no call the presentation makes to a
  sink may take a client away from it while it serves that client. (Bun's own close at its
  backpressure limit was measured to run after the `send` that reached it returned.) A socket the
  presentation ended has its frames ignored. Another handler that throws is logged, and Bun's
  `error` handler closes its socket with 1011; a fetch that throws is answered with 500. `stop()`
  is Bun's `stop(true)`: it stops listening and closes every socket with 1001, running each close
  handler.
- **Logs.** `refused` with the status and reason, `open` and `close` with the code and the count of
  connections, `binary_frame` with its size, and `handler_error` with the error's name. Never an
  address, a header, a payload, or an error's message, which could quote what a client sent.

**Codespaces, unverified.** A Codespace forwards a port that listens on localhost. The plan relies
on GitHub's documentation for two expectations: a forwarded port is private by default, and
forwarded connections arrive from 127.0.0.1, so `MAX_CONNECTIONS_PER_IP` counts them together. T6-7
measured neither, nor how the proxy sets `Host` on a forwarded request: that needs the forwarded URL
from outside the machine, which T6-7 did not use. If the proxy keeps the browser's `Host`
(`<name>-<port>.app.github.dev`), the default allowlist refuses it with 403, and a developer who
wants it through adds that name to `ALLOWED_HOSTS`. Either way the port must stay private, which
the server's warning at start says.

`transport.test.ts` runs the listener on a free loopback port over a presentation of a model
world, driven period by period:

- `route` on a table of cases, the `Host` before the method among them, and `Capacity` on its own;
- the health check, 404 with no CORS header, 426 before the upgrade, and the listener's own 426
  for a WebSocket version other than 13; a handshake Bun cannot complete, answered with the
  listener's 400, its slot back for the next client; 500 when answering a request throws;
- an `Origin` matched exactly and its absence accepted; a `Host` refused on every path and method;
- 503 with `Retry-After` at the cap of one address, with a second address, 127.0.0.2, still
  admitted, and at the global cap, until a socket closes; a client that leaves in the middle of
  its handshake gives its slot back;
- the close codes 1003, 1009 (a frame of 4,096 bytes passes), 1008, 1011 (a planted terrain fault,
  a `connect` that throws, and a `receive` that throws), and 1001; a close that releases the client
  unless the presentation ended it; and logs that hold no address and nothing a client sent;
- Bun's limits: `SOCKET_OPTIONS` equals ADR 0026's numbers, since an idle timeout of 120 s and its
  pings cannot be observed in a test's time; `websocketOptions` keeps them over handlers that try to
  override every one; and a client that does not read is closed by Bun once
  1 MiB waits for it, released once; and Bun 1.4.4 runs the open handler within `upgrade`, which the
  slots rely on.

Plan test 13 runs on real sockets: over one chunk of 65,536 beings, about 6 MB, a client that
stops reading (`pause()`) lags alone once loopback's buffers are full, while a client that reads
does not; when it reads again, Bun's `drain` makes the presentation send it more before any other
period runs. The test asserts only what the code guarantees: the buffer stays under 512 KiB, and
the lag comes within a generous bound of periods, since how much loopback absorbs is the kernel's
(at most `tcp_wmem`'s maximum, 4 MiB by default, and a window that does not grow while nothing
reads). A second test pins the Bun behavior that relies on, with no code of the server: a paused
client makes `send` return −1 past what loopback absorbs, and 16 MiB pushed arrive whole once it
reads, after a `drain`.

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
| `state()` | The world's state: `halted` once the host halted or the journal failed, otherwise the scheduler's, with `journalStall` as `stalled` |
| `status()` | The world plane's status, shaped for `ServerStatus` of `@open-origin/protocol/admin`; this plane has no clients, so the presentation's members are zero |
| `unhandledRejection()` | Asks `rejectionPolicy(AI_MODE)`; with `off`, the world halts |
| `halted()` | Why the world halted, for the entry point's log (C3): the host's halt, its code, tick, and cause, or `undefined` while it runs |

`deps` carries the clock and the timer, which the entry point takes from `src/adapters/`,
and, for tests, the journal, the source, the projection of its world, the scheduler (`schedulerOf`,
a `TickScheduler` over the options a `FixedRateScheduler` takes), and K. A journal failure
halts the host with `journal_failed` and the gate's `failure`. The status reads `E`, `C`, and `P`
from the gate, and its state is `state()`. `projectionMicros` holds the percentiles of each
projection's duration on the injected clock over the last 1,024 ticks; `stepMicros` covers the
whole tick, the projection included. `omittedSpeech` is the projection's count of speech left out
for text that is not plain text, when the projection keeps one (`BeingsProjection` does; a test's
projection may not, and counts 0).

`rejectionPolicy` is a pure function: with `AI_MODE=off` an unhandled rejection halts the world,
because no code of the world awaits anything, and async work in a brain would be a wall-clock
channel. The entry point installs the process handler that calls `unhandledRejection`.

`composeServer(config, deps)` wires both planes: it calls `compose`, then builds the `Presentation`
from the world plane's `subscribeToPublished`, `readTerrain`, and `state` alone, with the same clock
and timer, the configured rate, F, and `MAX_RETAINED_BYTES`, and hello's world: a random id of 16
bytes, fresh at every boot unless a test gives `worldId`, and the configured durability. Its
`start()` starts the presentation's periods, then the world's clock, so a presentation that cannot
start leaves no world running; `stop()` stops the periods and detaches the presentation, then stops
the world, resolving once every executed tick is published. Its `status()` is the world plane's
status with the presentation's telemetry, and `fanOutMicros`, the percentiles of the last 1,024
fan-outs' durations on the injected clock. The entry point calls it, and T8's admin listener
serves its status. `compose.test.ts` runs it with a small limit of retained bytes: the memory guard
aborts a lagging client three times and closes it with 1013, and the status carries every count of
the presentation's telemetry, each but `trims` above zero.

## Entry point

`src/main.ts` runs the server as a process. To run it on this machine, in ephemeral mode, on
`127.0.0.1:8080`:

```sh
OPEN_ORIGIN_DURABILITY=ephemeral bun run --bun apps/server/src/main.ts
```

`OPEN_ORIGIN_PORT=0` lets the system choose the port, which the `listening` line reports. The
world is the default world of T5, a new one with a new id at every start; a client connects to
`ws://127.0.0.1:<port>/ws` with the subprotocol `open-origin.public.v1`.

`start(env, log, deps)` builds the server, for tests too:

1. It reads the configuration with `parseConfig`. When the configuration is refused, it logs each
   problem as `config_error`, naming the variable and its rule, all at once, and starts nothing:
   among them, no `OPEN_ORIGIN_DURABILITY=ephemeral` ("no durable journal is available until T7"),
   a host that is not loopback, and an `AI_MODE` other than `off`.
2. It logs each warning as `config_warning`: with `CODESPACES=true`, that the forwarded port must
   stay private.
3. It wires `composeServer` with the real clock and timer of `src/adapters/` (tests may give fake
   ones, a source, its projection, a journal, or a server of their own, `serverOf`) and the
   transport. A port it cannot bind is logged as `listen_failed` with the error's code
   (`EADDRINUSE`) and no message.
4. It starts the server. When that throws once the listener bound, it logs `start_failed` with the
   error's name and the port it bound, then stops the transport and the server, logging each stop
   that fails as `stop_failed` with its part and the error's name, and returns the start's error as
   the cause: a stop's failure never replaces it.

It returns the running server, whose `stop()` stops the transport first, closing every socket with
1001, then the server, which flushes every executed tick (RPO 0 once the journal is durable), and
logs `stopped` with the executed, committed, and published ticks, the state, and the halt, if
any. The server stops even when the transport fails to; every call returns the same promise.

`main(host, deps)` binds a started server to its process, `host`, which tests replace with a
double: it installs every handler, then logs `listening` with the host and the port, so a
supervisor that signals on that line always finds the handlers in place.

| Event | What happens |
|---|---|
| A refused configuration, a port it cannot bind, or a start that throws once bound | Exit code 1, after the `config_error`, `listen_failed`, or `start_failed` lines; no crash |
| SIGTERM or SIGINT | `signal`, then `stop()`, then exit code 0, or 1 if stopping failed (`stop_failed`, with the error's name) |
| Another SIGTERM or SIGINT less than 1 s after the first | `signal_ignored`, with the signal: a duplicate, such as the copies a terminal's Ctrl-C sends both a wrapper (`bun run`) and the server |
| Another SIGTERM or SIGINT 1 s or more after the first | `forced_exit`, with the signal, then exit code 1 at once |
| `unhandledRejection` | The world halts by `rejectionPolicy(AI_MODE)`: with `off`, every client hears `status` `halted`. The line `unhandled_rejection` carries what was thrown (`causeOf`: an engine error's code, else its message and code) and the ticks; the server keeps serving the halted world |

Every exit but the forced one waits until the lines before it reached stdout: an empty write goes
after them, and the process exits in its callback. The forced exit does not wait: stdout may be a
stalled pipe, the very case in which a stop may hang, and losing the `forced_exit` line is better
than not exiting. The server sets no deadline on a stop: once the journal is durable, a stop can
hang on it, and a supervisor brings its own grace period, then a second signal forces the exit.
The 1 s that separates a duplicate from a forced exit is measured on the server's clock.

The log is JSON lines on stdout, the transport's events among them: events with codes, ticks,
counts, and sizes, never a payload or an address, which are C2. An exception no handler catches,
such as a fault of the whole presentation plane, ends the process with exit code 1 and Bun's own
report on stderr, flushing nothing: with the ephemeral journal there is nothing durable to lose.

`main.test.ts` runs `start` and `main` in process over the counting world on a fake clock and a
double of the process:

- `start` refuses every problem at once, reports a port in use as `listen_failed`, and, given a
  server whose start throws and whose stop then rejects, closes the listener on the port it bound
  and returns the start's error as the cause; and it stops the transport before the world flushes:
  a journal that counts the open sockets at each append sees one at the first batch and none at
  the last;
- `main` binds every handler before `listening`; SIGTERM and SIGINT each close a client with
  1001, publish the two ticks a batch held (seven executed, five committed before), and exit with 0
  only once the pipe took the `stopped` line; on a stdout that never drains, a signal 1 µs short of
  1 s after the first is ignored and one at 1 s forces exit 1 at once; an unhandled rejection halts
  the world; a refused configuration, a port in use, and a start that throws exit with 1 once
  written.

`tests/e2e/server.test.ts` (ADR 0019) spawns `main.ts` with `Bun.spawn` on port 0:

- at 50 Hz, it reports its port; two clients receive commits, follow the same being, and show the
  same views at every tick both committed, and no frame they got holds a seed of the default
  world, its terrain, or its spawns, or the key `terrainSeed`, though real terrain reached them; a
  rejection that `tests/e2e/fixtures/reject-on-input.ts` plants on request, as a `bun --preload` in
  the server's own process, halts the world for both; SIGTERM closes them with 1001 and exits with
  0, every executed tick published;
- signalled with SIGINT in the very task that reads its `listening` line, it stops and exits with 0;
- started without ephemeral mode, on `0.0.0.0`, and with `AI_MODE=on`, it names the three problems
  and exits with 1.

A stdout line that is not JSON is kept and expected absent, so a failure shows it. The server's
code has no switch for tests.

## Terminal probe

`apps/server/tools/probe.ts` is a minimal public client for a terminal: it connects to a running
server, applies every message with the protocol's reference reducer, `applyMessage`, and prints a
screen at each commit. To watch the spawn area of the default world, following its being 1, on a
server started as above:

```sh
bun apps/server/tools/probe.ts --around 0,0 --follow 1
```

| Option | What it does |
|---|---|
| `--url ws://host:port/ws` | The server's listener; `ws://127.0.0.1:8080/ws` unless given. A `ws:` or `wss:` URL |
| `--chunk x,y` | Adds a chunk to the camera; may be given more than once |
| `--around x,y` | Adds the square of chunks within `--radius` of a chunk, 1 unless given: 9 chunks, at most 49 (radius 3) |
| `--follow id` | Follows a being: its window of 3 × 3 chunks joins the view |
| `--commits n` | Exits with 0 after n commits |

With neither `--chunk` nor `--around`, it subscribes to no chunk and shows the clock and the feed.
The camera is checked with the protocol's own schema before anything is sent, so a camera of more
than 64 chunks, a repeated chunk, or one outside the world is refused at start; any argument it
does not know, or gives twice (but `--chunk`), exits with 2 and the usage.

A screen shows the link, the world's id, durability, and state, the clock of the last commit (its
tick, day, and thousandths of the day), the followed being, the visible chunks with their version
and count of beings, the beings, the last 16 items of speech and of the feed, the chunks the view's
limit left out (the last `notice`), the count of `error` messages and the last one's code, and its
counts of commits, anomalies, frames the strict schema refused, resyncs, and reconnects. On a
terminal it redraws in place; otherwise it prints each screen after a blank line. A `follow` of a
being the world does not hold yet, as right after a start, before the spawns of tick 1 are played
out, gets `unknown_being`, which the screen shows; the probe asks again only on its next
connection.

It behaves as ADR 0026 asks of a client:

- On each connection it sends `subscribe` and, when asked, `follow`: the server keeps no session.
- After an anomaly the reducer reports, it sends `resync`, at most once every 2 s
  (`RESYNC_INTERVAL_MS`); the reducer keeps the old view, marked stale, until the reset. The server
  measures the 2 s between the times it receives two resyncs, which the network's jitter can bring
  under 2 s though the probe sent them 2 s apart: after `resync_too_soon`, the probe asks again
  once its own 2 s allow.
- A connection that does not open, or hears nothing, for 3 s (`STALE_AFTER_MS`) is given up. It
  then reconnects, as after a close, with `reconnectDelayMs`: 0.5 s to 1 s at first, doubling up to
  30 s, and at least 5 s after an HTTP 503, which Bun's client reports only in the text of its
  error event (`Expected 101 status code: 503`). A `hello` starts the backoff over. Each connection
  has a generation, and the events of a socket it gave up are ignored.
- Ctrl-C (SIGINT) or SIGTERM closes the socket with 1000 and exits with 0.

**Nothing the server sends reaches the terminal raw.** `sanitize` (`tools/probe-screen.ts`) writes
every code point a terminal could act on as `\u{XXXX}`: the C0 and C1 controls, DEL, the line and
paragraph separators, the bidirectional controls and every invisible code point of the protocol's
`FORBIDDEN_CODE_POINTS`, and lone surrogates. So `\x1b[2J` prints as `\u{1B}[2J` and clears
nothing, and U+202E prints as `\u{202E}` and reorders nothing. A backslash is doubled, so text that
spells `\u{1B}` out never reads like an escaped ESC. Markup such as `<script>` is text, kept as it
is. Every line of a screen passes through it, so the protocol's refusal of text that is not plain
text is not the probe's only defense.

`probe.test.ts` checks `sanitize` on hostile inputs with exact outputs (ANSI, OSC, C1, NUL, DEL, a
line feed, U+202E, U+2028, U+200D, a lone surrogate, a tag, and a backslash), at both ends of
every range of `FORBIDDEN_CODE_POINTS` and of the surrogates, and just outside them; the arguments; the backoff, 7.5 s after a 503 at the test's draw of 0.5, and
its reset at `hello`; a socket given up that cannot act; the silence of 3 s; one `resync` per 2 s;
a resync the server, a presentation in the test's process, refuses at 1.999999 s by its clock,
asked again at 2 s by the probe's and not 1 ms sooner, and the view current again after the reset;
frames the schema refuses; an `error`, shown at once; and `stop`. Then a probe connects over a real socket to a presentation
of a model world in the test's process and prints two commits: the clock, the followed being, the
nine chunks of its window, a greeting in the feed, and speech holding `<script>` shown as text.

## Benchmarks

Three manual benchmarks measure the budgets of plan §11 that tests cannot: `bench/projection.ts`,
`bench/fanout.ts`, and `bench/load.ts`. They measure wall-clock time, so `bun test` and `check`
never run them; `bench.test.ts` checks their arguments, statistics, budgets, and the core of each run
with tiny parameters. Each prints the machine class (CPU model, logical cores, memory, and Bun's
version) and the CPUs and nice value its processes run with, read from `/proc`. Percentiles are by
nearest rank, as the server's status takes them. Run one at a time, each under a minute, while the
load average is below 2, pinned to one CPU and at the lowest priority, as AGENTS.md lists them.

### Projection

```sh
taskset -c 0 nice -n 19 bun apps/server/bench/projection.ts [default] [dense] [--ticks N]
```

Each tick is stepped with the engine's `step` and projected by `BeingsProjection`, as the host does,
each timed apart. `default` is the default world of T5, ticks 101 to 20,100; `dense` is the beings
benchmark's "dispersed 1,000" (1,000 beings under `utility@1`, one to a chunk, two chunks apart),
ticks 101 to 2,100, a third of a simulated day, so a run of both stays under a minute on one core.
It prints the step's and the projection's p50, p95, and p99, the projection's share of the step
(the sum of its times over the sum of the step's), the chunks the step changed and the records
published per tick, and the bytes of each published tick.

### Fan-out

```sh
taskset -c 0 nice -n 19 bun apps/server/bench/fanout.ts [same-chunk] [same-followed] [churn]
  [dense-chunk] [--clients 1,10,100,1000] [--periods N]
```

N clients in the benchmark's process, each a sink that counts the bytes and commits it is sent and
never lags, watch a `Presentation` that replays published ticks recorded once, one tick a period:

| Scenario | What every client does |
|---|---|
| `same-chunk` | Subscribes to the chunk of the default world that holds the most beings |
| `same-followed` | Follows the being of the default world whose record changes most often |
| `churn` | Pans a camera of 3 × 3 chunks one chunk a period around the spawn area, each from its own place on a ring 4 chunks out: a `subscribe` a period through `receive`, 3 chunks new each time |
| `dense-chunk` | Subscribes to the chunk of the beings benchmark's "concentrated 1,000 in 1 × 1", 1,000 beings in one chunk |

The default world is recorded from tick 501, once its beings are awake (they sleep from tick 2 until
past tick 260); the dense one from tick 3, after its spawns and first decisions. The presentation's
clock is the system's, moved ahead 200 ms at each period, so its buckets see periods 200 ms apart
while the fan-out's budget of 40 ms and the duration it records (`recordFanOut`, the status's
`fanOutMicros`) are real. A run warms up until every client committed once, at most 60 periods, and
measures 100. It prints the sync's periods and slowest fan-out, the fan-out's and the whole period's
p50 and p99, the churn's input, each client's bytes a period (p50 and p99), the most commits a client
got in a period, the share of client-periods with a commit, and the most clients deferred to the next
period, which got nothing in it.

### Load

```sh
taskset -c 0 nice -n 19 bun apps/server/bench/load.ts --clients N [--seconds S] [--ramp R]
taskset -c 0 nice -n 19 bun apps/server/bench/load.ts --sync
```

The real server runs in a process of its own, `bench/load-server.ts`: `start` of `src/main.ts`, in
ephemeral mode on a free loopback port, with the real clock, timer, and transport, and its caps
raised by configuration to hold N clients from 127.0.0.1 (`MAX_CONNECTIONS_PER_IP`). The clients run
in another, `bench/load-clients.ts`, both children of the driver, `bench/load.ts`, and pinned as it
is. The server boots for 2 s; the clients open R a second (100 unless given), each subscribed to the
9 chunks of the spawn area, and once every client committed, the driver measures for S seconds (20
unless given). Each load client reads only the head of a commit frame, its tick, and counts the bytes
of every frame, so the clients' process costs the shared core as little as it can.

The server's process adds what the protocol must never carry, over its own stdin and stdout:

- **Marks.** Its presentation's `period` is wrapped on that instance, so each period that plays out
  a new tick records the wall-clock time it began (`performance.timeOrigin + performance.now()`,
  which every process of the machine reads alike), and how many ticks the world had executed beyond
  it: E less the played-out tick, the publication's delay. The latency of a commit is the time a
  client got it less the mark of its tick.
- **Ticks.** It composes the server as `composeServer` does, through `start`'s `serverOf`, with a
  `FixedRateScheduler` whose `runTick` is timed on the server's clock: the span the status's
  `stepMicros` covers (the step, the projection, and the journal's append), read over the window
  alone. The status's own window is the last 1,024 ticks, which in a run of under a minute holds the
  boot. The scheduler's ticks are counted too, which is E, since the default world boots at tick 0.
- **Status and memory.** The server's C3 status, as `server.status()` gives it and the admin
  contract checks it, and the process's resident and heap memory after a full collection: before any
  client connected and once every client synced. Their difference over N is the memory per client
  at rest.

It prints the clients that failed to open, the time to open and sync them, the tick (from the status
and over the window), the status's projection, lateness, and fan-out, the latency from playout to
receipt (p50, p95, and p99), the ticks executed beyond the played-out one, each client's commits per
period played out in the window and its commits that came less than half a period after the one
before, the memory per client, the status's lagging clients, slow closes, aborts, and faults, and
the highest load average it saw.

With `--sync`, a fresh server, whose terrain is all uncached, gets one client of the reference
reducer, which subscribes, once its first (empty) commit arrived, to the 64 chunks of 8 × 8 around
the spawn area: the milliseconds and bytes from that `subscribe` to the commit that shows all 64.

The driver refuses to start while the load average is 2 or more, stops a run when it stays above 2
for 15 s, and stops its children, killing any that does not exit within 5 s.

### Measured budgets

Measured on 2026-11-03 with the code of `48c5973`, on a GitHub Codespace: an AMD EPYC 7763, 2 logical
cores, 7.8 GiB of memory, and Bun 1.4.4. **Every process of every run, the benchmark, the server,
and the clients alike, ran on CPU 0 alone at nice 19** (`taskset -c 0 nice -n 19`): half the
machine, shared with the editor's own processes, and in `load.ts` the server and up to 1,000 clients
share that one core. The numbers are pessimistic for this machine and promise nothing of another;
compare runs on one machine only. The load average stayed under 1 in every run of `load.ts`.

| Budget (plan §11) | Measured | Verdict |
|---|---|---|
| Server tick (step, projection, journal), default world: p99 ≤ 20 ms | Over each run's window of 20 s: p99 0.68, 2.53, 3.04, and 1.71 ms with 1, 10, 100, and 1,000 clients (p50 0.25 to 0.29 ms). The status's `stepMicros`: p99 35.9 to 38.9 ms, the second-slowest tick of the about 115 to 170 a run held, before its window: the boot, the ramp, or the sync (`load.ts`) | Met over the window; the status's own p99 misses while its 1,024 ticks hold the boot, which leaves them after 3.4 minutes at 5 Hz |
| Fan-out per period: p99 ≤ 5 ms with 100 clients; a target of 40 ms with 1,000 | 100 clients, 100 periods: 4.71 on one chunk, 25.49 following one being, 40.57 panning, and 4.85 ms on the dense chunk; a second run 7.99, 21.09, and 7.83 ms (panning not run again); over 500 periods 5.10, 21.69, 40.07, and 8.54 ms. 1,000 clients: 26.63, 44.79, 46.95, and 30.17 ms (`fanout.ts`). The real server's status with 100 clients on 9 chunks each, since boot: 40.8 and 70.6 ms (`load.ts`) | Missed with 100 clients: on one chunk and on the dense chunk the p99 straddles the budget (4.71 to 8.54 ms over three runs), and following a being or panning exceeds it four to eight times. With 1,000, met on one chunk and on the dense chunk; following and panning reach the fan-out's own budget of 40 ms, which defers up to 883 and 956 clients to the next period |
| Projection of changed chunks: p99 ≤ 2 ms on the default world; ≤ 10 % of the step in dispersed 1,000 | 0.69 ms over 20,000 ticks; 8.33 % over 2,000 ticks (its p99 4.40 ms, the step's p50 13.4 ms) (`projection.ts`) | Met; met |
| Playout to receipt, localhost: p99 ≤ 50 ms with 100 clients | 15.10 and 27.15 ms in two runs; 1.98 with 1 client, 5.03 with 10, and 40.02 with 1,000 (`load.ts`) | Met |
| Publication delay, E to playout: ≤ 2F ticks and an acknowledgement (≈2 s in ephemeral mode) | E ran 4 ticks ahead of the played-out tick at p50 and p99, 5 at most, with 1 to 1,000 clients: 0.8 to 1.0 s (`load.ts`) | Met; the estimate of 2 s is a bound, and the delay is half of it |
| Rate per client: at most 1 commit a period, no bursts; exactly 1 in the steady state | No client got a commit within half a period of its last in any run, nor two in one period (`fanout.ts`). Commits per client and period: 1.000 with 1 and 10 clients, 1.000 and 0.962 with 100, 0.485 and 0.511 with 1,000 (`load.ts`) | At most 1: met. Exactly 1: met to 10 clients; with 1,000 on one core shared with them, the fan-out's 40 ms serves about half the clients a period |
| Memory per client: ≤ 64 KB at rest; its queue ≤ 1 MB | Resident memory per client at rest, after a full collection: 59.6 and 51.0 KiB with 100 clients, 29.2 and 31.2 KiB with 1,000; heap 17.0 and 8.1 KiB. With 1 and 10 clients the difference is the process's own growth (3.3 to 6.5 MiB, 0.7 MiB) and says nothing per client (`load.ts`) | At rest: met with 100 and 1,000. The queue: not measured, since no run makes a client lag; the outbox of at most 13 messages and the buffer under 320 KiB are held by tests |
| Terrain: ≤ 16 chunks generated a period (≈8 ms), a fair queue, an LRU of 2,048 | The 64 uncached chunks of the sync entered in 4 commits, one a period (`load.ts --sync`) | Not measured as a cost; the cap, the queue, and the LRU are held by tests (`presentation-terrain`) |
| Sync of 64 chunks, default world (≈450 KB estimated): ≤ 1 s with uncached terrain | 822.7 and 828.2 ms in two runs; 799,966 bytes from the `subscribe` to the commit (`load.ts --sync`) | Met. The estimate is corrected: 781 KiB, not 450 KB |
| Delta per client, default world: median ≤ 1 KB, p99 ≤ 8 KB | Every client on one chunk: 92 B and 312 B over 100 periods, 95 B and 330 B over 500. Following one being: 92 to 93 B and 315 to 464 B, 95 B and 527 B over 500 (`fanout.ts`) | Met |
| Resynchronization: as the sync, the previous view consistent meanwhile | Not measured apart: the sync of 64 uncached chunks bounds a resync whose terrain the LRU evicted, and a resync of cached terrain waits for none | Not measured |
| Scenarios of 1, 10, 100, and 1,000 spectators, the cap per address raised by configuration | All four ran, in `load.ts` and `fanout.ts`, with no client refused, closed for slowness or strikes, aborted, or faulted | Measured |
| Being record ≤ 256 B; part ≤ 64 KB; ≤ 256 KB a client and period, buffer ≤ 512 KB; view ≤ 32 MB; retained versions ≤ 128 MB; the largest chunks and view of `beings@2` and `beings@1`; input limits | Held by the tests the plan names for them, not by a benchmark. The most a client got in a period in `fanout.ts`: 110 KiB (p99, panning, 1,000 clients) | Not measured by a benchmark |
| CI: T6 adds ≤ 3 s to the parallel step, each step ≤ 70 s | Measured by the CI of each pull request | Not measured here |

Not measured either, and why:

- **The terrain a lagging client holds** (tracker L73: at most 64 KiB of terrain text, down from
  905,273 B): no benchmark makes a client stop reading while its transaction's terrain is evicted,
  and a process's resident memory cannot single one client out. Tests hold the bound.
- **Clients beyond 1,000, and several machines.** Nothing was run past 1,000 clients, nor with the
  server and its clients on cores of their own.

What the runs show besides the budgets:

- The world plane keeps its time under every load measured: its tick stays under 3.1 ms at p99
  whatever the clients do, and the fan-out delays it within a period (lateness p50 39.5 ms and p99
  45.2 ms with 1,000 clients). Plan §12's trigger for a Worker, a tick p99 above half a period, is
  far off.
- Following a being costs about seven times as much per client as watching one chunk (fan-out p50
  4.85 against 0.66 ms with 100 clients).
- Past 40 ms the fan-out defers clients rather than delay the world: with 1,000 clients each one
  commits about every other period, and none is closed.

The tables the runs printed, condensed (times in ms):

| `projection.ts` | Ticks | Step p50 / p95 / p99 | Projection p50 / p95 / p99 | Share | Records a tick, p50 / max | Bytes a tick, p50 / p99 |
|---|---|---|---|---|---|---|
| default | 20,000 | 0.025 / 1.468 / 4.527 | 0.004 / 0.244 / 0.689 | 17.07 % | 0 / 8 | 97 / 388 |
| dense (dispersed 1,000) | 2,000 | 13.429 / 31.114 / 46.079 | 1.117 / 2.898 / 4.398 | 8.33 % | 32 / 78 | 4,951 / 10,741 |

| `fanout.ts`, 100 periods | Clients | Sync periods | Fan-out p50 / p99 | Bytes a client and period, p50 / p99 | Client-periods with a commit | Most deferred |
|---|---|---|---|---|---|---|
| same-chunk | 1 / 10 / 100 / 1,000 | 1 / 1 / 1 / 4 | 0.047 / 1.085; 0.179 / 2.959; 0.662 / 4.706; 7.439 / 26.628 | 92 / 312 | 100 % to 100; 99.7 % | 0; 271 with 1,000 |
| same-followed | 1 / 10 / 100 / 1,000 | 1 / 1 / 2 / 12 | 0.077 / 3.669; 0.360 / 4.660; 4.851 / 25.492; 40.025 / 44.786 | 92 / 315 to 464 | 100 % to 10; 99.7 %; 80.2 % | 30; 883 |
| churn | 1 / 10 / 100 / 1,000 | 1 / 1 / 1 / 4 | 0.265 / 8.756; 2.457 / 14.808; 14.265 / 40.565; 40.198 / 46.945 | 37,656 / 37,662 to 112,576; p50 0 with 1,000, most deferred | 100 % to 10; 99.2 %; 11.5 % | 44; 956 |
| dense-chunk | 1 / 10 / 100 / 1,000 | 1 / 1 / 2 / 12 | 0.063 / 2.068; 0.165 / 3.249; 1.289 / 4.852; 8.833 / 30.165 | 91 / 418 | 100 % | 0 |

| `load.ts` | Ramp and sync s | Tick, window p50 / p99 | Tick, status p99 | Fan-out (status) p50 / p99 | Playout to receipt p50 / p95 / p99 | Commits a client and period | RSS / heap a client KiB |
|---|---|---|---|---|---|---|---|
| 1 client | 0.2 | 0.282 / 0.680 | 37.908 | 0.275 / 2.430 | 0.509 / 1.718 / 1.982 | 1.000 | (3,364 / 267: no per-client meaning) |
| 10 clients | 0.4 | 0.267 / 2.529 | 35.888 | 0.951 / 13.931 | 1.194 / 3.237 / 5.028 | 1.000 | (699 / 55: no per-client meaning) |
| 100 clients | 1.2 | 0.293 / 3.035 | 36.907 | 8.375 / 70.598 | 5.055 / 12.131 / 27.148 | 0.962 | 51.0 / 17.0 |
| 1,000 clients | 10.4 | 0.250 / 1.705 | 38.936 | 40.112 / 42.855 | 21.120 / 38.514 / 40.020 | 0.511 | 31.2 / 8.1 |

The `load.ts` rows are the second run of each; the first, before the delay of publication was
measured, gave with 100 clients a latency p99 of 15.10 ms, commits 1.000 a period, and 59.6 KiB a
client, and with 1,000 clients 40.04 ms, 0.485, and 29.2 KiB. The sync took 822.7 and 828.2 ms.

## Observer invariance

`observer-invariance.test.ts` checks P9 (ADR 0005, control 1 as ADR 0025 refines it) through
`composeServer`, on a fake clock, with a constant `readTerrain`, over the `mind@1` subject world of
T5: three beings that greet, tell, forage, and cross chunks, and a research injection, an admin
command, at tick 30. The default world sleeps from its second tick until past tick 260, too still
for a brain's leak to show in a run. A reference run with no observer is compared with runs of 100
ticks with 1 and 32 simulated observers, which act half a period after each tick. They connect and,
through `receive` with the text a client would send, subscribe, all follow the same being, change
camera and followed being at random, resync, ping, and send hostile messages (no JSON, binary-like
text, types that would control time, extra keys, `__proto__`) that earn strikes, and, in the run of
32, closes for strikes. Their sockets stall, holding at least 256 KiB, and then drain slowly, so the
presentation holds their messages back until `drained`. They disconnect midway and come back. The
four clients of the crossing below subscribe and follow through `receive` too. For every tick, the
fake-clock time at which the host asked for its commands, its full command list, rejected commands
included, its checksum, and the bytes of its `PublishedTick` must be equal, and so must the final
snapshot. The checksums are read from the journal's records, never through the protocol.

The run of 32 observers also checks plan test 9 in the subject world: four clients of the
protocol's reducer watch its first chunk crossing, the client of the chunk the being leaves, of the
chunk it enters, of both, and its follower. After every commit each view equals the world the gate
published at the commit's tick, and the crossing falls between two of each client's commits: the
being leaves one chunk and enters the other in one transaction, and the follower's window moves
with it.

The run and the comparison live in `test/support/invariance.ts`. `ws-world.test.ts` shares them for
the variant over real sockets: the subject world runs 40 ticks behind the real transport on a free
loopback port, and ten clients of Bun's WebSocket act between periods, the test waiting after each
until every frame, each way, arrived. Every tick and the final snapshot equal a run with no client.
The clients are:

- two calm clients of the subject's chunks, which see the same ticks and the same views, each the
  published world at its commit's tick (plan tests 1 and 2);
- a client of a distant region, which floods the bucket of new chunks once, with one strike, and
  then hears the same feed as the calm ones (plan test 10);
- a follower that follows a being the world does not hold (`unknown_being`, no strike), then
  churns camera and followed being at random, pings, and resyncs;
- a client that stops reading for ten periods and catches up, consistent at every commit, and one
  that leaves and comes back to a new `hello` and a reset, each of its commits from its return the
  published world;
- the hostile battery (plan test 12): a binary frame closed with 1003, a frame over 4 KiB closed with
  1009, bad JSON, `__proto__`, and a type that would pause the world, closed with 1008 on the third
  strike, and 25 pings at once, 20 answered and the rest refused until 1008.

The same file scans the bytes real sockets carried (plan test 11): every frame of every client
parses with the strict schemas, the calm clients heard greetings and tells, and no frame holds a
taint, a seal, a checksum, or the state root of the subject, after its research injection; a run of
the canary world through the same transport, watched and its sitter followed, holds none of its
canaries, seeds, seals, or state root either. The helpers of the scan live in
`test/support/leak.ts`, which `leak.test.ts` shares.

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
and `transport/` included, keeps every rule, and each rule is also proved on planted trees whose
legal version passes. The same
reader rejects, in `packages/scenarios/src` and `packages/protocol/src`, a relative path that leaves
`src`, a type-level `import()`, a `require()` or `import.meta.require()`, a computed specifier, and a
triple-slash reference directive, which their Biome rules cannot see.

`published.ts` imports only types of `@open-origin/protocol/public`, so a type-only import of it gives
the presentation plane no path to the engine: a published tick holds protocol records and numbers,
never an engine type.
