# 0026. Public protocol v1: audiences, transactions, interest, and C0 projections

- Status: Accepted
- Date: 2026-11-02

## Context

T6 builds the per-audience protocol and its projections ([0008](0008-data-classification-and-audience-projections.md):
"T6 builds the projections"). The plan sketches the protocol in §I.3:

- **Server to client:** `hello`, `snapshot`, `delta`, `events`.
- **Client to server:** `subscribe(chunks)`, `follow(beingId)`, `ping`.
- **Rules:** pub/sub by chunk, every message carries its tick, and a gap triggers a resync. This ADR
  refines all three below: sends per client, a tick defined per message, and a resync only on an
  anomaly.

Other documents fix the rest:

- **[0022](0022-single-shared-public-universe.md)** requires four things:
  - no message that controls time;
  - a feed for every client;
  - "local speech" that follows chunk subscriptions;
  - clients that "never compute or adjust a clock of their own".
- **[0023](0023-autonomous-beings.md) and [0024](0024-mind-memory-beliefs-and-speech.md)** put the
  classes of beings, events, and commands in a registry, and leave the projections to T6.
- **T5 left one open item:** the template text the feed shows has to be escaped (tracker L65).

Code and review added these facts (tracker L67):

| Fact | Consequence |
|---|---|
| Bun's topic publish reports status in aggregate | It cannot tell which client lagged |
| A chunk holds up to 1,024 beings under `beings@2` and 65,536 under `beings@1` (`packages/engine/src/beings/chunk.ts`) | One dense chunk can outgrow any per-message or per-period limit |
| Terrain is estimated at about 7 KB per chunk, to be measured once its DTO exists | Even 64 empty chunks would not fit in 256 KB |
| Raw `depletion` (`{cell, taken, since}`) shows how much each being ate (C1) and when food regrows (C3) | It cannot be public |
| `changedChunks` lists every write, and about 97 % of writes change only a being's body | Versioning by engine dirtiness would leak when C1 and C3 change |
| `simSecondsPerTick`, sent with the day's position, gives the day's length in seconds | That is a law parameter, C3 under [0008](0008-data-classification-and-audience-projections.md) (O-15) |

## Decision

We will speak one versioned JSON protocol per audience, built only from explicit C0 projections. Each
client's view moves between ticks atomically, through transactions read from pinned, immutable chunk
versions.

### Package, versioning, and the runtime dependency

- **Package.** `packages/protocol` exports `./public` and `./admin`, with no root export. `public` never
  imports `admin`. The package imports no `bun`, no `node:*`, and nothing from the domain.
- **zod.** It depends on zod 4.6.7, pinned exactly. Zod validates input, and the outbound schemas use
  `strictObject`.
- **Runtime dependencies.** A runtime dependency follows the rules [0015](0015-automated-quality-gates.md)
  set for dev dependencies: an exact pin and a release at least 14 days old. `workspace:*` is allowed. A
  repository test checks both.
- **Wire.** Text JSON, uncompressed in v1. The client asks for the subprotocol
  `open-origin.public.v1`; anything else gets HTTP 426 before the upgrade.
- **Versioning.** The server speaks exactly one version. Any change of shape raises the version and
  updates this ADR, `docs/architecture/protocol.md`, and the allowlist tests. In v0.1, web and server
  ship together.

### Client to server: an exact allowlist of four types

| Type | Fields | Rules |
|---|---|---|
| `subscribe` | `chunks: [[x, y], …]` | **Replaces** the camera interest (`[]` cancels it); at most 64, unique, within the world's chunk bounds |
| `follow` | `being: id \| null` | Presentation only |
| `ping` | `nonce` | An integer from 0 to 2³¹ − 1 |
| `resync` | — | At most once every 2 s |

Any other type, including any that names pause, speed, step, seek, rewind, tick, or rate, gets
`error{code: "unknown_type"}` and a strike.

### Server to client

Every message carries `type`, `seq`, and `tick`, defined under Ordering and liveness:

