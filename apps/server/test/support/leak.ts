/**
 * The scan for C1, C3, and C4 data in public text (plan test 11; ADR 0026, "Projections and
 * classification"), shared by the scan of published ticks (leak.test.ts) and the scan of the frames
 * real sockets carry (ws-world.test.ts): names of taints and C3 members, the C3 digests a world
 * holds, the texts of a seed's words, and the text of a world's state, which holds them all.
 */
import { type beings, readView, type World } from "@open-origin/engine";

/** Names of taints and C3 members that no public message may hold, as text or as a key. */
export const FORBIDDEN_NAMES = [
  "model-prior-suspect",
  "human-external",
  "implementation-leak",
  '"tn"',
  '"ex"',
  '"exposure"',
  '"captured"',
  '"needs"',
  '"traits"',
  '"mind"',
  '"depletion"',
  '"due"',
  '"genesis"',
  '"life"',
  '"seed"',
  '"simSecondsPerTick"',
];

/** The C3 digests of `world`'s global value: the genesis seal and the life seal. */
export function sealsOf(world: World): string[] {
  const global = readView(world as World<beings.BeingsGlobal, beings.BeingsChunk>).readGlobal();
  return [global.genesisSeal, global.lifeSeal];
}

/** The decimal and hexadecimal texts of each word of `words`, a seed's u32 words. */
export function seedTexts(words: readonly number[]): string[] {
  return words.flatMap((word) => [
    String(word),
    word.toString(16),
    word.toString(16).padStart(8, "0"),
  ]);
}

/** The texts of `forbidden` that `text` holds: none, for a projection that leaks nothing. */
export function found(text: string, forbidden: readonly string[]): string[] {
  return forbidden.filter((entry) => text.includes(entry));
}

/** The text of every chunk of `world`, as the engine holds it: C0, C1, and C3 alike. */
export function stateText(world: World): string {
  const view = readView(world);
  return JSON.stringify(view.chunkKeys().map((key) => view.readChunk(key)));
}
