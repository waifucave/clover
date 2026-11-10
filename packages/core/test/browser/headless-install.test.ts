// The headless shell's pin and install, failing closed (spec §12.1, "Where no app runs"), with no browser: a fake
// fetch serves a small zip whose size, SHA-256 and tree digest this test pins itself.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEADLESS_PIN, InstallError, pinFrom, type HeadlessShellPins, archiveUrl, binaryIn, cftPlatform, installDirFor, installHeadlessShell, renameIntoPlace, stageForLaunch, treeDigestOfArchive,
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

/** What its owner could do to a file of the install (they are read-only): make it writable, then change it. */
function tamper(path: string, data: string): void {
  if (process.platform !== "win32") chmodSync(path, 0o700);
  writeFileSync(path, data);
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
  test("the pin file pins the headless shell for linux64, linux-arm64, mac-arm64 and win64, each with its bytes, SHA-256 and tree", () => {
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

  test("the pin file is in the controller's shape, its milestone the Chromium's, and the installer takes every asset from it", () => {
    const file = JSON.parse(readFileSync(join(import.meta.dir, "../../../../plugins/clover/plugins/browser/headless-shell.pins.json"), "utf8")) as HeadlessShellPins;
    expect(Object.keys(file).sort()).toEqual(["assets", "chromium", "electron", "milestone"]);
    expect(file.milestone).toBe(Number(file.chromium.split(".")[0]));
    expect(file.chromium).toBe(HEADLESS_PIN.version);
    for (const a of file.assets) {
      expect(Object.keys(a).sort()).toEqual(["platform", "sha256", "url"]);
      expect(HEADLESS_PIN.platforms[a.platform]).toMatchObject({ sha256: a.sha256, url: a.url });
      expect(archiveUrl(HEADLESS_PIN, a.platform)).toBe(a.url);
    }
    // An asset whose SHA-256 the integrity file doesn't hold, or whose URL isn't Chrome for Testing's, isn't pinned.
    const extra = { why: "x", platforms: { linux64: { sha256: "a".repeat(64), bytes: 1, tree: "b".repeat(64) } } };
    expect(pinFrom({ ...file, assets: [{ platform: "linux64", url: file.assets[0]!.url, sha256: "c".repeat(64) }] }, extra).platforms).toEqual({});
    expect(pinFrom({ ...file, assets: [{ platform: "linux64", url: "https://evil.test/x.zip", sha256: "a".repeat(64) }] }, extra).platforms).toEqual({});
  });

  test("the pinned version is the Chromium of the app's Electron (the pin's own record of it)", () => {
    const electron = (JSON.parse(readFileSync(join(import.meta.dir, "../../../../apps/desktop/package.json"), "utf8")) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> });
    const version = electron.devDependencies?.electron ?? electron.dependencies?.electron;
    // Moving Electron means moving the pin (or saying in `why` why it's ahead): the pin names the Electron it follows.
    expect(HEADLESS_PIN.why).toContain(`${version} ships Chromium ${HEADLESS_PIN.version}`);
    const file = JSON.parse(readFileSync(join(import.meta.dir, "../../../../plugins/clover/plugins/browser/headless-shell.pins.json"), "utf8")) as HeadlessShellPins;
    expect(file.electron).toBe(version!);
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
    tamper(bin, "#!/bin/sh\necho swapped\n");
    const again = await installHeadlessShell({ dir, pin, platform: PLAT, fetch: s.fetch });
    expect(again.reused).toBe(false);
    expect(readFileSync(bin, "utf8")).toContain("echo browser");
    expect(s.urls.length).toBe(2);

    writeFileSync(join(installed, `chrome-headless-shell-${PLAT}`, "libextra.so"), "planted");
    expect((await installHeadlessShell({ dir, pin, platform: PLAT, fetch: s.fetch })).reused).toBe(false);
    expect(existsSync(join(installed, `chrome-headless-shell-${PLAT}`, "libextra.so"))).toBe(false);
    expect(s.urls.length).toBe(3);

    // A mode change is a change only where files have POSIX modes: on Windows the tree digest records none (`-`), as
    // the archive's tree does for a Windows platform, so there is no mode to change.
    if (process.platform !== "win32") {
      chmodSync(join(installed, `chrome-headless-shell-${PLAT}`, "resources.pak"), 0o755);
      expect((await installHeadlessShell({ dir, pin, platform: PLAT, fetch: s.fetch })).reused).toBe(false);
    }

    // Tampered, and the pinned download isn't there: refused, never the changed one.
    tamper(bin, "#!/bin/sh\necho swapped\n");
    expect(await code(installHeadlessShell({ dir, pin, platform: PLAT, fetch: async () => { throw new Error("offline"); } }))).toBe("download");
    expect(existsSync(bin)).toBe(false);
  });
  test("an install is unpacked with its permissions tightened: directories 0700, executables 0500, other files 0400", async () => {
    if (process.platform === "win32") return;
    const dir = home();
    const { dir: installed, bin } = await installHeadlessShell({ dir, pin: pinFor(ZIP), platform: PLAT, fetch: server(ZIP).fetch });
    const modes = (path: string): number => lstatSync(path).mode & 0o777;
    expect(modes(installed)).toBe(0o700);
    expect(modes(join(installed, `chrome-headless-shell-${PLAT}`))).toBe(0o700);
    expect(modes(bin)).toBe(0o500);
    expect(modes(join(installed, `chrome-headless-shell-${PLAT}`, "resources.pak"))).toBe(0o400);
    expect(modes(join(dir, "cft"))).toBe(0o700);
  });

  test("a browser is launched from a private copy that was checked itself: never the install, and a swapped file is caught", async () => {
    const dir = home();
    const pin = pinFor(ZIP);
    const installed = await installHeadlessShell({ dir, pin, platform: PLAT, fetch: server(ZIP).fetch });
    const staged = await stageForLaunch(installed, { dir, pin });
    expect(staged.bin).not.toBe(installed.bin);
    expect(staged.dir.startsWith(join(dir, "run"))).toBe(true);
    expect(readFileSync(staged.bin, "utf8")).toContain("echo browser");
    if (process.platform !== "win32") {
      expect(lstatSync(join(dir, "run")).mode & 0o777).toBe(0o700);
      expect(lstatSync(staged.dir).mode & 0o777).toBe(0o700);
      expect(lstatSync(staged.bin).mode & 0o777).toBe(0o500);
    }
    // Changing the install afterwards doesn't touch what runs, and the next start reuses the checked copy (no new copy).
    tamper(installed.bin, "#!/bin/sh\necho swapped\n");
    expect(readFileSync(staged.bin, "utf8")).toContain("echo browser");
    const again = await stageForLaunch(installed, { dir, pin });
    expect(again.dir).toBe(staged.dir);
    expect(readdirSync(join(dir, "run"))).toEqual([staged.dir.split(/[\\/]/).pop()!]);
    // A kept copy that was changed is caught at the next start: remade from the (swapped) install, refused and removed.
    tamper(staged.bin, "#!/bin/sh\necho swapped in the copy\n");
    expect(await code(stageForLaunch(installed, { dir, pin }))).toBe("tree");
    expect(readdirSync(join(dir, "run"))).toEqual([]);
    staged.release();
    staged.release();
  });

  test("a start with the copy of a version already kept doesn't copy the browser again", async () => {
    const dir = home();
    const pin = pinFor(ZIP);
    const installed = await installHeadlessShell({ dir, pin, platform: PLAT, fetch: server(ZIP).fetch });
    const first = await stageForLaunch(installed, { dir, pin });
    expect(readdirSync(join(dir, "run")).length).toBe(1);
    const second = await stageForLaunch(installed, { dir, pin });
    expect(second.bin).toBe(first.bin);
  });

  test("copies left by a process that is gone are removed at the next start; a live one's stay", async () => {
    const dir = home();
    const pin = pinFor(ZIP);
    const installed = await installHeadlessShell({ dir, pin, platform: PLAT, fetch: server(ZIP).fetch });
    mkdirSync(join(dir, "run", "2147483646-dead"), { recursive: true });
    mkdirSync(join(dir, "run", `${process.pid}-alive`), { recursive: true });
    const staged = await stageForLaunch(installed, { dir, pin });
    expect(existsSync(join(dir, "run", "2147483646-dead"))).toBe(false);
    expect(existsSync(join(dir, "run", `${process.pid}-alive`))).toBe(true);
    staged.release();
  });
});

