// The fold's own subpath (`@waifucave/clover-plugin-sdk/fold`): foldTitle and lookalikeOf with no dependencies, so a
// client part that compares names never bundles zod or the catalogs.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import * as root from "../src/index";
import { foldTitle, lookalikeOf } from "../src/catalogs/fold";

describe("the fold subpath", () => {
  test("is exported as ./fold and imports nothing", () => {
    expect((pkg.exports as Record<string, string>)["./fold"]).toBe("./src/catalogs/fold.ts");
    const src = readFileSync(join(import.meta.dir, "..", "src", "catalogs", "fold.ts"), "utf8");
    expect(src.match(/^\s*import\b/m)).toBeNull();
  });

  test("is the same fold the root exports, and lookalikeOf reads the merged map", () => {
    expect(root.foldTitle).toBe(foldTitle);
    expect(root.lookalikeOf).toBe(lookalikeOf);
    expect(lookalikeOf("\u13EB")).toBe("o"); // Cherokee O, from the island's tables
    expect(lookalikeOf("\u043E")).toBe("o"); // Cyrillic o, from the confusables
    expect(lookalikeOf("\u0111")).toBe("d"); // d with a stroke
    expect(lookalikeOf("a")).toBeUndefined();
    expect(lookalikeOf("\u03B7")).toBeUndefined(); // eta: too loose to fold
  });
});
