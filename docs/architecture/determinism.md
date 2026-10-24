# Determinism

The engine must turn the same inputs into the same results on every run and every host
([ADR 0003](../decisions/0003-authoritative-deterministic-engine.md)). This document specifies the
rules that make it so, as the code implements them;
[ADR 0020](../decisions/0020-deterministic-core-design.md) records why they were chosen. Each
section names its code and its tests, and the next T2 pull request adds the section still to
come: snapshots.

## Canonical values

Everything the engine stores, hashes, or compares is a canonical value, and its only text form is
canonical text. Code: `packages/engine/src/canonical/` and `packages/engine/src/errors.ts`. Tests:
`packages/engine/test/` (`value`, `copy`, `encode`, `order`, `errors`, `hostile`, and
`canonical-fuzz`); the lint exceptions for `order.ts`, `encode.ts`, and `value.ts` are proven in
`tests/repo/engine-lint.test.ts`.

### What is canonical

| Kind | Rule | Why |
|---|---|---|
| Boolean | `true` or `false` | |
| Integer | `Number.isSafeInteger(n)`, and not `-0` | Integer arithmetic is exact on every engine (ADR 0003); above 2^53, distinct integers round to the same number. `-0` is written as `0`, so it would not survive a round trip |
| String | Well-formed UTF-16 (`isWellFormed`), in Unicode Normalization Form C | A lone surrogate has no UTF-8 form, and digests hash UTF-8. NFC gives each text one sequence of code points; the core rejects other forms and never normalizes, so a stored value is the value given |
| Array | Dense; prototype `Array.prototype`; no own properties other than its elements and `length`; no symbol keys | Holes and extra properties would vanish from the text, so two different values would share it |
| Record | Prototype `Object.prototype` or `null`; only own, enumerable, string-keyed data properties; keys follow the string rule; no key `__proto__` | A getter or a Proxy could answer differently on each read. `__proto__` sets the prototype when assigned |
| Nesting | At most 64 arrays and records deep | Bounds recursion |
| Tree | No array or record appears twice, so no value contains itself | A shared object would be walked once per path, which grows exponentially with depth, and a write through one place in the state would change another without marking it dirty. A cycle is reported at once, even one that branches |

Nothing else is canonical: not `null` or `undefined`, bigints, symbols, or functions, and no other
object (`Map`, `Set`, `Date`, class instances, typed arrays, boxed primitives, `Array`
subclasses).

**NFC fast path.** Text whose UTF-16 code units are all below U+0300 is already in NFC, so
validation calls `normalize` only for text that reaches U+0300. A differential fuzz test checks
the result against `text.normalize("NFC") === text` over random text with combining marks, Hangul
jamo and syllables, characters that NFC replaces, and astral characters.

### Canonical text

The text form is the subset of [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) that canonical
values need:

