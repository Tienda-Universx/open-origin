# Worldgen

Worldgen is the procedural world generator: the world is a latent field that the engine evaluates
and never stores, a pure function of the generator version, the genesis, and the cell.
[ADR 0021](../decisions/0021-procedural-world.md) records that design and why. This document
specifies what the code implements: space, the sealed genesis, noise, terrain, time, the
observables, and how they run inside the kernel. Code: `packages/engine/src/worldgen/`, exported by
`packages/engine` as the `worldgen` namespace. Tests: `packages/engine/test/` (`worldgen-space`,
`worldgen-genesis`, `worldgen-lattice`, `worldgen-noise`, `worldgen-terrain`, `worldgen-calendar`,
`worldgen-observables`, `worldgen-scale`, `worldgen-suite`, and `worldgen-observer`). Benchmark:
`packages/engine/bench/worldgen.ts`.

`WORLDGEN_VERSION` is `"worldgen@1"`. The seal of a genesis contains it, so a seal made under any
other version does not match; [ADR 0021](../decisions/0021-procedural-world.md#decision)
(Versioning) says when the version changes.

## Space

Code: `worldgen/space.ts`.

### Bounds and indexing

| Quantity | Rule | Constant |
|---|---|---|
| Chunk | 32 × 32 cells | `CHUNK_CELLS` |
| Cell coordinate | An integer from −2^31 to 2^31 − 1 | `MIN_CELL`, `MAX_CELL` |
| Chunk coordinate | An integer from −2^26 to 2^26 − 1: the chunks of the edge cells, so every cell of the world lies in a chunk of the world | `MIN_CHUNK`, `MAX_CHUNK` |
| Cell index in a chunk | `y·32 + x`, row by row, from 0 to 1023, for offsets `x` and `y` in [0, 32) | |

Kernel chunk keys stay any safe integers ([chunk keys](determinism.md#chunk-keys)). A ruleset that
uses worldgen rejects a key outside the world in `check` with `chunkKeyIssues`, as a rejection,
never as a fault that poisons the world.

### Floor rounding

The helpers round toward negative infinity, with `floorDiv` and `floorMod` from `int.ts`. `|0`
would round toward zero, putting the cell −1 in the chunk 0; `>>` floors only within int32 and
wraps beyond it (`2^31 >> 5` is −2^26). The helpers check nothing: they run on hot paths, whose
callers validate coordinates once.

| Helper | Result | At the cell −33 | Precondition |
|---|---|---|---|
| `chunkOfCell(cell)` | ⌊cell / 32⌋ | −2 | `cell` is a safe integer |
| `cellOffset(cell)` | cell − 32·⌊cell / 32⌋, in [0, 32) | 31 | `cell` is a safe integer |
| `chunkFirstCell(chunk)` | 32·chunk | | `chunk` is a chunk coordinate, not −0 |
| `cellIndex(x, y)` | y·32 + x | | `x` and `y` are offsets in [0, 32) |

For every cell, `chunkFirstCell(chunkOfCell(cell)) + cellOffset(cell)` is the cell, and no helper
returns −0.

### Reading coordinates

| Function | Accepts | Problems |
|---|---|---|
| `chunkKeyIssues(key)` | A kernel chunk key whose coordinates lie in [`MIN_CHUNK`, `MAX_CHUNK`] | Its problems, as issues at the path `""`: a malformed key reports only the kernel's format messages, and a well-formed key each coordinate outside the world, as `the x of the chunk key, 67108864, is outside the world: chunk coordinates lie from -67108864 to 67108863` |
| `readWorldChunkKey(key, path, sink)` | The same key; returns its coordinates | The same, reported to `sink` at `path` |
| `readCell(value, path, sink)` | Any object that is not an array, with `x` and `y` in [`MIN_CELL`, `MAX_CELL`]; returns a fresh `{ x, y }` | Every problem, reported to `sink` under `path`: a coordinate that is not a safe integer or is `-0`, in `chunkKey`'s words, or `2147483648 is outside the world: cell coordinates lie from -2147483648 to 2147483647` |

`readCell` reads only `x` and `y`, each once, through its own descriptor, as every host object is
read ([creating a world](determinism.md#creating-a-world)): an inherited coordinate reads as
missing, an accessor never runs, and an object that throws while read is one issue at `path`. The
two readers report to an issue sink, so worldgen's own modules can gather their problems with
others; the `worldgen` namespace does not export them.

## Genesis

Code: `worldgen/genesis.ts`. A world's global value holds `genesis` and `genesisSeal`. The genesis
is everything the world's terrain and laws derive from; it is written once (ADR 0021).

### Schema

| Member | Content |
|---|---|
| `terrainSeed` | Eight u32 words that the host draws from a CSPRNG: the key of terrain randomness |
| `laws.day` | `length`, in simulated seconds; `daylight`, the share of the day with light, in ‰ |
| `laws.liquid` | `level`, the equipotential level that liquid fills, in ‰ of the elevation range [−amplitude, +amplitude] |
| `laws.thermal` | `base`; `spread`, its spatial variation; `lapse`, a signed ratio `{ num, den }` per unit of elevation; `diurnal`, its daily swing |
| `laws.radiance` | `peak`, during the day; `night`, the floor at night |
| `terrain.relief` | `wavelength`, of the coarsest octave, in cells; `octaves`; `amplitude` |
| `terrain.substrate` | `cell`, the size of a Voronoi cell; `weights`, one per substrate class |
| `terrain.deposits` | A list of fields, each with `wavelength`, `octaves`, `threshold` (in ‰), and `peak` |

Every member is required, every value is an integer, and an unknown member is refused at every
level, so a misspelled law is reported instead of silently ignored.

### Bounds

The bounds keep every intermediate value of worldgen a safe integer. `GENESIS_BOUNDS` holds them,
frozen at every level. They belong to the genesis schema, which `worldgen@1` covers. The golden
values are recorded in T3-5; `worldgen@1` is frozen when T3 closes (ADR 0021), and T3-6 changes no
output. After the freeze, changing a bound needs `worldgen@2`.

| Field | Bounds |
|---|---|
| `terrainSeed` | Exactly 8 u32 words |
| `day.length` | [1, 2^36] simulated seconds, with a light period of at least one second |
| `day.daylight` | [1, 999] ‰ |
| `liquid.level` | [100, 900] ‰ of the range [−amplitude, +amplitude] |
| `thermal.base` | [−2^20, 2^20] |
| `thermal.spread` | [0, 2^20] |
| `thermal.lapse.num` | [−2^20, 2^20] |
| `thermal.lapse.den` | [1, 2^20] |
| `thermal.diurnal` | [0, 2^20] |
| `radiance.peak` | [1, 2^20] |
| `radiance.night` | [0, peak] |
| `relief.octaves` | [1, 12] |
| `relief.wavelength` | A power of two in [8·2^(octaves − 1), 2^16] |
| `relief.amplitude` | [1, 2^29], so that the noise of the largest relief fits an `Int32Array` |
| `substrate.cell` | A power of two in [8, 2^12] |
| `substrate.weights` | 1 to 16 entries, each in [1, 1000] |
| `deposits` | 0 to 8 entries |
| each deposit's `octaves` | [1, 6] |
| each deposit's `wavelength` | A power of two in [8·2^(octaves − 1), 2^16] |
| each deposit's `threshold` | [0, 999] ‰ |
| each deposit's `peak` | [1, 2^20] |

A wavelength's lower bound leaves at least 8 cells to the finest octave. When the octaves are
invalid, the wavelength is checked for one octave, and when `peak` is invalid, `night` is checked
against the highest peak, so that one bad value is reported once.

One rule joins a law and a terrain parameter: |`lapse.num`| × `relief.amplitude` ≤ 2^28 ×
`lapse.den`, so that `thermalBase` fits an `Int32Array`. It is checked only when the three values
are each in bounds, and reported at `/laws/thermal/lapse`.

### Reading a genesis

`genesisIssues(value)` and `prepareGenesis(value)` read the value once, through
`copyCanonicalReported` ([copying at the boundary](determinism.md#copying-at-the-boundary)): a
getter never runs, and a Proxy cannot show validation one value and the copy another. The schema
and the bounds are then checked on the copy, which the engine owns.

| Rule | Detail |
|---|---|
| Every problem at once | Issues carry JSON Pointers relative to the genesis: first the canonical walk's, in canonical key order, then the schema's, in schema order. At most 50 are kept (`MAX_ISSUES`) |
| Canonical first | A value that is not canonical (`-0`, a fraction, `null`, a string not in NFC, an accessor, a record that is not plain) is reported once, by the walk, and never again by the schema |
| No seed in messages | No message prints a word of the terrain seed. The schema's messages name the problem, never the word, and the walk's messages inside `/terrainSeed`, which print numbers, are replaced by `the terrain seed is not canonical here; the details are withheld, as no message prints the terrain seed` |

| Problem | Message |
|---|---|
| A value outside its bounds | `0 is out of bounds: it must be from 1 to 999` |
| A wavelength or cell size | `1000 is not a power of two from 512 to 65536` |
| A list of the wrong length | `the array has 17 entries: it must have from 1 to 16` |
| A seed word | `the word is not a u32: terrain seed words are integers from 0 to 4294967295` |
| A value of the wrong type | `the value must be an integer, not a string`, `the value must be a record { length, daylight }, not an array` |
| An unknown member | `unknown member: the members here are day, liquid, thermal, radiance` |
| A missing member | `the member is missing` |
| A lapse too steep for the relief | `the lapse 524289/1048576 is too steep for a relief of amplitude 536870912: \|num\| × amplitude is 281475513581568, and it must be at most 2^28 × den, 281474976710656, so that thermalBase fits an Int32Array` |
| A day without light | `the day has no light period: 999‰ of a day of 1 seconds is less than one second, and the light period and the night must each last at least one second` |

### Defaults

`defaultGenesis(terrainSeed)` returns a fresh genesis with laws unlike Earth's (plan O-13, ADR
0021), so that an inhabitant who predicts Earth's behavior reveals prior knowledge. It throws
`invalid_value` when the seed is not 8 u32 words.

| Group | Defaults | Why it is not Earth's |
|---|---|---|
| day | `length` 75,600, `daylight` 550 | A day of 21 hours, not 86,400 s, lit for more than half of it |
| liquid | `level` 450 | Liquid fills one equipotential level, as any fluid under uniform gravity does; the level is the world's own, not Earth's sea level |
| thermal | `base` 400, `spread` 120, `lapse` 3/1000, `diurnal` 60 | The lapse is positive: the thermal level rises with elevation, the sign opposite to Earth's |
| radiance | `peak` 1000, `night` 40 | Night keeps 4% of the peak, far brighter than a night on Earth |
| relief | `wavelength` 2048, `octaves` 7, `amplitude` 60,000 | Generic noise parameters in the world's own units, scaled from nothing on Earth |
| substrate | `cell` 64, `weights` [5, 3, 2, 1] | Four abstract classes, with no Earth material behind them |
| deposits | `{ wavelength 256, octaves 3, threshold 300, peak 1000 }`, `{ wavelength 512, octaves 2, threshold 450, peak 1000 }` | Two abstract resources, with no Earth mineral behind them |

### The seal

`genesisSeal(genesis)` is `digest(["genesis", WORLDGEN_VERSION, genesis])`. Every ruleset that uses
worldgen calls `sealedGenesisIssues(global)` from `validateGlobal`, which the kernel runs at
creation, at decoding, and at every commit that wrote the global value.

| Guarantee | How |
|---|---|
| A sealed global value holds a valid genesis and its seal | `sealedGenesisIssues` requires a record with own data members `genesis` and `genesisSeal`, each read once; other members are ruleset data. Genesis problems sit at `/genesis/...`, and a missing member is one issue at its path |
| A changed genesis is found wherever `validateGlobal` runs | A seal that does not match is one issue at `/genesisSeal`, under the prefix the kernel adds; what each path gives, from a write through `writeGlobal` to an edited snapshot, is the table in [ADR 0021](../decisions/0021-procedural-world.md#decision) |
| No message prints a seal | The mismatch message names neither the stored seal nor the expected one |
| The check never depends on the number of chunks | It copies, validates, and digests the genesis once per call, so a tick pays it only when it writes the global value |
| Not guaranteed: a deliberate change | Ruleset code that also recomputes the seal is not prevented; it is trusted, so this is outside the threat model (ADR 0021) |

### A prepared genesis

`prepareGenesis(value)` validates and copies a genesis once, for worldgen to reuse. It throws
`invalid_value` with every problem `genesisIssues` finds.

| Guarantee | How |
|---|---|
| No forged prepared genesis is accepted | A `PreparedGenesis` keeps its state in an ES2022 private field. Every function checks the brand, which runs no Proxy trap, and throws `invalid_value` for anything else, a record or an object whose prototype is a prepared genesis included. The constructor and the internal reader throw `invalid_value` unless `genesis.ts` calls them with its private key |
| The host cannot change a prepared genesis | `prepareGenesis` copies its input; `genesisOf(prepared)` returns a fresh copy on every call |
| Its seal is computed once | `sealOf(prepared)` returns it; it identifies the genesis, as a cache key would need |
| Worldgen modules read it without copying | `sharedGenesis(prepared)` returns the genesis itself, frozen at every level; the `worldgen` namespace does not export it |
| No module state | Worldgen keeps no top-level `let` or `var`; `GENESIS_BOUNDS` is frozen at every level |

The genesis, the terrain seed, and the seal are C3, never projected to a client nor passed to a
prompt ([data classification](data-classification.md), ADR 0021).

## Noise

Code: `worldgen/lattice.ts` and `worldgen/noise.ts`. Terrain's fields are 2D gradient noise summed
over octaves (fBm), computed with safe-integer doubles, `floorDiv`, and `floorMod`, never `|0`,
`>>`, `imul`, or `%` ([ADR 0021](../decisions/0021-procedural-world.md#decision), Noise). The noise is
a building block of worldgen's own modules: the `worldgen` namespace does not export it, and terrain
exposes its regions instead.

### Pseudorandom inputs

Every draw is one ChaCha20 block of the terrain seed (`rng/chacha.ts`). Its 4 input words name the
use, so no two uses share a block:

| Use | Word 0 | Word 1 | Word 2 | Word 3 |
|---|---|---|---|---|
| A lattice point of a field | purpose | octave | lattice x | lattice y |
| The offsets of a field's octave | 0 (`octaveOffset`) | octave | the field's purpose | 0 |

| Purpose (`LATTICE_PURPOSES`) | Value | Draws |
|---|---|---|
| `octaveOffset` | 0 | the offsets of every field's octaves |
| `elevation`, `thermal` | 1, 2 | noise |
| `substrate` | 3 | the points of the substrate's Voronoi regions |
| `deposits[k]` | 4 + k, for k from 0 to 7 | noise |

The packing is injective: word 0 tells offsets from lattice points, and the other words hold each
value whole. Lattice coordinates lie in [−2^28, 2^28 + 1] at every octave, so each is an int32, and
it becomes a u32 word with `>>> 0` in `lattice.ts` only. Noise accepts only `NOISE_PURPOSES`, so no
noise draw shares a block with an offset or a substrate draw.

### One octave

For a cell c on each axis, an octave of wavelength W (a power of two, at least 8):

| Step | Rule |
|---|---|
| Offset | o = word 0 (x) or 1 (y) of the octave's offset block, mod W: in [0, W) |
| Lattice cell | ⌊(c + o) / W⌋; c + o is a double, so the top edge never wraps |
| Fraction | ⌊((c + o) mod W)·S / W⌋ with S = 2^16, in [0, S) |
| Gradient | the low 3 bits of word 0 of the lattice point's block choose (1, 2), (−1, 2), (1, −2), (−1, −2), (2, 1), (−2, 1), (2, −1), or (−2, −1) |
| Fade | 6t⁵ − 15t⁴ + 10t³ in Horner form, in Q32, rounded once to Q16: monotonic, exact at 0, S/2, and S, within 1/2 + 2^−16 of the exact value |
| Noise n | the corners' dot products, interpolated as a + ⌊(b − a)·u / S⌋ along x, then along y |

Octave o has wavelength W0 / 2^o and amplitude A_o = ⌊A / 2^o⌋. The field is Σ_o ⌊n_o·A_o / S⌋, and
an octave whose amplitude is 0 is skipped.

### Bounds

| Quantity | Bound | Why |
|---|---|---|
| A spec (`NOISE_BOUNDS`) | purpose in `NOISE_PURPOSES`; octaves [1, 12]; wavelength a power of two in [8·2^(octaves − 1), 2^16]; amplitude [1, 2^29] | the finest octave spans 8 cells or more; every output fits an `Int32Array`; a test keeps the genesis bounds inside these |
| A region | each side in [1, 256]; every cell inside the world | |
| One octave's noise | \|n\| ≤ `NOISE_PEAK` = ⌊73·S / 48⌋ + 2 = 99,671 | a corner's dot product is at most \|dx\| + \|dy\| + max(\|dx\|, \|dy\|); the fade's weights bound their mean by 73/48; the floors add less than 2 |
| Output | \|v\| ≤ `noiseBound(spec)` = Σ_o ⌈NOISE_PEAK·A_o / S⌉ ≤ 4·A | Σ_o A_o ≤ 2A − 1 |
| Neighbors | \|Δv\| ≤ Σ_o (137·A_o / (16·W_o) + 28·A_o / S + 1) | the real noise's slope is at most 137/16; the integer noise stays within 14 units of it; each floor adds 1 |
| Intermediates | below 2^53 | fade steps ≤ 15·2^48; interpolation ≤ 6·S²; n·A_o < 2^47 |

### Sampling a region

`sampleNoiseRegion(prepared, spec, rect)` returns `rect.width × rect.height` values in an
`Int32Array`, row by row: the cell (x + i, y + j) is at index j·width + i. With the default relief it
costs about 0.16 ms for a 32×32 region and 13.5 µs for one cell (Bun 1.4.4, two-core Codespace,
indicative).

| Guarantee | How |
|---|---|
| A chunk is a 32×32 region, and a cell a 1×1 region | A cell's value depends only on the genesis, the spec, and the cell. Lattice points are cached for one call only, so any region equals the composition of its chunks and cells |
| Order and history never matter | There is no module state, and each call builds its key from the terrain seed and returns a fresh array |
| Every problem at once | `invalid_value` with issues at `/prepared`, `/spec/...` (purpose, octaves, wavelength, amplitude), and `/rect/...`. Host objects are read once, member by member, and the last cell is checked once the first cell and the sides are valid |
| No seed in messages | No message prints a seed word |

## Terrain

Code: `worldgen/terrain.ts`. The permanent primary fields of a cell are each a pure function of the
generator version, the genesis, and the cell, never of time
([ADR 0021](../decisions/0021-procedural-world.md), permanent and temporal layers).

| Field | Array | Rule | Range |
|---|---|---|---|
| `elevation` | `Int32Array` | noise of purpose `elevation` with `terrain.relief` | ±noiseBound(relief) |
| `thermalBase` | `Int32Array` | `base` + thermal noise + lapse term | below 2^31 in magnitude, by the genesis rule on the lapse |
| `substrate` | `Uint8Array` | the class of the nearest Voronoi point | [0, number of weights − 1] |
| `deposits[k]` | `Int32Array` | the excess of noise over a threshold, scaled to `peak` | [0, peak] |

| Quantity | Rule |
|---|---|
| Level L (`liquidLevel`) | ⌊A × (2·level − 1000) / 1000⌋, with A the relief amplitude |
| Thermal noise | purpose `thermal`, amplitude `spread`, wavelength 4096, 3 octaves (`THERMAL_NOISE`); 0, never sampled, when `spread` is 0 |
| Lapse term | ⌊num × max(0, elevation − L) / den⌋: with the default positive lapse, thermal level rises with elevation |
| Deposit k | noise n of purpose `deposits[k]`, amplitude 2^16, the deposit's wavelength and octaves; B its noiseBound and t = ⌊threshold × B / 1000⌋; ⌊(n − t) × peak / (B − t)⌋ where n > t, else 0 |

The thermal noise has a wavelength twice the default relief's, so it is a regional trend, and the
lapse term dominates the differences between nearby cells: the lapse law stays discoverable. A
deposit's threshold is ‰ of its noise's own bound B. The noise rarely exceeds 0.74·B, so the
default thresholds of 300‰ and 450‰ leave about 11% and 4.7% of the cells above them (indicative),
and thresholds of 600‰ or more leave under 1%.

### Substrate

The plane is cut into squares of `substrate.cell` cells, and each square holds one point:

- words 0 and 1 of its block (purpose `substrate`) give the jitter in [0, cell) on each axis;
- word 2 draws its class, ⌊word × W / 2^32⌋ against the cumulative weights, with W their sum.

A cell takes the class of its exact nearest point by squared integer distance. The search covers
the 5 × 5 squares around the cell minus the 4 corners, 21 squares, which is enough for exactness:
the cell's own point is less than √2·cell away, and every point outside those squares is farther.
Ties go to the lowest square y, then x. A 3 × 3 search would miss the nearest point in only about
2·10⁻⁷ to 2·10⁻⁶ of the cells, so the tests pin such cells in all 12 outer squares of the search,
the ring of the 5 × 5 without its corners, instead of relying on random regions.

### Bounds

Every intermediate stays below 2^53 at `GENESIS_BOUNDS`, and every field fits its array:

- |elevation| ≤ 1,632,610,980, and `num × (elevation − L)` < 2^51;
- `thermalBase` fits its `Int32Array` because the genesis requires |num| × amplitude ≤ 2^28 × den;
- the substrate's squared distances stay below 2^29, and `word × W` below 2^46;
- for deposits, `threshold × B` < 2^28 and `(n − t) × peak` < 2^39, and B − t ≥ B / 1000 > 0.

### Sampling

| Function | Result | Problems |
|---|---|---|
| `sampleRegion(prepared, rect)` | The `TerrainRegion` of a rectangle, row by row, with the same rect rules and cap as the noise | `invalid_value` at `/prepared` and `/rect/...`, all at once |
| `sampleSurface(prepared, rect, k)` | `{ elevation, deposit }`: the elevation and deposit `k` of a rectangle, each equal to the field of the same name from `sampleRegion`, computed by the same functions without the other fields. Added in T4 for the senses of beings ([0023](../decisions/0023-autonomous-beings.md)); it changes no output of `worldgen@1`, and a test compares it with `sampleRegion` cell for cell | `invalid_value` at `/prepared` and `/rect/...`, as `sampleRegion`, and at `/deposit` for an index the genesis has no deposit for |
| `generateChunk(prepared, key)` | The region of the chunk, with its `key` (`TerrainChunk`) | `invalid_value` at `/key`, with the messages of `chunkKeyIssues` |
| `terrainDigest(chunk)` | The digest of the chunk's fields | `invalid_value` for anything that is not a chunk: a record with a key, typed arrays of 1,024 cells, at most 8 deposits |

Their cost is in [Measured cost](#measured-cost-indicative). `sampleSurface` skips the substrate, the thermal base, and the other deposits: on a 49 × 49 region it took about a quarter of `sampleRegion`'s time (0.78 against 2.98 ms on a loaded Codespace, indicative).

`liquidLevel(genesis)` is exported too: the level below which a cell is under liquid, so that a ruleset computes `liquid.depth` with the same formula as `observe`.

### The terrain digest

`terrainDigest` is MurmurHash3 x86_128 over little-endian u32 words, in this order:

1. the text `terrain`, then `WORLDGEN_VERSION`, each as its byte count followed by its bytes padded
   with zeros to a whole word;
2. the chunk's x and y;
3. `elevation`, 1,024 words;
4. `substrate`, 1,024 bytes, 4 per word;
5. `thermalBase`, 1,024 words;
6. the number of deposits, then each deposit, 1,024 words each.

No seed and no instant enter it.

### Golden terrain values

`test/fixtures/golden-worldgen.ts` pins `terrainDigest` for 3 terrain seeds × 13 chunks (the origin,
its −1 neighbors, a far chunk, the four edge midpoints, and the four corners at ±2^26), plus the
digest of a 16×16-chunk region, under both the default and a maximum genesis. The region is chunks
0 to 15 on each axis, the first candidate in which each default deposit covers at least 1% of the
cells pooled over the seeds (8.4% and 6.7%). Two processes recorded identical values. The golden
values are recorded in T3-5; `worldgen@1` is frozen when T3 closes (ADR 0021), and T3-6 changes no
output. After the freeze, any change to these values needs `worldgen@2`.

## Time

Code: `worldgen/calendar.ts`. The temporal layer depends on the generator version, the laws, and an
instant, never on a cell or the terrain seed ([ADR 0021](../decisions/0021-procedural-world.md)).
Every function is pure, O(1), and exact in safe integers, with no implicit clock and no default
instant.

### Instants

An `Instant` is `{ tick, simSecondsPerTick }`; its simulated second is their product, the kernel's
`simSeconds`. Inside the `step` that computes tick T, `instantOf(ctx)` is the instant that
`instantOf(readView(world))` gives outside on the world at tick T, so a measurement taken inside
tick T equals one taken outside at tick T. The measurements reject an invalid instant as
`simSeconds` does: `invalid_value` with every problem, and `tick_overflow` for the product.

| Problem | Path | Message |
|---|---|---|
| A tick that is not a tick | `/tick` | `-1 is not a tick: ticks are safe integers from 0` |
| Seconds per tick that are not a positive safe integer | `/simSecondsPerTick` | `0 seconds per tick is not a positive safe integer` |
| A value that is not a record | `""` | `the instant must be a record { tick, simSecondsPerTick }` |
| A product beyond the safe integers | `""` | `tick 750599937895083 at 12 seconds per tick is beyond the largest safe integer` |

`readInstant(value, path, sink)` reads an instant from a host value for worldgen's own modules, as
`readCell` reads a cell; the `worldgen` namespace does not export it.

### The day

| Quantity | Rule |
|---|---|
| Day | `dayIndex = ⌊second / length⌋`, from 0 |
| Phase | `secondOfDay = second mod length`, from 0 at dawn |
| Light period | `lightPeriod(day) = ⌊length × daylight / 1000⌋` seconds from dawn; the night is the rest, and lasts at least one second, as daylight is at most 999‰ |
| Day curve, in Q16 (`CURVE_SCALE`, 2^16, is 1) | 0 at night; in the light period, with `s = ⌊secondOfDay × 2^16 / lightPeriod⌋`: `v = ⌊4s(2^16 − s) / 2^16⌋` and `curve = ⌊v² / 2^16⌋`, which is 16s²(1 − s)²: C1 at dawn and dusk, exactly 2^16 at mid-light |
| `radiance` | `night + ⌊(peak − night) × curve / 2^16⌋`, in [night, peak] |
| `diurnal` | `⌊thermal.diurnal × curve / 2^16⌋`, in [0, diurnal], 0 at night; `thermal = thermalBase + diurnal` |

`dayPosition`, `dayCurve`, `radiance`, and `diurnal` take a prepared genesis and an instant, and a
forged prepared genesis is `invalid_value`. Within `GENESIS_BOUNDS` no intermediate reaches 2^53:
`secondOfDay × 2^16` stays below 2^52 because a day lasts at most 2^36 seconds, `4s(2^16 − s)` and
`v²` are at most 2^32, and a span times the curve is at most 2^36.

### Time laws

`timeLawIssues(laws, simSecondsPerTick)` returns the problems of the pair, as JSON Pointers into
`{ laws, simSecondsPerTick }`. `validateGlobal` cannot see the seconds per tick, so the host calls it
before `createWorld` (ADR 0021); decoding does not repeat it. The genesis itself requires a light
period of at least one second, so the curve never divides by zero even when the host skips it.

| Rule | Path | Message |
|---|---|---|
| Positive safe seconds per tick; otherwise nothing else is checked | `/simSecondsPerTick` | `0 seconds per tick is not a positive safe integer` |
| A day of at least 16 ticks | `/laws/day/length` | `a day of 191 seconds is shorter than 16 ticks of 12 seconds: it must last at least 16 ticks, so that every day has at least 16 distinct phases` |
| A light period and a night of at least one tick each | `/laws/day` | `the night lasts 11 seconds, shorter than one tick of 12 seconds: a day of 1200 seconds with 991‰ of daylight must have a light period and a night of at least one tick each` |

### Golden time values

`test/fixtures/golden-time.ts` pins the day position, the curve, radiance, and the diurnal term of the
default laws at a set of instants:

- dawn, a quarter and half of the light period;
- the last tick before dusk and the first at or past it;
- the last tick of day 0 and the first of day 1;
- the last safe tick.

It does so at 12, 7, and 13 seconds per tick, and 13 divides neither the day nor its light period,
so its phase drifts. The values are equal under any terrain seed. Near dusk the curve is flat (C1),
so the last tick of light already reads the night floor.

## Observables

Code: `worldgen/observables.ts`. The primitive observables are what can be measured of a cell
([ADR 0021](../decisions/0021-procedural-world.md), primitive observables).
`observableCatalog(prepared)` lists them for a genesis, and `observe(prepared, { id, cell, instant })`
measures one as an integer.

| id | Dimension, unit | Kind | Varies | Exposure | Value | Range |
|---|---|---|---|---|---|---|
| `elevation` | length, `len` | quantity | static | surface | the terrain field | [−B, B] |
| `liquid.depth` | length, `len` | quantity | static | surface | max(0, L − elevation) | [0, L + B] |
| `substrate` | category | category | static | surface | the terrain field | [0, M − 1] |
| `thermal` | thermal, `tu` | quantity | time | measurement | thermalBase + diurnal(instant) | [base − T + min(0, P), base + T + max(0, P) + diurnal] |
| `radiance` | radiant, `ru` | quantity | time | surface | radiance(instant), the same in every cell | [night, peak] |
| `deposit.<k>` | amount, `qu` | quantity | static | measurement | the terrain field of deposit k | [0, peak_k] |

- B is noiseBound(relief), L the level of liquid, M the number of substrate classes, T the thermal
  noise bound (0 for a spread of 0), and P = ⌊num × (B − L) / den⌋, the lapse term at the highest
  elevation. Each range is a true bound for every cell and instant, derived from the terrain and
  noise bounds, never from sampled values.
- The catalog lists the five fixed ids, then one `deposit.<k>` per deposit, in order. It is frozen
  at every level and canonical, and a category has no `unit`.
- Every entry belongs to `WORLDGEN_VERSION`, which versions its definition: the version that
  ADR 0021 lists among the observable data is the generator's, not a field of each entry. After the
  freeze, a change to an id, a unit, a range, or a value needs `worldgen@2`.
- The catalog does not depend on the terrain seed. Its ranges derive from the laws and terrain
  parameters, which are C3, so T6 decides each projection.
- Ids, units, and every other text of the catalog are engineering names. Perception never passes
  them into a prompt (plan §K.4, §K.7), and no field carries a human-language gloss.

### Measuring

The instant is required for every id, with no default. A static id ignores its value but still
validates it. The query is read once, member by member, and every problem is reported at once as
`invalid_value`: at `/prepared` for a value `prepareGenesis` did not make; at `/query` for a value
that is not a record; at `/query/id` for an id that names nothing or a deposit the genesis lacks; and
under `/query/cell` and `/query/instant` as `readCell` and `readInstant` report.

A static id or `thermal` costs one 1×1 terrain region, and `radiance` far less
([Measured cost](#measured-cost-indicative)). A ruleset that reads many cells should read regions.

### Golden observation values

`test/fixtures/golden-observations.ts` pins every id at 9 cell and instant pairs under the default
genesis, with one terrain seed of the terrain goldens.

- The cells are a liquid cell, a dry cell, a cell of each deposit, the four world corners, and
  (−1, −1).
- The instants span dawn, light, night, mid-light, and the last safe tick at 12 seconds per tick,
  mid-light at 7, and a drifting instant at 13.
- Two runs of the recording agreed. The values hold inside the steps of worlds with different world
  seeds, and other time laws change only the temporal ones.

## Integration

No production ruleset exists in T3, so a test-only probe ruleset proves that worldgen runs inside
`step` and keeps the kernel deterministic ([ADR 0021](../decisions/0021-procedural-world.md),
"Proof without a production ruleset"); the first ruleset of T4 runs the
[determinism suite](determinism.md#determinism-suite) again. Code, in `packages/engine/test/`:
`fixtures/probe-ruleset.ts`, `support/probe-world.ts`, and `support/broken-probe.ts`. Tests:
`worldgen-suite` and `worldgen-observer`.

| Part | Rule |
|---|---|
| Global value | `{ genesis, genesisSeal, watch }`. `validateGlobal` calls `sealedGenesisIssues`, rejects unknown members, and accepts at most 16 distinct chunks of the world in `watch` |
| Chunk | `{ at, terrain, readings }`: the tick it was materialized at, `terrainDigest(generateChunk(prepared, key))` computed inside that tick, and the calendar boundaries it saw while watched. No chunk stores terrain |
| `probe.materialize { x, y }` | Admin only. `check` rejects `admin_only`, `outside_world` (with the messages of `chunkKeyIssues`), and `materialized`, never faulting; `apply` creates the chunk and watches it while `watch` has room |
| `probe.measure { id, cell }` | Emits `probe.reading { id, cell, value }`, the value of `observe` at `instantOf(ctx)`; `check` rejects what `observe` rejects, as `invalid_query` |
| System `probe.daylight` | When the day or the light state differs from the previous tick's, emits `probe.boundary { day, light }` and adds 1 to the readings of every watched chunk |
| State | None: each system and handler prepares the genesis from the global value it reads, in its own run |

`probeWorld` gives each world seed its own terrain seed, so the suite's interleaving covers terrain
too. Its day lasts 600 seconds at 12 seconds per tick, so a run crosses many boundaries, and it
checks `timeLawIssues` before `createWorld`, as the host must. A world starts with no chunk: only
commands materialize the latent world.

The tests check:

- the determinism suite, under audit, over 600 ticks of a seeded script that materializes chunks
  at the origin, its negative neighbors, the edges, and the corners, and measures every observable
  at random and edge cells; it cuts around calendar boundaries and materializations and at seeded
  random ticks, and the resumed cuts are pinned (test 13);
- boundaries at exactly the ticks the laws give; chunks created only by accepted materializations;
  each chunk's readings; and the exact rejections of a chunk outside the world, a duplicate, a
  materialization from an inhabitant, and an invalid query;
- the probe's validators report every problem of a global value and its chunks at once, with its
  path: an unknown member, a watch list too long, a duplicate, or a chunk outside the world, and
  each member of a chunk that breaks its schema;
- every stored terrain digest and every reading equal to what worldgen computes outside, for the
  same genesis, chunk, cell, and instant, under each world's terrain seed (tests 16 and 21, I7);
- each path of ADR 0021's seal table (test 14, I8): a change through `writeGlobal` faults that tick
  at `/global/genesisSeal` and poisons the world; a change behind the barrier is found by audit at
  that tick, and without audit `encodeSnapshot` refuses the world and its next global write fails at
  the seal; an edited genesis with a stale seal fails decoding at `/world/global/genesisSeal`; after
  the suite, the genesis is the initial one;
- the same records and final snapshot under three observer regimes (test 15, I4): no observer; one
  that, between ticks, reads the view, the global value, and every chunk, and generates terrain
  under another genesis and the world's own; and the same through a memo keyed by seal and chunk
  that the probe shares. Negative controls: a memo keyed by chunk alone, shared by the observer and
  the probe, changes the records and fails the suite's interleaving; the same memo kept in a module
  fails the interleaving too; and a host that materializes what its observer looks at changes the
  records from tick 1;
- at scale, 24 × 24 chunks: seams within the Lipschitz bound, every chunk equal to its rows in the
  regions that hold it, and the same digests generated by rows or by columns (`worldgen-scale`).

## Measured cost (indicative)

`bun packages/engine/bench/worldgen.ts` prints these numbers. They are indicative: one run on the
two-core Codespace, with Bun 1.4.4, on 2026-10-25, on an otherwise idle machine, which took about
20 s. The Codespace's two hardware threads share one physical core, so concurrent work slowed rows
by up to 1.8 times in other runs. Compare several runs on one machine, before and after a change to
worldgen; never compare across machines.

| Measurement | Result |
|---|---|
| 32×32 chunk, default genesis, at the origin / the top edge | 0.497 / 0.520 ms |
| 32×32 chunk, maximum genesis, at the origin / the top edge | 1.371 / 1.413 ms |
| 1×1 / 9×9 region, default genesis | 39.6 / 84.0 µs |
| 1×1 / 9×9 region, maximum genesis | 124.1 / 239.6 µs |
| ChaCha20 blocks | 4.29 million per second |
| Heap kept alive per chunk, default / maximum genesis, 1,000 chunks held | 17.4 / 41.6 KB |
| One default chunk, after 0 / after 10,000 other generations | 0.494 / 0.498 ms |
| `observe`, `elevation` / `radiance`, default genesis | 32.9 / 0.6 µs |
| `prepareGenesis`, default / maximum genesis | 60.7 / 108.9 µs |
| `sealedGenesisIssues`, default / maximum genesis | 70.8 / 100.3 µs |
| A tick that writes the global value, validated by `sealedGenesisIssues` / by a validator that accepts everything | 80.9 / 36.8 µs |
| A probe tick that materializes a chunk / with no command | 742 / 64.7 µs |

What they show:

- A chunk costs about 0.5 ms with the default genesis and 1.4 ms with the maximum one, at the origin
  and at the edge alike. T3's targets are 2 ms and 4 ms.
- A chunk of the maximum genesis keeps 41.6 KB alive, its fields' typed arrays, under the target of
  48 KB. The figure reads JSC's `heapSize` alone, as `bench/measure.ts` explains.
- A chunk costs the same after 10,000 other generations: a ratio of 1.01, against a target of 2.
- One default cell costs about 40 µs, under T3's gate of 50 µs (T3-5 measured 44.3 µs), so the
  generator keeps one ChaCha20 block per field, octave, and lattice point. A 9×9 region costs about
  twice a cell for 81 times the cells, which is why a ruleset should read regions.
- Checking the seal adds about 44 µs to a tick that writes the global value. A tick that does not
  write it never runs `validateGlobal`.
- A probe tick costs about 65 µs, most of it preparing the genesis, which the probe does in every
  run of a system or handler. Materializing a chunk adds about 0.7 ms, most of it generating the
  chunk.

## What the tests check

- the space constants, and the chunk and offset of the cells 0, 31, 32, −1, −32, −33, −2^31, and
  2^31 − 1, with no −0, and the first cell of the chunks 0, ±1, −2^26, and 2^26 − 1;
- `cellIndex` maps the 1,024 offsets of a chunk one to one onto 0 to 1023;
- `chunkKeyIssues` accepts the chunks at both bounds on each axis, rejects one past each bound,
  both coordinates at once, and every malformed key form;
- `readCell` accepts the edge cells, rejects one past each bound, non-integers, `-0`, and wrong
  types, reads an inherited coordinate as missing, never runs an accessor, and reports a revoked
  Proxy as one issue with its cause;
- the defaults are pinned and valid, with a day other than 86,400 s and a positive lapse, and
  `GENESIS_BOUNDS` is pinned and frozen;
- each bound accepts both of its ends and rejects one past each, wavelengths follow the octaves,
  night follows peak, and each list accepts and rejects its lengths;
- wrong types, unknown members, and missing members at every level of the schema, with exact paths
  and messages, an unknown key escaped as a JSON Pointer, and many problems reported together in
  their documented order;
- bad seeds (a wrong length, words that are not u32, non-canonical words, a hole), with no message
  that prints a word;
- `prepareGenesis` copies its input, `genesisOf` returns fresh copies, accessors never run,
  `sharedGenesis` is frozen and not exported, and forged prepared geneses (a record, an object whose
  prototype is one, a revoked Proxy, a Proxy whose traps count calls, the constructor, the internal
  reader without its key) are rejected without running a trap;
- the seal equals its formula, does not depend on key order, and changes with every law, terrain
  parameter, and seed word tested;
- `sealedGenesisIssues` accepts a sealed global value with ruleset data, and rejects a tampered
  genesis with its stale seal, a seal made for another version, missing members, a seal that is not
  a string, genesis problems under `/genesis`, accessors, and a value that is not a record.
- the purposes are pinned and frozen; the packing writes the documented words, has a left inverse
  over 6,600 uses at the int32 edges, and gives no two uses the same block;
- the fade over all 65,537 inputs: monotonic, exact at 0, S/2, and S, within 1/2 + 2^−16 of the
  exact value;
- `noiseBound` is exact on small cases, and at most 4·amplitude for every amplitude up to 2^12 and
  every octave count; the genesis bounds stay inside the noise bounds;
- the Lipschitz bound holds around the origin, across the lattice lines of every octave, and in the
  two outermost chunks at each edge; a float Perlin with the same draws agrees on random cells and
  at every edge within Σ_o (14·A_o / S + 1), the integer noise's bound and each octave's floor,
  plus 2^−10 for its own rounding;
- a 48×48 region equals its 4 chunks, every 1×1 region equals its chunk's cell over 200 chunks, and
  seams, pooled over 100 worlds, are within ±10% of the interior;
- 5 permutations of chunk requests and 2,000 other generations change nothing; outputs stay within
  `noiseBound` under a fuzz of geneses and specs; elevation and thermal are uncorrelated;
- each broken variant of `support/broken-worldgen.ts` fails its property check, and the faithful
  composition equals `sampleNoiseRegion`;
- dawn, dusk, and the day rollover fall on exact seconds, and the night floor holds;
- the day curve, swept over every s, rises on one half and falls on the other, is symmetric, 0 at
  both ends and 2^16 at mid-light, and steps by at most 1 within 1/64 of dawn or dusk and at most 6
  anywhere;
- radiance and the diurnal term stay in range over seeded random laws, and agree with a BigInt
  reference, including at the largest genesis, whose intermediates stay below 2^53;
- an invalid instant is rejected with its paths, and an overflowing product as `simSeconds` reports
  it; the instant taken inside a tick equals the one taken outside at the same tick;
- `timeLawIssues` accepts each edge and rejects one past it, and the genesis rejects a day without a
  light period;
- the golden time values hold under two terrain seeds;
- the lapse rule accepts its edges for a positive and a negative `num`, rejects one past them, and is
  checked only when `num`, `den`, and the amplitude are each in bounds, even among other problems;
- every terrain field: a region equals its chunks, and each 1×1 region its chunk's cell, over 200
  chunks under both geneses; the laws hold uniformly (five lapses, negative and zero included, and
  spread 0); a fuzz of 80 geneses stays in range;
- order does not matter: 5 permutations, 2,000 other generations, a child process, and the history
  check; a different terrain seed changes terrain, and a broken variant with a fixed key is caught;
- the substrate matches a brute-force nearest search, including the 26 pinned cells beyond 3 × 3;
- the digest follows its layout, the golden terrain values hold, and each default deposit covers at
  least 1% of the golden region.
- the catalog is pinned, frozen, and canonical, lists exactly the genesis's deposits, and does not
  depend on the terrain seed;
- every static id gives the same value at 9 instants and equals its field or formula, under the
  default and the maximum genesis;
- `thermal − thermalBase = diurnal` at random cells and instants, `radiance` is equal at every cell,
  and `varies` matches the behavior over one default day;
- every observable stays within its range under a fuzz of geneses, and each range equals a BigInt
  derivation;
- `observe` reports every problem with its path, reads its query once, and never runs an accessor;
- the golden observation values hold, also inside steps of worlds with different world seeds.