describe("renameIntoPlace (the install's swap)", () => {
  const fail = (code: string) => Object.assign(new Error(code), { code });
  test("on Windows a rename that fails for a moment (a pending delete, a file still held) is retried, then lands", async () => {
    let tries = 0;
    const slept: number[] = [];
    await renameIntoPlace("staging", "dir", {
      platform: "win32", remove: () => {}, sleep: async (ms) => void slept.push(ms),
      rename: () => { if (++tries < 3) throw fail("EPERM"); },
    });
    expect([tries, slept]).toEqual([3, [50, 100]]);
  });
  test("it gives up after its tries on Windows, and never retries elsewhere or another error", async () => {
    const always = (code: string) => () => { throw fail(code); };
    const sleep = async () => {};
    expect(await renameIntoPlace("s", "d", { platform: "win32", remove: () => {}, sleep, rename: always("EPERM") }).catch((e: Error) => e.message)).toBe("EPERM");
    let tries = 0;
    await renameIntoPlace("s", "d", { platform: "linux", remove: () => {}, sleep, rename: () => { tries++; throw fail("EPERM"); } }).catch(() => {});
    expect(tries).toBe(1);
    tries = 0;
    await renameIntoPlace("s", "d", { platform: "win32", remove: () => {}, sleep, rename: () => { tries++; throw fail("ENOENT"); } }).catch(() => {});
    expect(tries).toBe(1);
  });
});
