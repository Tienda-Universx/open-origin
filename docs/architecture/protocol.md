# Public protocol v1

The public protocol is how the server and its public clients speak: one versioned JSON protocol,
built only from explicit C0 projections, whose views move between ticks atomically through
transactions. [ADR 0026](../decisions/0026-public-protocol-v1.md) records the design and why;
[ADR 0025](../decisions/0025-real-time-world-host.md) records the host that feeds it. This document
specifies what the code implements: the messages, their fields and classes, the records, plain
text, the limits, the reference client reducer, and the versioning rule.

Code: `packages/protocol/src/` (`@open-origin/protocol`). Tests: `packages/protocol/test/`
(`backoff`, `engine-parity`, `text`, `terrain`, `dto`, `client`, `server`, `reducer`, and `admin`),
and `tests/repo/protocol-boundary.test.ts`.

## Package

| Entry | Content | Classes |
|---|---|---|
| `@open-origin/protocol/public` | Constants, records, messages each way, plain text, the terrain encoding, the reconnect backoff, and the reference reducer | C0 |
| `@open-origin/protocol/admin` | `ServerStatus`, `OperatorCommand`, and `AuditEntry` | C3 |

There is no root export. The package depends only on zod 4.6.7, pinned exactly, and imports only
relative paths and `zod` (a Biome rule): no `bun`, no `node:*`, and nothing from the domain, so it
runs in any JavaScript engine. Its tsconfig declares only ECMAScript 2024. A module under
`src/public/` imports only relative paths inside `src/public/` and `zod`, never the admin
contracts (`protocol-boundary.test.ts`); admin imports public.

The protocol repeats the world's bounds and vocabularies, because it imports nothing from the
engine; `engine-parity.test.ts` holds each copy equal to the engine's: `CHUNK_CELLS`, `MIN_CHUNK`,
`MAX_CHUNK`, `MIN_CELL`, `MAX_CELL`, `MAX_CHUNK_BEINGS`, `SUBSTRATE_CODES`, `STAGES`, `ACTS`,
`ACTIVITY_KINDS`, `DIRECTION_COUNT`, and the members of `BeingPublic` and of each activity against
the C0 members of the engine's registry of classes.

## Wire and versioning

- Text JSON frames, uncompressed. The subprotocol is `PROTOCOL_ID`, `open-origin.public.v1`.
- Every schema is a strict object at every level: an extra key, a missing key, a fraction, or an
  integer that is not safe is rejected. Integers are zod's `z.int()`, which accepts only safe
  integers.
- The server speaks exactly one version. Any change of shape raises the version and updates
  ADR 0026, this document, and the allowlist tests (`client.test.ts`, `server.test.ts`).

## Client to server

An exact allowlist of four types:

| Type | Fields | Rules |
|---|---|---|
| `subscribe` | `chunks: [[x, y], …]` | Replaces the camera interest; `[]` cancels it. At most 64 chunks, each once, each inside the world's chunk bounds |
| `follow` | `being: id \| null` | An entity id from 1, or `null` to follow nothing |
| `ping` | `nonce` | An integer from 0 to 2^31 − 1 (`MAX_NONCE`) |
| `resync` | — | At most once every `RESYNC_INTERVAL_MS`, 2 s, which the server enforces |

`parseClientMessage(text)` reads one text frame. It never throws, and its result holds nothing of
the input but a valid message: `{ok: true, message}` or `{ok: false, code}`, with the first code
that applies:

| Code | When |
|---|---|
| `bad_message` | More than 4 KiB of UTF-8 (checked before parsing: the transport closes such a frame with 1009 first) |
| `bad_json` | The text is not JSON |
| `bad_message` | The value is not a record, or its own `type` is missing or not a string |
| `unknown_type` | `type` is none of the four: any that names pause, speed, step, seek, rewind, tick, rate, clock, or time included |
| `too_many_chunks` | A `subscribe` of more than 64 chunks, whatever they hold |
| `out_of_bounds` | A `subscribe` whose only problems are safe integer coordinates outside the world |
| `bad_message` | Any other problem: an extra key (`__proto__` and `constructor` included), a wrong type, a fraction, an unsafe integer, a repeated chunk |

## Server to client

Every message carries `type`, `seq`, and `tick`. `seq` starts at 0 with `hello` and grows by exactly
1 per message. The messages of a transaction (`delta`, `snapshot`, `events`, `commit`, `abort`)
carry its target tick; every other message carries the client's visible tick when it is sent.

