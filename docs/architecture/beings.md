# Beings

The beings of T4: a body whose laws the engine applies, and a brain that only proposes
([0023](../decisions/0023-autonomous-beings.md), which refines
[0020](../decisions/0020-deterministic-core-design.md) and
[0021](../decisions/0021-procedural-world.md)). This page is the specification that T4's pull
requests implement, and the preregistration of its scenarios.

| Part | Code | Pull request |
|---|---|---|
| Layering and module-state scans | `tests/repo/engine-purity.ts` | T4-2 |
| State, laws, and exact arithmetic | `packages/engine/src/beings`: `rates.ts`, `food.ts`, `laws.ts`, `being.ts`, `chunk.ts`, `occupancy.ts`, `contracts.ts` | T4-2 |
| Senses and validation of intentions | `packages/engine/src/beings`: `senses.ts`, `locomotion.ts`, `intention.ts`; `sampleSurface` in `worldgen/terrain.ts` | T4-3 |
| Navigation | `packages/agents/src/navigation` | T4-4 |
| The tick, actions, spawn, and occupancy | `packages/engine/src/beings`: `body.ts`, `light.ts`, `activity.ts`, `env.ts`, `advance.ts`, `resolve.ts`, `system.ts`, `ruleset.ts` | T4-5a |
| Contests, incapacity, fuzz, and call counts | `packages/engine/test`: `beings-contest.test.ts`, `beings-fuzz.test.ts` | T4-5b |
| The brain `utility@1` | `packages/agents` | T4-6 (*planned*) |
| Scenarios, survival, and controls | `packages/agents/test`, `bench` | T4-7 (*planned*) |

## Layers

```
packages/agents           L1 Utility AI, L2 recipes, Dijkstra and A*        brain "utility@1"
   │ implements Controller.decide(senses) → intention, a pure function
   ▼
src/beings                L0 physiology, senses, validation and execution,
   │                      contests, occupancy, sealed laws of life          ruleset "beings@1"
   ▼
src/worldgen (frozen) and an allowlist of kernel modules
```

`src/beings` imports only `src/worldgen/index.ts`, `int`, `errors`, `time/tick`, `world/chunk`,
`world/members`, `world/contracts` (types only), and the modules under `canonical/` and `digest/`.
The kernel and worldgen never import it. `packages/agents` imports only `@open-origin/engine`.

## State

### Global value

| Member | Content |
|---|---|
| `genesis`, `genesisSeal` | The sealed genesis of T3, unchanged |
| `life` | `{ version: "life@1", deathEnabled, species }`, written once |
| `lifeSeal` | `digest(["life", LIFE_VERSION, life])` |
| `occupancy` | Chunk keys that may hold beings, in the kernel's order (UTF-16 code units), without repeats |
| `prunedDay` | The last simulated day whose empty chunks were pruned from `occupancy` |

`validateGlobal` checks the genesis seal, the life seal with the schema and bounds of every law,
that each species eats a deposit the genesis has and has a brain, and that `occupancy` is ordered,
without repeats, and made of chunk keys inside the world. The invariant chunks with beings ⊆
`occupancy` ⊆ materialized chunks is kept by the system; a listed chunk that is not materialized,
or a being found outside the chunk of its cell, fails the tick.

### A species

| Law | Meaning |
|---|---|
| `needs.nutrition` | Decay per simulated second while awake and idle (`awake`), walking, and asleep |
| `needs.rest` | Decay per simulated second while awake and idle, and walking |
| `sleep.recover` | Rest restored per simulated second while asleep |
| `diet` | The deposit eaten, nutrition per unit, units per bite, milliseconds per bite, and the cue thresholds `some` ≤ `plenty` |
| `locomotion` | `stepMs` for a flat orthogonal step; `maxRise`, the largest elevation difference a step may take; `maxWade`, the deepest liquid it may enter; and `rise` and `wade`, the extra milliseconds per unit of each |
| `health` | `starve`, the loss per second while nutrition is 0; `recover`, the gain per second while nutrition and rest are above `recoverAbove` |
| `regrowth` | Food units per second that an eaten cell recovers |
| `senses` | The radius R of the window, at most 32 |
| `traits` | The bounds of each trait, in permille; the neutral value 1000 lies within them |

Every rate is a ratio with `num` from 0 to 2^20 and `den` from 1 to 2^32, so `num·den` and
`10^6·den` are safe integers. Locomotion also has a bound across its members: the slowest step it
allows, `stepMs + ⌊rise·maxRise⌋ + ⌊wade·maxWade⌋`, is at most 1,518,729,594 ms before the diagonal
factor, so that every step lasts at most 2^31 − 1 ms and fits the senses' Int32 durations. Each quantity changes under one rate at a time: nutrition and rest by
activity, rest by `sleep.recover` while asleep, health by `starve` or `recover` or not at all.

