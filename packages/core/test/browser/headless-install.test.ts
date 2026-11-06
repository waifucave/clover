// The headless shell's pin and install, failing closed (spec §12.1, "Where no app runs"), with no browser: a fake
// fetch serves a small zip whose size, SHA-256 and tree digest this test pins itself.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEADLESS_PIN, InstallError, archiveUrl, binaryIn, cftPlatform, installDirFor, installHeadlessShell, treeDigestOfArchive,
  type HeadlessPin,
} from "../../src/browser/headless";

/** A zip of stored entries, made on Unix (modes kept). */
function makeZip(entries: { name: string; data?: string; mode?: number }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data ?? "");
    const crc = Bun.hash.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made on Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = e.mode ?? (e.name.endsWith("/") ? 0o40755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/** This machine's platform, so the unpacked tree reads back as the archive says (Windows keeps no modes). */
const PLAT = cftPlatform() ?? "linux64";
const EXE = `chrome-headless-shell${PLAT.startsWith("win") ? ".exe" : ""}`;
const ZIP = makeZip([
  { name: `chrome-headless-shell-${PLAT}/` },
  { name: `chrome-headless-shell-${PLAT}/${EXE}`, data: "#!/bin/sh\necho browser\n", mode: 0o100755 },
  { name: `chrome-headless-shell-${PLAT}/resources.pak`, data: "resources" },
]);

function pinFor(zip: Uint8Array, over: Partial<{ bytes: number; sha256: string; tree: string }> = {}): HeadlessPin {
  return {
    version: "1.2.3.4",
    why: "test",
    base: "https://cft.test",
    artifact: "chrome-headless-shell",
    platforms: {
      [PLAT]: {
        bytes: zip.length,
        sha256: createHash("sha256").update(zip).digest("hex"),
        tree: treeDigestOfArchive(zip, PLAT),
        ...over,
      },
    },
  };
}

function server(zip: Uint8Array, opts: { length?: string | null; md5?: string } = {}) {
  const urls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    urls.push(url);
    const headers: Record<string, string> = {};
    if (opts.length !== null) headers["content-length"] = opts.length ?? String(zip.length);
    if (opts.md5 !== undefined) headers["x-goog-hash"] = `crc32c=AAAAAA==, md5=${opts.md5}`;
    return new Response(Buffer.from(zip), { headers });
  };
  return { fetch, urls };
}

const home = () => mkdtempSync(join(tmpdir(), "clover-headless-install-"));
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return e instanceof InstallError ? e.code : `not an InstallError: ${String(e)}`;
  }
  return undefined;
}