| Type | Fields besides `type`, `seq`, `tick` | Rules the schema checks |
|---|---|---|
| `hello` | `protocol`, `audience: "public"`, `world{id}`, `durability`, `state`, `clock`, `limits` | `seq` is 0; `clock.tick` equals `tick`; `world.id` is 32 lowercase hexadecimal digits |
| `delta` | `txn`, `chunks[{at, v, gone[], upsert[], speech[], speechMissed?}]`, `drop[]` | No chunk's `v` and no speech item's `tick` exceeds `tick`; a chunk appears once, in `chunks` or in `drop` |
| `snapshot` | `txn`, `reset`, `chunks[{at, v, terrain?, beings[], frag{i, n}}]`, `followed?` | No chunk's `v` exceeds `tick`; `0 ≤ i < n` |
| `events` | `txn`, `items[]`, `missed?` | Items are FeedItem records; no item's `tick` exceeds `tick` |
| `commit` | `txn`, `clock{tick, day, dayPermille}` | `clock.tick` equals `tick`; `dayPermille` from 0 to 999 |
| `abort` | `txn` | |
| `notice` | `code: "interest_trimmed"`, `chunks[]` | At least one chunk, each once |
| `pong` | `nonce` | From 0 to 2^31 − 1 |
| `status` | `state`, `reason?` | `reason` is plain text |
| `error` | `code` | One of `ERROR_CODES` |

`state` is one of `running`, `paused`, `stalled`, and `halted`; `durability` is `ephemeral` or
`durable`. `limits` holds exactly `maxChunks`, `maxFollowChunks`, `maxMessageBytes`,
`messagesPerSecond`, `burst`, `newChunksPer2s`, and `maxViewBytes`: limits on the client, none on the
world's rate. The first three are fixed at the values the parser enforces (64, 9, and 4,096); the
others are positive integers the server's policy sets. Arrays are bounded by the most the protocol
allows: 73 chunks a view (`MAX_VIEW_CHUNKS`), 65,536 beings a chunk, and 2,048 items a ring.
`parseServerMessage(text)` reads a server frame into `{ok: true, message}` or `{ok: false, code}`,
with `bad_json` or `bad_message`, and never throws.

### Field classes

