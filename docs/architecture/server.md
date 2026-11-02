# Server: the world plane

`apps/server` runs the public universe in one Bun process. Its world plane steps the engine at a fixed
rate, makes each tick durable before it publishes it, and hands the rest of the server only frozen
published records. [ADR 0025](../decisions/0025-real-time-world-host.md) records the design and why;
this document describes what the code implements as of T6-4: the configuration, the scheduler, the
world host and its sources, the journal port, the publication gate, and their composition. The
projection, the presentation plane, the transport, and the entry point arrive in later batches.

Code: `apps/server/src/` (`@open-origin/server`). Tests: `apps/server/test/` (`config`,
`scheduler`, `adapters`, `publication`, `host`, `rejection`, and `compose`), and
`tests/repo/server-boundaries.test.ts`.

## Layout

| Path | Plane | What it holds |
|---|---|---|
| `src/config/` | — | `parseConfig`: the environment, parsed and deep-frozen |
| `src/world/` | World | `time.ts` (the `Clock` and `Timer` ports), `scheduler.ts`, `samples.ts`, `host.ts`, `source.ts`, `journal.ts`, `publication.ts`, `published.ts`, and `rejection.ts` |
| `src/adapters/` | — | `systemClock` (`performance.now()`, in whole microseconds) and `systemTimer` (one `setTimeout` per deadline) |
| `src/compose.ts` | — | `compose(config, deps)`: the wiring of the world plane |

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
| `ALLOWED_HOSTS` | `localhost:<port>` and `<host>:<port>`, with an IPv6 host in brackets | A comma-separated list of `Host` header values |
| `MAX_CONNECTIONS` | `1024` | An integer from 1 to 65536 |
| `MAX_CONNECTIONS_PER_IP` | `16` | An integer from 1 to 65536, at most `MAX_CONNECTIONS` |
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
  or failure and after an unhandled rejection, stops a world halted between ticks at once.
- **Metrics** (C3): the state, the ticks run, `shortfallTicks`, `rebases`, the count of each stop,
  the p50, p95, and p99 of lateness and of step duration over the last 1,024 ticks, and the rate
  achieved over the last 64 tick starts, in millihertz.

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
3. it hands the gate the tick's record (`tick`, `checksum`, every command it gave, rejected ones
   included, and every event), its published record, and the checkpoint when there is one.

The host reads nothing else and changes nothing in what `step` computes: over the `mind@1` subject
of T5 and its script it reproduces the frozen trail of the determinism suite (`edb4c527…`), and over
the default scenario every checksum of a direct step loop.

When `step` or the snapshot throws, the host has the gate flush the ticks it holds, never the faulted
one, and halts with the error's code only: an `EngineError`'s issues can name C3 data. A halt keeps
the first code: an engine error's, `unexpected_error`, `journal_failed`, or `unhandled_rejection`.

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
  receive frozen `PublishedTick` records, which carry only `{ tick }` until T6-5 adds the C0
  projection. Their return values are ignored; their exceptions and rejected promises are counted
  as `listenerFaults` and never stop publication.
- **Flush.** `flush` appends what is left as partial batches and resolves once all of it is
  committed and published, or once the journal failed; it never rejects.
- **Failure.** When an append rejects or throws, the gate fails: it drops the ticks it holds,
  appends and publishes nothing more, and refuses further ticks. Nothing uncommitted is published.
- **Window.** `stalled()` is `E − C > W`, with `W = 4F`.

## Composition

`compose(config, deps)` wires a source (the default scenario unless given), the gate (over the
ephemeral journal unless given), the host, and the scheduler, and returns:

| Member | What it does |
|---|---|
| `start()` | Starts the scheduler, or resumes it after `stop` |
| `stop()` | Pauses the scheduler and flushes the gate: every executed tick is committed and published (RPO 0 once the journal is durable) |
| `subscribeToPublished(listener)` | Adds a listener of published ticks and returns the function that removes it |
| `status()` | The server's status, shaped for `ServerStatus` of `@open-origin/protocol/admin` |
| `unhandledRejection()` | Asks `rejectionPolicy(AI_MODE)`; with `off`, the world halts |

`deps` carries the clock and the timer, which the entry point of T6-7 takes from `src/adapters/`,
and, for tests, the journal, the source, and K. A journal failure halts the host with
`journal_failed`. The status reads `E`, `C`, and `P` from the gate; the state is `halted` once the
host halted or the journal failed, and otherwise the scheduler's (`journalStall` is `stalled`).
`projectionMicros` and `fanOutMicros` are 0 and `connections` is 0 until the planes that measure
them exist.

`rejectionPolicy` is a pure function: with `AI_MODE=off` an unhandled rejection halts the world,
because no code of the world awaits anything, and async work in a brain would be a wall-clock
channel. T6-7's entry point installs the process handler that calls `unhandledRejection`.

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
through another name (`const load = require`) is left to review. Until `presentation/` and
`transport/` exist, each rule is proved on planted trees whose legal version passes. The same
reader rejects, in `packages/scenarios/src` and `packages/protocol/src`, a relative path that leaves
`src`, a type-level `import()`, a `require()` or `import.meta.require()`, a computed specifier, and a
triple-slash reference directive, which their Biome rules cannot see.

`published.ts` imports nothing, so a type-only import of it gives the presentation plane no path to
the engine: in T6-4 a published tick is `{ tick }`, a number, not the engine's `Tick` type.
