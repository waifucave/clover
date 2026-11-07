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

  test("`dist` builds the unpacked app on every OS, and never signs or publishes", () => {
    // The release targets (the dmg and its update zip, the Windows installer) are lane M's release build's
    // (scripts/release/); `--dir` overrides them for `dist`.
    expect(pkg.scripts.dist).toContain("--dir");
    expect(pkg.scripts.dist).toContain("--publish never");
    expect(config.linux.target).toEqual([{ target: "dir" }]);
    expect(config.mac.identity).toBeNull();
    expect(config.mac.notarize).toBe(false);
    // The feed electron-updater reads; nothing uploads to it from a build.
    expect(config.publish).toEqual({ provider: "github", owner: "waifucave", repo: "clover" });
  });

  test("packages only the build output, which has no runtime dependencies", () => {
    expect(config.files).toEqual(["out/main/**", "out/renderer/**", "package.json"]);
    expect(pkg.main).toBe("out/main/index.js");
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(config.npmRebuild).toBe(false);
  });
});
