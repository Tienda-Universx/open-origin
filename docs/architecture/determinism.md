# Determinism

The engine must turn the same inputs into the same results on every run and every host
([ADR 0003](../decisions/0003-authoritative-deterministic-engine.md)). This document specifies the
rules that make it so, as the code implements them;
[ADR 0020](../decisions/0020-deterministic-core-design.md) records why they were chosen. Each
section names its code and its tests.

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
| Nesting | At most 64 arrays and records deep, counted from the value's own root: the global value, a chunk, a command payload or origin, an event payload, and a `check` verdict are each a value | Bounds recursion. The engine's envelopes, which are the digest tags, the events list and event records, and the snapshot document, never count toward it, so a value that is accepted anywhere can be hashed, saved, and restored |
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
  record, a sparse array, an accessor, a cycle, nesting beyond 64 levels of the value itself, and
  an object reached a second time, reported with the path of its first occurrence.
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
`packages/engine/test/` (`murmur3`, `digest`, `lanes`, `utf8`, and `int`). `int.ts` also holds
`floorDiv(a, b)`, ⌊a / b⌋, and `floorMod(a, b)`, in [0, b), for a safe integer `a` and a positive safe
integer `b` that the caller guarantees: both are exact, and neither returns -0.

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
- **Hide its seed from its draws.** MurmurHash3 x86_32 folds `[s0, s1]` into one 32-bit state, and
  every later step can be undone. One draw whose stream, key, and counter are known therefore gives
  back that state, which predicts every draw of every stream, and a quantized draw takes a search
  over 2^32 states. The 64-bit seed is worth 32 bits. One public outcome therefore makes every draw
  predictable. That is acceptable only while nobody can act on a prediction: the generator is
  replaced by a keyed pseudorandom function before any public world with players, and terrain
  already uses a separate seed and ChaCha20 ([ADR 0021](../decisions/0021-procedural-world.md)).
- **Pass a statistical battery.** The checks above are smoke tests on fixed samples; no PractRand
  or TestU01 battery has been run.