- record keys sorted by UTF-16 code units (RFC 8785 §3.2.3), so `"1"` < `"10"` < `"9"` < `"a"`;
- integers in decimal, without a fraction or an exponent;
- strings escaped exactly as `JSON.stringify` does: `"`, `\`, and U+0000 to U+001F become escapes
  (`\b`, `\f`, `\n`, `\r`, `\t`, or `\u00xx` in lowercase); every other character, `/`, DEL, C1
  controls, and U+2028 included, is written as it is;
- no whitespace.

Canonical values are narrower than RFC 8785: there is no `null`, no fraction, and text must be in
NFC. The key U+FB33 of the RFC's own sorting example is therefore rejected, because NFC turns it
into U+05D3 U+05BC.

`canonicalize(value)` fails fast: it throws at the first invalid value, in canonical order.

### Parsing accepts exactly the canonical texts

`parseCanonical(text)` parses with `JSON.parse`, validates every value, writes the canonical text
of the result, and requires it to equal `text`. A text that differs anywhere is rejected, so the
parser refuses whitespace, unsorted or duplicate keys, other escapes (`\u0041` for `A`,
`\/`, uppercase hexadecimal), other number forms (`1.0`, `1e3`), and everything validation
refuses (`-0`, `9007199254740992`, `null`, a lone surrogate escape, text that is not NFC, the key
`__proto__`).

Fuzz tests with a seeded generator (`test/support/sfc32.ts`, independent of the engine) check two
properties against an independent serializer: random canonical values round-trip exactly, and a
text one character away from a canonical text is either rejected or canonical itself.

### Copying at the boundary

`copyCanonical(value)` validates and deep-copies in one pass, as everything entering the engine
must be (ADR 0020, ownership):

- it reads each property once, through `Object.getOwnPropertyDescriptor`, and an array's length
  the same way, so getters never run and the value validated is the value copied;
- a Proxy is copied as the data its descriptors report during that pass, one consistent snapshot:
  its `get` trap never runs, so a `get` that lies changes nothing, and a reported `length` must
  agree with the reported keys (keys beyond it are not elements; a longer one is sparse);
- the copy shares no object with the input, and its records have the prototype
  `Object.prototype`.

Validation, copying, and encoding share one walk (`walkCanonical`) with different builders, so they
cannot disagree about what is canonical.

### Errors

Every failure is an `EngineError` with a `code` (`invalid_value` here, `tick_overflow` for
[time](#time), `invalid_input` and `invalid_ruleset` for [the world](#world), and
`system_fault`, `integrity_violation`, `world_faulted`, `world_busy`, `context_expired`, and
`id_exhausted` for [step](#step); later batches add codes) and `issues`. An issue has a `path`, a JSON Pointer
([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)) into the value (`""` is the whole value, and
`~` and `/` in keys become `~0` and `~1`), and a `message`.

- Validation and copying report every issue they reach, in canonical order. A value rejected as a
  whole is one issue, and its contents are not checked: an object that is not a plain array or
  record, a sparse array, an accessor, a cycle, nesting beyond 64, and an object reached a second
  time, reported with the path of its first occurrence.
- An object that throws while being read (a revoked Proxy, or a trap that throws or breaks a
  Proxy invariant) is an issue at its path, so these operations throw nothing but `EngineError`;
  `copyCanonical` and `canonicalize` keep the first thrown value as the `cause`. The walk may have
  read part of the object first: the issues it found there come before the issue at the object's
  path, and the contents after the throw are not checked.
- A thrown `EngineError` is treated like any other thrown value. Only the error that the walk's own
  fail-fast reporting throws, which stops `canonicalize` at its first issue, passes through.
- An `EngineError` keeps the first 50 issues and its message counts them all:
  `invalid_value at /0: NaN is not a safe integer; 120 issues in all, 70 dropped beyond the first 50`.
- `validateCanonical` returns at most those 50 issues; an empty list means the value is canonical.
- `canonicalize` reports only the first issue.
- `parseCanonical` reports the issues of the parsed value, the parser's error as the `cause` when
  the text is not JSON, or else the first UTF-16 offset where the text differs from its canonical
  form.

### Cost and limits

- A walk costs O(n) for n values, plus a key sort per record. Each array and record also costs one
  lookup and one insertion in a `Map` of the objects entered so far, which finds cycles and shared
  objects; a shared object is rejected at its second occurrence without walking its contents again.
- Strings and keys with no quote, backslash, or C0 control are written between quotes without
  calling `JSON.stringify`; a test checks every canonical one-unit string against it.
- NFC is checked with the host's Unicode data. Unicode keeps the normalization of assigned
  characters stable, so two hosts can disagree only on text with a character that one of them
  does not assign yet.

## Digests

A digest detects accidental divergence: a replay, a recovery, or a replica that computed something
else. Code: `packages/engine/src/digest/`, `src/canonical/utf8.ts`, and `src/int.ts`. Tests:
`packages/engine/test/` (`murmur3`, `digest`, `lanes`, `utf8`, and `int`).

`digest(value)` is MurmurHash3 x86_128 with seed 0 over the UTF-8 bytes of `canonicalize(value)`,
written as the words h1, h2, h3, and h4 in 8 lowercase hexadecimal digits each: 32 characters. A
value that is not canonical throws `invalid_value`, as `canonicalize` does. The digest adds no
domain tag; callers hash a tagged array such as `["chunk", key, chunk]` (ADR 0020).

| Part | What the tests check |
|---|---|
| MurmurHash3 port (`murmur3.ts`) | SMHasher's verification procedure gives 0xB0F57EE3 for x86_32 and 0xB3ECE62A for x86_128, the values in SMHasher's `src/main.cpp`; published vectors for both variants pass; a view into a larger buffer hashes as a copy |
| Word variant | x86_32 over u32 words equals x86_32 over their little-endian bytes, on random words and seeds |
| UTF-8 (`utf8.ts`) | The bytes equal `TextEncoder`'s on every length boundary and on random well-formed text with astral characters, in an array of exactly their length; a lone surrogate, high or low (the last of each, U+DBFF and U+DFFF, included), at the start, the end, or next to a pair, throws `invalid_value` with its UTF-16 offset, and a pair at either end encodes as one code point |
| Lanes (`lanes.ts`) | Addition and subtraction modulo 2^128 over four u32 lanes, most significant first, equal BigInt's, and a sum does not depend on the order of its terms |
| `digest` | Pinned digests, cross-checked against SMHasher's C reference when they were written; key order does not change a digest |

What a digest does not do:

- **Resist an attacker.** MurmurHash3 is not cryptographic: inputs with equal hashes can be built
  on purpose. Integrity against corruption and tampering is SHA-256 over the snapshot bytes, in
  the adapter (ADR 0020).
- **Prove the absence of collisions.** The tests check the port against the reference, not the
  collision rate; ADR 0020 records why 128 bits.
- **Keep the state root by themselves.** The lanes only add and subtract: [the world](#world)
  composes its root with them when it is created, and [step](#step) updates the sum for the chunks
  each tick changed.

## Randomness

The engine draws random numbers with `ctr-mix32@1` (ADR 0020), a counter-based generator: draw n
of a stream for a key is MurmurHash3 x86_32 over the u32 words `[s1, stream, key.length, ...key,
n]` with seed s0, where `[s0, s1]` is the world seed. Code: `packages/engine/src/rng/`. Tests:
`packages/engine/test/` (`mix32` and `random`).

| Function | Contract |
|---|---|
| `mix32(seed, stream, key, n)` | One draw. Every input must be u32 words; all problems are reported at once, with the paths `/seed/i`, `/stream`, `/key/i`, and `/n`, as `invalid_value`. Each word is read once, by index, into a copy that is validated and hashed, so a getter or a custom iterator cannot show the hash other words than validation saw. A hole is an issue at its path even when the array's prototype has a value at that index. A key has at most 64 words (`MAX_KEY_WORDS`: a per-tick key has 4); a longer one is one issue at `/key`, found before any of its words is read |
| `streamId(name)` | MurmurHash3 x86_32 of the UTF-8 of `name` with seed 0 |
| `tickKey(tick, entity)` | `[tickLo, tickHi, entityLo, entityHi]`: each integer as the two u32 words of its 64-bit two's complement, low first. `tick` must be a tick; `entity` may be any safe integer |
| `new DrawSequence(seed, stream, key, next = 0)` | The draws of one stream for one key, from the counter `next`. It reads its inputs once, as `mix32` does, and keeps the copies |
| `sequence.u32()` | The draw at the counter, which then advances. A sequence has 2^32 counters; one more draw throws `invalid_value` at `/n`: the draw counter is exhausted |
| `sequence.int(bound)` | An integer in [0, bound) for an integer bound in [1, 2^32], without modulo bias: a draw at or above `2^32 - (2^32 mod bound)` is rejected, and each retry uses the next counter |
| `sequence.permutation(count)` | 0 to count - 1 in random order: a Fisher-Yates shuffle that draws `int(i + 1)` for i from count - 1 down to 1. `count` is an integer in [0, 2^16] (`MAX_PERMUTATION`), far more than the inhabitants contending for one resource in one tick; any other count throws `invalid_value` at `/count` before any draw |

What the tests check:

- a draw depends only on its seed, stream, key, and counter, so more draws for one entity or from
  another stream never shift the draws of the others;
- the bounds at both sides: a key of 64 words is hashed and one of 65 is rejected without reading
  its words, as is an array of 2^32 - 1 holes; a permutation of 2^16 items is complete and a count
  of 2^16 + 1 is rejected; a hole in a key or a seed is rejected, also when the prototype fills it;
- pinned draws, cross-checked against SMHasher's C reference when they were written, and `mix32`
  equal to MurmurHash3 x86_32 over the documented words on random inputs;
- with the bound 2^31 + 1, about half of the draws are rejected, and each result and the final
  counter equal a replay through `mix32`; the bounds 1 and 2^32 use one counter per draw;
- the exact limit, on draws of 0x80000000, 0x80000001, and 0xffffffff: a draw equal to the limit is
  rejected and one below it is accepted;
- on fixed inputs, 100,000 draws fill 16 buckets with a chi-square below 37.697 (p = 0.001 for 15
  degrees of freedom), by their low bits (`int(16)`) and by their high bits; flipping any one of
  192 input bits flips between 15 and 17 output bits on average over 256 samples; permutations of 3 and 4
  items are uniform by chi-square over 6,000 and 24,000 keys. The critical values come from the
  [NIST/SEMATECH e-Handbook, table 1.3.6.7.4](https://www.itl.nist.gov/div898/handbook/eda/section3/eda3674.htm).

What the generator does not do:

- **Hide its draws.** Anyone with the seed computes every draw, which is why the snapshot that
  holds the seed is C3 (ADR 0020). It is not a cryptographic generator.
- **Pass a statistical battery.** The checks above are smoke tests on fixed samples; no PractRand
  or TestU01 battery has been run.
- **Keep counters across calls by itself.** A `DrawSequence` keeps its own counter; the tick
  context keeps one sequence per stream and id for each tick (see [the tick
  context](#the-tick-context)), and faults a draw from a stream its caller did not declare. The
  ruleset check that rejects colliding stream ids, streams shared by two owners, and the reserved
  `engine.` prefix is part of [the world](#world).

## Time

The engine knows only ticks (ADR 0020). Code: `packages/engine/src/time/tick.ts`. Tests:
`packages/engine/test/tick.test.ts`.

- A tick is a safe integer from 0; `-0` is not a tick, since it is not canonical.
- `nextTick(tick)` is `tick + 1`; at `Number.MAX_SAFE_INTEGER`, whose successor is not a safe
  integer, it throws `tick_overflow`.
- `simSeconds(tick, simSecondsPerTick)` is `tick * simSecondsPerTick`, for a positive safe integer
  of seconds per tick. A product that is not a safe integer throws `tick_overflow`: an exact
  product below 2^53 is computed exactly, and a larger one rounds to 2^53 or more, so the check
  needs no division.
- Anything that is not a tick, or a seconds per tick that is not a positive safe integer, throws
  `invalid_value` with every invalid argument.

Pacing ticks in real time (`TICK_RATE_HZ`) belongs to the scheduler (T6), and the calendar waits
for the batch that defines the length of a day.

## World

A world is the state the engine owns: the kernel's counters, a global value, and chunks keyed by
their grid position (ADR 0020, ownership and digests). This section covers creating a world,
reading it, and its state root; [step](#step) advances it. Code:
`packages/engine/src/world/`. Tests: `packages/engine/test/` (`chunk`, `chunk-index`,
`ruleset`, `world`, and `checksum`).

### What is guaranteed now

| Guarantee | How |
|---|---|
| The host cannot change a world through anything it gave | `createWorld` copies the global value and each chunk as `copyCanonical` does, and captures the ruleset into structures of its own. Changing the definition or the ruleset afterwards changes no digest |
| The host cannot change a world through anything it read | `readView`, `worldStatus`, and `chunkHashes` return fresh copies or primitives |
| No forged world is accepted | A `World` keeps its state in one ES2022 private field. Every function checks the brand (`#state in value`), which runs no Proxy trap, and throws `invalid_input` for anything else. The constructor throws `invalid_input` unless `createWorld` calls it |
| Every problem is reported at once | One `invalid_input` for the definition, with paths into `{ init, options }`; one `invalid_ruleset` for the ruleset, with paths into the ruleset. Only the three checks that stop the rest are reported alone (see below) |
| Nothing escapes as a raw exception | Every inspection of a host object, `Array.isArray` and the prototype included, is guarded: an object that throws while read, such as a revoked Proxy, is an issue at its path, with the thrown value as the error's `cause` |
| Ruleset code cannot reach the captured ruleset | The validators are called without a receiver, so `this` is `undefined` |
| The root does not depend on insertion order | The chunk sum is commutative, and every key list is sorted by UTF-16 code units |

