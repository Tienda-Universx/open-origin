# 0026. Public protocol v1: audiences, transactions, interest, and C0 projections

- Status: Accepted
- Date: 2026-11-02

## Context

T6 builds the per-audience protocol and its projections ([0008](0008-data-classification-and-audience-projections.md):
"T6 builds the projections"). The plan sketches the protocol in §I.3:

- **Server to client:** `hello`, `snapshot`, `delta`, `events`.
- **Client to server:** `subscribe(chunks)`, `follow(beingId)`, `ping`.
- **Rules:** pub/sub by chunk, every message carries its tick, and a gap triggers a resync.

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
| Terrain takes about 7 KB per chunk | Even 64 empty chunks do not fit in 256 KB |
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
  updates this ADR and the allowlist tests. In v0.1, web and server ship together.

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

Every message carries `type`, `seq` (counted per connection from 0), and `tick`:

| Type | Fields | When |
|---|---|---|
| `hello` | `protocol`, `audience: "public"`, `world{id}`, `durability`, `state`, `clock`, `limits` | On connect. `world.id` is random per boot, never derived from the seed, a label, or the genesis |
| `delta` | `txn`, `chunks[{at, v, gone[], upsert[], speech[], speechMissed?}]`, `drop[]` | Parts of a transaction: differences of visible chunks |
| `snapshot` | `txn`, `reset`, `chunks[{at, v, terrain?, beings[], frag{i, n}}]`, `followed?` | Parts of a transaction: chunks entering the view, or the whole view in a `reset` |
| `events` | `txn`, `items[]`, `missed?` | The feed in the transaction's range |
| `commit` | `txn`, `clock{tick, day, dayPermille}` | Closes and applies the transaction; sent every period, even when empty |
| `abort` | `txn` | Memory protection cancelled the transaction; the client discards its parts |
| `notice` | `code: "interest_trimmed"`, `chunks[]` | The view limit trimmed the interest |
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
| 1001 | Shutdown |

Capacity is refused at the upgrade, with HTTP 503 and `Retry-After`.

### The authoritative clock

The server computes `clock{tick, day, dayPermille}` with worldgen's calendar functions, from the state of
the published tick. It sends the clock in `hello` and in every `commit`:

- the client shows the clock of its last `commit`;
- it interpolates only what is drawn between commits, from measured arrival times;
- it never extrapolates the clock.

No public field carries a rate. The silence threshold is the protocol constant
`STALE_AFTER_MS = 3000`, and `CHUNK_CELLS = 32` is a protocol constant tested against the engine's.

| Field | Class | Why |
|---|---|---|
| `tick` | C0 | The shared clock ([0008](0008-data-classification-and-audience-projections.md)) |
| `clock.day`, `clock.dayPermille` | C0 | The observable effect of the day's law (the sun), computed by the server. An observer infers the day's length in ticks, as one inside the world would |
| `simSecondsPerTick` | C3 | World configuration. With the day's cycle it gives the day's length in seconds, a law parameter (O-15). Admin only |
| `TICK_RATE_HZ` | C3 | Configuration of the scheduler's operation ([0022](0022-single-shared-public-universe.md)). Admin only |
| `world.id`, `durability`, `state` | C0 | An opaque random id, an honesty notice, a state shared by everyone |

### Interest and transactions

- **Interest.** A client's effective interest is its camera (at most 64 chunks) plus its follow window
  (the followed being's chunk ± 1, at most 9).
- **Immutable versions.** At each played-out tick, the mirror makes a new immutable version of every
  chunk whose **C0 bytes** changed: `{v, records}`, with being records sorted by id and already encoded.
  Engine dirtiness that changes nothing public moves no version. Clients that are up to date share the
  same versions, and a replaced version is freed once no client pins it.
- **What a transaction is.** Each client has a visible tick `L` and pins the versions it shows. A
  transaction `txn` takes its whole view from `L` to `L'`, the playout tick at which it **starts**, and
  pins the versions of `L'` for its interest. Its content, in order:
  1. `drop` for the chunks that leave;
  2. the differences by id between the pinned versions at `L` and at `L'` of every visible chunk
     (`upsert`, `gone`), computed once per pair of versions and shared;
  3. the full content, with terrain, of the chunks that enter, or of the whole view in a `reset`;
  4. speech and the feed of `(L, L']`;
  5. `commit`.
- **Fragmentation.** Parts are at most 64 KB and break on record boundaries, and a being record is at
  most 256 B by schema. One chunk may span **several parts and several periods** (`frag{i, n}`). Every
  part reads pinned versions, so the content stays that of `L'` while the world moves on.
- **Atomic application.** The client keeps the parts aside and applies the whole transaction at
  `commit`. The visible view is always at one tick, and a chunk is never half shown.
- **One transaction in flight per client.** Interest changes during a transaction go to the next one,
  which takes the view from `L'` to the current tick. A transaction's content is fixed and finite, so
  it ends in ⌈bytes / budget⌉ periods while the client drains.
- **Reset.** A resync, a reconnect, or the loss of the versions pinned at `L` starts a full transaction
  against an empty view. The old view stays shown, consistent and marked stale, until its `commit`.
- **Rings.** Local speech and the feed are kept in rings of H = 300 ticks, with at most 2,048 items.
  A client that falls further behind gets `speechMissed` or `missed`.
- **Reference client.** `applyMessage` in `protocol/public` is the pure reference reducer. The tests,
  the terminal probe, and the web client of T8 all use it.

### The feed

The feed reaches every client: `arrival{being, species, chunk}`, `death{being, chunk}`, and
`greeting{from, to, chunk}` (a `greet` act). It carries no text. The text of speech is local: it goes in
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
| New chunks | At most 64 every 2 s |
| Strikes | 3 in 10 s close with 1008 |
| Connections | 1,024 in all and 16 per IP, both configurable, refused at the upgrade |
| Idle | `idleTimeout` 120 s, with `sendPings` |
| Origin | Exact match against `PUBLIC_ORIGINS`. A request without `Origin` is accepted, for non-browser tools |
| Host | Must be on an allowlist |
| Send per client and period | At most 256 KB, and only while `getBufferedAmount()` is under 256 KB, so a client's buffer never passes 512 KB |
| Bun's own limit | `backpressureLimit` 1 MB, with `closeOnBackpressureLimit` |
| View per client | At most 32 MB encoded. A larger interest is trimmed deterministically, the follow window first and then the camera in the order the client sent it, and the client gets a `notice` |
| Retained replaced versions | At most 128 MB in all, configurable, with exact accounting. Above that, the client with the oldest pin gets `abort`, and 3 aborts in 60 s close with 1013 |
| Terrain | At most 16 chunks generated per period across all clients, from a fair queue, with an LRU of 2,048 entries |

### Reconnecting

Backoff is exponential with full jitter, from 0.5 s up to 30 s, and at least 5 s after a 503. Every
reconnect is a new `hello`, followed by a resent `subscribe` and `follow` and a `reset`. The server keeps
no session for a client that disconnected.

### Admin contracts

`protocol/admin` defines three contracts:

- `ServerStatus` (C3): the executed, committed, and published ticks, rates, lateness, shortfall,
  connections, durability, and state;
- `OperatorCommand` (`pause{reason}`, `resume`);
- `AuditEntry`.

T8 builds the listener that serves them.

## Consequences

- Every public byte has a class and an allowlist. The tests parse every serialized message strictly
  and scan them for planted C1, C3, and C4 canaries.
- Two spectators of the same region receive the same transactions and, after each `commit`, see the
  same view at the same tick.
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
