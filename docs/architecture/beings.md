# Beings

The beings of T4: a body whose laws the engine applies, and a brain that only proposes
([0023](../decisions/0023-autonomous-beings.md)). This page is the specification each T4 pull request
implements; sections marked *planned* describe what a later pull request of T4 delivers, and become
plain specification when it merges.

- Body, senses, authority: `packages/engine/src/beings` (*planned*, T4-2 to T4-5).
- Brain and navigation: `packages/agents` (*planned*, T4-4 and T4-6).
- Decisions: [0023](../decisions/0023-autonomous-beings.md), which refines
  [0020](../decisions/0020-deterministic-core-design.md) and
  [0021](../decisions/0021-procedural-world.md).

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

`src/beings` imports only `src/worldgen/index.ts`, `int`, `errors`, `canonical/copy`, `digest/*`,
`world/chunk`, `world/members`, `time/tick`, and `world/contracts` (types). The kernel and worldgen
never import it. `packages/agents` imports only `@open-origin/engine`.

## State

### Global value

| Member | Content |
|---|---|
| `genesis`, `genesisSeal` | The sealed genesis of T3, unchanged |
| `life` | `{ version: "life@1", deathEnabled, species }`, written once |
| `lifeSeal` | `digest(["life", LIFE_VERSION, life])` |
| `occupancy` | Sorted, unique chunk keys that may hold beings |
| `prunedDay` | The last simulated day whose empty chunks were pruned from `occupancy` |

`validateGlobal` checks the genesis seal, the life seal with the schema and bounds of every law,
that each species eats a deposit the genesis has and has a brain, and that `occupancy` is sorted,
unique, and made of chunk keys inside the world.

### A species

| Law | Meaning |
|---|---|
| `needs.nutrition`, `needs.rest` | Decay per simulated second while awake, walking, and asleep, as ratios |
| `diet` | The deposit eaten, nutrition per unit, units per bite, milliseconds per bite, and the two thresholds of the food cue |
| `locomotion` | Milliseconds per flat orthogonal step, the largest rise a step may climb, the deepest liquid it may wade, and the penalties of rise and depth |
| `sleep` | Rest recovered per simulated second |
| `health` | Loss per second while nutrition is 0; recovery per second while nutrition and rest are above `recoverAbove` |
| `regrowth` | Food units per second that an eaten cell recovers |
| `senses` | The radius R of the window, at most 32 |
| `traits` | The bounds of each trait, in permille |

Every law has bounds that keep every intermediate value a safe integer; each ratio has
`num·den ≤ 2^53`.

### A materialized chunk

`{ beings, depletion, due }`:

- `beings`: ordered by id; each one's cell lies in this chunk.
- `depletion`: `{ cell, taken, since }` per eaten cell, ordered by cell index `y·32 + x`, with
  `taken` in (0, 2^20], the bound of a deposit's peak. That `taken` never exceeds the cell's deposit
  is checked by the invariant tests, because `validateChunk` cannot see the genesis.
- `due`: the minimum `wake` of its beings, or the largest safe integer when it has none.

Effective food in a cell is `max(0, base − max(0, taken − regrowth since since))`, in closed form.
An entry that regrew completely is dropped when its chunk is written for another reason.

### A being

| Field | Class | Content |
|---|---|---|
| `id`, `species`, `stage`, `born` | C0 | Identity; T4 has the single stage `adult` |
| `cell` | C0 | Absolute cell |
| `activity` | C0 | `idle`, `walk` (directions, arrival offsets, index), `eat`, or `sleep` |
| `needs`, `health`, `anchor` | C1 | Values in 0 to 1,000,000 at the tick `anchor` |
| `traits` | C1 | `appetite`, `sleepiness`, `curiosity`, in permille |
| `condition` | C1 | `ok` or `incapacitated` |
| `plan` | C1 | Up to three pending steps |
| `behavior` | C1 | What the brain stored: its behavior, since when, and its heading |
| `wakeWhen` | C1 | Need and light thresholds the brain asked to be woken at |
| `wake` | C1 | The next tick at which the being is processed |
| `outcome`, `cooldowns` | C1 | The result of the last step and up to four recently failed targets |

T6 decides which C0 fields each projection carries.

## Time and needs

The engine knows only ticks; laws are rates per simulated second, and durations of steps and bites
are integer simulated milliseconds.