### Chunk keys

A chunk key is `"x,y"`, both coordinates safe integers in canonical decimal, as a template literal
writes them: `chunkKey({ x: -1, y: 0 })` is `"-1,0"`. `chunkKey` takes any object that is not an
array and reads only its `x` and `y`, each once, as own, enumerable data properties, as every host
object is read (below): an inherited coordinate is read as missing, an accessor never runs and is
an issue, a property that is not enumerable is an issue, and an object that throws while read is
one issue at `""`. `parseChunkKey` accepts a part only when
writing its number back gives the same text, so it rejects `-0`, `+1`, `01`, spaces, `1e3`,
`0x10`, `1.0`, empty parts, and values beyond the safe range. A key that is not two parts joined
by one comma is rejected as a whole. Both throw `invalid_value` with every problem.

### Creating a world

`createWorld(init, options?)` makes a world at epoch 0, tick 0, with the next entity id 1. Its
checks run in this order:

1. `init` must be a record that can be read. If it is not, that is the only issue reported, at
   `/init`.
2. Its `ruleset` member must be an own, enumerable data property that can be read. If it is not,
   that is the only issue reported, at `/init/ruleset`.
3. The ruleset is captured, because its validators check the data: a broken ruleset throws
   `invalid_ruleset` with all its problems (see below), and a missing ruleset, or one that is not
   a record, is one issue at the path `""`.
