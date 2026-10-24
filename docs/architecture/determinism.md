# Determinism

The engine must turn the same inputs into the same results on every run and every host
([ADR 0003](../decisions/0003-authoritative-deterministic-engine.md)). This document specifies the
rules that make it so, as the code implements them;
[ADR 0020](../decisions/0020-deterministic-core-design.md) records why they were chosen. Each
section names its code and its tests, and the later T2 pull requests add one section per
subsystem still to come: `step` and snapshots.

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

Every failure is an `EngineError` with a `code` (`invalid_value` here, and `tick_overflow` for
[time](#time), `invalid_input` and `invalid_ruleset` for [the world](#world); later batches add
codes) and `issues`. An issue has a `path`, a JSON Pointer
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
- **Update the state root per tick yet.** [The world](#world) composes its root with these lanes
  once, when it is created; updating the sum for the chunks a tick changed arrives with `step`.

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
- **Keep counters across calls yet.** The per-tick counter for each stream and entity arrives with
  the step context, and so does the fault for a draw from a stream its caller did not declare.
  The ruleset check that rejects colliding stream ids, streams shared by two owners, and the
  reserved `engine.` prefix is part of [the world](#world).

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
reading it, and its state root; `step` arrives in the next pull request. Code:
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
writes them: `chunkKey({ x: -1, y: 0 })` is `"-1,0"`. `chunkKey` reads `x` and `y` as own data
properties, as every host object is read (below). `parseChunkKey` accepts a part only when
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
| `fullChecksum(world)` | O(N) | The root recomputed from the state alone, never from the cache. It equals `stateRoot` unless something changed the state without the engine knowing |
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

- chunk keys round-trip and reject every malformed form above;
- the index orders `"-1,0"` < `"0,0"` < `"10,0"` < `"2,0"`, keeps adds pending (an observable
  `pendingCount`) until asked while counting them in its `size`, and agrees with a full sort
  under random adds;
- every ruleset rule, all reported at once, including a real `streamId` collision;
- every `createWorld` check, all reported at once, and validators that throw, return malformed
  results, or try to use `this`;
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

### What arrives with `step`

These parts of ADR 0020 are not implemented yet; the types for the first two ship now in
`world/contracts.ts`:

- **The tick context and commands.** `TickContext`, `Command`, `EngineEvent`, `Rejection`, and the
  handlers' signatures are types only: no command is applied and no system runs.
- **Faults.** `worldStatus` always reports `{ kind: "ok", tick }`. Its `faulted` form, and
  poisoning a world whose tick failed after a change, arrive with `step`.
- **Incremental digests.** The cache is computed once, at creation. Updating the sum and the root
  for the dirty chunks of a tick, and validating dirty data at commit, arrive with `step`.
- **Audit.** `options.audit` is validated and stored; recomputing every digest after each tick
  arrives with `step`, and the check before encoding a snapshot with snapshots.

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
| `int.ts` | The global `Math`, for `Math.imul` and `Math.floor`, which ECMA-262 defines exactly | `global-math.grit` |

A global's plugin reports every reference to the name outside a type: member access, calls, `new`, aliasing,
arguments, shorthand properties, and `typeof`, even where a local declaration shadows the global.
Property names, keys, and types are not references to it. Assigning to any of these globals is
rejected everywhere by Biome's recommended `noGlobalAssign`.

`tests/repo/engine-lint.test.ts` proves that each plugin reports those references and not names,
keys, or types; that each exception covers its exact path; that look-alike paths are still rejected;
and that every other purity rule applies to the excepted files.