`life@1` has one food: every species eats the deposit of the first species, with its regrowth. A
depletion entry records what was taken from a cell, not from which deposit, so two diets on one
cell could not be told apart. A later version of the laws may give each deposit its own entries.

### A materialized chunk

`{ beings, depletion, due }`:

- `beings`: ordered by id; each one's cell lies in this chunk.
- `depletion`: `{ cell, taken, since }` per eaten cell, ordered by cell index `y·32 + x`, with
  `taken` in (0, 2^20], the bound of a deposit's peak. That `taken` never exceeds the cell's deposit
  is checked by the invariant tests, because `validateChunk` cannot see the genesis.
- `due`: the minimum `wake` of its beings, or the largest safe integer when it has none.

Effective food in a cell is `max(0, base − max(0, taken − regrown))`, where `regrown` is the
regrowth over the seconds since `since`, in closed form. An entry that regrew completely is dropped
when its chunk is written for another reason.

### A being

What an observer inside the world could see is C0; the rest of the being is C1. T6 decides which
C0 fields each projection carries.

| Field | Class | Content |
|---|---|---|
| `id`, `species`, `stage`, `born` | C0 | Identity; T4 has the single stage `adult` |
| `cell` | C0 | Absolute cell |
| `activity.kind`, and the direction of the current step of a walk | C0 | `idle`, `walk`, `eat`, or `sleep` |
| the rest of `activity` | C1 | The remaining route, its arrival schedule, and the activity's targets |
| `needs`, `health`, `anchor` | C1 | Values from 0 to 1,000,000, all as of the one tick `anchor` |
| `traits` | C1 | `appetite`, `sleepiness`, `curiosity`, in permille |
| `condition` | C1 | `ok` or `incapacitated` |
| `plan` | C1 | Up to two steps pending after the current activity |
| `behavior` | C1 | What the brain stored, its behavior and heading, and since when, which the engine stamps |
| `wakeWhen` | C1 | Need and light thresholds the brain asked to be woken at |
| `wake` | C1 | The next tick at which the being is processed |
| `outcome`, `cooldowns` | C1 | The result of the last step, and up to four recently failed targets |

## Time and needs

The engine knows only ticks. Laws are rates per simulated second, and durations of steps and bites
are integer simulated milliseconds.

- **A need at tick t** is `v0 − ⌊num·E/den⌋` when it falls and `v0 + ⌊num·E/den⌋` when it rises,
  clamped to 0 and 1,000,000, with `E = simSeconds(t) − simSeconds(anchor)`. It is computed as
  `num·⌊E/den⌋ + ⌊num·(E mod den)/den⌋`, and saturates before multiplying once the change would
  pass the clamp, so every intermediate value is a safe integer for any `simSecondsPerTick`.
- **Re-anchoring.** Needs and health share one anchor. When the rate of any of them changes, all of
  them are brought to the tick and re-anchored there, and so are they when food moves the body;
  nothing is re-anchored because a being was processed. `bodyAt` gives the values at any tick from
  the anchor, and reading them writes nothing.
- **Reaching a level θ** means being at or below θ for a falling quantity and at or above θ for a
  rising one. It happens at the first tick t with `E ≥ ⌈d·den / num⌉`, where d is `v0 − θ` when
  falling and `θ − v0` when rising; that is `t = anchor + ⌈⌈d·den / num⌉ / simSecondsPerTick⌉`. A
  level already reached gives the anchor itself, and a rate of 0 never reaches another level. Every
  wake is at least the next tick.
- **A walk** of steps with durations `d_1 … d_n` that starts at tick s arrives at step i at the tick
  `s + ⌈S_i / (simSecondsPerTick·1000)⌉`, with `S_i = d_1 + … + d_i`. Several steps may fall in one
  tick. The bites of a meal follow the same rule with the bite's duration.
- **What `simSecondsPerTick` changes.** Laws, routes, and arrival instants `S_i` do not depend on it.
  The engine observes an arrival at the first tick at or after it, so an activity lasts a whole
  number of ticks, and needs change over whole ticks. With 12 or 6 seconds per tick, a walk follows
  the same cells and each arrival tick, read as seconds, lies within one tick after `S_i`.