4. Everything else is gathered into one `invalid_input`:
   - the seed is two u32 words, `[s0, s1]`;
   - `simSecondsPerTick` is a positive safe integer;
   - the global value is canonical, then `validateGlobal` checks it;
   - `chunks` is a plain record (prototype `Object.prototype` or `null`, no symbol keys). Each key
     must parse as a chunk key. Each chunk is copied on its own and then checked by
     `validateChunk(key, chunk)`, so the problems of every chunk are reported;
   - `options`, when given, is a record, and its `audit`, when present, is a boolean.

Every member of `init`, `options`, and the ruleset is read once, through its own descriptor: a
getter never runs, and an accessor or a property that is not enumerable is an issue, as in
canonical records. An object that throws while read is an issue at its path, with the thrown
value as the error's `cause`. Issue paths are JSON Pointers, so a key with `/` or `~` is escaped.

A validator must return a list of `{ path, message }` records whose paths are JSON Pointers. Each
issue it returns is reported under the path of its value. A validator that throws or returns
anything else is one issue at that path.

Validators receive the values the world keeps, not copies, as ruleset code does during a tick: a
validator must not change or keep what it is given. Copying each value for its validator would cost
a deep copy per dirty chunk at every commit, the cost for which ADR 0020 rejected copy-on-write.
Instead, the global digest and each chunk term are taken before the validators run, so a validator
that changes its value, at once or later through a reference it kept, leaves a cache that
`fullChecksum` disagrees with: it is detected, like every write that bypasses the barrier, not
prevented.

### Capturing the ruleset

`captureRuleset` checks the ruleset and copies its lists and records; functions are kept as
references.