| Type | Fields | When |
|---|---|---|
| `hello` | `protocol`, `audience: "public"`, `world{id}`, `durability`, `state`, `clock`, `limits` | On connect. `world.id` is random at the world's creation, never derived from the seed, a label, or the genesis; in ephemeral mode every boot creates a world |
| `delta` | `txn`, `chunks[{at, v, gone[], upsert[], speech[], speechMissed?}]`, `drop[]` | Parts of a transaction: differences of visible chunks |
| `snapshot` | `txn`, `reset`, `chunks[{at, v, terrain?, beings[], frag{i, n}}]`, `followed?` | Parts of a transaction: chunks entering the view, or the whole view in a `reset` |
| `events` | `txn`, `items[]`, `missed?` | The feed in the transaction's range |
| `commit` | `txn`, `clock{tick, day, dayPermille}` | Closes and applies the transaction. An empty transaction still gets its `commit`, so a client that is up to date gets one per period: heartbeat and clock |
| `abort` | `txn` | Memory protection cancelled the transaction; the client discards its parts |
| `notice` | `code: "interest_trimmed"`, `chunks[]` | The view limit trimmed the interest: the chunks left out, or none when nothing is left out any more |
| `pong` | `nonce` | Answer to `ping` |
| `status` | `state: "running" \| "paused" \| "stalled" \| "halted"`, `reason?` | World stops and resumes, for everyone |
| `error` | `code` | A rejected message. The fixed codes are `bad_json`, `bad_message`, `unknown_type`, `too_many_chunks`, `out_of_bounds`, `unknown_being`, `rate_limited`, and `resync_too_soon`. The input is never echoed |

**Close codes:**

| Code | Reason |
|---|---|
| 1003 | A binary frame |
| 1008 | Strikes |
| 1009 | Size |
| 1013 | Too slow for its interest |
| 1011 | The server failed in serving the client: the WebSocket code for an internal error, chosen in T6-7 |
| 1001 | Shutdown |

Capacity is refused at the upgrade, with HTTP 503 and `Retry-After`.

### Ordering and liveness

- **`seq`** starts at 0 with `hello` and grows by exactly 1 per message.
- **`tick`.** The messages of a transaction (`delta`, `snapshot`, `events`, `commit`, `abort`) carry
  its target tick `L'`. Every other message carries the client's visible tick `L` when it is sent.
  The ticks of successive commits strictly increase. A gap between them is normal: a transaction
  covers every tick in `(L, L']`.
- **The client's rules.**
  - Any message resets a silence timer of `STALE_AFTER_MS`. When it expires, the client reconnects
    with backoff.
  - A `seq` gap, or a `commit` whose tick does not exceed the previous one, is an anomaly. The client
    then sends `resync`.
- **The server's duty.** While a client is not lagging, it gets at least one message per period: a
  part or a `commit`, or, in a period that brings it neither, `status` with the world's state,
  whatever that state is: while the world is stopped and its playout gives no new tick, or while
  the next part of its transaction waits for terrain. Terrain never holds up a view: a
  transaction brings the entering chunks whose terrain is at hand, and the others enter a later
  one. A lagging client is quiet only while its own buffer is full, and Bun's idle timeout and
  pings still apply.
- **Fields.**
  - `v` is the tick at which a chunk's C0 content last changed.
  - `followed` is the followed being's `BeingPublic`, even while its chunk is not shown (trimmed, or
    waiting for terrain), or `null` when it is gone.
  - `hello.state` takes the values of `status.state`.
  - `limits` holds `maxChunks`, `maxFollowChunks`, `maxMessageBytes`, `messagesPerSecond`, `burst`,
    `newChunksPer2s`, and `maxViewBytes`: limits on the client, none on the world's rate.

### The authoritative clock

The server computes `clock{tick, day, dayPermille}` with worldgen's calendar functions, from the state of
the published tick. It sends the clock in `hello` and in every `commit`:

- the client shows the clock of its last `commit`;
- it interpolates only what is drawn between commits, from measured arrival times;
- it never extrapolates the clock.