- **`wake`** is the minimum of: the next arrival or bite, the end of the activity, nutrition and
  rest reaching 0 and crossing `recoverAbove` either way, health reaching 0, the health above
  `recoverAbove` at which an incapacitated being recovers, the targets of the activity, the brain's
  `wakeWhen` (the light included, computed with `nextLightTick`), and one simulated day after the
  tick.
- **Physiology.** Health falls while nutrition is 0 and recovers while nutrition and rest are above
  `recoverAbove`. Rest at 0 forces sleep. Health at 0 incapacitates the being, or kills it when
  `life.deathEnabled` is true (plan O-16).

### What the tests check

`packages/engine/test/beings-rates.test.ts`, `beings-laws.test.ts`, and `beings-model.test.ts`:

- the closed forms against an oracle that accumulates each rate tick by tick with an exact
  rational remainder; the first second that reaches a level, on random cases, against the second
  before it; saturation at the clamp for any elapsed time; and a constructed case where computing
  `num·seconds` directly would round to the wrong integer;
- every problem of the laws, a being, a chunk, and the occupancy index reported at once with its
  path, independent problems together (a bad `due` beside a bad being); one bad value for each
  member, which must give exactly one issue at that member's path; bounds from both sides; and a
  hostile global value read without throwing. The validators read canonical values, as the kernel
  passes them; a host copies an arbitrary value first with `copyCanonical`;
- the seal, and a diet that names a deposit the genesis does not have;
- the default laws against the registered targets that depend on the laws alone, including one
  cell's regrowth against the cheapest day and the stationary horizon H;
- each being in the chunk of its cell, on both sides of the origin, ids rising strictly, and `due`
  equal to the earliest wake.

When these tests were written, each of 24 deliberate defects made them fail, except one that is
equivalent: without the saturation guard of `scaledFloor`, its final clamp gives the same result,
but an intermediate product could leave the safe integers, so the guard stays.

## Senses

At each decision the engine builds a square window of side `2R + 1` centered on the being (R = 24
by default):

| Member | Content |
|---|---|
| `origin`, `side` | The window's first cell and its side; cells outside the world are part of it, impassable and without food |
| `edgeMs` | 8 entries per cell: the milliseconds of the step from that cell in each direction, or −1 for a step that cannot be taken |
| `foodCue` | Per cell: 0 when the effective food of the species' deposit is below `some`, 1 from `some` up to below `plenty`, 2 from `plenty` |
| `light` | The radiance of the instant |
| `self` | The being's own state, including `behavior`, `outcome`, and `cooldowns` |
| `draws` | Two u32 draws from the system's stream `beings.brain`, keyed by the being |

Indexing, shared by the engine, the brain, and every oracle:

- the window's cell `(x, y)` has index `(y − origin.y)·side + (x − origin.x)`, and its step in
  direction d is entry `index·8 + d` of `edgeMs`; the being's own cell is the center, so `origin` is
  its cell minus `(R, R)`;
- direction d moves by `(dx, dy)`: 0 E `(1, 0)`, 1 NE `(1, 1)`, 2 N `(0, 1)`, 3 NW `(−1, 1)`,
  4 W `(−1, 0)`, 5 SW `(−1, −1)`, 6 S `(0, −1)`, 7 SE `(1, −1)`. Worldgen has no compass: this
  contract names +x east and +y north, on worldgen's own cell axes;
- a walk is a string of the digits of its directions, from the being's cell.

A step from cell a to its neighbor b cannot be taken when b lies outside the world or the window,
when `|elevation(b) − elevation(a)|` exceeds `maxRise`, or when the liquid depth of b exceeds
`maxWade`. A diagonal step by `(dx, dy)` also cannot be taken when either orthogonal step from a, by
`(dx, 0)` or by `(0, dy)`, cannot. Otherwise it lasts
`⌈f · (stepMs + ⌊rise·|Δelevation|⌋ + ⌊wade·depth(b)⌋) / 1000⌉` milliseconds, with f = 1000 for an
orthogonal step and 1414 for a diagonal one, and the rise and wade terms computed as rates over
those units.

Terrain is read by regions: each decision samples its window once with `sampleSurface`, which
returns exactly `sampleRegion`'s elevation and the diet's deposit and costs about a quarter of it.
The food beings took comes from the chunks the window covers, read without writing or
materializing anything. Every decision gets fresh arrays, so one brain cannot change what another
sees. A memo shared by the decisions of one tick waits until the benchmark shows several beings
deciding in the same tick and region.

### What the tests check (senses)

`packages/engine/test/beings-senses.test.ts` and `worldgen-surface.test.ts`:

