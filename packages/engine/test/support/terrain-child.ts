import { prepareGenesis } from "../../src/worldgen/genesis.ts";
import { generateChunk, terrainDigest } from "../../src/worldgen/terrain.ts";

/**
 * The child process of terrain's order test (plan §12, test 10): a fresh process, whose modules
 * start without the state that earlier generations left in the parent, so terrain that kept a
 * module-level cache or counter would digest differently here.
 *
 * Run as `bun terrain-child.ts`, it reads one TerrainChildInput as JSON from stdin, a list of
 * geneses and a list of chunk keys, and writes to stdout, as JSON, the terrainDigest of each chunk
 * under each genesis: one list of digests per genesis, in the order of the keys. Anything it cannot
 * do, it throws, so the process exits with an error that the test reports.
 */
export type TerrainChildInput = { readonly geneses: unknown[]; readonly keys: string[] };

const input = JSON.parse(await Bun.stdin.text()) as TerrainChildInput;
const digests = input.geneses.map((genesis) => {
  const prepared = prepareGenesis(genesis);
  return input.keys.map((key) => terrainDigest(generateChunk(prepared, key)));
});
await Bun.write(Bun.stdout, JSON.stringify(digests));