- **Keep counters across calls by itself.** A `DrawSequence` keeps its own counter; the tick
  context keeps one sequence per stream and id for each tick (see [the tick
  context](#the-tick-context)), and faults a draw from a stream its caller did not declare. The
  ruleset check that rejects colliding stream ids, streams shared by two owners, and the reserved
  `engine.` prefix is part of [the world](#world).

### ChaCha20

Terrain draws from the ChaCha20 block function of RFC 8439 §2.3, with 20 fixed rounds, keyed by the
terrain seed and never by anything derived from the world seed
([ADR 0021](../decisions/0021-procedural-world.md)). Code: `packages/engine/src/rng/chacha.ts`,
which reads words through `src/rng/words.ts`, as `mix32` does. Tests:
`packages/engine/test/chacha.test.ts`.

| Function | Contract |
|---|---|
| `chacha20Block(key, input)` | One block. `key` is 8 u32 words and `input` 4 u32 words, which become state words 12 to 15 (in RFC 8439, the block counter and the nonce). It returns a fresh array of 16 u32 words: the state after the rounds plus the initial state, word by word modulo 2^32, which is the RFC's serialized block read as little-endian words. Each word is read once, by index, as `mix32` reads its key, with the same messages; all problems are reported at once, as `invalid_value`, at `/key`, `/key/i`, `/input`, and `/input/i` |
| `new ChaCha20Key(key)` | Validates and copies the key once, with the same issues as `chacha20Block`, for hot loops |
| `prepared.blockInto(input, output)` | Writes the block for the first 4 words of the `Uint32Array` `input` to words 0 to 15 of the `Uint32Array` `output`, without validating or allocating. The caller guarantees the lengths. `input` is read before `output` is written, so the two may share memory. Each prepared key has working words of its own, so keys share no state |

The rounds keep the state in an `Int32Array` with a quarter-round helper: about 225 ns per block on
the two-core Codespace (Bun 1.4.4, indicative), against about 130 ns with the 16 words in local
variables, which no function of 50 lines or fewer can hold. The lint limit stays.

What the tests check:

- the block function vectors of RFC 8439 (§2.3.2 and appendix A.1, #1 to #5), each against the
  serialized bytes and the final state words that the RFC prints;
- two blocks whose key and input words have the high bit set, which no RFC vector has,
  cross-checked against OpenSSL 3.5.8's `chacha20` when they were written;
- every validation problem with its path, reported together, holes and getters included;
- `blockInto` equals `chacha20Block` on 1,024 random blocks, all distinct; it leaves its inputs
  unchanged, writes only words 0 to 15, and two prepared keys interleaved give what each gives alone;
- when the tests were written, each deliberate defect made them fail: a wrong rotation, no final
  addition, swapped diagonal words, 18 rounds, reversed input words, a wrong constant, a key buffer
  shared by all keys, unchecked holes and lengths, a word read twice, and a write past word 15.

What it guarantees, and what it does not:

- **Determinism.** The same key and input give the same words on every ECMAScript engine, because
  the block uses only 32-bit addition, xor, and rotation, which ECMA-262 defines exactly.
- **Unpredictability, under an assumption.** Without the key, blocks nobody observed cannot be
  computed from observed ones, under the standard assumption that ChaCha20 is a pseudorandom
  function with a 256-bit key. Public cryptanalysis supports it; nothing proves it.
- **Generator security.** It also needs the terrain seed to stay secret (C3) and no two uses to
  share an input. Observed terrain still reveals the dominant shape within the coarsest lattice cell
  it touches, and nothing here replaces the kernel's `ctr-mix32@1`.

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
- The host's view and the tick context expose the world's `simSecondsPerTick`. The host's read
  throws `world_faulted` once the world is poisoned and `world_busy` during a step; the context's
  read throws `context_expired` after its step returns ([ADR 0021](../decisions/0021-procedural-world.md)).

Pacing ticks in real time (`TICK_RATE_HZ`) belongs to the scheduler (T6). The calendar belongs to
worldgen, which defines the length of a day as a law of each world
([ADR 0021](../decisions/0021-procedural-world.md)).

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
   - `options`, when given, is a record whose only member is `audit`, a boolean when present.
     Every other key is an issue at `/options/<key>`, all of them in canonical order before the
     problems of `audit`; symbol keys are one issue at `/options`.

The options are strict on purpose, here and in `decodeSnapshot`: a misspelled option such as
`{ audti: true }` must not silently turn audit off, so an unknown key is refused instead of
ignored. The cost is compatibility: a host written for a later engine that adds an option fails
loudly on this one instead of running without it.

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
| `simSecondsPerTick` | The world's seconds per tick, from its configuration, which never changes: an instant read inside the step that computes tick T equals one read outside at tick T ([ADR 0021](../decisions/0021-procedural-world.md)) |
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
  `fullChecksum`, `stateRoot`, `encodeSnapshot`, `snapshotBytes`, and `versionDifferences` throw
  `world_faulted`. Recovery starts from the last snapshot, with `decodeSnapshot`.
- A world keeps its first fault: poisoning a world that is already poisoned changes nothing, so
  `worldStatus` always gives the diagnosis of the fault that stopped it.
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
`chunkHashes`, `worldStatus`, `encodeSnapshot`, `snapshotBytes`, and `versionDifferences`) throws
`world_busy`, so nothing sees or saves a partial state:

- Ruleset code that holds the world and calls one of them during the tick also faults the tick,
  at the system or command that made the call, so catching the error hides nothing.
- A host Proxy among the commands whose trap calls one of them while step reads the commands is
  refused the same way. Step then sees the trap's own result: a descriptor, which it validates as
  any other, or the thrown error, which makes that command an `invalid_input` issue. The world is
  unchanged either way, so a command always applies at the tick it names.
- Step checks that the world's tick and health did not change while it read the commands. Only an
  engine function that skipped the busy guard could change them, so the check guards that rule:
  step then throws `world_busy`, naming the engine defect, and poisons the world, which keeps its
  first fault if it already had one.

### A world is busy while it is read

Every function that reads a value of the state, and so can run the traps of a Proxy in it, marks
the world busy while it reads: `fullChecksum`, the view's `readChunk` and `readGlobal`,
`encodeSnapshot`, and `snapshotBytes` (`readState` in `world/world.ts`). A call of any engine
function from a trap meanwhile throws `world_busy`, naming the function called and the one that
reads, and changes nothing. The rule for the read is exact:

| The read | Result |
|---|---|
| completes | Its result, even when a trap caught a refusal and then answered as data |
| throws after a refusal | The first refusal, `world_busy`, and nothing is poisoned, whether the trap let the refusal escape, caught it and threw something else, threw a copy, or was refused again. This holds even when the state itself is bad, such as a value that is not canonical: once a trap was refused, the engine cannot tell the trap's failure from the state's, so it blames neither, and the next read with no refusal finds the bad state |
| poisons the world after it completed | That fault: `encodeSnapshot` whose recomputed root differs throws `integrity_violation`, which a refusal does not replace |
| throws, with no refusal | Its own error: `invalid_value` at the value's path for `fullChecksum`, `readChunk`, and `readGlobal`, and `integrity_violation` for the encoders |

`chunkHashes`, `stateRoot`, `worldStatus`, `versionDifferences`, and the view's `tick`,
`simSecondsPerTick`, and `chunkKeys` read only what the engine keeps (cached digests, keys, the kernel, and the header), so
no trap can run during them. `world-reentry.test.ts` checks each reader against `step`,
`readView`, and `encodeSnapshot` called from a trap, each way a trap can fail after a refusal, an
encoding that poisons the world after a trap caught a refusal, and each reader's own error when a
trap throws without using the world.

### What is detected, and when

Inside the tick, isolation is checked, not prevented (ADR 0020, ownership):

| Change | Detected |
|---|---|
| A write through `writeChunk`, `writeGlobal`, or `createChunk` | Valid: the commit hashes it |
| A value that is not canonical (`NaN`, `1.5`, `undefined`, a `Map`, `-0`), written through the barrier | At the commit of that tick: `system_fault` at its path |
| Data that the ruleset's validators reject | At the commit of that tick: `system_fault` with the validator's issues |
| A `Proxy` written into the state, which `biome.json` denies in the engine but ruleset code can still create | Not when its traps answer as plain data would: JavaScript cannot tell a Proxy from its target, so the commit accepts it, and its traps then run on every read, the host's included. Only a change in its answers is detected, as the next row describes |
| A write through `readChunk` or `readGlobal`, a reference kept from an earlier tick, a validator that changes the value it checks, or a Proxy whose answers change | With audit: after the commit of that tick, `integrity_violation` naming each stale chunk and the global value. Without audit: at the next `encodeSnapshot` or `snapshotBytes`, which recomputes every digest, poisons the world with the same `integrity_violation`, and returns no text ([snapshots](#snapshots)) |

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

The [complexity test](#the-complexity-test) enforces this in CI, and the
[benchmark](#measured-cost-indicative) measures it.

### Measured cost (indicative)

`bun packages/engine/bench/step.ts` prints these numbers. They are indicative: one run on the
2-core Codespace, with Bun 1.4.4, on 2026-10-25, which took about 36 s and peaked at about 1.3 GB
of resident memory, most of it the world of 1,000,000 chunks. Compare runs of the benchmark on
one machine, before and after a change to a hot path; never compare across machines.

| Measurement | Result |
|---|---|
| A tick with D = 10 small changed chunks, N = 1,000 / 10,000 / 100,000 / 1,000,000 | 72.1 / 73.3 / 73.5 / 71.9 µs |
| A changed chunk of 1.0 KB of canonical text | 43 µs (25 MB/s) |
| A changed chunk of 7.0 KB | 253 µs (28 MB/s) |
| A changed chunk of 49.3 KB | 1,885 µs (27 MB/s) |
| `encodeSnapshot` / `decodeSnapshot`, 0.2 MB | 9.1 ms (23 MB/s) / 14.4 ms (14 MB/s) |
| `encodeSnapshot` / `decodeSnapshot`, 10.2 MB | 468 ms (22 MB/s) / 891 ms (11 MB/s) |
| Kernel memory per chunk (key, entry, term, index), N = 100,000 | 274 B |
| MurmurHash3 x86_128 over 1 MiB | 2,481 MB/s |
| Draws of one `DrawSequence` (`u32`) | 35.0 million per second |

What they show:

- A tick costs the same at every N, as the cost model says.
- The pipeline of a changed chunk (canonical text, validation, term) runs at about 25 to 28 MB/s
  per core. ADR 0020's prototype estimate was 55 to 80 MB/s, so it is about half as fast. One
  core at 5 Hz then handles about 5 to 6 MB of changed state per tick, not 11 to 16 MB; v0.1
  needs a few KB. Hashing is not what limits it: it runs at about 2.5 GB/s.
- The throughput is about the same from 1 KB to 50 KB, so above about 1 KB a changed chunk costs
  in proportion to its bytes. Below that, the fixed cost of each walk dominates, as the CPU
  profiles of [tally runs](#golden-fuzz-and-isolation) found.
- The kernel keeps about 270 bytes per chunk. The 16 bytes of a 128-bit term are a small part of
  that; the rest is JavaScript's objects, arrays, and strings for the key, the entry, and the index.
  A million chunks would take about 270 MB before any chunk value.

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
- cost: the exact `hashedBytes`, a world of 10,000 chunks with one changed, a lazy index, and the
  [complexity test](#the-complexity-test);
- a fault swallowed outside the systems and handlers: each context method used by a validator at
  the commit, chunk and global, a Proxy trap at the commit and at the audit, and a commit that
  stops at the validator that faulted;
- a busy world: each read and `step`, from a system and from a command handler, and from a host
  Proxy while the commands are read, including one whose own step would fault;

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
| Isolation (`world-isolation`) | Three worlds (two of them replicas) stepped in turn, in a random interleaving, and sharing one ruleset object, give exactly what each gives alone, record by record (`interleave` and `recordRun` of the [determinism suite](#determinism-suite)) |
| Determinism suite (`determinism-suite`) | The golden run, and 200 ticks of generated commands, pass every check of the [suite](#determinism-suite), including resumption at ticks 0, 1, 2, 37, 299, 300, and 999 in process and at 0, 37, and 999 in child processes |

The fuzz runs 64 seeds, about 8 seconds on the 2-core Codespace: a tally tick costs about 110 µs,
and about 300 µs with audit, which recomputes every chunk. The plan's estimate of 200 seeds took
about 22 seconds, and every check runs the whole suite. The test is synchronous, so Bun cannot
interrupt it: its timeout only fails a run that took longer, and the CI job's timeout stops a hang.
The timeout is therefore a budget of 1 second per seed, about eight times the measured cost, so a
runner that much slower still passes (four runs at once on the Codespace took 32 seconds each). The
comment at the top of `step-fuzz.test.ts` records the measurements and says how to run a larger
sweep once, by hand.

Measured observation (indicative: CPU profiles of tally runs, Bun 1.4.4 on the 2-core Codespace,
2026-10-24): for small chunks, of about 140 bytes of canonical text, the fixed costs of each
`walkCanonical` call (its `Map` of visited objects, path arrays, descriptor reads, and key lists)
dominate, and a commit spends about 70% of its time walking values. A small changed chunk costs
about 10 µs at the commit, far more than the per-byte figure of ADR 0020 (68 to 110 µs per 7 KB)
predicts, so that figure underestimates the cost of small chunks. The
[benchmark](#measured-cost-indicative) confirms it: about 40 µs for a chunk of 1 KB.

## Snapshots

A snapshot is a world as canonical text, so a host can save it, hash it, and load it on any host
(ADR 0020, snapshots). Encoding checks the world's integrity; decoding checks the text, the schema,
the ruleset's validators, and the state root; step checks that the versions allow a replay. Code:
`packages/engine/src/snapshot/` and `src/world/versions.ts`. Tests: `packages/engine/test/`
(`snapshot`, `snapshot-decode`, `snapshot-resume`, and `snapshot-fixture`), and
`tests/repo/format-exclusions.test.ts` for the fixture's exclusion from Biome.

### Format: version 1

```text
{ header: { snapshotSchemaVersion: 1, engineVersion, rulesetVersion, generatorVersion, brainVersion },
  stateRoot,
  world: { epoch, tick, nextEntityId, rng: { algorithm: "ctr-mix32@1", seed },
           config: { simSecondsPerTick }, global, chunks } }
```

- The text is canonical, so its members are in canonical key order, and one world has one text.
- It holds no world id, which is host metadata, so replicas of a world encode to the same text.
- `stateRoot` covers the world, not the header. The header records the versions that made the
  world; integrity against corruption and tampering, header included, is SHA-256 over
  `snapshotBytes`, in the adapter.
- The snapshot holds the seed, so it is C3 as a whole
  ([data classification](data-classification.md#why-the-seeds-are-c3)).

| Function | Cost | Result |
|---|---|---|
| `encodeSnapshot(world)` | O(N) | The text, after the integrity check below. The world is busy while it is read, so a Proxy in the state cannot step or read it meanwhile |
| `snapshotBytes(world)` | O(N) | The UTF-8 bytes of the same text, in a fresh array, which adapters hash with SHA-256 |
| `decodeSnapshot(text, ruleset, options?)` | O(N) | A new world, after the gates below; `options.audit` as in `createWorld` |
| `versionDifferences(world)` | O(1) | Each difference between the header and the running versions, in a fresh array. Plan §4 writes `versionDifferences(world, ruleset)`; the world runs the ruleset it captured, so that ruleset is the one compared and no second argument is taken |

Encoding and decoding cost O(N) for N chunks, so they run at checkpoints and on load, never every
tick.

### Integrity check at encoding

`encodeSnapshot` canonicalizes the global value and each chunk once. Each text goes into the
snapshot and into its digest (`["global", global]` and `["chunk", key, chunk]`, as the
[state root](#state-root) defines them), so the root is recomputed from the very text the snapshot
holds. When it differs from the world's incremental root, a write bypassed the barrier: the world
is poisoned with `integrity_violation`, which names each stale chunk and the global value as audit
does, and no text is returned. This is how such a write is found when audit is off.
`fullChecksum` and audit recompute the root with `recomputeRoot`, and the encoders with
`recomputeState`, which also keeps each value's text; both run the same private `recompute` in
`world/checksum.ts`, so the three cannot disagree about the composition.

Only a value that is not canonical, or a root that differs, blames the state. A use of the world
from a Proxy's trap during the encoding is refused, and what follows it is decided by the rule of
[a world that is read](#a-world-is-busy-while-it-is-read): a read that fails after a refusal
throws `world_busy` and poisons nothing. A trap that throws without using the world leaves a
value that cannot be read, which is not canonical: `integrity_violation`. Either way, no text is
returned.

### Gates

| Gate | Where | Refuses with |
|---|---|---|
| Integrity | `encodeSnapshot`, `snapshotBytes` | `integrity_violation`; the world is poisoned and no text is returned |
| Options | `decodeSnapshot`, first, before the text | `invalid_input`, as `createWorld` reports its options: at `/options`, "the options must be a record", for options that are neither undefined nor a record (`null`, a number, a string, an array), symbol keys, and what was thrown for options that throw while read or while their keys are listed (a revoked Proxy); at `/options/<key>` for every key other than `audit`; at `/options/audit` for an `audit` that is not a boolean, that is an accessor or not enumerable, or whose read throws, as with a Proxy that throws only when `audit` is read |
| Canonical text | `decodeSnapshot`, with `parseCanonicalEnvelope`, whose nesting budget covers the snapshot document; each value's own depth is checked with the content | `invalid_snapshot` with the parser's issue: whitespace, reordered keys, a float, or text that is not JSON |
| Schema version | `decodeSnapshot`, before any member is checked | `unsupported_schema`, reported alone: a snapshot of another version may have other members, at the top level too |
| Schema | `decodeSnapshot` | `invalid_snapshot` with every problem at once, in schema order (below): each missing and each extra member of the snapshot, the header, the world, `rng`, and `config`; versions that are not non-empty strings; a `stateRoot` that is not 32 lowercase hexadecimal digits; `epoch` and `tick` outside the safe integers from 0; `nextEntityId` outside the safe integers from 1; an algorithm other than `ctr-mix32@1`; a seed that is not two u32 words; `simSecondsPerTick` that is not a positive safe integer; and chunk keys that `parseChunkKey` rejects |
| Ruleset | `decodeSnapshot`, after the schema | `invalid_ruleset`, as `createWorld` reports it |
| Content | `decodeSnapshot`, last | `invalid_snapshot` with every issue the ruleset's validators return for the global value and each chunk, and a stored `stateRoot` that differs from the recomputed one, at once |
| Replay | `step`, after the brand, busy, and health guards | `version_mismatch` with every difference between the header and `ENGINE_VERSION` and the ruleset's versions; the world stays healthy and unchanged |

Schema order is the order in which the gate reads the snapshot: the top level, the header,
`stateRoot`, then the world. At each record come its missing members, in the schema's order, then
its extra members, in canonical key order, then the problems of its own members, in the schema's
order. The world's members are `epoch`, `tick`, `nextEntityId`, `rng`, `config`, `global`, and
`chunks`, each chunk key in canonical order. A world missing `tick` and `config` and with an
extra member `aaa` reports `/world/tick`, `/world/config`, then `/world/aaa`.

A decoded world keeps the versions its header records, even when they differ from the running
engine or ruleset: it loads, but it cannot be replayed. Worlds that `createWorld` makes always
match. The replay gate runs before step reads a command, so no host code among the commands runs.

The validators run after every digest is taken, as at `createWorld` and at the commit: a
validator that changes a value it is given, at decoding, leaves a stale digest that
`fullChecksum` and `encodeSnapshot` find.

### Recovery

A world poisoned at tick N recovers from the last snapshot taken before N:

- Decoded with a corrected ruleset that keeps the same version labels, it continues exactly as
  the corrected ruleset runs from tick 0, provided the fault changed no state before N.
- Decoded with a corrected ruleset that bumps its version, it loads, and `step` refuses it with
  `version_mismatch`: replay requires equal versions, by design until T7 opens epochs.

### What is promised, and what is not

| Promised | Not promised |
|---|---|
| Encode, decode, encode is byte-identical, with equal state roots and full checksums | Replay across versions: a snapshot from another engine or ruleset version loads, but `step` refuses it |
| A world resumed from a snapshot, with a fresh ruleset object, continues exactly as the world that was never interrupted | Migrations: the `vN -> vN+1` chain arrives with the first version 2, in T7 |
| The frozen version 1 fixture keeps loading in every future engine, through migrations once version 2 exists | Opening an epoch after an upgrade or an experimental change: `epoch` is in version 1, and opening one arrives with T7 and T8 |
| Nothing the host gave or received changes a world: the text and bytes are fresh, and the ruleset is captured | Authenticity, or integrity against tampering: SHA-256 in the adapter covers integrity; authenticity is not provided in v0.1 |

### What the tests check

- the version 1 text of a small world, written by value; `snapshotBytes` as the UTF-8 of that text;
- the round trip of 40 fuzzed tally worlds, byte for byte, with equal roots and full checksums;
- every schema rejection above, missing and extra members at every level reported at once in
  schema order, an uppercase `stateRoot`, and schema versions 0 and 2 reported alone, version 2
  with a member added or removed at the top level included;
- options checked before the text, every kind of options that is not a record, and the true count
  of more than 50 parser issues;
- a tampered state root, a changed value under an unchanged root, and validator issues reported
  with the root in one error; validators that change what they check at decoding, found at
  encoding;
- an epoch other than 0, round-tripped and stepped;
- the replay gate for each version field and for all four at once, and for a ruleset with other
  versions, each leaving the world unchanged; and that it runs before any command is read;
- recovery after a fault with a corrected ruleset, with the same version labels and with a bumped
  version;
- resumption of the golden run, in process at ticks 0, 1, 2, 37, 299, 300, and 999 and in child
  processes at 0, 37, and 999: every later tick and the final text equal the uninterrupted run's
  (the [determinism suite](#determinism-suite));
- each write behind the barrier, without audit, found by `encodeSnapshot`, which poisons the world
  and returns no text; several stale chunks and the global value, each named, at encoding and by
  audit;
- a busy world: `encodeSnapshot`, `snapshotBytes`, and `versionDifferences` from a system and a
  handler, and a Proxy in the state whose trap steps the world while `encodeSnapshot` or
  `snapshotBytes` reads it, refused with a message that names that function; a trap that lets the
  refusal escape fails the encoding with that `world_busy` and leaves the world healthy, one that
  catches the refusal and then changes what the Proxy answers poisons the world with an
  `integrity_violation` that the refusal does not replace, and one that throws without using the
  world is an `integrity_violation`
  ([a world that is read](#a-world-is-busy-while-it-is-read) has the whole rule);
- the snapshot's `stateRoot` equal to the root computed independently from the formulas, on 200
  random worlds;
- unknown options refused at both entry points, every unknown key listed in canonical order, and
  known options still accepted;
- the frozen fixture (`packages/engine/test/fixtures/snapshot-v1.canonical.json`, the golden run at
  tick 37): its pinned SHA-256, a byte-identical re-encoding, and the pinned checksums of ticks 38
  to 40. `biome.json` excludes exactly its path from formatting, which
  `tests/repo/format-exclusions.test.ts` proves against files next to it.

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
| `int.ts` | The global `Math`, only as `Math.imul` and `Math.floor` (called or used as values), which ECMA-262 defines exactly; `int-math.grit`, registered for `int.ts` alone, rejects every other reference to `Math` | `global-math.grit` (excepted), `int-math.grit` |

A global's plugin reports every reference to the name outside a type: member access, calls, `new`, aliasing,
arguments, shorthand properties, and `typeof`, even where a local declaration shadows the global.
Property names, keys, and types are not references to it. Assigning to any of these globals is
rejected everywhere by Biome's recommended `noGlobalAssign`.

`tests/repo/engine-lint.test.ts` proves that each plugin reports those references and not names,
keys, or types; that each exception covers its exact path; that look-alike paths are still rejected;
that every other purity rule applies to the excepted files; and that `int-math.grit` holds `int.ts`
to `Math.imul` and `Math.floor` and applies to no other file.

## Determinism suite

The suite is the one harness that every ruleset runs: tally in T2, and the rulesets of T3 to T5,
which ADR 0020 requires to pass it with audit on (plan §1 item 8, §2.5, §8). Code:
`packages/engine/test/support/` (`determinism-suite.ts`, `determinism-records.ts`, and
`resume-child.ts`), with its negative controls in `broken-rulesets.ts`. Tests:
`packages/engine/test/determinism-suite.test.ts`.

### What it checks

`runDeterminismSuite(subject)` runs the subject's world several times and compares, tick by tick,
the record of each tick: its checksum, events, changed chunks, and statistics, as canonical text.

| Property | Check | What it catches |
|---|---|---|
| `fault` | The uninterrupted run, the reference, completes every tick | A tick that faults, such as a system that returns a `Promise` |
| `repeat` | A second run, with a fresh ruleset, gives the same records | State that changes across runs, such as a counter shared between them |
| `audit` | A run under audit gives the same records, so the incremental root equals the full one at every tick | A write behind the barrier, at the tick it happens |
| `resume` | At each cut, the snapshot of that tick, decoded with a fresh ruleset under audit, gives the same records from the next tick, and the same final snapshot text. The snapshots come from a run of their own, so an encoding that poisons its world changes no other run | Behavior that depends on insertion order, which a decoded world does not keep; state kept in the ruleset object; a write behind the barrier, which encoding refuses, and which audit finds at its tick even when only a resumed world makes it |
| `child-resume` | The same, in a fresh child process for each child cut, also under audit | State kept at module level, which an in-process resume shares with the first run |
| `interleave` | The world, a world with the second seed, and a replica of the first, sharing one ruleset object and stepped in a seeded random interleaving, give what each gives alone: the first seed's worlds the reference run, and the second seed's world its run alone in a fresh child process | State shared between worlds, through the ruleset object or a module. A module cache keyed without the seed agrees with itself within one process, whose runs all start from what the first seed left in it, so only a process that has seen no other world can give the second seed's own run |

It returns a report and asserts nothing, so the negative controls can prove that it fails. Each
failure names its property, the first tick at which it failed, and, for a resume, the cut (for an
interleaving, the world). Only the first divergence of each comparison is reported, since the
ticks after it follow from it. The report also lists the cuts each resume ran, so a check that
ran nothing shows, and holds the reference records and the final snapshot text.

### How a batch uses it

```ts
const report = await runDeterminismSuite({
  ruleset: { module: import.meta.resolve("./fixtures/terrain-ruleset.ts"), name: "terrainRuleset" },
  world: (seed, ruleset, audit) => terrainWorld(seed, ruleset, audit),
  seeds: [[1, 2], [3, 4]],
  ticks: 1_000,
  commands: terrainCommands,
  cuts: [0, 1, 37, 999],
  childCuts: [37],
});
expect(report.failures).toEqual([]);
```

- `ruleset` names a module and the function it exports, which returns a fresh ruleset on every
  call; the child process imports it by that path, so the module must load on its own.
- `world(seed, ruleset, audit)` must build its world with the ruleset and the audit flag it is
  given. A factory that ignores them makes checks vacuous: the audit run then audits nothing, and
  the repeat and the interleaving do not run the fresh or the shared ruleset object they test.
- `commands(tick)` is called once per tick, in order from 1, before any run, so a generator such
  as `sfc32` may keep state: every run, the child processes included, gets the same script.
- Cuts are ticks in [0, ticks), and a subject needs at least one, in `cuts` or `childCuts`, since
  with none the resume checks would pass without running. A subject that breaks these rules is
  refused before anything runs.
- The optional second argument, `{ childTimeoutMs }`, sets the
  [child processes'](#the-child-process) time limit; it must be a positive integer.

### The child process

The suite starts one child process per child cut, and one for the interleaving's run of the second
seed alone: `bun resume-child.ts` with `process.execPath`, in the repository root, so
`bunfig.toml` keeps telemetry off. Its input is one JSON document on stdin: the ruleset's module
and name, the snapshot text, the tick to continue from, the whole script, and whether to audit.
Its output is one JSON document on stdout: the record of every tick it ran, and its final snapshot
or what encoding it threw. A resume decodes its snapshot under audit, as the in-process resume
does. The second seed's run starts from that world's snapshot at tick 0, built before any child
starts, and decodes it without audit, as the interleaving's worlds run; a world decoded at tick 0
runs as the one its factory created, as every resume from cut 0 shows. Nothing touches the disk,
so there is nothing to clean up.

The processes start together and run while the parent does its in-process resumes and the
interleaving. Those are synchronous, so meanwhile the parent neither feeds a child's stdin nor
drains its stdout; each child's time limit therefore starts only when the parent waits for it.
Past that limit, 30 s by default (`CHILD_TIMEOUT_MS`, or `childTimeoutMs`), the process is killed
with SIGKILL and reaped, and if an in-process check throws, every child is killed and reaped before
the error propagates, so no process outlives the suite. Each of these is a failure that names the
problem: a `child-resume` failure at its cut, or, for the second seed's run, an `interleave`
failure of world 1 at tick 0:

- a process that ran past its limit, with the end of its stderr;
- a process that exited with an error, with its exit code, the signal that killed it if any, and
  the end of its stderr;
- a process that exited with 0 but wrote nothing, output that is not JSON, or JSON without the
  shape of the child's output (the records, each with a tick and a fault or its four parts, and
  the final snapshot or its error), with the start of what it wrote.

### Negative controls

Each control in `broken-rulesets.ts` is broken on purpose, and a test asserts the exact failures
the suite reports for it:

| Control | Defect | Reported |
|---|---|---|
| `writesThroughReadChunk` | Writes through `readChunk` at tick 5 | `audit` at tick 5; `resume`: the encoding at the cut after it throws `integrity_violation`, and each resume from before it faults at tick 5 under audit |
| `dependsOnInsertionOrder` | Remembers the first key of a record by `Object.keys` | `resume` and `child-resume` at the tick after a cut with two keys or more |
| `keepsModuleCache` | A module-level `const` `Map` of the tick each chunk was first written | `child-resume` only, at the tick after the cut |
| `keepsRulesetCache` | The same cache, in the ruleset object | `resume` at the tick after the cut |
| `keepsModuleCacheOfSeed` | A module-level `const` `Map` of the first draw of the process, keyed without the world seed | `interleave` only, for the second seed's world at tick 1 |
| `returnsPromise` | A system that returns a `Promise` | `fault` at tick 1 |
| `sharesCounter` | A counter shared by every run in the process | `repeat`, `audit`, `resume`, and `interleave` at their first tick |
| `keepsLastTick` | The tick its ruleset object last ran, kept in the object | `interleave` only, at the first tick at which each world finds another world's tick |
| `writesBehindOnResume` | Writes through `readChunk` on the first tick of a ruleset object that starts after tick 1, and restores the value the same way on the next, so every record and snapshot stay the same | `resume` and `child-resume` at the tick after the cut, found only by the resumes' audit |

Other rulesets in `broken-rulesets.ts` count as tally does in the parent, but make the child
process exit with an error, hang, or write nothing, text that is not JSON, or JSON of another
shape; a test asserts the `child-resume` failure and the `interleave` failure of the second seed's
run that each gives, and that a child that hangs is killed and reaped.

Tally, the positive control, passes every check on the golden run and on 200 ticks of generated
commands. A test of the comparison itself shows that a divergence that heals is still found, at its
tick, so comparing only the final checksum would fail it.

### The complexity test

`step-cost.test.ts` proves in CI that the kernel's work per tick does not depend on the number of
chunks N (plan §2.4, criterion 9). Two worlds, of 1,000 and 200,000 chunks, change D = 10 chunks
per tick. Their `stats.hashedBytes` must equal the canonical bytes of the changed chunks plus the
fixed digests, and the median tick of the large world must cost less than 2 times that of the
small one. Measured (indicative: Bun 1.4.4, the 2-core Codespace, 2026-10-25, alone and four
runs at once), the kernel gives 0.95 to 1.1. Added to the commit, the cheapest work that grows
with N, a bare copy of the key list, gives 3.1 to 4.2, whether before or after the commit adds the
created chunks; a scan of every key gives about 95, and a sort about 70. An O(N) term is
therefore caught once it costs more than about 0.3 ns per chunk per tick, as much as a whole tick
of D = 10. The plan set the bound at 4 (§8 "Complejidad"), which a bare copy passed, so the test
uses 2: 1.8 times the kernel's highest ratio, while the bare copy's lowest is 1.5 times 2. The
worlds and the ruleset are those of the benchmark's step rows (`test/support/cost-worlds.ts`), so
both measure the same tick.

Against flakiness, the test collects garbage before it measures, steps both worlds alternately so
they share the machine's conditions, warms up for 100 ticks, takes the median of 300, and repeats a
failed measurement once: an O(N) bug fails both attempts, and noise rarely does. A test of the
bound itself checks that 1.99 passes, and that 2 and the 3.1 of a bare copy fail. If the test
still fails intermittently, plan R11 moves it to the benchmark, with the reason recorded. It takes
about 2 s, most of it creating the large world.

### Time

On the 2-core Codespace with Bun 1.4.4 (2026-10-25; indicative), the golden subject takes about
10 s: about 13,000 ticks in process, about 6,400 of them under audit (the audit run and the
resumes), and three child processes, which resume under audit too. The test of a child that hangs
waits for its time limit of 1 s. The whole `bun test` takes about 26 to 29 s.