- every edge and cue of windows near the origin, across chunks in negative coordinates, at both
  corners of the world, and along a shore where a step wades, against an oracle that recomputes
  each step from `sampleRegion` and `liquidLevel` one cell at a time; no diagonal cuts a blocked
  corner;
- the cue exactly at `some − 1`, `some`, `plenty − 1`, and `plenty`; regrowth that moves a cell to
  another band, counted in seconds from the tick of the take; and entries in a covered chunk just
  outside the window, which change nothing;
- step durations that round up, the slowest step a valid law allows within 2^31 − 1 ms, and
  `minimumSteps`;
- accepted intentions with the cumulative arrivals of a walk of several steps; each rejection, a
  walk as the second or third step, a getter, a Proxy whose traps throw, a revoked Proxy as the
  list of steps, and a huge list, refused from its length without reading its entries;
- `sampleSurface` equal to `sampleRegion` cell for cell on random regions and at the world's edges,
  and its deposit index, `-0` and a genesis without deposits included.

When these tests were written, each of 10 deliberate defects, from an independent verifier's
review and its follow-up, made them fail; one more, dropping the row check of an entry outside the
window, is equivalent, because such a row gives an index outside the window's arrays, and a typed
array ignores a write there.

## The brain

`Controller.decide(senses) → { steps, wakeWhen, behavior }`, a pure function of its senses:

- `steps`: one to three of `walk` (at most 64 directions, digits 0–7 in the order of `edgeMs`),
  `eat` (until a nutrition target), `sleep` (until a rest target), and `idle` (for some
  milliseconds);
- `wakeWhen`: optional thresholds `nutritionBelow`, `restBelow`, `lightBelow`, and `lightAbove`;
  each wakes the being when the quantity reaches the threshold (at or below, or at or above);
- `behavior`: what the brain wants to find again in its next senses;
- `cooldowns`: optional, up to four targets to avoid for a while, each `{ cell, ms }` with a cell
  inside the world and `ms` from 1 to 2^32. The brain does not sense the tick, so the engine stamps
  each with `until = tick + ⌈ms / (simSecondsPerTick·1000)⌉`; one added for a cell replaces the
  being's earlier one there, and the being keeps the newest four. Before each decision the engine
  drops those with `until ≤ tick`, so the brain senses only cooldowns that still hold. A refused
  intention adds none, and an intention without the member leaves them as they were.

The brain receives copies of everything it senses, the window's arrays included, and the engine
keeps its own window: a brain that writes to its senses changes nothing the engine judges by. The
engine copies the intention canonically, reading each member once and refusing accessors, then
validates its shape and bounds, and every step of a walk against its window of the same tick. A
walk is the first step or none, so its arrivals are computed from that window; the preconditions of
the steps, food to eat and a condition that allows walking, are checked when they start. A step
whose precondition fails is no refusal: the being idles briefly, and `outcome` records `failed`
with the reason `no_food` or `incapacitated`. An invalid intention is rejected with one of the
reasons `malformed`, `walk_not_first`, and `walk_blocked`: the being idles briefly, `outcome`
records the reason, and the engine emits `being.intention_rejected`. A brain that throws
poisons the world. The ruleset captures its brains as it captures its lists, and its
brain version composes each species with its brain, in species order.

`utility@1` (T4-6) scores five behaviors with integer response curves: forage, eat here, sleep,
explore, and rest. It keeps hysteresis, a commitment bonus with a minimum margin to switch, and
cooldowns on failed targets. It plans with one Dijkstra over the window for food and A* with an
octile heuristic for a single target; ties break by (f, h, cell index).

## Navigation

`@open-origin/agents` searches the window of the senses (`packages/agents/src/navigation`):

- `dijkstra(grid, start)` gives, for every cell, the exact duration in milliseconds of its shortest
  walk from `start`, or −1 when no walk reaches it, the direction of its last step, and the number
  of cells expanded. `pathTo(paths, target)` returns that walk as direction digits: `""` for the
  start, undefined for an unreachable cell.
