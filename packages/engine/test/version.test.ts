import { expect, test } from "bun:test";
import { ENGINE_VERSION } from "../src/index.ts";

test("ENGINE_VERSION matches the package version", async () => {
  const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    version: string;
  };
  expect(ENGINE_VERSION).toBe(manifest.version);
});
