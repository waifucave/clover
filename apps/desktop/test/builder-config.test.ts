// electron-builder.yml: the unsigned, unpacked app CI builds on each OS (M-M0).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const config = Bun.YAML.parse(readFileSync(join(root, "electron-builder.yml"), "utf8")) as Record<string, any>;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, any>;

describe("electron-builder.yml", () => {
  test("is the dist identity", () => {
    expect(config.appId).toBe("com.waifucave.clover");
    expect(config.productName).toBe("Clover");
  });

  test("builds the unpacked app on every OS, and never signs or publishes", () => {
    for (const os of ["mac", "win", "linux"]) expect(config[os].target).toEqual([{ target: "dir" }]);
    expect(config.mac.identity).toBeNull();
    expect(config.publish).toBeNull();
    expect(pkg.scripts.dist).toContain("--publish never");
  });

  test("packages only the build output, which has no runtime dependencies", () => {
    expect(config.files).toEqual(["out/main/**", "out/renderer/**", "package.json"]);
    expect(pkg.main).toBe("out/main/index.js");
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(config.npmRebuild).toBe(false);
  });
});