No public field carries the tick rate or the simulated seconds per tick. The cadence of commits still
reveals the tick rate to a patient observer, as the sun reveals the day's length in ticks: the class
removes the field, not the inference. The silence threshold is the protocol constant
`STALE_AFTER_MS = 3000`, and `CHUNK_CELLS = 32` is a protocol constant tested against the engine's.

| Field | Class | Why |
|---|---|---|
| `tick` | C0 | The shared clock ([0008](0008-data-classification-and-audience-projections.md)) |
| `clock.day`, `clock.dayPermille` | C0 | The observable effect of the day's law (the sun), computed by the server. An observer infers the day's length in ticks, as one inside the world would |
| `simSecondsPerTick` | C3 | World configuration. With the day's cycle it gives the day's length in seconds, a law parameter (O-15). Admin only |
| `TICK_RATE_HZ` | C3 | Configuration of the scheduler's operation ([0022](0022-single-shared-public-universe.md)). Admin only |
| `world.id`, `durability`, `state` | C0 | An opaque random id, an honesty notice, a state shared by everyone |

This refines [0022](0022-single-shared-public-universe.md), whose clients show "the server's tick and
simulated time": the simulated time they show is the day and its position, computed by the server.
Simulated seconds stay internal. It also refines [0008](0008-data-classification-and-audience-projections.md)
with the classes of the clock's fields, and with those of the chunk and global members below.

### Interest and transactions

