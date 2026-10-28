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
| Cooldowns that an intention adds | `packages/engine/src/beings`: `intention.ts`, `advance.ts` | T4-6 |
| The brain `utility@1` | `packages/agents/src/brain`: `curves.ts`, `parameters.ts`, `recipes.ts`, `utility.ts` | T4-6 |
| The preregistered scenario and the calibration | `packages/agents/test/support`: `scenario.ts`, `metrics.ts`; `packages/agents/bench/calibration.ts`; `defaultLife` in `laws.ts` | T4-6 |
| The evaluation: survival, negative controls, scarcity, determinism, observers, and the soak | `packages/agents/test`: `survival.test.ts`, `scarcity.test.ts`, `beings-determinism.test.ts`, and their support; `packages/agents/bench/soak.ts` | T4-7 |
| The cost: the complexity test, the count of the system's calls, and the scale benchmark | `packages/engine/test/beings-cost.test.ts` and `support/beings-cost.ts`; `packages/agents/bench`: `beings.ts`, `scale.ts` | T4-8 |

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
  cell's regrowth against the cheapest day and the stationary horizon H, and numerators of at most
  953,250 that a variant of ±10% moves; the targets that depend on the typical food cell f are
  checked in `packages/agents/test/scenario.test.ts`, which measures f on the calibration areas;
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

### `utility@1`