Every field above is C0. No public field carries the tick rate or the simulated seconds per tick,
which are C3 ([ADR 0026](../decisions/0026-public-protocol-v1.md#the-authoritative-clock)): the
server sends the clock itself, computed with worldgen's calendar, and a client shows the clock of
its last commit and never extrapolates it. `server.test.ts` holds the key set of `hello`, its
`clock`, and its `limits` exact, and rejects a rate, a speed, or the seconds of a tick at each
level.

## Records

### BeingPublic

| Field | Bounds | Registry member (C0) |
|---|---|---|
| `id` | A safe integer from 1 | `id` |
| `species` | An identifier: 1 to 32 characters, a lowercase letter first, then lowercase letters, digits, `.`, `_`, or `-` | `species` |
| `stage` | `adult` | `stage` |
| `born` | A tick | `born` |
| `cell` | `[x, y]`, each from −2^31 to 2^31 − 1 | `cell` |
| `activity` | `{kind}` for `eat`, `idle`, and `sleep`; `{kind, to, act}` for `talk`; `{kind, dir}` for `walk` | `activity.kind`, a talk's `to` and `act`; `dir` is the C0 direction of a walk's current step, which observers derive from `dirs` and `done` |

A direction is its index: 0 E, 1 NE, 2 N, 3 NW, 4 W, 5 SW, 6 S, 7 SE. The largest valid record
encodes to 206 bytes of JSON, under `MAX_BEING_RECORD_BYTES`, 256 (`dto.test.ts` builds it).

### Speech and the feed

- **Speech** `{tick, speaker, to, act, text}`: local speech, heard in the speaker's chunk and sent
  in `delta.chunks[].speech`. `act` is `greet`, `ask`, `tell`, or `unknown`; `text` is plain text.
- **FeedItem**, which reaches every client and carries no text: `arrival{tick, being, species,
  chunk}`, `death{tick, being, chunk}`, and `greeting{tick, from, to, chunk}`, each with `kind`. A
  transaction covers several ticks, so each item carries the tick it happened at.

### TerrainPublic

Only the observables whose exposure is `surface` and that vary from cell to cell: `elevation`,
`liquidDepth` (the observable `liquid.depth`), and `substrate`. Radiance is equal in every cell and
follows the clock; thermal values and deposits take measuring.

Each field is `{width, data}`: the canonical Base64 (RFC 4648, standard alphabet, padded) of the
chunk's 1,024 cells, row by row (cell `x + 32·y`), as little-endian integers of `width` bytes.
`width` is the narrowest of 1, 2, or 4 that the world's declared range of the observable allows,
signed for elevation and unsigned for the others, so it never depends on one chunk's values. A
substrate is one byte, a code of `SUBSTRATE_CODES` (0 to 15): a category with no name, no unit,
and no order. The schema decodes each field and rejects any other length, a non-canonical text,
and a substrate byte above 15. `encodeTerrain(values, ranges)` and `decodeTerrain(terrain)` are the
encoder and decoder; the widest chunk, every field at 4 bytes but the substrate, takes 12,401
bytes of JSON.

## Plain text

Every text field is `PlainText`: well-formed UTF-16, in Normalization Form C, from 1 to 280 code
points, and holding no code point of `FORBIDDEN_CODE_POINTS`. That table is every code point
Unicode 17.0 puts in the general categories Cc, Cf, Zl, or Zp, or marks Default_Ignorable: the C0
and C1 controls and DEL, the line and paragraph separators, the bidirectional controls, the
zero-width characters and the word joiner, the byte order mark, soft hyphens, invisible fillers,
variation selectors, and tags. It is written out, so engines with other Unicode data agree;
`text.test.ts` holds it equal to the runtime's data and fails when that data changes. Emoji
sequences that need U+200D or a variation selector are rejected with it.

No markup is ever sent, and plain text is data: `<script>` is accepted as the characters it is.
**Renderers must render text as text**, never as markup or HTML. Under ADR 0026, the server leaves
out an item whose text is not plain, and counts it (C3).

## Limits and constants

| Constant | Value |
|---|---|
| `STALE_AFTER_MS` | 3,000: a client that hears nothing for this long reconnects with backoff |
| `RESYNC_INTERVAL_MS` | 2,000 |
| `CLIENT_LIMITS` | 64 camera chunks, 9 follow chunks, 4 KiB a client message, 10 messages a second with a burst of 20, 64 new chunks every 2 s, and 32 MiB a view |
| `MAX_PART_BYTES` | 64 KiB a server message |
| `RING_TICKS`, `RING_ITEMS` | 300 ticks and 2,048 items in each ring of speech and of the feed |
| `MAX_FEED_ITEMS_PER_TICK` | 64 |

Close codes (`CLOSE_CODES`): 1001 shutdown, 1003 a binary frame, 1008 strikes, 1009 a message too
large, and 1013 too slow for its interest. Error codes (`ERROR_CODES`): `bad_json`, `bad_message`,
`unknown_type`, `too_many_chunks`, `out_of_bounds`, `unknown_being`, `rate_limited`, and
`resync_too_soon`.

### Reconnecting

`reconnectDelayMs(attempt, draw, unavailable?)` gives the delay before reconnect attempt `attempt`,
counted from 0, from `draw`, a random number in [0, 1) the caller injects: a whole number of
milliseconds spread uniformly over [500, ceiling), where the ceiling is 1 s for the first attempt
and doubles with each one up to 30 s. After an HTTP 503 (`unavailable`), it is at least 5 s. It
throws a RangeError for an attempt that is not a non-negative safe integer or a draw outside
[0, 1). Every reconnect gets a new `hello`; the client then resends its `subscribe` and `follow`,
and the server keeps no session for it (ADR 0026).

## The reference client reducer

`applyMessage(state, message)` is one client's model of the public view: pure and deterministic,
with no clock reads and no I/O, and it never changes the state or the message it is given. The
server's tests, the terminal probe, and the web client use it.

| Export | What it is |
|---|---|
| `initialClientState()` | The state of a client that has received nothing |
| `applyMessage(state, message)` | `{state, committed?, anomaly?}` after one message the `ServerMessage` schema accepted |
| `ClientState` | `connection` (from `hello`), `world` (state and reason), `view`, `stale`, `trimmed` (the last `notice`), and the reducer's own tracking |
| `ClientView` | `tick`, `clock`, `chunks` (by `chunkKey`, each with `v`, `terrain`, and `beings` by id), and `followed` |
| `Committed` | What a commit brought besides the view: `txn`, `tick`, `reset`, `speech` (each item with its chunk), `speechMissed`, `feed`, and `missed` |
| `Anomaly` | `before_hello`, `seq_gap`, `tick_not_increasing`, or `bad_transaction`, with a detail |
| `findBeing(view, id)`, `chunkKey([x, y])` | Helpers |

Semantics:

- **Transactions apply whole.** The parts of a transaction are kept aside, and the whole
  transaction applies at its `commit`, so the visible view is always at one tick. `abort` discards
  the parts. A transaction with no parts still commits: a heartbeat that moves the tick and the
  clock.
- **Order.** A commit applies the chunks that leave (`drop`), then every visible chunk's `gone`,
  then every visible chunk's `upsert`, then the full content of the chunks that enter. A being that
  crosses between two visible chunks leaves one and enters the other in the same transaction, so
  after every commit each being is in exactly one visible chunk. The differences of one chunk may
  span several parts.
- **Fragments.** A chunk that enters is put together from all its fragments, which may span several
  parts; exactly one fragment carries its terrain, and a being lies in its chunk.
- **Reset.** A `reset` transaction replaces the whole view at its commit, and carries no `delta`;
  until then the old view stays, marked `stale`. A reset always has at least one `snapshot` part
  with `reset: true`, even an empty one.
- **Connections.** Every `hello` marks the view stale and starts sequence and commit tracking over;
  the first `hello` opens an empty view at its tick and clock, and a later one keeps the old view
  and its clock. The server keeps no session, so every connection's first transaction is a reset.
  While stale, only a reset transaction applies.
- **Clock.** The visible clock comes only from `hello`, before any view, and from `commit`.
- **Followed being.** The followed being is the one the last part that said one named; none after
  a part said none or after a reset that said nothing. At each commit, `followed` is its record in
  the view, which moves with the being while it is visible; when the view does not hold it, the
  record a part of that transaction sent, or `null`: a being that died or left the view with no
  record sent is no longer shown as followed.
- **Anomalies.** A message before `hello`, a `seq` gap, a `commit` whose tick does not exceed the
  previous commit's (or, first, is below `hello`'s), and a transaction that breaks the protocol
  (parts at two ticks, two transactions at once, missing or repeated fragments, terrain not in
  exactly one fragment, differences of a chunk that is not visible or of a being that is not there,
  a chunk entering that is visible, a being in two visible chunks, a version that goes back, a
  change of a chunk's beings that keeps its version, speech or a feed item at or before the view's
  tick, or a delta in a reset) each return an anomaly. The view stays as it was, marked stale, and
  the client sends `resync`, at most once every `RESYNC_INTERVAL_MS`. After a gap, the transaction
  in flight and the transaction of the next transaction message are discarded, even a reset, since
  parts of them may be lost.
- **Versions and ticks.** A chunk's `v` is the tick of its last public change, so an entry that
  changes its beings (`gone` or `upsert`) carries a `v` above the chunk's, while one that only
  brings speech keeps it. A transaction from the view's tick `L` to `L'` brings the speech and the
  feed of `(L, L']`: the schema holds them at most at `L'`, and the reducer above `L`. A reset's
  feed is not compared with the old view's tick, which may belong to another connection or world.

The silence timer, the resync rate, and reconnecting are the client's: they read the clock, which
the reducer never does.

## Admin contracts

`@open-origin/protocol/admin` (C3, never public):

- **`ServerStatus`**: `executedTick`, `committedTick`, and `publishedTick`, with E ≥ C ≥ P;
  `tickRateHz` (1 to 1,000) and `simSecondsPerTick` (from 1); `durability` and `state`; the
  percentiles `{p50, p95, p99}`, in rising order and whole microseconds, of `latenessMicros`,
  `stepMicros`, `projectionMicros`, and `fanOutMicros`; and the counts `shortfallTicks`, `rebases`,
  and `connections`.
- **`OperatorCommand`**: `{type: "pause", reason}`, with a plain-text reason, or `{type: "resume"}`.
- **`AuditEntry`**: `seq`, `atMs` (wall-clock milliseconds since the Unix epoch), `actor` (an
  identifier), `command`, `tick` (the published tick), and `outcome`, `applied` or `rejected`.

T8 builds the listener that serves them.