| Part | Rule |
|---|---|
| `versions` | A plain record of exactly `ruleset`, `generator`, and `brain`, each a non-empty, well-formed NFC string; each missing one is reported |
| `systems` | A dense array, kept in its order, which is the order they run in. Names are non-empty, canonical, and unique; `run` is a function. Messages name a system with its path, so two systems that share a name are told apart |
| `commands` | A plain record (prototype `Object.prototype` or `null`, no symbol keys), enumerated in canonical order through `canonical/order.ts`, never `Object.keys`. Types are non-empty, canonical, and not prefixed `engine.`; `check` and `apply` are functions; `streams` is optional |
| Streams | Non-empty canonical names, not prefixed `engine.`. Each belongs to exactly one system or command, declared once. No two names have the same `streamId`: the test pins two names found to collide by hashing `"rain.0"`, `"rain.1"`, ... in order |
| Validators | `validateGlobal` and `validateChunk` are functions |

### State root

Every digest hashes a canonical array that starts with a domain tag:

| Digest | Definition |
|---|---|
| Kernel | `digest(["kernel", { epoch, tick, nextEntityId, rng: { algorithm: "ctr-mix32@1", seed }, config: { simSecondsPerTick } }])` |
| Global | `digest(["global", global])` |
| Chunk term | `digest(["chunk", key, chunk])`, read as a 128-bit integer |
| Chunk sum | The sum of the terms modulo 2^128, in four u32 lanes with carry (`digest/lanes.ts`) |
| State root | `digest(["state", kernelDigest, globalDigest, chunkSum, chunkCount])`, the sum written as 32 hexadecimal digits |

| Function | Cost | Result |
|---|---|---|
| `stateRoot(world)` | O(1) | The root the world caches |
| `fullChecksum(world)` | O(N) | The root recomputed from the state alone, never from the cache. It equals `stateRoot` unless something changed the state without the engine knowing. A value left not canonical by such a change throws `invalid_value` at its path, `/chunks/<key>/...` or `/global/...` |
| `chunkHashes(world)` | O(N) | Each chunk's cached term as a digest, in a fresh record keyed in canonical order, to find which chunks differ between two worlds |

The world caches each chunk's term, the chunk sum, the global digest, and the root. The kernel
digest has a fixed size and is recomputed whenever the root is.

### Chunk index

The world keeps its chunks in a lazy, sorted index, so creating a chunk never costs O(N):

- adding a chunk is amortized O(1): its key joins a pending list;
- looking a chunk up is O(1), in a null-prototype record that is never enumerated, so its insertion
  order is never observable and no key reaches an inherited property. The index therefore needs no
  `Map` and no lint exception;
- `sortedKeys()` sorts only the pending keys and merges them into the sorted list, O(P log P + N),
  and returns a fresh array. Only a caller that asks for every key pays it.

### What the tests check

- chunk keys round-trip and reject every malformed form above, and `chunkKey` rejects inherited,
  accessor, and non-enumerable coordinates;
- the index orders `"-1,0"` < `"0,0"` < `"10,0"` < `"2,0"`, keeps adds pending (an observable
  `pendingCount`) until asked while counting them in its `size`, and agrees with a full sort
  under random adds;
- every ruleset rule, all reported at once, including a real `streamId` collision;
- every `createWorld` check, all reported at once, and validators that throw, return malformed
  results, or try to use `this`;
- a member that is not enumerable (the ruleset, the seed, the seconds per tick, the global value,
  the chunks, and `options.audit`) is reported once, never again as a missing value;
- a validator that changes its value, or keeps it and changes it later, makes `fullChecksum`
  disagree with `stateRoot`;
- host isolation: changing the definition, the ruleset, and everything `readView`, `worldStatus`,
  and `chunkHashes` returned leaves `stateRoot`, `fullChecksum`, and `chunkHashes` unchanged;
- forged worlds (a record, a Proxy of a world whose traps throw, a revoked Proxy, an object whose
  prototype is a world, a call to the constructor) are rejected by every function, and no trap
  runs;
- a revoked Proxy at every entry point (the definition, the options, the ruleset, its versions,
  systems, commands, handlers, and streams, the chunks, a chunk, the global value, the seed, and
  chunk coordinates) is one issue at its path, with the `TypeError` as the cause;
- `stateRoot` equals `fullChecksum` and a root computed independently from the formulas above,
  with `BigInt` for the sum, on 200 random worlds from a seeded generator, and on 64 chunks whose
  lanes carry;
- the root does not depend on the order of the chunks, and changes with any chunk, the global
  value, either seed word, the seconds per tick, and the epoch, tick, and next entity id;
- the chunk sum of a world equals the lane sum of the sums of two disjoint regions;
- `fullChecksum` sees a change made behind the engine's back, and `stateRoot` does not;
- `chunkHashes` is sorted, fresh, and a changed chunk changes only its own term.

## Step

`step(world, commands)` advances a world by one tick, in place, and returns what the tick did. A
step ends in one of three ways: the tick completes; the world is left exactly as it was, because
the input was invalid; or the world is poisoned, because the tick failed after it began. Code:
`packages/engine/src/step/`. Tests: `packages/engine/test/` (`step`, `step-commands`,
`step-faults`, `step-random`, and `step-cost`); the lint exception for `step/context.ts` is proven
in `tests/repo/engine-lint.test.ts`.

### Pipeline

