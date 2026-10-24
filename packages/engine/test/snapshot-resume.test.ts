import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  decodeSnapshot,
  ENGINE_VERSION,
  encodeSnapshot,
  fullChecksum,
  type Issue,
  readView,
  stateRoot,
  step,
  versionDifferences,
  type World,
  worldStatus,
} from "../src/index.ts";
import { GOLDEN_TALLY } from "./fixtures/golden-tally.ts";
import {
  TALLY_VERSIONS,
  tallyCommands,
  tallyRuleset,
  tallyWorld,
} from "./fixtures/tally-ruleset.ts";
import { engineErrorOf } from "./support/engine-error.ts";

/**
 * Replay and resumption (ADR 0020, snapshots; plan §5.2 "Versiones", §8 "Ida y vuelta",
 * "Reanudación"): a decoded world keeps the versions its snapshot records, step refuses to replay
 * it under other versions, and a world resumed from a snapshot continues exactly as the world
 * that was never interrupted.
 */

/** The snapshot of a tally world at tick 3, with `header` merged into its header. */
function withHeader(header: { readonly [field: string]: string }): string {
  const world = tallyWorld([1, 2]);
  for (let tick = 1; tick <= 3; tick += 1) step(world, tallyCommands(tick));
  const snapshot = JSON.parse(encodeSnapshot(world)) as { header: object };
  snapshot.header = { ...snapshot.header, ...header };
  return canonicalize(snapshot);
}

/** What a step must leave as it was when it refuses a world. */
const observe = (world: World) => ({
  status: worldStatus(world),
  root: stateRoot(world),
  full: fullChecksum(world),
  text: encodeSnapshot(world),
  global: readView(world).readGlobal(),
});

const difference = (field: string, recorded: string, running: string, source: string): Issue => ({
  path: `/header/${field}`,
  message: `the world records ${field.replace("Version", " version")} "${recorded}", but ${source} "${running}"`,
});

const CHANGES: [string, { readonly [field: string]: string }, Issue[]][] = [
  [
    "the engine version",
    { engineVersion: "0.0.1" },
    [difference("engineVersion", "0.0.1", ENGINE_VERSION, "this engine is")],
  ],
  [
    "the ruleset version",
    { rulesetVersion: "tally@0" },
    [difference("rulesetVersion", "tally@0", TALLY_VERSIONS.ruleset, "its ruleset declares")],
  ],
  [
    "the generator version",
    { generatorVersion: "tally-grid@0" },
    [
      difference(
        "generatorVersion",
        "tally-grid@0",
        TALLY_VERSIONS.generator,
        "its ruleset declares",
      ),
    ],
  ],
  [
    "the brain version",
    { brainVersion: "none@0" },
    [difference("brainVersion", "none@0", TALLY_VERSIONS.brain, "its ruleset declares")],
  ],
];

describe("the replay gate", () => {
  test.each(CHANGES)(
    "a decoded world whose header changes %s loads, keeps it, and does not step",
    (_name, header, issues) => {
      const text = withHeader(header);
      const world = decodeSnapshot(text, tallyRuleset());
      expect(encodeSnapshot(world)).toBe(text);
      expect(versionDifferences(world)).toEqual(issues);
      const before = observe(world);
      const error = engineErrorOf(() => step(world, tallyCommands(4)));
      expect({ code: error.code, issues: error.issues }).toEqual({
        code: "version_mismatch",
        issues,
      });
      expect(observe(world)).toEqual(before);
    },
  );

  test("every difference is reported at once, in header order", () => {
    const all = Object.assign({}, ...CHANGES.map(([, header]) => header));
    const world = decodeSnapshot(withHeader(all), tallyRuleset());
    const error = engineErrorOf(() => step(world, []));
    expect(error.code).toBe("version_mismatch");
    expect(error.issues).toEqual(CHANGES.flatMap(([, , issues]) => issues));
  });

  test("a ruleset with other versions than the snapshot's is refused the same way", () => {
    const ruleset = { ...tallyRuleset(), versions: { ...TALLY_VERSIONS, brain: "llm@1" } };
    const world = decodeSnapshot(withHeader({}), ruleset);
    expect(versionDifferences(world)).toEqual([
      difference("brainVersion", TALLY_VERSIONS.brain, "llm@1", "its ruleset declares"),
    ]);
    expect(engineErrorOf(() => step(world, [])).code).toBe("version_mismatch");
  });

  test("worlds that createWorld makes, and their round trips, have no differences", () => {
    const world = tallyWorld([1, 2]);
    expect(versionDifferences(world)).toEqual([]);
    expect(versionDifferences(decodeSnapshot(encodeSnapshot(world), tallyRuleset()))).toEqual([]);
    expect(versionDifferences(world)).not.toBe(versionDifferences(world));
  });
});

/** Where the resumption tests cut the golden run: its edges, a pinned tick, and near its end. */
const CUTS = [0, 1, 2, 37, 299, 300, 999] as const;

/**
 * The uninterrupted golden run: the checksum of every tick, the snapshot text at each cut, and
 * the final text. Encoding at a cut does not change the world, so one run serves every cut.
 */
function goldenRun() {
  const world = tallyWorld([GOLDEN_TALLY.seed[0], GOLDEN_TALLY.seed[1]]);
  const checksums: string[] = [];
  const cuts = new Map<number, string>();
  for (let tick = 0; tick <= GOLDEN_TALLY.ticks; tick += 1) {
    if (tick > 0) checksums[tick] = step(world, tallyCommands(tick)).checksum;
    if (CUTS.some((cut) => cut === tick)) cuts.set(tick, encodeSnapshot(world));
  }
  return { checksums, cuts, final: encodeSnapshot(world) };
}

describe("resumption from a snapshot", () => {
  /**
   * Time: the uninterrupted run is 1,000 ticks and the resumptions 5,362 more, about 1.5 s on the
   * 2-core Codespace (Bun 1.4.4, 2026-10-24; later ticks cost more, as tally's chunks grow). The
   * test is synchronous, so its timeout is a budget that only fails a slower run
   * (step-fuzz.test.ts explains why): 12 s allows about eight times it, as the fuzz does.
   */
  test(`cut at ticks ${CUTS.join(", ")}, decoded with a fresh ruleset, continues exactly`, () => {
    const run = goldenRun();
    expect(run.checksums[1000]).toBe(GOLDEN_TALLY.checksums[1000]);
    for (const cut of CUTS) {
      const text = run.cuts.get(cut);
      if (text === undefined) throw new Error(`no snapshot at tick ${cut}`);
      const world = decodeSnapshot(text, tallyRuleset());
      for (let tick = cut + 1; tick <= GOLDEN_TALLY.ticks; tick += 1) {
        const { checksum } = step(world, tallyCommands(tick));
        if (checksum !== run.checksums[tick]) {
          throw new Error(
            `resumed at ${cut}, tick ${tick} gave ${checksum}, not ${run.checksums[tick]}`,
          );
        }
      }
      expect(encodeSnapshot(world)).toBe(run.final);
      expect(stateRoot(world)).toBe(GOLDEN_TALLY.stateRoot);
    }
  }, 12_000);
});