- **A need at tick t** is `v0 ∓ ⌊num·E/den⌋`, clamped to its range, with
  `E = simSeconds(t) − simSeconds(anchor)`. It is computed as `num·⌊E/den⌋ + ⌊num·(E mod den)/den⌋`,
  and saturates before multiplying once `E ≥ ⌈range·den/num⌉`, so every intermediate value is a safe
  integer for any `simSecondsPerTick`.
- **Re-anchoring** happens only when a rate changes, never because a being was processed.
- **Crossing a threshold θ** happens at the first tick with `E ≥ ⌈(v0 − θ)·den / num⌉`, that is
  `anchor + ⌈⌈(v0 − θ)·den / num⌉ / simSecondsPerTick⌉`. A rate of 0 never crosses. Every wake is at
  least the next tick.
- **A walk** of steps with durations `d_1 … d_n` that starts at tick `s` reaches step i at tick
  `s + ⌈S_i / (simSecondsPerTick·1000)⌉`, with `S_i = d_1 + … + d_i`. Several steps may fall in one
  tick. Bites follow the same rule.
- **`wake`** is the minimum of: the next arrival or bite, the end of the activity, nutrition and rest
  crossing 0 and `recoverAbove`, the targets of the activity, the brain's `wakeWhen` (light included),
  critical hunger, and the anchor plus the maximum reconsideration interval.
- **Physiology:** health falls while nutrition is 0 and recovers while nutrition and rest are above
  `recoverAbove`. Rest at 0 forces sleep. Health at 0 incapacitates the being, or kills it when
  `life.deathEnabled` is true (plan O-16).

## Senses

At each decision the engine builds a square window of side `2R + 1` centered on the being:

| Member | Content |
|---|---|
| `origin`, `side` | The window's first cell and side; cells outside the world are padded |
| `stepMs` | 8 entries per cell, in the order E, NE, N, NW, W, SW, S, SE: the duration of that step in milliseconds, or −1 when it leaves the world, wades deeper than `maxWadeDepth`, climbs more than `maxRise`, or is a diagonal whose orthogonal neighbors are not both passable |
| `foodCue` | Per cell: 0 none, 1 some, 2 plenty, from the effective food of the species' deposit and the two thresholds of its diet |
| `light` | The radiance of the instant |
| `self` | The being's own state, including `behavior`, `outcome`, and `cooldowns` |
| `draws` | Two u32 draws from the system's stream `beings.brain`, keyed by the being |

A step lasts `⌈stepMs·(1000 or 1414)/1000 · (1 + risePenalty·|Δelevation| + wadePenalty·depth)⌉`
milliseconds. Terrain is read by regions with `sampleRegion` (or a reader of selected fields that
returns exactly its values), through a memo local to one run of the system. The arrays are copied for
each decision, so one brain cannot change what another sees.

## The brain

`Controller.decide(senses) → { steps, wakeWhen, behavior }`, a pure function of its senses:

- `steps`: one to three of `walk` (at most 64 directions, digits 0–7 in the order of `stepMs`),
  `eat` (until a nutrition target), `sleep` (until a rest target), and `idle` (for some milliseconds);
- `wakeWhen`: optional thresholds `nutritionBelow`, `restBelow`, `lightBelow`, `lightAbove`;
- `behavior`: what the brain wants to find again in its next senses.

The engine copies the intention canonically, reading each member once and refusing accessors, then
validates its shape, bounds, and preconditions, and every step of a walk against the window. An
invalid intention is rejected: the being idles briefly and `outcome` records the reason. A brain
that throws poisons the world.

`utility@1` (*planned*, T4-6) scores five behaviors with integer response curves: forage, eat here,
sleep, explore, rest. It keeps hysteresis, a commitment bonus with a minimum margin to switch, and
cooldowns on failed targets. It plans with one Dijkstra over the window for food and A* with an
octile heuristic for a single target; ties break by (f, h, cell index).

## The tick

One system, `beings`, runs three phases:

1. **Collect.** Read `due` of every chunk in `occupancy`, gather the beings with `wake ≤ tick`, and
   sort them by id. A listed chunk without beings, outside a pending prune, is an inconsistency and
   fails the tick.
2. **Advance and decide**, by id: bring needs and health to the tick, apply physiology, advance the
   activity, and when the being is free or a condition holds, build its senses, ask its brain, and
   copy and validate the intention. Bites that fall due become claims on their cell.
3. **Resolve and apply.** Claimed cells in order of chunk key and cell index: when the food suffices,
   every claim is served; otherwise `random.permutation` on `beings.contest`, keyed by the lowest
   claimant id, orders them, and each takes what is left. Losers get an outcome and wake at the next
   tick, without a second decision in this phase. Then consumption, chunk crossings, `due`,
   `occupancy` with its daily prune, and events. At most one write of the global value per tick.