| Phase | What happens | If it fails |
|---|---|---|
| 1. Guards | The brand check, then a step already running on the same world, which only ruleset code that holds the world, or a host Proxy among the commands, can start, then the world's health | `invalid_input`, `world_busy`, or `world_faulted`, and nothing changes; a nested step from ruleset code is also a fault of the running tick |
| 2. Commands | Every command is validated and copied (below), with the world already marked busy | `invalid_input` with every problem, and nothing changes |
| 3. Tick | The kernel's tick advances | `tick_overflow` at `Number.MAX_SAFE_INTEGER`, and the world is poisoned |
| 4. Commands | In seq order. A type without a handler, looked up with `Object.hasOwn`, or a `check(view, command)` that returns a rejection, is rejected; otherwise `apply(ctx, command)` runs | Poisoned |
| 5. Systems | `run(ctx)` for each system, in the ruleset's order | Poisoned |
| 6. Commit | The changed chunks, in key order, then the global value if it was written: canonical text, term, validator. Then the kernel digest, the state root, the events digest, and the tick checksum | Poisoned, with the first problem of each value that is not canonical (canonical text fails fast, so `{ a: 0.5, b: NaN }` reports only `/a`) and every issue the validators return |
| 7. Audit | With `options.audit`, the root recomputed from the state alone must equal the incremental one | `integrity_violation`, and the world is poisoned |

Systems and handlers must return `undefined`; a value, such as the `Promise` of an `async`
function, is a fault. They are called without a receiver.

### Commands

A command is a plain record with exactly these members, each read once through its own
descriptor, as `createWorld` reads its definition. Issue paths point into `{ commands }`, as in
`/commands/2/seq`.

| Member | Rule |
|---|---|
| `applyTick` | The tick this step computes: the world's tick plus one |
| `seq` | A safe integer from 0. The seqs strictly increase along the list, which is the order the commands run in |
| `type` | A non-empty canonical string |
| `origin` | `{ kind: "admin" }`, or `{ kind: "inhabitant", actor }` with `actor` a safe integer from 1 |
| `payload` | A canonical value whose canonical text takes at most 8 KiB of UTF-8 (`MAX_PAYLOAD_BYTES`, 8192 bytes) |

A rejected command emits `engine.command_rejected`, whose payload is `{ seq, type, reason,
origin }`, plus `details` when the rejection has them. A type without a handler has the reason
`unknown_type`. `check` must return `undefined` or a rejection `{ reason, details? }` with a
non-empty `reason`; anything else is a fault.

### The tick context

There is one context per step, and one view of it for `check`, which has only the reads. Both are
revoked when the step returns: every method then throws `context_expired`. Every misuse of a
method is a fault at the system or command that made it.

| Method | Behavior |
|---|---|
| `tick`, `readChunk`, `readGlobal` | The tick being computed, and the live values. Their `DeepReadonly` types are a compiler aid only |
| `chunkKeys()` | A fresh array of the committed keys, sorted |
| `writeChunk(key)`, `writeGlobal()` | The live value, marked as changed, so that the commit hashes it |
| `createChunk(key, initial)` | Validates the key and copies `initial`. The chunk can be read and written at once, and `chunkKeys` lists it from the next tick on. A key that exists is a fault |
| `newEntityId()` | The next id from `nextEntityId`. When `nextEntityId` is `Number.MAX_SAFE_INTEGER` it throws `id_exhausted`, so `nextEntityId` stays a safe integer |
| `random.u32`, `random.int`, `random.permutation` | A `DrawSequence` of a stream the running system or handler declared, keyed by `tickKey(tick, id)`, where `id` is the entity, or the resource of a permutation. The counter of each (stream, id) continues across calls and restarts every tick. So `u32` and `int` keyed by an entity and `permutation` keyed by a resource with the same id share one sequence within a stream, each shifting the other's draws: an owner that draws for both purposes should declare a stream for each. A stream the owner did not declare is a fault |
| `rejectedCommands()` | A fresh array of this tick's rejections |
| `emit(type, payload)` | `type` is a non-empty canonical string not prefixed `engine.`, and `payload` is copied. Events are numbered from 0 in each tick, in emission order, with the cause `{ kind: "command", seq }` or `{ kind: "system", name }` |

The draw sequences of a tick live in a `Map` keyed by stream id and then by id, which the context
looks up and never iterates: this is the reviewed lint exception of `step/context.ts`.

### Failures and poisoning

| Class | When | Result |
|---|---|---|
| Invalid input | Before the tick begins | `invalid_input` with every problem. The world is unchanged: its status, `stateRoot`, `fullChecksum`, and `chunkHashes` are equal, and the next valid step gives what it gives a control world |
| Fault | After the tick began | The world is poisoned: `system_fault`, or the specific `id_exhausted`, `tick_overflow`, or `integrity_violation` |
| Use of a poisoned world | Any later call | `world_faulted`, except `worldStatus` |

- A fault's issues name what failed: `/commands/<index>` for the command given at that index,
  with its seq and type in the message; `/systems/<index>` for the ruleset's system, with its
  name; `/chunks/<key>/...` and `/global/...` for data at the commit. Its `cause` is what the
  ruleset threw.
