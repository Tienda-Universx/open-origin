import type { Genesis } from "../../src/worldgen/genesis.ts";

/**
 * The golden values of worldgen@1's terrain (plan §12, test 8; ADR 0021, permanent and temporal
 * layers): the terrainDigest of chunks of the default and the maximum genesis under three terrain
 * seeds, and the digest of a 16×16-chunk region. They cover the permanent layer only, so they do
 * not depend on any instant; the time goldens (golden-time.ts) do not depend on the terrain seed.
 * They pin behavior; they do not prove it correct, which is the job of the properties, the oracles,
 * and the broken variants.
 *
 * The golden values are recorded in T3-5; `worldgen@1` is frozen when T3 closes (ADR 0021), and
 * T3-6 changes no output. Update policy: after the freeze, any change that alters one of these
 * values alters a world's terrain, so it needs a new WORLDGEN_VERSION ("worldgen@2"), which this
 * file also pins, and new values recorded in the same change; the code of worldgen@1 stays as long
 * as a world uses it. These were recorded on 2026-10-25 with Bun 1.4.4: two runs in separate
 * processes gave the same values, and the tests' child process agrees with the parent.
 *
 * What they cover, pooled over the seeds (worldgen-terrain.test.ts checks it): all 4 substrate
 * classes of the default genesis, in its region alone, and 13 of the maximum genesis's 16, whose
 * squares of 2^12 cells give its region one class per seed; cells under and above the liquid; an
 * elevation range wider than the amplitude; thermalBase rising with elevation; and, in the region,
 * each default deposit in at least 1% of the cells: 8.4% and 6.7%. Deposits cluster, so most
 * pinned chunks hold none.
 */

/** Three terrain seeds: all zeros, all ones, and a mixed pattern. */
const SEEDS: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [
    0x0123_4567, 0x89ab_cdef, 0xfedc_ba98, 0x7654_3210, 0x0f1e_2d3c, 0x4b5a_6978, 0x8796_a5b4,
    0xc3d2_e1f0,
  ],
  [
    0xffff_ffff, 0xffff_ffff, 0xffff_ffff, 0xffff_ffff, 0xffff_ffff, 0xffff_ffff, 0xffff_ffff,
    0xffff_ffff,
  ],
];

/**
 * The chunks each seed pins: the origin and its negative neighbors, one far inside the world, the
 * middle of each edge, and the four corners, at the chunk bounds ±2^26.
 */
const CHUNKS: readonly string[] = [
  "0,0",
  "-1,-1",
  "-1,0",
  "0,-1",
  "12345,-678",
  "-67108864,0",
  "67108863,0",
  "0,-67108864",
  "0,67108863",
  "-67108864,-67108864",
  "67108863,-67108864",
  "-67108864,67108863",
  "67108863,67108863",
];

/**
 * The maximum genesis around `terrainSeed`: every terrain parameter at the end of its bound that
 * makes worldgen's intermediates largest (relief amplitude 2^29 over 12 octaves, the lowest liquid
 * level, 8 deposits of 6 octaves with peak 2^20, 16 substrate classes in cells of 2^12), except two
 * choices. The lapse is 2^19 / 2^20, the steepest the genesis accepts at that amplitude, by its
 * rule |num| × amplitude ≤ 2^28 × den. The thresholds spread over [0, 875]: the low ones leave many
 * cells above them, and those above the noise's real reach, about 0.74 of its bound, leave none,
 * so both branches of the deposit formula are pinned. The time laws are at their bounds too,
 * though terrain does not read them.
 */
export function maximumGenesis(terrainSeed: readonly number[]): Genesis {
  return {
    terrainSeed,
    laws: {
      day: { length: 2 ** 36, daylight: 999 },
      liquid: { level: 100 },
      thermal: {
        base: 2 ** 20,
        spread: 2 ** 20,
        lapse: { num: 2 ** 19, den: 2 ** 20 },
        diurnal: 2 ** 20,
      },
      radiance: { peak: 2 ** 20, night: 2 ** 20 },
    },
    terrain: {
      relief: { wavelength: 2 ** 16, octaves: 12, amplitude: 2 ** 29 },
      substrate: { cell: 2 ** 12, weights: Array.from({ length: 16 }, () => 1000) },
      deposits: Array.from({ length: 8 }, (_, k) => ({
        wavelength: 2 ** 16,
        octaves: 6,
        threshold: 125 * k,
        peak: 2 ** 20,
      })),
    },
  };
}

