/**
 * The golden values of the tally run (plan §8 "Golden", risk R12): seed [0x5eed, 0x7a11], the
 * commands of tallyCommands, 1,000 ticks. They pin behavior; they do not prove it correct, which
 * is the job of the vectors, the properties, and the negative controls. Besides the checksums of
 * ticks 1, 10, 100, and 1000 and the final root, `runDigest` is digest(["run", checksums]) over
 * the checksum of every tick, so a change that alters only the events of another tick is caught.
 *
 * Any change that alters one of them changes what a replay produces, so it must bump
 * ENGINE_VERSION or a tally version, which golden-tally.test.ts also pins, and record the new
 * values in the same change. These were recorded from the first verified run, on 2026-10-24 with
 * Bun 1.4.4: two runs and one audited run gave the same values, and the final state root equaled
 * fullChecksum. Adding the commands that reach the reasons empty_name and no_entity, rejected at
 * ticks that are multiples of 17 and 19, changed none of the five first values: a rejection
 * changes no state, and no pinned tick is such a multiple. runDigest was recorded then, the same
 * way.
 */
export const GOLDEN_TALLY = {
  engineVersion: "0.1.0",
  versions: { ruleset: "tally@1", generator: "tally-grid@1", brain: "none@1" },
  seed: [0x5eed, 0x7a11],
  ticks: 1000,
  checksums: {
    1: "919fbc80dbe5eef5f1b9cfb4be90b34f",
    10: "9ab5bef924f283e2a456efec4ed03a9a",
    100: "48bc2fc30594dca9b4b6bcc113dc5e7a",
    1000: "aa3ccfa62b8659626618200122769265",
  },
  stateRoot: "0d797690c89b31792e64cedc71cf4fa0",
  runDigest: "bfe8c1191a4e12b47c041da48e33c4a2",
} as const;