- **Interest.** A client's effective interest is its camera (at most 64 chunks) plus its follow window
  (the followed being's chunk ± 1, at most 9).
  - When the followed being crosses chunks, the follow window moves with it in the next transaction:
    the chunks that enter come in full, and those that leave go in `drop`.
  - A being that crosses between two visible chunks leaves one and enters the other in the same
    transaction.
- **Immutable versions.** At each played-out tick, the mirror makes a new immutable version of every
  chunk whose **C0 bytes** changed: `{v, records}`, with being records sorted by id and already encoded.
  Engine dirtiness that changes nothing public moves no version. Clients that are up to date share the
  same versions, and a replaced version is freed once no client pins it.
- **What a transaction is.** Each client has a visible tick `L` and pins the versions it shows. A
  transaction `txn` takes its whole view from `L` to `L'`, the playout tick at which it **starts**, and
  pins the versions of `L'` for its interest. A transaction starts only after the previous one
  committed and while the client is not lagging. A chunk that would enter but whose terrain is not
  at hand yet is left out of it, neither trimmed nor dropped from the interest: it enters, whole,
  in a later transaction, once its terrain comes. Its content, in order:
  1. `drop` for the chunks that leave;
  2. the differences by id between the pinned versions at `L` and at `L'` of every visible chunk
     (`upsert`, `gone`), computed once per pair of versions and shared;
  3. the full content, with terrain, of the chunks that enter, or of the whole view in a `reset`;
  4. the local speech of `(L, L']` for the chunks that stay visible, in `delta.chunks[].speech` (chunks
     that enter, and a reset, carry no speech history), and the feed of `(L, L']`, in `events`;
  5. `commit`.
- **Fragmentation.** Parts are at most 64 KB and break on record boundaries, and a being record is at
  most 256 B by schema. One chunk may span **several parts and several periods** (`frag{i, n}`). Every
  part reads pinned versions, so the content stays that of `L'` while the world moves on.
- **Atomic application.** The client keeps the parts aside and applies the whole transaction at
  `commit`. The visible view is always at one tick, and a chunk is never half shown.
- **One transaction in flight per client.** Interest changes during a transaction go to the next one,
  which takes the view from `L'` to the current tick. A transaction's content is fixed and finite, so
  it ends while the client drains: in at least ⌈bytes / budget⌉ periods, and more when it waits for
  the terrain queue or its turn in the fan-out.
- **Reset.** A resync, a reconnect, or the loss of the versions pinned at `L` starts a full transaction
  against an empty view. The old view stays shown, consistent and marked stale, until its `commit`.
- **Rings.** Local speech and the feed are kept in rings of H = 300 ticks, with at most 2,048 items.
  A client that falls further behind gets `speechMissed` or `missed`.
- **Reference client.** `applyMessage` in `protocol/public` is the pure reference reducer. The tests,
  the terminal probe, and the web client of T8 all use it.

### The feed

The feed reaches every client: `arrival{tick, being, species, chunk}`, `death{tick, being, chunk}`, and
`greeting{tick, from, to, chunk}` (every `greet` act). Each item carries the tick it happened at,
because a transaction covers several ticks. It carries no text. The text of speech is local: it goes in
the speaker's chunk, as `speech[{tick, speaker, to, act, text}]`.

At most 64 feed items go out per tick, and the rest are counted in `missed`. The feed is encoded once
per tick and shared by all clients.

### Projections and classification

- **Explicit allowlists only.** Projections read detached copies of `readView`. An engine entity or
  event is never serialized: the C1 risk is the raw being that `readChunk` returns.
- **Being.** `BeingPublic = {id, species, stage, born, cell, activity{kind, to?, act?, dir?}}`. These
  are the registry's C0 members, with an explicit map from each DTO field to its registry path.
- **Terrain.** `TerrainPublic` carries only observables whose exposure is `surface`. `readTerrain`
  returns it, never a `TerrainChunk`, which holds deposits and thermal bases.
- **New classes in the registry:**
  - `CHUNK_CLASSES` and `GLOBAL_CLASSES` join the registry;
  - `depletion` is C3: food shown to spectators waits for a derived, registered field in T8;
  - `due` is C3;
  - the whole global value is C3.

  This adds data to the engine only: hashes, `ENGINE_VERSION`, and goldens stay the same.
- **Effects and parameters.** Observable effects of laws (the day's cycle, visible water) are C0, and
  their raw parameters stay C3. This is recorded against O-15, which stays open for the maintainer
  before a public phase.
- **Plain text.** Every text field is `PlainText`: NFC, with no C0 or C1 control characters, no bidi
  or invisible characters, and at most 280 characters. No markup is ever sent. An item that fails is
  left out and counted (C3). Clients render text as text. This closes T5's open item.

### Limits and backpressure

| Limit | Value |
|---|---|
| Input message | At most 4 KB (`maxPayloadLength`). Binary frames are refused |
| Message rate | A token bucket of 10 per second, burst 20 |
| New chunks | At most 64 every 2 s: those a `subscribe` adds to the camera, and those a `follow` adds to the interest. The follow window's moves with its being are not counted |
| Strikes | 3 in 10 s close with 1008. Every rejected message earns one, except `unknown_being` and `resync_too_soon`, which a correct client may meet |
| Connections | 1,024 in all and 16 per IP, both configurable, refused at the upgrade |
| Idle | `idleTimeout` 120 s, with `sendPings` |
| Origin | Exact match against `PUBLIC_ORIGINS`. A request without `Origin` is accepted, for non-browser tools |
| Host | Must be on an allowlist; any request with another, or none, gets 403 on every path |
| Send per client and period | At most 256 KB, counting every message to that client (parts, commits, `pong`, `status`, `error`, `notice`, `abort`, and sends that `drain` triggers), and only while `getBufferedAmount()` is under 256 KB, so a client's buffer never passes 512 KB |
| Fan-out | At most 40 ms per period across all clients. Clients that do not fit wait for the next period, in rotating order |
| Bun's own limit | `backpressureLimit` 1 MB, with `closeOnBackpressureLimit` |
| View per client | At most 32 MB encoded, measured at `L'`. A larger interest is trimmed deterministically: the follow window is kept first, then camera chunks in the order the client sent them, until 32 MB. The rest are listed in a `notice`, sent again with none when nothing is left out any more |
| Parts per transaction | At most 1,024; above it the client discards the transaction as malformed |
| Retained replaced versions | At most 128 MB in all, configurable, with exact accounting, checked after each period's fan-out. While above it, the oldest retained version is taken, and every client that pins it gets `abort`. The abort releases that client's transaction pins and, if it pins that version at `L`, its `L` pins too, so its next transaction is a reset. Each aborted client counts one abort; 3 in 60 s close with 1013, and the client reconnects with a smaller interest |
| Terrain | At most 16 chunks generated per period across all clients, from a fair queue, with an LRU of 2,048 entries |
| HTTP | Only `/ws` and `/healthz` (`{ok}`). Everything else is 404, with no CORS headers |

### Reconnecting

Backoff is exponential with full jitter, from 0.5 s up to 30 s, and at least 5 s after a 503. Every
reconnect is a new `hello`, followed by a resent `subscribe` and `follow` and a `reset`. The server keeps
no session for a client that disconnected.

### Admin contracts

`protocol/admin` defines three contracts:

- `ServerStatus` (C3): the executed, committed, and published ticks, rates, lateness, shortfall,
  connections, durability, and state; the fan-out's durations; the presentation's lagging clients,
  retained bytes, and terrain queue; its counts of aborts, trims, strikes, closes for strikes and
  for slowness, and faults; and the speech the projection left out;
- `OperatorCommand` (`pause{reason}`, `resume`);
- `AuditEntry`.

T8 builds the listener that serves them.

## Consequences

- Every public byte has a class and an allowlist. The tests parse every serialized message strictly
  and scan them for planted C1, C3, and C4 canaries.
- Two spectators of the same region whose views are at the same tick see the same view. Their
  transactions may split the ticks differently, never reach a different state.
- How dense a chunk is changes how long a transaction takes, never whether the view is consistent.
  Memory per client and in all is bounded.
- The clock cannot be computed by a client, and no message can change it.
- The tests cover the worst case the schemas allow, not the average:
  - a chunk of 1,024 beings and one of 65,536;
  - a full view of `beings@2`;
  - an interest above 32 MB;
  - the world moving during a transaction;
  - many slow clients.
- Revisit:
  - when the measured bytes per client pass the budgets: a binary encoding or compression;
  - in T8: the derived food field, and the client of `applyMessage`;
  - before a public phase: O-15, the generator `ctr-mix32@1`, whose outcomes become public once
    positions do ([0023](0023-autonomous-beings.md)), secret seeds, and admin authentication.

## Alternatives considered

- **Operation-based deltas with tombstones and a lag horizon.** Rejected: they need pruning rules and
  resets at the horizon. The differences between pinned versions are exact.
- **Frames bounded to one period, with a chunk inside one frame.** Rejected: a dense chunk can exceed
  any such frame, so it could never be sent.
- **Sending `simSecondsPerTick` and `tickRateHz` in `hello`.** Rejected: clients would compute their
  own clock, and a C3 law parameter would leak.
- **Utterances in the global feed.** Rejected: [0022](0022-single-shared-public-universe.md) keeps
  local speech with chunk subscriptions.
- **Raw `depletion` as C0.** Rejected: it shows how much each being ate and when food regrows.
- **Limiting cameras to a radius around occupied chunks.** Rejected: it limits exploration, and the
  terrain budget already bounds the cost.
- **A binary encoding in v1.** Deferred: JSON is easier to inspect and to test. Measure first.

## References

- Tracker `docs/roadmap/v0.1-tracker.md`: S17, S20, L65, L66, L67.
- Plan `docs/roadmap/v0.1-plan.es.md`: §E.4, §E.5, §I.3, §K.6, §L, §N.
- [Data classification](../architecture/data-classification.md).
- [0008](0008-data-classification-and-audience-projections.md), [0009](0009-public-and-private-admin-interfaces.md),
  [0015](0015-automated-quality-gates.md), [0022](0022-single-shared-public-universe.md),
  [0023](0023-autonomous-beings.md), [0024](0024-mind-memory-beliefs-and-speech.md),
  [0025](0025-real-time-world-host.md).