describe("the pin", () => {
  test("pins.json pins the headless shell for linux64, linux-arm64, mac-arm64 and win64, each with its bytes, SHA-256 and tree", () => {
    expect(HEADLESS_PIN.artifact).toBe("chrome-headless-shell");
    expect(HEADLESS_PIN.version).toMatch(/^\d+\.0\.\d+\.\d+$/);
    expect(HEADLESS_PIN.why.length).toBeGreaterThan(20);
    expect(Object.keys(HEADLESS_PIN.platforms).sort()).toEqual(["linux-arm64", "linux64", "mac-arm64", "win64"]);
    for (const p of Object.values(HEADLESS_PIN.platforms)) {
      expect(p!.bytes).toBeGreaterThan(50_000_000);
      expect(p!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p!.tree).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(archiveUrl(HEADLESS_PIN, "mac-arm64")).toBe(`https://storage.googleapis.com/chrome-for-testing-public/${HEADLESS_PIN.version}/mac-arm64/chrome-headless-shell-mac-arm64.zip`);
  });

  test("the pinned version is the Chromium of the app's Electron (the pin's own record of it)", () => {
    const electron = (JSON.parse(readFileSync(join(import.meta.dir, "../../../../apps/desktop/package.json"), "utf8")) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> });
    const version = electron.devDependencies?.electron ?? electron.dependencies?.electron;
    // Moving Electron means moving the pin (or saying in `why` why it's ahead): the pin names the Electron it follows.
    expect(HEADLESS_PIN.why).toContain(`${version} ships Chromium ${HEADLESS_PIN.version}`);
  });

  test("Chrome for Testing's platform names", () => {
    expect(cftPlatform("darwin", "arm64")).toBe("mac-arm64");
    expect(cftPlatform("linux", "x64")).toBe("linux64");
    expect(cftPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(cftPlatform("win32", "x64")).toBe("win64");
    expect(cftPlatform("freebsd", "x64")).toBeUndefined();
    expect(cftPlatform("linux", "riscv64")).toBeUndefined();
  });
});

describe("the install, failing closed", () => {
  test("installs under the folder it's given, from the pinned URL, then reuses the install while it still matches", async () => {
    const dir = home();
    const pin = pinFor(ZIP);
    const s = server(ZIP);
    const first = await installHeadlessShell({ dir, pin, platform: PLAT, fetch: s.fetch });
    expect(first).toMatchObject({ version: "1.2.3.4", platform: PLAT, reused: false, dir: installDirFor(dir, pin, PLAT), bin: binaryIn(installDirFor(dir, pin, PLAT), PLAT) });
    expect(first.dir.startsWith(join(dir, "cft"))).toBe(true);
    expect(s.urls).toEqual([`https://cft.test/1.2.3.4/${PLAT}/chrome-headless-shell-${PLAT}.zip`]);
    expect(readFileSync(first.bin, "utf8")).toContain("echo browser");
    if (process.platform !== "win32") expect(statSync(first.bin).mode & 0o100).not.toBe(0);
    const again = await installHeadlessShell({ dir, pin, platform: PLAT, fetch: s.fetch });
    expect(again.reused).toBe(true);
    expect(s.urls.length).toBe(1);
  });

  test("no pin for the platform: nothing is fetched or installed", async () => {
    const dir = home();
    const s = server(ZIP);
    expect(await code(installHeadlessShell({ dir, pin: pinFor(ZIP), platform: "no-such-platform", fetch: s.fetch }))).toBe("no_pin");
    expect(await code(installHeadlessShell({ dir, pin: pinFor(ZIP, { sha256: "" }), platform: PLAT, fetch: s.fetch }))).toBe("no_pin");
    expect(await code(installHeadlessShell({ dir, pin: pinFor(ZIP, { tree: "nope" }), platform: PLAT, fetch: s.fetch }))).toBe("no_pin");
    expect(s.urls).toEqual([]);
    expect(existsSync(join(dir, "cft"))).toBe(false);
  });

  test("a wrong size or SHA-256 refuses before anything is unpacked", async () => {
    const dir = home();
    const pin = pinFor(ZIP);
    // The announced length.
    expect(await code(installHeadlessShell({ dir, pin, platform: PLAT, fetch: server(ZIP, { length: String(ZIP.length + 1) }).fetch }))).toBe("size");
    // No announced length: what arrives is counted.
    const longer = new Uint8Array([...ZIP, 0]);
    expect(await code(installHeadlessShell({ dir, pin, platform: PLAT, fetch: server(longer, { length: null }).fetch }))).toBe("size");
    expect(await code(installHeadlessShell({ dir, pin, platform: PLAT, fetch: server(ZIP.subarray(0, ZIP.length - 1), { length: null }).fetch }))).toBe("size");
    // Same size, other bytes.
    const other = makeZip([
      { name: `chrome-headless-shell-${PLAT}/${EXE}`, data: "#!/bin/sh\necho evil!!!\n", mode: 0o100755 },
      { name: `chrome-headless-shell-${PLAT}/resources.pak`, data: "resources" },
      { name: `chrome-headless-shell-${PLAT}/` },
    ]);
    expect(other.length).toBe(ZIP.length);
    expect(await code(installHeadlessShell({ dir, pin, platform: PLAT, fetch: server(other).fetch }))).toBe("sha256");
    // The server's own MD5, when it sends one, must match too.
    expect(await code(installHeadlessShell({ dir, pin, platform: PLAT, fetch: server(ZIP, { md5: Buffer.alloc(16).toString("base64") }).fetch }))).toBe("md5");
    expect(existsSync(installDirFor(dir, pin, PLAT))).toBe(false);
    // An HTTP error, or no network at all.
    expect(await code(installHeadlessShell({ dir, pin, platform: PLAT, fetch: async () => new Response("no", { status: 404 }) }))).toBe("download");
    expect(await code(installHeadlessShell({ dir, pin, platform: PLAT, fetch: async () => { throw new Error("offline"); } }))).toBe("download");
  });

  test("an archive whose tree isn't the pinned one, or whose entry would land outside the folder, is never installed", async () => {
    const dir = home();
    // Its own hash pinned, but another tree's digest: refused.
    expect(await code(installHeadlessShell({ dir, pin: pinFor(ZIP, { tree: "0".repeat(64) }), platform: PLAT, fetch: server(ZIP).fetch }))).toBe("tree");
    const escaping = makeZip([{ name: "../escaped", data: "x" }]);
    expect(await code(installHeadlessShell({ dir, pin: pinFor(escaping), platform: PLAT, fetch: server(escaping).fetch }))).toBe("unpack");
    expect(existsSync(join(dir, "cft", "escaped"))).toBe(false);
    expect(existsSync(join(dir, "escaped"))).toBe(false);
  });

  test("a reused install that changed (a file edited, added, or its mode) is never run: it is installed again, and refused when it can't be", async () => {
    const dir = home();
    const pin = pinFor(ZIP);
    const s = server(ZIP);
    const { bin, dir: installed } = await installHeadlessShell({ dir, pin, platform: PLAT, fetch: s.fetch });
    writeFileSync(bin, "#!/bin/sh\necho swapped\n");
    const again = await installHeadlessShell({ dir, pin, platform: PLAT, fetch: s.fetch });
    expect(again.reused).toBe(false);
    expect(readFileSync(bin, "utf8")).toContain("echo browser");
    expect(s.urls.length).toBe(2);

    writeFileSync(join(installed, `chrome-headless-shell-${PLAT}`, "libextra.so"), "planted");
    expect((await installHeadlessShell({ dir, pin, platform: PLAT, fetch: s.fetch })).reused).toBe(false);
    expect(existsSync(join(installed, `chrome-headless-shell-${PLAT}`, "libextra.so"))).toBe(false);
    expect(s.urls.length).toBe(3);

    if (process.platform !== "win32") {
      chmodSync(join(installed, `chrome-headless-shell-${PLAT}`, "resources.pak"), 0o755);
      expect((await installHeadlessShell({ dir, pin, platform: PLAT, fetch: s.fetch })).reused).toBe(false);
    }

    // Tampered, and the pinned download isn't there: refused, never the changed one.
    writeFileSync(bin, "#!/bin/sh\necho swapped\n");
    expect(await code(installHeadlessShell({ dir, pin, platform: PLAT, fetch: async () => { throw new Error("offline"); } }))).toBe("download");
    expect(existsSync(bin)).toBe(false);
  });
});