- `aStar(grid, start, goal, bounds)` returns `{ durationMs, path, expanded }` for a shortest walk to
  one goal, or undefined. `bounds = { straight, diagonal }` are the shortest possible orthogonal and
  diagonal steps of the species (the engine's `minimumSteps`), integers with
  `0 < straight ≤ diagonal ≤ 2·straight` and `straight < 2^31`. The heuristic is octile,
  `straight·(dmax − dmin) + diagonal·dmin` (`octileMs`), admissible and consistent under those
  bounds; a grid with a step inside the window shorter than its bound is rejected.

Contract and guarantees:

- A grid is `{ side, edgeMs }`: `side` from 1 to 65, and `edgeMs` an `Int32Array` of `side²·8`
  entries indexed as in [Senses](#senses), each −1 or a positive duration. A step that leaves the
  window is impassable whatever its entry. Durations add up as doubles, exact below 2^53, so a walk
  of 65² − 1 steps of 2^31 − 1 ms stays exact.
- Determinism: an indexed binary heap over typed arrays orders cells by (g, cell index) for
  Dijkstra and by (f, h, cell index) for A*, a total order, so equal-duration alternatives always
  resolve the same way. Each cell is expanded at most once, which bounds the nodes expanded by the
  window's cell count, and a cell keeps the first walk that reached it with its shortest
  duration.
- Invalid inputs throw `EngineError("invalid_value")` with every issue at its path: `/grid`,
  `/grid/side`, `/grid/edgeMs`, `/grid/edgeMs/<i>`, `/start`, `/goal`, `/target`,
  `/bounds`, `/bounds/straight`, `/bounds/diagonal`, `/dx`, `/dy`, and `/paths/arrival` when a caller changed
  the arrival directions of a result so that they no longer lead back to its start.
- Every buffer belongs to one search: no module state, `Map`, `Set`, `Math`, `JSON`, or key
  enumeration.
- A route may exceed the 64 steps a walk allows: the brain walks its first part and decides again.

### What the tests check

`packages/agents/test`: an O(V²) Dijkstra with no heap on 1,000 seeded random windows of sides 1 to
17, with corner cutting as the engine encodes it; breadth-first search on uniform-cost windows; and
an enumeration of every simple walk on 4 × 4 windows (40 pairs). On every random window the costs
equal the oracle's, every path is valid and sums to its cost, reachability agrees, and the heuristic
is admissible and consistent; ties, window edges, and every validation error are pinned. When the
tests were written, each of 12 deliberate defects made them fail; two more, off-by-one steps at the
window's north and south edges, are equivalent, because the index they reach lies outside the
window's arrays, which every caller already treats as impassable.

## The tick

One system, `beings`, runs three phases:

1. **Collect.** Read `due` of every chunk in `occupancy`, gather the beings with `wake ≤ tick`, and
   sort them by id. Each being is processed once per tick, even when it crosses into another chunk.
2. **Advance and decide**, by id: bring needs and health to the tick, move the steps that arrived
   by it, apply physiology, advance the activity, and when the being is free or a condition holds,
   build its senses, ask its brain, and copy and validate the intention. Bites that fall due become
   claims on their cell.
   - Exhaustion and a collapse act after the steps due at the tick. Exhaustion ends the current
     activity, `interrupted` with the reason `exhausted` (a walk whose last step arrived is
     `done`), takes no bite at that tick, drops the plan and the wake conditions, and starts a
     forced sleep; a collapse ends a walk the same way, with the reason `incapacitated`.
   - A wake condition that holds asks the brain, whose intention replaces the plan, also at the
     tick the activity ends; an activity it interrupts ends `interrupted` with the reason
     `wake_condition`, without the bite due at that tick.
   - A sleep whose target rest already holds ends at the next tick.
3. **Resolve and apply.** Claimed cells in order of chunk key (UTF-16 code units, the kernel's
   order) and cell index. When the food covers every claim, each claimant takes its bite. Otherwise
   `random.permutation` on the stream `beings.contest`, keyed by the lowest claimant id, orders the
   claimants, and each takes its bite or what is left, whichever is smaller. A claimant that takes
   less than a full bite has eaten what there was and ends its meal; one that takes nothing lost the
   contest. A being alone at a cell takes what there is, without a draw: when nothing is left its
   meal fails with the reason `food_gone`. Each gets an outcome and is processed again at the next
   tick, without a second decision in this phase. Then consumption, chunk crossings, `due`, `occupancy` with its daily prune, and
   events. At most one write of the global value per tick.

Commands: `beings.spawn`, from an admin, with `{ species, cell, needs?, traits? }` and no draws;
from any other origin it is rejected with the reason `admin_only`.
Events, one per behavior rather than per step, on the order of 50 per being and simulated day:
`being.spawned`, `started`, `finished`, `ate`, `contested`, `exhausted`, `incapacitated`,
`recovered`, `died`, `intention_rejected`. A sleep starts and finishes as every activity does, so
it has no events of its own; an idle that runs out ends without one.

The brain does not sense the tick, so the engine keeps `behavior.since`: the tick at which the
brain first named a behavior of that kind, kept while it names the same kind.

### What the tests check (tick)

`packages/engine/test/beings-ruleset.test.ts` and `beings-tick.test.ts`, over a test genesis whose
day lasts 100 ticks:

- the ruleset's brain version, its refusal of every bad brain at once, and that it captured its
  brains; a species without a brain; and an occupancy index that lists a chunk that does not exist;
- `beings.spawn`: refused from an inhabitant; the record it creates, in the chunk of its cell at
  negative coordinates, omitted needs and traits, sorted beings and occupancy, every problem of a
  bad spawn, traits bounded by the species, and a cell under liquid deeper than the species wades;
- walks arriving at the tick their milliseconds give, across a chunk edge, at 12 and at 6 seconds
  per tick, and the chunk they left pruned from the occupancy index at the next day;
- needs equal to an integer oracle whether a being is processed every tick or every 50, re-anchored
  at the tick nutrition crosses `recoverAbove`, and read without writing;
- each bite at its tick, the cell's depletion, a meal that ends when the cell is empty, the cell
  regrown at the law's rate and eaten again, and a meal that cannot start on an empty cell;
- forced sleep at the tick rest reaches 0, with no decision until rest is full;
- wake conditions on the light and on nutrition at the exact tick, and conditions already met
  dropped; `behavior.since` stamped by the engine;
- each reason of a refused intention, and a brain that throws poisoning the world;
- a world resumed from a snapshot that continues with the original's checksums.

When these tests were written, each of 15 deliberate defects made them fail: floored arrivals,
re-anchoring at every processing, no wakes at levels, a prune at every tick, conditions kept when
already met, `since` taken from the brain, a bite of nothing re-anchoring the body, a contest
without rivals, unforced exhaustion, a short refusal, a late first decision, a strict light
threshold, taken food ignored when a meal checks its cell, no exhaustion, and regrowth ignored when a
cell is eaten again.

An independent verifier then found six defects that these tests missed, and 14 deliberate defects
they let pass, two of which belong to the contests of the next section. The tests added for the
rest check that:

- a brain that writes over its senses cannot forge a walk, because the engine judges by its own
  window;
- a wake condition that holds with planned steps left asks the brain, also when it starts to hold
  at the tick the activity ends; a meal it interrupts at a bite takes no bite there; a refused
  intention clears its conditions; and a condition the body already meets exactly is dropped;
- a sleep whose target holds ends at the next tick; steps due at the tick of exhaustion arrive; the
  forced sleep finishes the walk, `done` when its last step arrived then, and starts with its own
  events;
- `nextLightTick` finds a crossing at the light's middle second, on two days whose light period is
  odd and whose light is 999 at second ⌊light/2⌋ and 1000 at ⌈light/2⌉;
- a being recovers at the tick its health passes `recoverAbove`, processed every tick or every 500;
- rest re-anchors at the tick it passes `recoverAbove`, not at the tick it reaches it; a cell's
  entry is dropped once it regrew, when its chunk is written; a being is processed at least once a
  simulated day; and a spawn may stand exactly as deep as the species wades.

Each of 21 more deliberate defects makes them fail: a floored middle of the light period, no
daily processing, regrown entries kept, a
condition met exactly kept, no level just above `recoverAbove`, a spawn refused at its wading
depth, recovery at `recoverAbove` itself, the bite kept at an interruption, the conditions kept by
a forced sleep and by a refusal, no level at rest 0, regrowth shifted by a tick, the brain's window
judged, steps due at exhaustion dropped, no event for the interrupted activity or the forced sleep,
a sleep that waits out a target it met, no wake at recovery, the next planned step run instead of
asking the brain, a condition ignored at the tick the activity ends, and a walk whose last step
arrived at exhaustion reported as interrupted.

### What the tests check (contests, incapacity, fuzz)

`packages/engine/test/beings-contest.test.ts` and `beings-fuzz.test.ts`:

- three rivals on a cell with two whole bites, and with two bites and a part: the drawn order, the
  bites of each, their nutrition and the cell's depletion read from the state, and the outcome of
  the one left short; two rivals that the food covers, at the boundary, eat without a contest;
- the draw is keyed by the lowest claimant id: rivals 1, 2, 3 and rivals 1, 2, 4 are ordered alike
  on each of 8 seeds, which draw different orders;
- across 120 world seeds, the rival left short is each id about as often: the chi-square statistic
  of the three counts stays below 13.82, its 0.999 quantile with 2 degrees of freedom;
- with faster laws, a starving being incapacitated at the exact tick its health reaches 0, a walk
  it proposes failing its precondition and one in progress interrupted where it stands, a meal
  allowed, and its recovery at the exact tick its health passes `recoverAbove`; with death enabled,
  the being dies, leaves its chunk, and the chunk leaves the occupancy index at the next day;
- three seeded runs of 250 ticks with random spawns, valid and not, and a random brain whose choices
  come from its draws, valid and not, on a patch of food: after every tick, ids are unique, each
  being is in the chunk of its cell, chunks with beings ⊆ occupancy ⊆ materialized chunks, `due` is
  the least `wake`, every `wake` is after the tick, every cell's food lies within its deposit, and
  each cell lost exactly what the beings on it ate; beings ate in every run;
- a quiet tick of ten beings reads each listed chunk once, never lists every chunk, and writes the
  global value at most once; the daily prune and the daily processing read each chunk once more.

When these tests were written, each of 14 deliberate defects made them fail: contests ordered by
id, contests keyed by the highest claimant id, a contest when the food covers every claim, no
contests, no wake at recovery, a walk not interrupted at the collapse, death ignored, food taken
twice, a grant of the whole claim, the occupancy index not grown, depletion not recorded, a stale
`due`, a being left in the chunk it left, and every chunk listed each tick. One more, a wake
at the tick itself, is equivalent: every candidate for `wake` already lies after the tick.

## Preregistration

Registered before any calibration, so that neither the laws nor the brain are tuned until the
survival test passes. Every choice below is fixed: none is left to the pull request that implements
it.

### Seeds

The seeds of T4's scenarios are derived from public labels, so none is chosen by hand. For a label:

- the world seed is the first two words, read as big-endian u32, of SHA-256 of the UTF-8 text
  `<label>/world`;
- the terrain seed is the eight words of SHA-256 of `<label>/terrain`, read the same way;
- the spawn generator is the test generator Sfc32 seeded with the first word of SHA-256 of
  `<label>/spawn`.

| Set | Labels | Use |
|---|---|---|
| Default | `open-origin/t4/default` | The survival test in CI (plan §N.15) |
| Calibration | `open-origin/t4/calibration/1` to `/4` | Calibrating laws and brain, and nothing else |
| Held out | `open-origin/t4/heldout/1` to `/6` | Evaluation: `/1` in CI, all six in the soak |
| Reserve | `open-origin/t4/heldout/7` to `/12` | Replacement after a burn |

These are test seeds in a public repository. No world reachable by anyone else may use them: a
public world's seeds come from a CSPRNG and are C3 ([0021](../decisions/0021-procedural-world.md)).

### Scenario

- **World:** `defaultGenesis(terrainSeed)`, 12 seconds per tick (plan §I.1.1), the default laws of
  life, 8 beings of one species that eats deposit 0, death disabled.
- **Food coverage of the genesis:** the number of cells with deposit 0 above 0 among the 1024 × 1024
  cells from (−512, −512) to (511, 511).
- **Spawn area:** candidate centers are chunks ordered by `(max(|x|, |y|), y, x)`, ascending. The
  area of a candidate is the 3 × 3 chunks around it, 96 × 96 cells from the cell
  `(32·(x − 1), 32·(y − 1))`. An area qualifies when at least 4,608 of its cells have liquid depth 0
  and at least `⌈coverage · 9,216 / 2^20⌉` of its cells have deposit 0 above 0: as much food as the
  genesis has on average, measured on terrain only, without running the simulation. The spawn area
  is the first candidate that qualifies with `max(|x|, |y|) ≤ 64`. A label without one is
  uninhabitable and reported; for the default label, the next of `open-origin/t4/default/2`, `/3`,
  and so on that is habitable takes its place.
- **Beings:** the area's cells with liquid depth 0 are listed by y, then x, ascending, and counted
  n. Every draw of a number in [a, b] takes `u = next()` from the spawn generator, rejects it while
  `u ≥ k·⌊2^32 / k⌋` with `k = b − a + 1`, and gives `a + u mod k`. For each being in turn: its cell
  is entry `draw [0, n − 1]` of the list, drawn again while another being has it; then nutrition and
  rest, each in [600,000, 900,000]; then appetite, sleepiness, and curiosity, each within the
  species' trait bounds, which are [800, 1,200] in the default laws and are not calibrated.

The spawn areas, computed with this rule on `worldgen@1` before any law of life existed:

| Label | Coverage (cells of 2^20) | Area needs | Center chunk | Land cells | Food cells |
|---|---|---|---|---|---|
| `default` | 93,579 (8.92%) | 823 | (0, 0) | 9,216 | 2,289 |
| `calibration/1` | 92,120 (8.79%) | 810 | (0, 0) | 9,216 | 4,811 |
| `calibration/2` | 95,565 (9.11%) | 840 | (0, 0) | 9,216 | 5,696 |
| `calibration/3` | 71,601 (6.83%) | 630 | (−6, −1) | 9,216 | 811 |
| `calibration/4` | 49,768 (4.75%) | 438 | (2, −2) | 9,216 | 603 |
| `heldout/1` | 89,154 (8.50%) | 784 | (7, 11) | 7,921 | 834 |
| `heldout/2` | 70,167 (6.69%) | 617 | (10, −6) | 4,897 | 2,176 |
| `heldout/3` | 91,207 (8.70%) | 802 | (−3, −3) | 9,216 | 1,607 |
| `heldout/4` | 93,031 (8.87%) | 818 | (−3, −3) | 9,216 | 1,815 |
| `heldout/5` | 89,380 (8.52%) | 786 | (10, −10) | 9,216 | 901 |
| `heldout/6` | 83,655 (7.98%) | 736 | (−5, −5) | 9,216 | 1,766 |

The scenario fixture of T4-7 recomputes this table, and a test pins it.

### Ecological targets

Expressed in the world's own day L (75,600 s by default): a design choice that ties the body to the
world's day law, not a fact about Earth. A typical food cell holds f units, the lower median of the
positive values of deposit 0 over the cells of the four calibration areas pooled (entry
`⌊(m − 1)/2⌋` of the m values in ascending order). A full meal raises nutrition from 400,000 to
1,000,000.

| Target | Range |
|---|---|
| Nutrition, awake and idle, without food: 1,000,000 to 0 | 1.5 L to 3 L |
| Nutrition while walking, and while asleep, against awake and idle | 1.25 to 2 times; 0.25 to 0.75 times |
| Health at nutrition 0: 1,000,000 to 0 | 1 L to 2 L |
| Rest, awake and idle: 1,000,000 to 0; while walking, against idle | 1.2 L to 2 L; 1 to 1.5 times |
| Rest asleep: 0 to 1,000,000 | 0.25 L to 0.45 L |
| Units a full meal needs | 0.5 f to 1.5 f |
| Regrowth of an emptied cell to f units | 1 L to 3 L |
| 32 flat orthogonal steps | 0.01 L to 0.03 L |
| One cell alone | g ≤ 0.75 c, below |
| The stationary horizon H, below | at most 60 L |

Here c is the nutrition a day costs at the cheapest mix, asleep for the shortest time that restores
the rest a day costs and awake and idle otherwise; g is a day of regrowth times the nutrition per
unit. With P the peak of deposit 0, H is the time from full nutrition and health, eating only one
cell that starts full, to health 0: `(1,000,000 + P·nutritionPerUnit) / (c − g)` days to nutrition
0, plus `T·c / (c − g)`, where T is the time health takes to fall from full to 0. The second term
is longer than T because the being keeps eating what regrows, and health falls only while its
nutrition is 0, a fraction `(c − g) / c` of the time.

### Evaluation

- Laws and brain are calibrated on the calibration seeds only, then frozen together in T4-6; the
  commit that freezes them is recorded in the tracker.
- The survival test runs the default seed and `heldout/1` in CI; the soak runs `heldout/1` to `/6`
  and records every result, whatever it is.
- If a held-out seed fails, it is analyzed. Any change to laws or brain after that burns every
  held-out seed already evaluated, and the evaluation moves to the reserve.
- Margins:
  - on the default seed, health never falls;
  - in the soak, two variants still survive: an adverse one, with every rate that lowers a need or
    health multiplied by 11/10 and every rate that raises a need, health, or food by 9/10, and a
    favorable one with the opposite factors; each numerator is rounded to the nearest integer,
    halves up. Calibrated numerators stay at or below 953,250, ⌊2^20·10/11⌋, so the adverse variant
    stays within the bounds of a ratio.
- Acceptance on the default seed and `heldout/1`, over 63,000 ticks (10 days): no being is
  incapacitated, dies, or reaches rest 0, and the brain has no intention rejected. Every being:
  - ate in at least 5 distinct cells, at least one outside the window it was born in;
  - had at least 5 meals that each raised its nutrition by at least 300,000;
  - slept at least 9 times and woke with rest at least 900,000 at least 9 times;
  - walked at least 320 cells.

  Some cell was emptied, regrew to at least half its deposit, and was eaten again.
- Negative controls: a brain that never eats is incapacitated at the tick the laws give; a
  stationary brain, which only eats in its own cell and sleeps, is incapacitated by H on every seed.