- Poisoning sets the status to `{ kind: "faulted", tick, code, issues }`, where `tick` is the tick
  being computed (for `tick_overflow`, the last tick). The tick's events are discarded and `step`
  throws the fault. `step`, `readView` and every method of a view read before, `chunkHashes`,
  `fullChecksum`, and `stateRoot` throw `world_faulted`. Recovery starts from the last snapshot.
- Faults are recorded, not only thrown: ruleset code that catches one still poisons the world, and
  every later use of the context throws the same fault again. The first fault of a tick is the one
  reported.
- This holds for ruleset code that runs outside the systems and handlers too. A validator at the
  commit, or the trap of a Proxy in the state, may use a context it kept; every method then faults
  before it acts, so it marks nothing and emits nothing. Step checks the recorded fault after each
  validator at the commit, which stops the commit there, and once more after the audit, before it
  returns a result. `createWorld`'s validators run outside every tick: a context kept from a step
  is expired there, throws `context_expired`, and changes nothing.

### A world is busy while it steps

From the first read of a command to the end of the tick, every function that reads or steps the
world (`step`, `readView` and the methods of every view, `fullChecksum`, `stateRoot`,
`chunkHashes`, and `worldStatus`) throws `world_busy`, so nothing sees or saves a partial state:

- Ruleset code that holds the world and calls one of them during the tick also faults the tick,
  at the system or command that made the call, so catching the error hides nothing.
- A host Proxy among the commands whose trap calls one of them while step reads the commands is
  refused the same way. Step then sees the trap's own result: a descriptor, which it validates as
  any other, or the thrown error, which makes that command an `invalid_input` issue. The world is
  unchanged either way, so a command always applies at the tick it names.

### What is detected, and when

Inside the tick, isolation is checked, not prevented (ADR 0020, ownership):

| Change | Detected |
|---|---|
| A write through `writeChunk`, `writeGlobal`, or `createChunk` | Valid: the commit hashes it |
| A value that is not canonical (`NaN`, `1.5`, `undefined`, a `Map`, `-0`), written through the barrier | At the commit of that tick: `system_fault` at its path |
| Data that the ruleset's validators reject | At the commit of that tick: `system_fault` with the validator's issues |
| A `Proxy` written into the state, which `biome.json` denies in the engine but ruleset code can still create | Not when its traps answer as plain data would: JavaScript cannot tell a Proxy from its target, so the commit accepts it, and its traps then run on every read, the host's included. Only a change in its answers is detected, as the next row describes |
| A write through `readChunk` or `readGlobal`, a reference kept from an earlier tick, a validator that changes the value it checks, or a Proxy whose answers change | With audit: after the commit of that tick, `integrity_violation` naming each stale chunk and the global value. Without audit: not in this pull request; snapshot encoding (next pull request) recomputes every digest and refuses a state that disagrees with them |

The commit takes each chunk's term, and the global digest, before its validator runs, so a
validator that changes its value is found like any other write that bypasses the barrier.

### Cost per tick

The kernel's work is O(K + E + D log D + B + C), as ADR 0020 sets it: the commands with their
payloads, the events, the changed chunks (sorted), the canonical bytes of what changed, and the
created chunks. Nothing depends on the number of chunks N: the sum is updated per changed chunk,
the kernel digest has a fixed size, the global value is hashed only when written, the draw
sequences are dropped with the context, and created chunks join the lazy index without sorting
it.

`stats.hashedBytes` is exact and deterministic: the UTF-8 bytes of the canonical text of
`["chunk", key, value]` for each changed chunk, of `["global", value]` when the global value was
written, and of the kernel, state, events, and tick arrays. Audit's full recomputation is O(N),
for tests, and is not counted, so a step returns the same result with or without audit.

### What the tests check

- the order: commands in seq order, each checked then applied, then systems in declared order;
  events numbered in emission order with their causes; the checksum composition, and that it
  covers the events;
- rejections of unknown types and by `check`, with their events and `rejectedCommands`;
- every rule of the context: live reads, marking, created chunks, ids, copies in `emit` and
  `createChunk`, and each misuse as a fault;
- input atomicity: an invalid command first or last, a wrong `applyTick`, seqs out of order or
  repeated, a payload over 8 KiB (and one of exactly 8 KiB, counted in bytes), and malformed
  types, origins, and members, each leaving the world unchanged;
- the fault matrix, at tick 1 and at tick 4: `check`, `apply` (first and last command), a system
  (first, middle, and last), a validator at the commit, five non-canonical writes, a `Promise`
  from `run` and from `apply`, an undeclared stream, and exhausted ids; and exhausted ticks. Each
  checks the code and issues, that only `worldStatus` answers, and its diagnosis;
- barrier violations, each found by audit at the exact tick, and missed without it;
- revocation, a fault caught by the ruleset, a nested step, and host isolation of the commands
  and of everything a step returns;
- randomness: counters per (stream, id) that continue within a tick and restart the next, and
  independence from other entities and streams;