Commands: `beings.spawn`, from an admin, with `{ species, cell, needs?, traits? }` and no draws.
Events, one per behavior rather than per step: `being.spawned`, `started`, `finished`, `ate`,
`slept`, `woke`, `contested`, `exhausted`, `incapacitated`, `recovered`, `died`,
`intention_rejected`.

## Preregistration

Registered before any calibration (T4-1), so that neither the laws nor the brain are tuned until
the survival test passes.

### Seeds

The seeds of T4's scenarios are derived from public labels, so none is chosen by hand. For a label
`open-origin/t4/<set>/<i>`:

- the world seed is the first two words, read as big-endian u32, of SHA-256 of the UTF-8 text
  `<label>/world`;
- the terrain seed is the eight words of SHA-256 of `<label>/terrain`, read the same way;
- the spawn generator is the test generator Sfc32 seeded with the first word of SHA-256 of
  `<label>/spawn`.

| Set | Labels | Use |
|---|---|---|
| Default | `open-origin/t4/default` (no index) | The survival test in CI (plan §N.15) |
| Calibration | `open-origin/t4/calibration/1` to `/4` | Calibrating laws and brain, and nothing else |
| Held out | `open-origin/t4/heldout/1` to `/6` | Evaluation: `/1` in CI, all six in the soak |
| Reserve | `open-origin/t4/heldout/7` to `/12` | Replacement after a burn |

These are test seeds in a public repository. No world reachable by anyone else may use them: a
public world's seeds come from a CSPRNG and are C3 ([0021](../decisions/0021-procedural-world.md)).

### Scenario

- **World:** `defaultGenesis(terrainSeed)`, `simSecondsPerTick` 12 (plan §I.1.1), the default laws of
  life, 8 beings of one species that eats deposit 0, death disabled.
- **Spawn area:** candidate centers are chunks ordered by `(max(|x|, |y|), y, x)`. The area of a
  candidate is the 3×3 chunks around it (96×96 cells). An area qualifies when at least half its
  cells have `liquid.depth` 0 and the fraction of its cells with deposit 0 above 0 is at least the
  median of that fraction over the 81 areas whose center has `max(|x|, |y|) ≤ 4`. The spawn area is
  the first candidate that qualifies, searched up to `max(|x|, |y|) = 64`; a seed with none is
  reported as uninhabitable, never replaced in silence. The rule reads terrain only and never runs
  the simulation; choosing a habitable place adds no food.
- **Beings:** 8 distinct cells drawn uniformly by the spawn generator among the area's cells with
  `liquid.depth` 0; nutrition and rest drawn uniformly in [600,000, 900,000]; each trait drawn
  uniformly in [800, 1,200] permille; all in that order, being by being.

### Ecological targets

Expressed in the world's own day L (75,600 s by default): a design choice that ties the body to
the world's day law, not a fact about Earth.

| Target | Range |
|---|---|
| Without food, nutrition from full to 0 | 1.5 L to 3 L |
| Then health from full to 0 | 1 L to 2 L |
| Awake, rest from full to 0 | 1.2 L to 2 L |
| Asleep, rest from 0 to full | 0.25 L to 0.45 L |
| A full meal | empties a typical food cell (the median non-zero deposit 0 value of the calibration areas) |
| Regrowth of an emptied typical cell | 1 L to 3 L |
| Walking the 32 cells of a flat chunk | 0.01 L to 0.03 L |
| One cell alone | cannot sustain a being: its regrowth per day gives less nutrition than a day awake costs |

### Evaluation

- Laws and brain are calibrated on the calibration seeds only, then frozen together in T4-6; the
  commit that freezes them is recorded in the tracker.
- The survival test runs the default seed and `heldout/1` in CI; the soak runs `heldout/1` to `/6`
  and records every result, whatever it is.
- If a held-out seed fails, it is analyzed. Any change to laws or brain after that burns every
  held-out seed already evaluated, and the evaluation moves to the reserve.
- Margins: on the default seed health never falls; in the soak, every law scaled by ±10% still
  survives.
- Acceptance on the default seed and `heldout/1`: over 63,000 ticks (10 days), no being is
  incapacitated, dies, or reaches rest 0, and the brain has no intention rejected; every being ate
  in several distinct cells, at least one outside the window it was born in, slept at least 9 times,
  walked, and fell below and recovered from its thresholds; some cell was emptied, regrew, and was
  eaten again.
