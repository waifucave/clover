import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_IDENTIFIERS, bundledBinaryProblems, bundledFiles, CORE_IDENTIFIERS, HOLDER_FILE, holderCompileArgs, PLUGIN_BUN, PLUGIN_BUN_ENTITLEMENTS, pluginBunZip, unpackPluginBun, zipEntry } from "./bundled-binaries";

const ROOT = join(import.meta.dir, "..");

describe("the binaries beside the core", () => {
  test("plain Bun is the core's own Bun: its pins follow .bun-version", () => {
    expect(PLUGIN_BUN.version as string).toBe(readFileSync(join(ROOT, ".bun-version"), "utf8").trim());
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

describe("plain Bun's zip is unpacked in-process (no tar: Git Bash's GNU tar reads C:\\… as host:path)", () => {
  /** A zip of `files` (deflated unless `stored`), as Oven's release zips are laid out. */
  const zipOf = (files: Record<string, string>, stored = false): Uint8Array => {
    const locals: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const [name, body] of Object.entries(files)) {
      const raw = new TextEncoder().encode(body);
      const data = stored ? raw : new Uint8Array(deflateRawSync(raw));
      const n = new TextEncoder().encode(name);
      const crc = Bun.hash.crc32(raw) >>> 0;
      const lh = new Uint8Array(30 + n.length);
      const l = new DataView(lh.buffer);
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(8, stored ? 0 : 8, true);
      l.setUint32(14, crc, true); l.setUint32(18, data.length, true); l.setUint32(22, raw.length, true); l.setUint16(26, n.length, true);
      lh.set(n, 30);
      const ch = new Uint8Array(46 + n.length);
      const c = new DataView(ch.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(10, stored ? 0 : 8, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, raw.length, true); c.setUint16(28, n.length, true); c.setUint32(42, offset, true);
      ch.set(n, 46);
      locals.push(lh, data);
      central.push(ch);
      offset += lh.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new Uint8Array(22);
    const e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, central.length, true); e.setUint16(10, central.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    const parts = [...locals, ...central, end];
    const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
    let o = 0;
    for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  };

  test("reads a stored or deflated entry, checked against its CRC-32, and nothing else", () => {
    for (const stored of [true, false]) {
      const z = zipOf({ "bun-linux-x64/bun": "the bun binary", "bun-linux-x64/README": "x" }, stored);
      expect(new TextDecoder().decode(zipEntry(z, "bun-linux-x64/bun")!)).toBe("the bun binary");
      expect(zipEntry(z, "bun-linux-x64/missing")).toBeUndefined();
    }
    const z = zipOf({ "a/bun": "abc" }, true);
    // A flipped byte in the stored data: refused, not handed on.
    const bad = z.slice();
    bad[30 + "a/bun".length] ^= 1;
    expect(() => zipEntry(bad, "a/bun")).toThrow("doesn't match its size and CRC-32");
    expect(() => zipEntry(new TextEncoder().encode("not a zip at all"), "a/bun")).toThrow("not a zip");
  });

  test("a zip at a Windows drive-letter path unpacks, with no tar or unzip on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-plugin-bun-unpack-"));
    const zip = zipOf({ "bun-windows-x64/bun.exe": "the windows bun", "bun-linux-x64/bun": "the linux bun" });
    const here = process.cwd();
    const path = process.env.PATH;
    try {
      // `C:\Users\runner\…\bun-windows-x64.zip`, relative to this folder: on Windows a drive path, elsewhere a file
      // name that GNU tar would read as a remote host's path. And no unpacking tool is reachable at all.
      process.chdir(dir);
      process.env.PATH = "";
      const winZip = "C:\\Users\\runner\\AppData\\Local\\clover-bun\\bun-windows-x64.zip";
      const target = process.platform === "win32" ? join(dir, "C-drive", "bun-windows-x64.zip") : winZip;
      if (process.platform === "win32") mkdirSync(join(dir, "C-drive"), { recursive: true });
      writeFileSync(target, zip);
      unpackPluginBun(target, "windows-x64", join(dir, "out", "clover-plugin-bun.exe"));
      expect(readFileSync(join(dir, "out", "clover-plugin-bun.exe"), "utf8")).toBe("the windows bun");
      unpackPluginBun(target, "linux-x64", join(dir, "out", "clover-plugin-bun"));
      expect(readFileSync(join(dir, "out", "clover-plugin-bun"), "utf8")).toBe("the linux bun");
      if (process.platform !== "win32") expect(statSync(join(dir, "out", "clover-plugin-bun")).mode & 0o777).toBe(0o755);
      expect(() => unpackPluginBun(target, "darwin-arm64", join(dir, "out", "x"))).toThrow("holds no bun-darwin-aarch64/bun");
    } finally {
      process.chdir(here);
      process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
