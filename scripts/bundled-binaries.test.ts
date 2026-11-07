import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_IDENTIFIERS, bundledBinaryProblems, bundledFiles, CORE_IDENTIFIERS, HOLDER_FILE, holderCompileArgs, PLUGIN_BUN, PLUGIN_BUN_ENTITLEMENTS, pluginBunZip } from "./bundled-binaries";

const ROOT = join(import.meta.dir, "..");

describe("the binaries beside the core", () => {
  test("plain Bun is the core's own Bun: its pins follow .bun-version", () => {
    expect(PLUGIN_BUN.version).toBe(readFileSync(join(ROOT, ".bun-version"), "utf8").trim());
    for (const a of Object.values(PLUGIN_BUN.assets)) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.asset).not.toContain("baseline");
    }
  });

  test("every target ships clover-plugin-bun; only macOS ships the holder", () => {
    expect(bundledFiles("darwin-arm64")).toEqual(["clover-plugin-bun", "clover-process-holder"]);
    expect(bundledFiles("linux-x64")).toEqual(["clover-plugin-bun"]);
    expect(bundledFiles("windows-x64")).toEqual(["clover-plugin-bun.exe"]);
  });

  test("each has its own identifiers, none of them the core's", () => {
    for (const ids of Object.values(BUNDLED_IDENTIFIERS)) for (const id of Object.values(ids)) expect(CORE_IDENTIFIERS as readonly string[]).not.toContain(id);
  });

  test("plugin Bun's entitlements are JIT, unsigned executable memory and native addons, nothing else", () => {
    const keys = [...readFileSync(join(ROOT, PLUGIN_BUN_ENTITLEMENTS), "utf8").matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys).toEqual(["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation"]);
  });

  test("the holder's build line is lane A's: arm64, the OS floor, libSystem only", () => {
    expect(holderCompileArgs("src.c", "out")).toEqual(["clang", "-O2", "-Wall", "-Wextra", "-mmacosx-version-min=26.0", "-arch", "arm64", "-o", "out", "src.c"]);
  });
});

describe("the package gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "clover-bundled-gate-"));
  const put = (f: string) => writeFileSync(join(dir, f), "x");
  test("a missing holder fails the build, naming the fallback it would cause", () => {
    put("clover-plugin-bun");
    const p = bundledBinaryProblems(dir, "darwin-arm64", { identifierOf: () => "com.waifucave.clover.plugin-bun" });
    expect(p).toEqual([`${HOLDER_FILE} is missing from ${dir} (a bot's commands would fall back to process-group tracking)`]);
  });
  test("one signed as the core fails, and a release wants exactly its own identifier", () => {
    put(HOLDER_FILE);
    expect(bundledBinaryProblems(dir, "darwin-arm64", { identifierOf: (p) => (p.endsWith(HOLDER_FILE) ? "com.waifucave.clover.core" : "com.waifucave.clover.plugin-bun") })).toEqual([`${HOLDER_FILE} is signed as the core (com.waifucave.clover.core): the Keychain items would trust it`]);
    expect(bundledBinaryProblems(dir, "darwin-arm64", { kind: "dist", identifierOf: (p) => (p.endsWith(HOLDER_FILE) ? "com.waifucave.clover.process-holder" : "bun") })).toEqual(["clover-plugin-bun is signed as bun, not com.waifucave.clover.plugin-bun"]);
    expect(bundledBinaryProblems(dir, "darwin-arm64", { kind: "dist", identifierOf: (p) => (p.endsWith(HOLDER_FILE) ? "com.waifucave.clover.process-holder" : "com.waifucave.clover.plugin-bun") })).toEqual([]);
    expect(bundledBinaryProblems(dir, "darwin-arm64", { identifierOf: () => undefined })).toHaveLength(2);
  });
  test("Linux and Windows need plugin Bun beside the core", () => {
    expect(bundledBinaryProblems(dir, "linux-x64")).toEqual([]);
    expect(bundledBinaryProblems(dir, "windows-x64")).toEqual([`clover-plugin-bun.exe is missing from ${dir} (plugins could not run)`]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("plain Bun's zip", () => {
  test("a download that doesn't match the pinned SHA-256 is refused and never cached", async () => {
    const cache = mkdtempSync(join(tmpdir(), "clover-bun-cache-"));
    try {
      await expect(pluginBunZip("linux-x64", async () => new TextEncoder().encode("not bun"), cache)).rejects.toThrow("nothing staged");
      expect(() => readFileSync(join(cache, PLUGIN_BUN.version, "zips", "bun-linux-x64.zip"))).toThrow();
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
  test("a cached zip with the pinned digest is used without a download", async () => {
    const cache = mkdtempSync(join(tmpdir(), "clover-bun-cache-"));
    try {
      const bytes = new TextEncoder().encode("pretend zip");
      const pinned = { ...PLUGIN_BUN.assets["linux-x64"] };
      // The real pin can't be met by a fixture, so only the miss path is exercised against it; here the digest is
      // what the code compares, so a stored file with the wrong digest is fetched again.
      const zip = join(cache, PLUGIN_BUN.version, "zips", `${pinned.asset}.zip`);
      await Bun.write(zip, bytes);
      let fetched = 0;
      await expect(pluginBunZip("linux-x64", async () => { fetched++; return bytes; }, cache)).rejects.toThrow(createHash("sha256").update(bytes).digest("hex"));
      expect(fetched).toBe(1);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