- cost: the exact `hashedBytes`, a world of 10,000 chunks with one changed, and a lazy index;
- a fault swallowed outside the systems and handlers: each context method used by a validator at
  the commit, chunk and global, a Proxy trap at the commit and at the audit, and a commit that
  stops at the validator that faulted;
- a busy world: each read and `step`, from a system and from a command handler, and from a host
  Proxy while the commands are read, including one whose own step would fault;
- not yet: that the commit's work does not grow with the number of chunks, which the complexity
  test of PR 8 measures.

### Golden, fuzz, and isolation

These tests run a whole ruleset, `tally` (`packages/engine/test/fixtures/tally-ruleset.ts`). It
has four systems, three with streams of their own; commands that `check` rejects; a chunk created
every 7 ticks with an id from `newEntityId`; a permutation for a contended market; events from
systems and handlers; text with non-ASCII and astral characters, written as escapes; record keys
that look like integers, inserted out of canonical order; and integers near 2^53 in magnitude. It
keeps no module state.

| Test | What it proves |
|---|---|
| Golden (`golden-tally`) | A fixed seed and a scripted command list give, over 1,000 ticks, the checksums pinned at ticks 1, 10, 100, and 1000 and the pinned final state root, and the pinned digest of every tick's checksum, under the pinned `ENGINE_VERSION` and tally versions. The run is checked to reach every event type and every rejection reason tally has. The values pin behavior and do not prove it correct; a change that alters them must bump a version and record the new values (`fixtures/golden-tally.ts`) |
| Fuzz (`step-fuzz`) | 64 seeds of 200 ticks, with random valid command lists from `sfc32`. Each seed runs two worlds on the same lists. The first, under audit, also receives on about one tick in eight a list broken in one of seven ways, before the valid one: step must throw `invalid_input` and leave `stateRoot` and `fullChecksum` unchanged, and audit makes the incremental root equal the full one after every tick. The second, without audit, never receives a broken list. Both must give the same checksum, events, changed chunks, and statistics at every tick |
| Isolation (`world-isolation`) | Three worlds (two of them replicas) stepped in turn, in a random interleaving, and sharing one ruleset object, give exactly what each gives alone |

The fuzz runs 64 seeds, about 7.5 seconds on the 2-core Codespace: a tally tick costs about 110 µs,
and about 300 µs with audit, which recomputes every chunk. The plan's estimate of 200 seeds took
about 22 seconds, and every check runs the whole suite. Its explicit timeout is 30 seconds, and the
comment at the top of `step-fuzz.test.ts` says how to run a larger sweep once, by hand.

Measured observation (indicative: CPU profiles of tally runs, Bun 1.4.4 on the 2-core Codespace,
2026-10-24): for small chunks, of about 140 bytes of canonical text, the fixed costs of each
`walkCanonical` call (its `Map` of visited objects, path arrays, descriptor reads, and key lists)
dominate, and a commit spends about 70% of its time walking values. A small changed chunk costs
about 10 µs at the commit, far more than the per-byte figure of ADR 0020 (68 to 110 µs per 7 KB)
predicts, so that figure underestimates the cost of small chunks. The benchmark of the next
pull requests measures it properly.

### What arrives with snapshots

The next pull request encodes and decodes snapshots. Encoding recomputes every digest and refuses
a state that disagrees with its incremental ones, which detects in production the writes that
only audit detects now; decoding a snapshot is how a poisoned world is recovered.

## Lint exceptions

Each reviewed exception lets one file break one purity rule. That rule lives in a GritQL plugin of
its own, which `biome.json` registers for `src/**` except that file: Biome adds up the plugins of
every override that matches a file and cannot take one away, while an override that set
`noRestrictedGlobals` again would replace the engine's list of denied globals instead of merging
it. The list therefore stays one list, in one override.

| File | May use | Plugin in `packages/engine/lint/` |
|---|---|---|
| `canonical/order.ts` | Key enumeration through `Object`: it lists own keys with `getOwnPropertyNames` and `getOwnPropertySymbols`, and sorts them | `key-order.grit` |
| `canonical/encode.ts` | The global `JSON` | `global-json.grit` |
| `canonical/value.ts` | The global `Map`, to look up the objects a walk has entered; it never iterates one | `global-map.grit` |
| `step/context.ts` | The global `Map`, to look up the draw sequences of a tick by stream and id; it never iterates one | `global-map.grit` |
| `int.ts` | The global `Math`, for `Math.imul` and `Math.floor`, which ECMA-262 defines exactly | `global-math.grit` |

A global's plugin reports every reference to the name outside a type: member access, calls, `new`, aliasing,
arguments, shorthand properties, and `typeof`, even where a local declaration shadows the global.
Property names, keys, and types are not references to it. Assigning to any of these globals is
rejected everywhere by Biome's recommended `noGlobalAssign`.

`tests/repo/engine-lint.test.ts` proves that each plugin reports those references and not names,
keys, or types; that each exception covers its exact path; that look-alike paths are still rejected;
and that every other purity rule applies to the excepted files.