`utilityController()` of `@open-origin/agents` is a Utility AI (plan §5.3, L1) with the recipes
of L2 (plan §5.4). It is a pure function of its senses: it keeps no state, what it must remember
travels in `behavior` and `cooldowns`, and its only randomness is `draws[0] mod 8`, its heading at
its first decision. Its parameters are in `packages/agents/src/brain/parameters.ts`, calibrated
and frozen with the laws (see [Calibration](#calibration)).

**Considerations**, integers in permille, each from a piecewise-linear response curve whose
values between points are rounded down:

- hunger and tiredness, the loss of nutrition and rest from full, `⌊(10^6 − level)/1000⌋`, each
  felt through a trait: `min(1000, ⌊loss·trait/1000⌋)`, appetite for hunger and sleepiness for
  tiredness;
- darkness, 1000 at a light of 100 or less and 0 from 200;
- the worth of a food cell, the worth of its cue (some 600, plenty 1000) times that of its route
  time (1000 for none, 700 for an hour, 300 for four hours), from one Dijkstra over the window;
- alertness, 1000 until half of rest is lost and 0 from 65%;
- the drive to wander, 500 felt through curiosity, times the daylight `1000 − darkness`.

**Scores** are the product of the considerations, each lifted by `(1 − c)·(1 − 1/n)·c` (the
compensation of Mark and Dill's Infinite Axis Utility System), so that a consideration of 0 vetoes
a behavior and more considerations do not lower a score by themselves:

| Behavior | Considerations | Plan | Woken by |
|---|---|---|---|
| forage | the drive to eat; the best cell's worth | walk the route, then eat to full when one walk reaches it | rest at 150,000 |
| eat here | the drive to eat; the cue of its own cell | eat to full | rest at 150,000 |
| sleep | the need to sleep; darkness, or the urgency of tiredness | sleep to full rest | nutrition at 250,000 |
| explore | the drive to search or to wander; alertness | a leg, then a pause of 3 hours when wandering | hunger, tiredness, dusk when wandering; tiredness when searching |
| rest | a constant 250 | idle 2 hours by day, 12 in the dark | hunger, tiredness, dusk and dawn |

- **The drive to eat** starts once 40% of nutrition is lost (700, rising to 1000 at 70%) and,
  once foraging or eating, keeps going until at most 10% is lost: the hysteresis that carries a
  meal from cell to cell. Without a reachable food cell or food here, the drive to eat becomes the
  drive to search; with one, the being does not wander.
- **The need to sleep** in the dark starts once 10% of rest is lost, by day once 65% is; once
  asleep, it holds until at most 2% is lost, and a sleep ends at full rest. So beings sleep once or
  twice each night and wake rested.
- **Choice.** The best score wins, ties going to the order forage, eat, sleep, explore, rest. The
  behavior the being is doing gets a bonus of 100, and another must also beat it by 50; a
  behavior it can no longer do, scored 0, holds nothing. A wake condition the brain asked for
  releases the commitment, since it is the brain's own request to weigh everything again: a
  sleep woken by starvation does not outweigh the meal.

**Decision points.** Every plan asks to be woken at the levels that would change the choice: the
nutrition at which the drive to eat starts and the rest at which sleep starts, felt through the
being's traits, and the light at dusk (100) and dawn (200), with both in the twilight. Rest idles
long, and a being decides again only when an activity ends or a condition holds, about 11 to 12
times a simulated day. By day, every plan either has the dusk condition or ends by itself, a walk
and a meal, so the reaction to darkness is bounded by the longest such plan: 64 of the slowest
steps the law allows and a meal to full.

**Recipes.**

- **Forage** searches the window once with Dijkstra and walks to the cell of highest worth, other
  than its own and those it cools; ties go to the shorter route, then to the lower cell index. A
  route of more than 64 steps is walked in parts, without the meal, and the being decides again at
  the end of each. Unreachable cells are never chosen, so no forage fails for want of a route.
- **Wander**, by a sated being by day: a leg toward the cell 16 cells away along its heading,
  planned with A* under the octile bounds of the window's own cheapest steps. The heading is kept
  from leg to leg and from one exploration to the next; the being turns, by 45° then wider to
  either side, when the target has a cooldown, has no food cue within 12 cells, or has no route,
  so it never wanders out of sight of food. A target without a route gets a cooldown of 6 hours.
- **Search**, by a hungry being with nothing to eat in sight: a spiral around its anchor, the
  oldest cooldown within 200 cells, or a new one of two days where it stands, a place where it
  found nothing. Each leg steps 12 cells around the anchor, counterclockwise, or around and out
  when that is blocked, and every leg ends farther from the anchor than it began, so the path is a
  spiral whose turns lie about π·12 ≈ 38 cells apart, inside the window's side of 49: it sweeps
  the land nearest the anchor first and never comes back to a place it passed. At the anchor itself
  the first leg follows the heading, turning when blocked. A straight search, and a search bounced
  inside a square, were tried during calibration and left beings that spawned out of sight of food
  to starve: the first walked away from food, the second fell into short periodic loops.
- **Cooldowns.** A meal that failed where the being stands (`failed` or `lost`, with `no_food` or
  `food_gone`) cools that cell for 6 hours, a wander target without a route for 6 hours, and the
  anchor of a search for two days. A cooled cell is neither foraged, eaten, nor aimed at.
- **The edges of the world.** The window covers cells outside the world, impassable and without
  food. The brain never aims a leg at one, nor gives one a cooldown, which the engine would refuse
  with the whole intention.
- When the being is incapacitated it never walks; when no leg has a route it rests.

### What the tests check (brain)

`packages/agents/test`: `curves.test.ts`, `utility.test.ts`, `utility-edges.test.ts`,
`utility-fuzz.test.ts`, `utility-world.test.ts`, on senses built by hand (`support/senses.ts`) and
in worlds:

- the curves, the compensated product, and traits, against values computed by hand;
- each behavior and its exact intention: eating here, foraging the cell of highest worth (cue
  against route time, both ways), ties by route time and by cell index, cooled cells, a route of
  92 steps walked in parts, no walk while incapacitated, failed meals remembered, sleep by night
  and only when exhausted by day, rest with its wake levels, felt through traits, wandering toward
  food in sight and resting when none is, the first heading from the draws, the heading kept, the
  search's anchor, its steps around and out, a spiral of 120 legs whose distance from the anchor
  always grows and whose turns lie 30 to 47 cells apart, and blocked targets cooled;
- hysteresis and commitment: the two levels of eating, needs that waver around a level, rest that
  wavers around the level of sleep at night, the margin to switch, and a wake condition that
  releases the commitment;
- the orders it keeps: the oldest cooldown near it as the anchor, the first four of the cooldowns
  it would add, the targets without a route cooled when wandering falls back to rest, cooled cells
  never aimed at by a wander or a search, some food where it stands eaten rather than searched
  for, and alertness, which keeps a tired being from wandering by day;
- the boundaries of its rules: a cooldown exactly SEARCH_RANGE away and one farther, food exactly
  WANDER_SIGHT cells from a target on each side and one farther, a route of exactly 64 steps
  against one of 65, cooled cells in the window's last column and last row, a cooldown one cell
  past the window's east or north side, which maps to no cell of it, and a target exactly on the
  world's last column;
- by each of the four edges of the world, a wandering being and a searching one that propose
  nothing outside it, and a world of eight beings by the east edge, some of them heading toward
  it, with no intention refused;
- that a decision is the same from the same senses and writes nothing to them;
- on 300 random senses over real terrain, that the engine accepts every intention, walks have at
  most 64 steps, an incapacitated being never walks, every behavior occurs, and by day every plan
  has the dusk condition or ends by itself;
- in the calibration scenario `calibration/1`, that resting and wandering beings decide at the
  exact tick of dusk, and a being spawned to forage across dusk within the bound above; and the
  ruleset's brain version `s1:utility@1`.

When these tests were written, each of 34 deliberate defects in the brain made them fail: the
start level of eating, no hysteresis of eating or of sleep, no commitment, no margin, ties to the
later behavior, a commitment kept through a wake condition, the heading drawn at every decision,
no anchor and no reuse of one, failed meals and blocked targets not cooled, cooled cells foraged
or eaten, ties to the longer route, route time ignored, a meal planned past one walk, no dusk
condition, wake levels one short, walking while incapacitated, traits ignored, no compensation,
curves rounded to the nearest, wandering while hungry, a short rest at night, wandering out of
sight of food or as far as the window, a clockwise spiral, an integer square root one too large,
out before around, a first leg that ignores the heading, a search step twice as long, bounds too
high for A*, and no exhaustion guard on foraging. Four of them first survived, and the tests were
strengthened: a slow route to plenty against some food near, a little food against wandering, a
tie in worth broken by route time, and a heading kept whatever the draws.

An independent verifier then found that the brain cooled targets outside the world by its edges,
which the engine refused, and named 11 more defects these tests let pass: the anchor on the newest
cooldown, a search over some food where the being stands, the last four cooldowns kept instead of
the first, blocked targets dropped when wandering falls back to rest, cooled cells aimed at by a
wander or a search, no alertness, and off-by-one boundaries of the search's range, of the sight of
food, of a walk of 64 steps, and of the window's last column. The tests above now make each fail,
with 4 more off-by-one boundaries of the sight and the window and a wander that aims outside the
world, and so do the 34 defects before. One defect is equivalent: a search that aims outside the
world finds no route there, so the check only spares an A*. The verifier's recheck found one of
the 11 still passing, a cooldown just past the window's east side mapped onto the next row, and a
target on the world's last column skipped; the last two tests above make both fail.

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

`packages/agents/test/support/scenario.ts` builds the scenario of a label by this rule, and
`packages/agents/test/scenario.test.ts` recomputes this table from the terrain alone and pins it.

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

## Calibration

Laws and brain were calibrated together on the four calibration labels only, as the
preregistration requires, and frozen together; no simulation ran on the default label or any
held-out label. `bun packages/agents/bench/calibration.ts [1 2 3 4] [adverse | favorable]
[--ticks N] [--spawn K]` reruns it; it refuses the default label and the held-out ones, and every
argument it does not know, with exit code 2. `packages/agents/test/freeze.test.ts` pins the
freeze. The correction that keeps the brain inside the world's edges froze them again; it
changed no result below, which the bench reproduced being by being on the four labels, under the
default laws and both variants.

### The laws

The typical food cell of the calibration areas is f = 84 units (the lower median of 11,921 positive
values), far below the deposit's peak of 1000. Three provisional laws missed the targets that
depend on f, and changed:

| Law | Provisional | Calibrated | Why |
|---|---|---|---|
| `diet.nutritionPerUnit` | 2000 | 8000 | a full meal needed 300 units, 3.6 f; it needs 75, 0.89 f |
| `regrowth` | 1/504 per s | 100/240,000 per s (1/2400) | f regrew in 0.56 L; it regrows in 2.67 L. The numerator 100 lets the ±10% variants move it, which 1 cannot |
| `diet.cue.plenty` | 200 | 40 | no cell of the calibration areas cued plenty at 200 in two of them; 40 units feed 320,000, a meal of the acceptance list |

Every other law kept its provisional value. With them, the default laws give: nutrition from full
to 0 awake in 2 L, walking 1.5 and asleep 0.5 times as fast; health from full to 0 in 1.5 L;
rest from full to 0 in 1.6 L, walking 1.25 times as fast; rest restored in 0.35 L; 32 flat steps
in 0.019 L; one cell's day of regrowth g = 252,000, 0.55 of the cheapest day c = 455,128; and a
stationary horizon H = 47.7 days. Every numerator is at most 953,250.

### The brain

The parameters of `utility@1` in `packages/agents/src/brain/parameters.ts` are frozen with these
laws. Calibration changed the brain itself three times:

- on `calibration/3`, sated beings wandered out of sight of food and starved, so wandering keeps
  food in sight;
- on `calibration/3`, beings spawned out of sight of food searched in a straight line into a
  barren region. A search bounced inside a square around where it began passed the four labels,
  but on `calibration/3` with another spawn draw (below) it fell into a loop of five legs; a
  square spiral on a lattice then looped where its points were blocked, so the search became the
  spiral whose every step leads farther out;
- while its tests were written, a sleep woken by starvation turned out to outweigh the meal, so a
  wake condition releases the commitment.

### Results

Each calibration label, 63,000 ticks (10 days), audit off, with the brain `utility@1` and the
default laws; the minimum over the eight beings of each acceptance item:

| Label | Incapacitated, rest 0, rejected | Meal cells | Ate outside birth window | Meals ≥ 300,000 | Sleeps; rested wakes | Walked | Lowest nutrition |
|---|---|---|---|---|---|---|---|
| `calibration/1` | 0, 0, 0 | 13 | all | 10 | 30; 30 | 535 | 523,974 |
| `calibration/2` | 0, 0, 0 | 13 | all | 9 | 30; 30 | 544 | 463,941 |
| `calibration/3` | 0, 0, 0 | 13 | all | 9 | 30; 30 | 589 | 452,077 |
| `calibration/4` | 0, 0, 0 | 12 | all | 11 | 21; 21 | 622 | 309,208 |

On every label some cell was emptied, regrew to half its deposit, and was eaten again; health
never fell, because nutrition never reached 0. The same holds, with the frozen laws and brain:

- under the adverse and the favorable variants of the laws, on all four labels (lowest nutrition
  278,726 and 339,101);
- over 20 days (126,000 ticks) on all four (lowest nutrition 309,208);
- on each calibration terrain with three other spawn draws, `--spawn 1` to `3`, the spawn
  generator seeded from `<label>/spawn/1` to `/3` instead of `<label>/spawn` (lowest nutrition
  299,847). These are
  calibration terrains, not registered scenarios; the first of them led to the spiral search, and
  none changed a parameter after it.

Measured on the two-core Codespace with Bun 1.4.4 (indicative): a 10-day run of eight beings,
audit off, takes 5.3 to 6.1 s, of which the brain takes 0.15 to 0.2 s, and 5.9 to 6.5 s with the
metrics. A being decides 11.2 to 12.3 times a simulated day.

### What the tests check (calibration)

`packages/agents/test`: `scenario.test.ts`, `metrics.test.ts`, `freeze.test.ts`, and
`calibration-bench.test.ts`, with `packages/engine/test/beings-laws.test.ts`:

- the seeds of a label; the spawn table of all eleven labels, from terrain alone; the beings a
  label draws, on distinct dry cells, by rejection, pinned for `calibration/1` after an independent
  reading of the rule agreed; another spawn draw from `--spawn K`; the scenario's genesis, its 12
  seconds per tick, its laws without death, and its spawns at tick 1; the variants of the laws,
  rounded half up; f = 84; and the targets that depend on f;
- each metric against a tiny run checked by hand, with scripted brains on the engine's test
  terrain: rejections, also one alone in its tick after an idle ran out; an exhaustion and its
  forced sleep; an incapacity, and a death when death is enabled; meals, and a rise of exactly
  300,000 counted big where one of 299,999 is not; sleeps, and a rested wake within a tick of
  900,000; three meal cells, the third outside a birth window of radius 4 and inside one of 8;
  walked cells of whole walks and of one a wake condition interrupts; a cell emptied and eaten
  again, found regrown to half after an idle of 120 ticks and not after one of a tick; and each
  acceptance item at its threshold;
- the freeze: the seal of the default laws and a digest of every parameter of `utility@1`, by
  name, so that any change to either fails a test that says it burns the evaluated held-out seeds;
- the bench's arguments: the default and held-out labels refused in any spelling, and every
  unknown label, option, or value refused instead of ignored.

With the provisional laws, three of these tests fail: the units of a full meal, the regrowth to
f, and a regrowth numerator that ±10% cannot move. Each of 5 deliberate defects of the calibrated
laws, 8 of 9 of the scenario builder, 13 of the metrics, and 4 of the scenario and the bench
makes them fail, and so does each of 10 changes of a law or a parameter that no other test sees.
The ninth of the scenario builder, a cell dry only above the liquid level rather than at it, is
equivalent on the eleven labels, where no area cell lies exactly at the level. The four new files
cost about 0.6 s, 0.2 s, 0.03 s, and 0.02 s of `bun test`.

The metrics (`packages/agents/test/support/metrics.ts`) read events and the state at their
ticks: a meal is one `eat` activity, and its rise is the nutrition at its end less the nutrition
at its start; a rested wake is a sleep that ends with rest at least 900,000; walked cells are the
steps that arrived; a cell is emptied when a bite leaves it 0, and eaten again when a later bite
finds at least half of its deposit there.

## Evaluation results

The evaluation ran with the laws and the brain frozen in T4-6 (`6bb327f`, tracker L50), which
`packages/agents/test/freeze.test.ts` pins: the seal of `defaultLife()` and a digest of every
parameter of `utility@1`. No law and no parameter of the brain changed after any held-out label
was evaluated. Each run below is the preregistered scenario of its label, 63,000 ticks (10 days),
audit off.

### Survival

The minimum over the eight beings of each acceptance item, as in [Results](#results):

| Label | Incapacitated, rest 0, rejected | Meal cells | Ate outside birth window | Meals ≥ 300,000 | Sleeps; rested wakes | Walked | Lowest nutrition | Acceptance |
|---|---|---|---|---|---|---|---|---|
| `default` | 0, 0, 0 | 13 | 8 of 8 | 10 | 21; 21 | 565 | 339,151 | pass |
| `heldout/1` | 0, 0, 0 | 11 | 7 of 8 | 9 | 30; 30 | 609 | 352,911 | fail: being 3, outside birth window |

On both labels some cell was emptied, regrew to half its deposit, and was eaten again, and no
being's health ever fell: it stayed 1,000,000 at every event of every being and at the last tick.
On the default label every being meets every item, and health never falls, as the margin
requires. The beings decided 11.8 and 12.3 times a simulated day.

**`heldout/1` fails one item of the preregistered acceptance, for one being.** Being 3 never
ate outside the window it was born in; every other item holds for every being, and every other
being meets every item. Being 3 was born at (278, 402), with nutrition 695,645, rest 866,765,
appetite 919, sleepiness 1045, and curiosity 840, in a window of 1,006 cells with food, 607 of
them with at least 25 units, 32,134 units in all. It ate its 20 meals in 14 cells, all within 14
cells of its birth cell; its lowest nutrition at any decision was 540,283. It walked 609 cells
and went as far as 29 cells from its birth cell, while sated, wandering by day; whenever it was
hungry, the cell of highest worth in sight lay near its birth cell, so it foraged there. An
independent rerun, which read its cell from the state at each of its meals, found the same 14
cells.

The failure is recorded as it is, as the preregistration says: a failed held-out label is
analyzed, and only a change to laws or brain burns the evaluated labels. A change that made being 3
eat outside its rich birth window would be tuning to the evaluation just after seeing it, and not
better behavior. The laws and the brain stay frozen, `heldout/1` stays the held-out label of CI,
and `packages/agents/test/survival.test.ts` pins the failure exactly, as it was evaluated: the
beings that ate outside their birth window are all but being 3, and every other item holds.

### The soak

The preregistered scenario of each held-out label, under the default laws, under the adverse and
the favorable variants, and with the random-walk baseline instead of `utility@1`, for comparison
only: `bun packages/agents/bench/soak.ts`, which ran the 24 runs two at a time in 5.5 minutes on
the Codespace. The incapacities, rests at 0, and rejections of all eight beings, and the minimum
over them of every other item:

| Label | Laws or brain | Incapacitated, rest 0, rejected | Meal cells | Ate outside birth window | Meals ≥ 300,000 | Sleeps; rested wakes | Walked | Lowest nutrition | Regrown and eaten | Acceptance |
|---|---|---|---|---|---|---|---|---|---|---|
| `heldout/1` | default laws | 0, 0, 0 | 11 | 7 of 8 | 9 | 30; 30 | 609 | 352,911 | yes | fail: being 3, outside birth window |
| `heldout/1` | adverse | 0, 0, 0 | 12 | 7 of 8 | 10 | 30; 30 | 715 | 328,542 | yes | fail: being 3, outside birth window |
| `heldout/1` | favorable | 0, 0, 0 | 11 | 7 of 8 | 8 | 21; 21 | 604 | 376,947 | yes | fail: being 3, outside birth window |
| `heldout/1` | random walk | 8, 0, 0 | 0 | 0 of 8 | 0 | 8; 7 | 2,308 | 0 | no | fail: 8 of 8 beings |
| `heldout/2` | default laws | 0, 0, 0 | 11 | 8 of 8 | 10 | 21; 21 | 619 | 488,364 | yes | pass |
| `heldout/2` | adverse | 0, 0, 0 | 8 | 8 of 8 | 11 | 30; 30 | 688 | 474,405 | yes | pass |
| `heldout/2` | favorable | 0, 0, 0 | 11 | 8 of 8 | 9 | 21; 21 | 631 | 501,555 | yes | pass |
| `heldout/2` | random walk | 7, 0, 0 | 0 | 2 of 8 | 0 | 8; 7 | 2,409 | 0 | yes | fail: 7 of 8 beings |
| `heldout/3` | default laws | 0, 0, 0 | 13 | 8 of 8 | 10 | 30; 29 | 596 | 320,628 | yes | pass |
| `heldout/3` | adverse | 0, 0, 0 | 14 | 8 of 8 | 11 | 29; 28 | 587 | 256,764 | yes | pass |
| `heldout/3` | favorable | 0, 0, 0 | 12 | 8 of 8 | 9 | 30; 29 | 565 | 338,361 | yes | pass |
| `heldout/3` | random walk | 4, 0, 0 | 0 | 6 of 8 | 0 | 8; 7 | 2,732 | 0 | no | fail: 6 of 8 beings |
| `heldout/4` | default laws | 0, 0, 0 | 13 | 8 of 8 | 10 | 30; 30 | 608 | 361,074 | yes | pass |
| `heldout/4` | adverse | 0, 0, 0 | 15 | 8 of 8 | 11 | 30; 29 | 610 | 329,917 | yes | pass |
| `heldout/4` | favorable | 0, 0, 0 | 13 | 8 of 8 | 9 | 21; 21 | 561 | 393,023 | yes | pass |
| `heldout/4` | random walk | 7, 0, 0 | 0 | 2 of 8 | 0 | 8; 7 | 2,435 | 0 | no | fail: 7 of 8 beings |
| `heldout/5` | default laws | 0, 0, 0 | 13 | 8 of 8 | 9 | 30; 29 | 614 | 352,685 | yes | pass |
| `heldout/5` | adverse | 0, 0, 0 | 13 | 8 of 8 | 10 | 30; 29 | 590 | 304,063 | yes | pass |
| `heldout/5` | favorable | 0, 0, 0 | 12 | 8 of 8 | 8 | 21; 21 | 630 | 365,892 | yes | pass |
| `heldout/5` | random walk | 6, 0, 0 | 0 | 4 of 8 | 0 | 8; 8 | 2,481 | 0 | no | fail: 7 of 8 beings |
| `heldout/6` | default laws | 0, 0, 0 | 12 | 8 of 8 | 10 | 30; 30 | 563 | 365,407 | yes | pass |
| `heldout/6` | adverse | 0, 0, 0 | 13 | 8 of 8 | 10 | 30; 30 | 615 | 335,492 | yes | pass |
| `heldout/6` | favorable | 0, 0, 0 | 10 | 8 of 8 | 9 | 30; 30 | 574 | 399,842 | yes | pass |
| `heldout/6` | random walk | 7, 0, 0 | 0 | 3 of 8 | 0 | 8; 7 | 2,479 | 0 | no | fail: 8 of 8 beings |

Under the default laws and both variants, every item holds for every being of `heldout/2` to
`/6`, and on `heldout/1` for every being but one: being 3 misses the same item under all three
laws, the preregistered failure above, and nothing else. Its run under the default laws is the run
of CI, item by item. No being was incapacitated or reached rest 0, and no intention was rejected,
in any of these 18 runs, so the margin the preregistration asks of the variants holds wherever the
default laws hold. The random walk, which eats only when hungry on a cell that cues food and sleeps
only once rest falls to 300,000, starves on every label: 4 to 8 of its 8 beings are incapacitated,
and 6 to 8 miss some item. An acceptance of "pass" also needs some cell emptied, regrown to half,
and eaten again, which every passing run above shows.

The stationary control, a negative control of the preregistration, ran on every held-out label
too, at its own settings ([Negative controls](#negative-controls)) and for the 6,007 ticks of H:
`bun packages/agents/bench/soak.ts stationary`, 9.7 s. Every being was incapacitated within ten
days, so by H, on every label:

| Label | Incapacitated | Day of the last incapacity | Within ten days | By H |
|---|---|---|---|---|
| `heldout/1` | 8 of 8 | 7.1 (tick 898) | yes | yes |
| `heldout/2` | 8 of 8 | 3.3 (tick 420) | yes | yes |
| `heldout/3` | 8 of 8 | 7.3 (tick 922) | yes | yes |
| `heldout/4` | 8 of 8 | 7.2 (tick 910) | yes | yes |
| `heldout/5` | 8 of 8 | 7.3 (tick 916) | yes | yes |
| `heldout/6` | 8 of 8 | 7.5 (tick 943) | yes | yes |

### Negative controls

Each control shows the survival test failing when it should (plan §9.4), with the default laws.
The first three are tests of `packages/agents/test/survival.test.ts`, and the soak also runs the
stationary one on every held-out label ([The soak](#the-soak)). The barren control was a test there
too until T4-8 moved it to the soak, `bun packages/agents/bench/soak.ts barren`, to keep `bun test`
in CI within its budget ([Measured cost](#measured-cost-indicative)); the soak runs it by default,
reports its verdict, and fails when it does, and `soak-bench.test.ts` checks that verdict on
every way the control can fail:

| Control | Where | Result |
|---|---|---|
| A brain that never eats | Two beings on the engine's test terrain, idle, rested, with nutrition 0 and 40,000 | Incapacitated at ticks 9,451 and 9,955, exactly the ticks the laws give: nutrition reaches 0 after ⌈40,000·189/1,250⌉ s, and health falls from full to 0 in ⌈10^6·567/5,000⌉ = 113,400 s |
| A stationary brain, which sleeps once tired and eats only what its own cell cues | The scenario of each calibration label, of the default label, and of `heldout/1`, at 600 s per tick, so that H takes 6,007 ticks and ten days 1,260 | Every being incapacitated within ten days, so by H, on all six labels: the last at 7.5 days on the calibration labels, at 7.1 days (tick 896) on the default label, and at 7.1 days (tick 898) on `heldout/1` |
| A brain that never sleeps: `utility@1` with every sleep turned into an hour idle | The scenario of `calibration/1` | Every being reaches rest 0, by tick 9,073, the bound from the slowest fall of rest awake |
| A nearly barren world: deposit 0 at peak 1 and threshold 999, in the soak since T4-8 | The terrain of `calibration/1`, its spawn area chosen by the same rule, two of its beings under `utility@1` | Incapacitated at ticks 19,208 and 18,936, before the bounds the laws give them, 31,599 and 32,552, from at least 39 units of nutrition and 105 of health lost per tick; no bite taken; the set of the food cues their brain sensed is exactly {0}, so it recorded cues and none was 1 or 2 |

The stationary control runs at 600 s per tick because the laws do not depend on the tick
(ADR 0023), and with a senses radius of 1, because a brain that looks only at its own cell needs
no wider window and the radius changes no law of the body or of food. The barren control keeps
two of the eight beings because, with nothing in sight, every decision searches, and eight would
cost about 10 s.

### What the tests check (evaluation)

`packages/agents/test`: `survival.test.ts`, `beings-determinism.test.ts`, `scarcity.test.ts`, and
the tests of their support, `metrics.test.ts`, `child.test.ts`, `survival-child.test.ts`,
`brains.test.ts`, and `soak-bench.test.ts`:

- **survival** (plan §9.2, test 1): the default label and `heldout/1`, each in a child process
  (`support/survival-child.ts`) started before the file's first test, so that both run beside the
  negative controls; every acceptance item for every being on the default label, and health that
  never falls, read at every event and at the last tick: health falls only while nutrition is 0,
  and a being that starved keeps its loss until it eats again, so a fall shows at an event or at
  the end. On `heldout/1`, the preregistered failure, pinned as evaluated, and health that never
  fell there either;
- **the mid-run resume** (test 8): the default run keeps its snapshot after tick 31,500 and the
  records of the next 1,500 ticks; the determinism suite's resume child decodes it in a fresh
  process, under audit, and gives the same 1,500 records and the same final snapshot;
- **the determinism suite** (tests 7 and 9) on five beings around a small patch of food, in the
  patch world (`support/patch-world.ts`): the engine's test genesis, whose day lasts 100 ticks, with
  deposit 0 reshaped into one patch of 17 cells and 353 units. They are spawned at tick 1, in the
  dark, with needs near the levels where the brain changes its mind: two hungry beings on one cell
  with food for one bite, one hungry being north of a chunk edge, one starving and tired, and one
  sated. Over 120 ticks every check passes, with cuts at 0, 1, the first contest (tick 7), the
  first chunk crossing (33), the first sleep that ends (51), and 119, child processes at 0, 60,
  and 119, and an interleaving whose three worlds share one ruleset object, and so one brain. A run
  before the suite finds those three ticks, which the test pins. The patch world builds its world
  with the seed it is given, and under audit when asked, which finds a system that writes behind
  the barrier at the tick it does;
- **observer independence** (test 10): two observers that, before every tick, read every being,
  its needs and health in closed form (`bodyAt`), the senses of one being (`senseWindow`), the
  terrain of its chunk, and the light leave every record and the final snapshot equal to the
  suite's reference run, which had none. Two coupled hosts, which turn the chunks their observers'
  windows covered into a command that materializes them, or that also lists them in the occupancy
  index, change the records at tick 2, the first tick after the observers see beings;
- **scarcity** (test 2): six beings in the dark around the patch. The four hungry and rested ones
  forage it, the hungry and tired one sleeps, since sleep in the dark outweighs food that only cues
  some, and the sated one rests; the patch runs out, and a being still hungry explores. At every
  tick each cell of the patch loses exactly what the beings on it ate, read from the state, with
  regrowth counted at the same tick;
- **the support**: each being's body at the last tick, in closed form, which shows health that
  fell after the being's last event; the step hook of the runner; child processes that exit with
  an error, write something that is not JSON, or hang, each reported, the last killed and reaped;
  the survival child, which refuses the reserve, every label outside the preregistration, and every
  brain or variant it does not know, and runs, with the adverse variant and the random-walk
  baseline, and as the stationary control, exactly as the same scenario in the test process, with
  the tick of each incapacity; a child that returns JSON of another shape, reported with what it
  wrote, and every child error named by its script and its label; the control brains, by their
  rules and against the engine's judge; and the soak's arguments, which refuse the reserve in any
  spelling and any label number or option that no named run would use, its summaries, which pass
  a run only when some cell also regrew and was eaten again, its runs, which report a child that
  fails and still run and report its siblings, and the verdict
  of the barren control, which fails a being not incapacitated or incapacitated after its bound, a
  bite, and any set of sensed cues but exactly {0}, an empty one included.

When these tests were written, each of 28 deliberate defects, planted one at a time in a copy of
the repository, made them fail: in the determinism suite, the second seed's world named as the
interleaving's and the repeat named as the reference; in the runner, no body at the last tick, the
stored body instead of the one in closed form, and no step hook; in the child processes, no kill at
the time limit and an exit code ignored; in the survival child, no check of the label, the variant
ignored, and the records kept from the snapshot's own tick; in the brains, a stationary brain that
eats without a cue or sleeps only below 300,000, a sleepless brain that sleeps, and a random walk
through walls; each control's brain or world made sound again (the never-eating, stationary, and
sleepless brains replaced by `utility@1`, the barren world given back its food, and the tick
length of a control ignored); the item of the birth window dropped from the acceptance; a brain
that keeps state in its module and changes its idles after 400 decisions in a process, which only
the mid-run resume finds in the survival file, and after 20, which the determinism suite finds;
a coupled host that sends nothing; no chunk crossing found for the cuts; depletion that records
one unit less of each take; a night sleep that needs 70% of rest lost; and, in the soak, the
reserve accepted when spelled out and the largest count of meal cells taken for the smallest. The
last one first passed, because every being of the summary's test had the same counts; the test now
gives them different ones. Each of 15 more, after an independent verifier's review, makes them fail
too: the barren control's brain that records the cues not wired, so that the set of cues stays
empty; the patch world ignoring its audit flag or its seed; a survival output of null read without
a check; the survival child not checking the brain, the variant, or a variant with the stationary
control, ignoring the stationary settings, or not recording incapacities; a summary that passes
without regrowth, or a stationary summary that ignores a being never incapacitated; a soak whose
one failing child rejects its batch; child errors without the child's name; health on `heldout/1`
read as lower than full; and the first crossing a tick late.

With the needs frozen in the engine, nutrition and rest never changing, all eight beings of
`calibration/1` miss six items (meal cells, outside the birth window, big meals, sleeps, rested
wakes, and walked), no cell regrows and is eaten again, and the survival test of the default label
fails: the acceptance items are the non-vacuity metrics of plan §9.4.

Measured on the Codespace, whose two CPUs are two threads of one core (Bun 1.4.4, 2026-10-27;
indicative): `bun test` went from 61.3 s for 2,149 tests to about 97 s for 2,218.
`survival.test.ts` takes about 21 to 23 s: its two ten-day runs take 6.4 s each alone, and there
they share the one core with the controls (about 8 s alone) and the resume (1.4 s).
`beings-determinism.test.ts` takes 4 s, and the other new files about 4 s together. CI ran
`bun test` in 51.9 s on `main` before T4-7 and in 65.6 s with it, before the stationary control
reached the default label and `heldout/1`; its runner has four CPUs, so the two ten-day runs and
the controls run there side by side.

## Measured cost (indicative)

Two things measure what beings cost (plan §7): the complexity test, which `bun test` runs, and
the scale benchmark, which is run by hand. The numbers are indicative: runs on the Codespace, whose
two CPUs are two threads of one core, with Bun 1.4.4, on 2026-10-27. Compare runs on one machine,
before and after a change; never compare across machines.

### The complexity test

`packages/engine/test/beings-cost.test.ts`, with the worlds and the counting context of
`packages/engine/test/support/beings-cost.ts` (plan §9.2, test 14):

- **Timed.** Ten beings sleep, each in its own chunk, in worlds of 1,000 and 200,000 empty chunks
  of the test terrain with the default day, so that every timed tick is quiet: it reads the `due`
  of ten chunks and writes nothing. The median tick of 200,000 chunks must cost less than 2 times
  one of 1,000, measured as `step-cost.test.ts` measures the kernel, whose alternating measurement
  both now share (`support/cost-worlds.ts`). A quiet tick costs about 40 µs; the ratio was 0.99 to
  1.02, and 4.9 to 5.2 with a planted `chunkKeys()` per tick, a copy of 200,000 keys. Building the
  world of 200,000 chunks takes about 3 s of the file's 4 s.
- **Counted.** A context that records the calls of the beings system (`counting`) runs ten beings
  that walk up to six steps, eat, and idle a minute, so that they decide every few ticks, cross
  chunks, and fail meals on cells without food, for 250 ticks of the test genesis, whose day lasts
  100 ticks, among 4,096 empty chunks that their windows cover. At every tick: no call of
  `chunkKeys`; the global value written at most once, and only when a chunk entered the occupancy
  index or the day turned; at most one read of each listed chunk, of each chunk a decision sensed,
  five more per being processed, and on a day turn the prune's reads; and no read of a chunk that
  is neither listed, sensed, nor holding a being after the tick. A planted `chunkKeys()` per tick
  fails this count (plan §9.4); so do one read past the bound, a needless write of the global
  value, and a read of a chunk that nothing explains.
- **Many wakes in one tick.** Beings idle, each alone in its chunk, at 1,200 s per tick, the test
  genesis' whole day, so the daily processing takes every one of them at every tick, without a
  decision. The median tick of 1,200 such beings must cost less than 1.6 times per being one of 50,
  timed in the same way. With the fix of `applyWorks` ([Ceilings](#ceilings)) the ratio was 0.99
  and 1.12; before it, 2.26 and 2.41. The work it did per pair of wakes, about 0.1 µs, is small
  beside the 85 µs or so a wake costs here, so it shows only beside a world 24 times larger. The
  test costs about 1.5 s, and its reach is that of its bound: it catches extra work of about 60 ns
  or more per pair of wakes, such as a placement computed per pair, and lets cheaper work pass.
  Planted in a copy, a linear search of the occupancy index or of the leaving ids, about 1 ns a
  pair, gave ratios of 0.89 to 0.93, and a scan of every placed being for each touched chunk,
  which made the tick of 1,200 beings 58 to 77% slower and one of 8,000 3.2 times slower when timed
  directly, side by side in the same world, gave 0.99 and 1.13. Such scans are left to
  review and to the benchmark's rows of many wakes; a test that caught them would cost several
  times more.
- The fuzz's count of a quiet tick (`beings-fuzz.test.ts`) uses the same counting context.

When these tests were written, each of 7 deliberate defects, planted one at a time in a copy of
the repository, made them fail: a `chunkKeys()` per tick in the system and a read of every chunk
per tick, which the timed and the counted test both find; and, which only the count finds, a read
of a fixed block of 4,096 chunks per tick without `chunkKeys`, every listed chunk read again for
each processed being, the prune run on every tick that adds a chunk to the index, the global value
written on every tick, and senses that read one ring of chunks beyond their window. The quiet tick
of `beings-fuzz.test.ts` let the last three pass. The system before the fix of `applyWorks`,
planted in a copy, fails the test of many wakes, at 2.64 and 3.10 in two runs. Of 7 deliberate
defects in the fix and its helpers, 6 make the tests fail: a binary search that turns the wrong
way, an index that never holds a key, a merge that drops the keys left to add or repeats one, the
leaving beings found nowhere, and the beings placed by id but not by chunk. The seventh, dropping
the check that both walks reached their ends, is equivalent: no tick reaches it.

### The scale benchmark

`bun packages/agents/bench/beings.ts [micro dispersed concentrated sleeping explored] [--large]
[--ticks N]`, with the worlds of `packages/agents/bench/scale.ts`, runs beings under `utility@1`
and the frozen default laws, audit off, 12 s per tick. Its terrain is the default genesis of the
public label `open-origin/t4/bench`, seeded as the preregistration seeds its labels; it is no label
of the preregistration, so measuring on it burns nothing. Beings are placed by rule around the
center chunk of that label's spawn area, (22, −22), which the preregistration's rule finds: one
being on the dry cell with the most food of every other chunk (dispersed); on the dry cells of the
first block of one or 3 × 3 chunks with half its cells dry (concentrated); and on the middle cell
of every chunk where that cell is dry (sleeping). Needs and traits are drawn as the
preregistration draws them, from the label's spawn seed. Every scenario runs the spawn at tick 1,
the first decisions at tick 2, and 100 more ticks before it times any, and the scenarios run one
at a time in one process. The default run stays small: at `nice -n 19` it took 5.9 minutes, with a
peak resident memory of 139 MB, which the benchmark prints. `--large` adds 10,000 dispersed
beings, 10,000 and 100,000 sleeping ones, ticks of 8,000 and 16,000 wakes, and 200,000 empty
chunks; each starts only while /proc/meminfo reports 1.5 GB of memory available, and not where it
cannot be read. The benchmark refuses `--large` and `--ticks` when no named group would use them.
Its dispersed group took about 10 minutes with `--ticks 1000`, and its sleeping group 4.5 minutes.

Except where they say otherwise, the tables come from one run at normal priority, before the fix
of `applyWorks` ([Ceilings](#ceilings)), which leaves every result the same and changes only the
time of ticks with many wakes. The same
scenarios, in the default run of the final benchmark at `nice -n 19` on a machine with a load
average near 2, were mostly slower, by up to 30%: the median tick of 1,000 dispersed beings took
36.6 ms, its p99 100.3 ms, and one decision 3.27 ms.

The senses at each radius, on the cells of 64 dispersed beings, and the searches over their
windows: Dijkstra from the center, and A* to the cell min(16, R) away along each direction in turn:

| Radius | Window cells | Senses | Dijkstra | Dijkstra nodes, median (max) | A* | A* nodes of found routes, median (max) | A* routes found |
|---|---|---|---|---|---|---|---|
| 8 | 289 | 294 µs | 56 µs | 289 (289) | 16 µs | 12 (65) | 61 of 64 |
| 16 | 1,089 | 1,032 µs | 224 µs | 1,089 (1,089) | 61 µs | 47 (196) | 59 of 64 |
| 24 | 2,401 | 3,325 µs | 653 µs | 2,401 (2,401) | 156 µs | 47 (196) | 59 of 64 |
| 32 | 4,225 | 3,981 µs | 947 µs | 4,225 (4,225) | 163 µs | 47 (196) | 59 of 64 |

Each scenario, timed over one simulated day (dispersed) or 500 ticks across dawn
(concentrated). A wake is a being processed; µs per wake is the time of the ticks with a wake less
the median tick without one, divided by their wakes. Snapshot bytes per being are the growth of the
snapshot from tick 0, and memory per being the growth of the live heap from tick 0 to the first
decisions, in parentheses below 1,000 beings, where fixed costs swamp it:

| Scenario | Median tick | p99 | Slowest tick, its decisions | µs per wake | Decisions per being and day | Events per being and day | KB hashed per tick, median / p99 | Snapshot B per being | Memory B per being | Being B, median (range) | First decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dispersed 10 | 0.042 ms | 5.9 ms | 20 ms, 1 | 773 | 28.5 | 63.2 | 0.4 / 2.5 | 916 | (71,859) | 521 (480–589) | 52 ms |
| dispersed 100 | 1.2 ms | 15.0 ms | 149 ms, 42 | 523 | 38.2 | 80.6 | 4.7 / 13.1 | 840 | (3,217) | 521 (468–667) | 313 ms |
| dispersed 1,000 | 32.5 ms | 80.8 ms | 1,514 ms, 481 | 531 | 40.9 | 84.7 | 57.4 / 112.4 | 816 | 2,112 | 523 (467–773) | 3.0 s |
| concentrated 10, 1 chunk | 0.029 ms | 2.8 ms | 4.5 ms, 1 | 664 | 7.6 | 25.2 | 0.3 / 5.5 | 500 | (4,569) | 484 (449–655) | 44 ms |
| concentrated 100, 1 chunk | 2.5 ms | 10.7 ms | 69 ms, 21 | 1,151 | 10.1 | 31.8 | 39.4 / 50.4 | 508 | (3,549) | 485 (449–751) | 298 ms |
| concentrated 1,000, 1 chunk | 37.4 ms | 86.9 ms | 1,022 ms, 243 | 1,600 | 11.3 | 36.7 | 456.2 / 522.6 | 504 | 1,426 | 486 (449–787) | 2.6 s |
| concentrated 10, 3 × 3 | 0.020 ms | 2.3 ms | 3.1 ms, 1 | 447 | 7.6 | 20.2 | 0.3 / 2.2 | 549 | (2,332) | 483 (449–657) | 31 ms |
| concentrated 100, 3 × 3 | 0.64 ms | 7.0 ms | 63 ms, 21 | 783 | 10.1 | 29.5 | 8.2 / 35.6 | 497 | (1,620) | 484 (449–659) | 253 ms |
| concentrated 1,000, 3 × 3 | 26.3 ms | 77.5 ms | 742 ms, 241 | 1,473 | 11.4 | 32.7 | 307.7 / 498.9 | 499 | 1,386 | 484 (449–751) | 2.8 s |

One decision, end to end: the median tick whose one wake decided, less the median tick whose one
wake did not, in the dispersed runs; and `utility@1` alone, timed around each decision:

| Scenario | Decisions timed | `utility@1` median / mean / p99 | Ticks whose one wake decided: count, median | Ticks whose one wake did not: count, median | One decision, end to end |
|---|---|---|---|---|---|
| dispersed 10 | 285 | 719 / 812 / 4,245 µs | 191, 4.13 ms | 1,693, 0.23 ms | 3.90 ms |
| dispersed 100 | 3,822 | 673 / 797 / 3,367 µs | 51, 3.16 ms | 315, 0.20 ms | 2.96 ms |
| dispersed 1,000 | 40,885 | 659 / 753 / 3,318 µs | 20, 3.29 ms | 49, 0.26 ms | 3.03 ms |

Ten active beings beside sleeping ones, which sleep through the timed ticks, each in its own chunk,
spawned 1,000 a tick; the worlds step tick by tick in turn, and the marginal cost of a sleeping
being is the median of the difference of their ticks, divided by the sleeping beings. Then each
world spawns a being in a chunk no being held, a tick that rewrites the occupancy index. The
default run (at `nice -n 19`) steps two worlds in turn, and the `--large` run three:

| Run | Sleeping beings | Median tick | p99 | Marginal per sleeping being and tick | A tick that adds a chunk to the index | KB it hashed | Chunks in the index |
|---|---|---|---|---|---|---|---|
| default | 0 | 0.030 ms | 3.2 ms | - | 1.2 ms | 3.7 | 15 |
| default | 1,000 | 0.114 ms | 3.3 ms | 75 ns | 2.6 ms | 12.9 | 1,011 |
| `--large` | 10,000 | 4.1 ms | 10.1 ms | 393 ns | 34.6 ms | 89.7 | 10,012 |
| `--large` | 100,000 | 47.6 ms | 89.0 ms | 473 ns | 256.8 ms | 978.8 | 100,012 |

Ticks that process many beings at once: N sleeping beings spawned in one tick, each in its own
chunk, are processed together at the next tick, where each decides to sleep with a window of
radius 1. Before the fix of `applyWorks` (`--large`, once, at normal priority) and after it (the
default run for 1,000 to 4,000, and the same scenario once for 8,000 and 16,000, at `nice -n 19`).
The fix does not touch the spawn, whose differences are the machine's:

| Beings | Spawn tick, before / after | Per spawn, before / after | Their first processing, before / after | Per being, before / after |
|---|---|---|---|---|
| 1,000 | 165 / 183 ms | 165 / 183 µs | 347 / 146 ms | 347 / 146 µs |
| 2,000 | 336 / 455 ms | 168 / 227 µs | 1.3 s / 391 ms | 627 / 195 µs |
| 4,000 | 825 ms / 1.1 s | 206 / 274 µs | 3.7 s / 725 ms | 933 / 181 µs |
| 8,000 | 1.7 / 2.1 s | 210 / 261 µs | 13.9 / 1.4 s | 1,734 / 176 µs |
| 16,000 | 3.6 / 4.1 s | 222 / 255 µs | 52.3 / 2.6 s | 3,269 / 163 µs |

Ten active beings, the dispersed ten, in worlds of empty chunks around them, stepped in turn: with
none, 1,000, and 200,000 chunks, as `--large` steps them, the medians were 0.033 ms in all three
(ratios 1.00, 0.99, and 1.00) and the p99 3.9 to 4.1 ms; in the default run, with none and 1,000,
0.025 and 0.023 ms. With `--large`, 10,000 dispersed beings timed for 1,000 ticks of the morning
took a median of 124 ms and a p99 of 275 ms; their slowest tick, 8.2 s, held 2,492 decisions;
their first decisions took 42.7 s; they wrote 239 KB a tick at the median and 388 KB at p99; and a
being took 609 B of snapshot and 1,594 B of memory.

The targets of plan §7, in the four runs of the default scenarios, three at normal priority and one
at `nice -n 19` on a loaded machine:

| Target | Bound | Measured | Status |
|---|---|---|---|
| 10 beings, median | ≤ 1 ms | 0.042 to 0.047 ms | met in all four |
| 1,000 dispersed | median ≤ 50 ms, p99 ≤ 100 ms | median 32.5 to 36.6 ms; p99 80.8, 82.6, and 85.6 ms, and 100.3 ms at `nice -n 19` | met in three; missed by 0.3 ms in the fourth |
| One decision, R = 24, default genesis | ≤ 3 ms | 2.96, 2.99, 3.01, and 3.27 ms end to end | met in two; missed in two, by 0.01 and 0.27 ms |
| A sleeping dispersed being, marginal | ≤ 1 µs per tick | 0.075 µs beside 1,000; 0.12 to 0.13 µs beside 10,000 in the three others; 0.39 µs beside 10,000 and 0.47 µs beside 100,000 with `--large` | met in all |
| Snapshot per being | ≤ 1 KB | 497 to 916 B | met in all |

What they show:

- **Two targets sit at their bounds, and were missed in some runs.** A decision at R = 24 costs
  about 3 ms end to end, 2.96 to 3.27 ms in four runs, missing the bound in two, and more when few
  beings run (3.9 to 4.4 ms with ten); the p99 tick of 1,000 dispersed beings was 81 to 100.3 ms
  against a bound of 100, missing it in one. The senses take most of a
  decision: 2.1 to 3.3 ms at R = 24 in seven runs, against about 0.7 ms for `utility@1` (median).
  A CPU profile (`bun --cpu-prof-md`) of 1,500 ticks of 300 dispersed beings put about two fifths
  of its samples in the edges of the windows (`stepDuration` and its callers, over 19,208 entries a
  window) and under a tenth in the terrain's noise: terrain reads are not what limits decisions,
  ADR 0023's condition for a cache of terrain across ticks; the edges are, and they are the lead
  for any later work on the cost of a decision.
- **Sleeping beings and explored chunks cost what the model says.** A sleeping being costs 0.08 to
  0.13 µs a tick beside 1,000 or 10,000 others, and 0.39 to 0.47 µs in the `--large` run, which
  holds 100,000 more; 200,000 explored chunks cost nothing.
- **The first days are a transient.** Over their first day, dispersed beings decided 28 to 41
  times and emitted 63 to 85 events. A separate run of the 100 dispersed beings over four days,
  with the benchmark's own runner, gave 38.2, 24.6, 12.6, and 11.1 decisions per being on days 1
  to 4, and 80.6, 58.5, 34.0, and 30.9 events: it settles at the 11 to 12 decisions of the
  preregistered scenario, and at about 31 events, fewer than ADR 0023's estimate of 50.
- **A being's record is about 500 B**, 449 to 802 B, and costs 497 to 916 B of snapshot: about 500
  when beings share chunks, more alone, with its chunk's key, `due`, and depletion, and its entry
  in the occupancy index. In memory, about 1.4 to 2.1 KB each with 1,000 beings or more.

### Ceilings

What the benchmark found beyond the targets, from the tables above:

1. **Ticks that process many beings at once cost more per being the more there are: found and
   fixed in T4-8.** Before the fix, the tick after a spawn of N beings cost 347 µs per being at
   1,000 and 3,269 µs at 16,000, 52 s in all: the time per being grew with N. `applyWorks`
   (`src/beings/resolve.ts`) looked, for each chunk the tick wrote, for the beings arriving there
   among every processed being, computing each one's chunk again (`env.place`), and searched the
   processed ids linearly for every being of the chunk; `updateOccupancy` searched the whole index
   for each chunk that received a being. That work was the product of the beings processed and
   the chunks written, which broke the rule that work per tick never grows with pairs of
   inhabitants (`AGENTS.md`, "Cost per tick"). Now the records are placed once, sorted by chunk
   key and id, and read in step with the chunks, as the takes are; the leaving ids and the index
   are searched by binary search; and the chunks the index lacks are merged into it in one pass.
   The same tick costs 146 µs per being at 1,000 and 163 µs at 16,000, 2.6 s in all. A
   differential gives the same checksum, state root and events, at every tick before and after the
   fix: on the three seeds of the fuzz, on `calibration/1` for 3,000 ticks, on a mass wake of 2,010
   beings, and on 100 and 1,000 dispersed beings, whose runs added two or more chunks to the index
   in one tick 14 and 34 times. Ticks with many wakes are common: a spawn's next tick, and dusk
   and dawn, when the light condition of every plan holds at once. Of 100 dispersed beings, 42
   decided at the tick the light fell to 100 (dusk, tick 3,231) and 21 at the one it rose to 200
   (dawn, tick 400), and the rests of 2 hours that dawn started kept 7 to 15 of them deciding
   together every 600 ticks after it. The slowest tick of 1,000 dispersed beings held 481
   decisions and took 1.5 s, and that of 10,000, 2,492 decisions and 8.2 s, both before the fix: at
   about 3 ms a decision, such ticks overrun the 200 ms of a tick at 5 Hz even without the defect.
2. **A crowded chunk is rehashed whole** whenever one of its beings changes: 1,000 beings in one
   chunk wrote 456 KB at the median tick and 523 KB at p99, and the median tick took 35 to 45 ms in
   four runs; in 3 × 3 chunks, 308 KB and 24 to 30 ms. ADR 0023 estimated 18 ms for 450 KB from
   the commit alone.
3. **The occupancy index is rewritten whole** with the global value when a chunk enters it and at
   the daily prune: 0.7 ms with 16 chunks listed, 10 to 35 ms with 10,012, and 257 ms with 100,012,
   about 1 to 3.5 µs per listed chunk. From about 10,000 occupied chunks a tick that adds one costs
   a twentieth of a tick or more, and from 100,000 more than a whole tick.
4. **A spawn costs about 0.2 ms**: 1,000 spawns in one tick take 0.17 to 0.33 s, measured before
   `applySpawn` searched the occupancy index with `isOccupied`; it had searched it linearly, a cost
   over pairs of spawns and listed chunks, and the binary search removed the search's share of it
   in T4-8. Inserting the chunk still splices the index, moving every key after it, and each spawn
   still prepares the genesis again to check its cell (`spawnBlocked`).

**When the entity section becomes necessary.** The commit turns changed chunks into canonical
text, validates, and hashes them at about 25 MB/s per core ([determinism](determinism.md)), about
5 MB a tick at 5 Hz. A tick of beings writes whole chunks, so the entity section of ADR 0023, with
one hash term per entity in snapshot version 2 (T7), is needed when the bytes a tick writes
approach that. As a trigger: when the benchmark's p99 of KB hashed per tick passes 1 MB, about a
fifth of a tick, in a scenario the universe must support. Today the highest is 523 KB, 1,000 beings
in one chunk. In proportion, at today's 500 B per being the trigger falls at about 2,000 beings in
one chunk; T5's mind data reaches it sooner, once a being's record passes about 1 KB among 1,000
crowded beings, or about 1.3 KB among 10,000 dispersed ones (388 KB at p99 today). The occupancy
index is another ceiling, which the entity section does not lift: past about 10,000 occupied
chunks it needs a structure whose writes do not grow with the chunks it lists. The cost of many
wakes in one tick was a defect of `applyWorks`, fixed in T4-8, not a ceiling of the snapshot.

### CI time

The plan's budget for `bun test` in CI is 70 s (§9.3); CI took 50.5 to 65.6 s before T4-8. On the
Codespace the new files take about 6.1 s: `beings-cost.test.ts` 5.8 s, of which about 3.3 s builds
the world of 200,000 chunks and about 1.5 s times many wakes, and `beings-bench.test.ts` 0.3 s.
Since CI already came close to the budget, T4-8 moved the barren control, about 4 s, out of
`survival.test.ts` to the soak ([Negative controls](#negative-controls)). CI's runner runs that
file's controls beside its two child processes, and the controls, 8 s alone in T4-7's measurement
against 6.4 s for each child, were the longest of the three. On the Codespace, `bun test` took
95.4 s for 2,218 tests before T4-8, and 92.7 s for 2,257 with it before the test of many wakes;
`survival.test.ts` took 21.3 s before and 18.1 s after. CI's runners split at about 50 s and about
65 s for the same code; with T4-8, CI ran `bun test` in 67.07 s on the slower kind, 3 s under the
budget, which leaves no room for more CI time.