export const GOLDEN_WORLDGEN = {
  version: "worldgen@1",
  seeds: SEEDS,
  chunks: CHUNKS,
  /**
   * The 16×16 chunks of each region digest: x and y from 0 to 15, row by row, y first. It is the
   * first of the candidate regions tried, from chunks -8, 0, -16, then others, where each default
   * deposit covers at least 1% of the cells, pooled over the seeds; in the region from -8 to 7, the
   * second deposit covers none under these seeds, though it covers 3.5% of a random region.
   */
  regionChunks: { first: 0, side: 16 },
  /** For each genesis, per seed, the terrainDigest of each chunk of CHUNKS, in order. */
  digests: {
    default: [
      [
        "628846466df3839e20013c804b098c4f",
        "dac1ef12a3fb39d89bfcd617bb04847f",
        "bd914780079e414c1c8e8d7c7ff39205",
        "f7cd9632c9af64e41fbc6d495af1a464",
        "a23b35c3d97c0ca2b189ecebdbf696b8",
        "2a0eadc4a2f2e5c705f85e264371b412",
        "8eb6e8f728767a6f7f5bdc203e955d1e",
        "055b7d650a552364e8d5b67ede99afdc",
        "395ae29cf5ca4bcb73516e6294f5f8c8",
        "2d1ddababff327d5a80b102e1c4221c4",
        "85915463e7d4930d07a8ffb84e671454",
        "5571ca9accf2cef06313799afeb96021",
        "253df8e834db9d107966a1c8ccf29b21",
      ],
      [
        "d778ad2adca306bd7a859ab7178af93c",
        "92b87b964f6426164ed1680ff6ea2c86",
        "a9f693cc9281c4da5c3380766532cbf4",
        "405a8495f225fb0ea0dcb5f7229fa178",
        "a45acec03734f7753ad719c20bf42b16",
        "fe9de7a88ddc0dd4460f010af1ed7e4a",
        "4b1299af52d40b647f725d04f1190b1b",
        "a1534092a06838ba6eccd9bf38ddb294",
        "0c5d3cc0e31829f166142d9feaeb104a",
        "b95539d14807a55916ac6a3939058b5e",
        "8ffa46708c64afd9c00559f8646e973e",
        "3f1635d0d56f9ba78d47ba3dea4a137b",
        "619d98e9baa4f52af3f41526828d4e76",
      ],
      [
        "82904c9d14343bd377d969a1f93466b7",
        "cf304664163b8879d828fd8c196909ae",
        "6cb8218f5d91984a9b84e44b2da2134d",
        "cd3a2758b543745a7d7ccbf1f7a33a0a",
        "486f8a4bf20c333dc3ad1d8454bedaea",
        "0734d8ff06344e16b83d2776edbee8d5",
        "1777446186dcf7670d16578418541751",
        "0d36237032c7e006641e93296315eac7",
        "17cdf7290ee7183719bf16fb0c7650b6",
        "edd79ec21288fb5b8f6e634955a754f8",
        "5e9b6d8d566754bbfe0384b06d3a2072",
        "b166f515a025dc771cd32e90a70c7792",
        "5667e2e1779329ebc36fe30cca029fd2",
      ],
    ] as readonly (readonly string[])[],
    maximum: [
      [
        "d4ce769793d41ef32b3e90a0c702ad98",
        "6cbdfc730a8c4ff941cfd6146fbb0ca2",
        "32dd7eeaeaacea68d0a9b927e2985e1c",
        "48c4134d0a918e3edfcf9fb8c5fe8376",
        "4a6d911e2ecae1e4b662ad96748afec6",
        "4d767f95118ed0449a35d8bdf92598fb",
        "5a9bcbb7d059f68ef94d47eccf425299",
        "3881258add1e98fd4ffef68835c13d67",
        "7f696a8fdc8911395acc9eb566957291",
        "2b8e1aaa2b57fea33b8e5ea9d08ba14c",
        "21775f655d0cd12e82175a6d471f93df",
        "fc95995d10147a3bbdb526f64d3ed6af",
        "b06e4c6179c3dae79dbfa99f916c2532",
      ],
      [
        "dd4e83d9e23b48ce1d12ef5bd37fbc22",
        "770222573f4b988f1686bd0e1ebd9c8b",
        "b85b64d9822a71cfad1d6c73178c034a",
        "be3b0b96d3a1b49e41c5d2d9f78163c3",
        "2f32e247d92cd9637982c87d30910a5a",
        "a38f87b891b46d028403bd1df53a93b0",
        "b59428a352eb26753d40fb84d0c77bf3",
        "8ed712738fcb37fedd5aa338ae5bd0a3",
        "8cd5eef373c22eee6e3918c21690afec",
        "14eb381e8463a7924a7181b0cd419cf5",
        "f0e8e48b8e893427191f23ab5ead7e31",
        "2079a74dcc8f9596183dbd8579bd4c8c",
        "714e40f99ad7936dcb86cf3c0f25654b",
      ],
      [
        "e4cb9b1af60346ebed3fabef9823ec8a",
        "160c2e147a7cdb0e575bbbde37951d53",
        "699e9a5a5b5aef6492c394dc4a8246d5",
        "602d39c428640d7b696b78ac7a068123",
        "d4ef0b952426958e9d2b4a50838b75c3",
        "81162ac1a96fc9a9abea46f18fbbd060",
        "359dafef7b0f9ff726d2e41d863343f2",
        "578c4951db74ce57bfafadd4b220da52",
        "825d809e3e9e8572cb05d0153ca6a9bd",
        "431191d8876646553fa7f00f673441af",
        "ee7ebdf2531a088283ed1fda89a2b59c",
        "5ab09478dde4a7cbdf2d2bb7c84ce33d",
        "3e6d74bdbd377b9325c96f99167b0312",
      ],
    ] as readonly (readonly string[])[],
  },
  /** For each genesis, per seed, digest(the terrainDigest of each chunk of the region). */
  regions: {
    default: [
      "754240f82b7e0123f3c906370644b403",
      "29744c07f8885b92514b5ea8583710a5",
      "47d9c977bd9b61d9de1071c42eee0b99",
    ] as readonly string[],
    maximum: [
      "a62df45b08da090c6bbc47e05053f84b",
      "5d05d3a884e6d1e344e1caa3dde922e6",
      "24f0fc7e9bb2abe765035d3fccf128fa",
    ] as readonly string[],
  },
} as const;
