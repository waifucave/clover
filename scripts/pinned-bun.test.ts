// scripts/pinned-bun: the pinned Bun beside any other one. Every test runs in a throwaway git checkout that pins a
// made-up version, against a throwaway cache folder and a local stand-in for Bun's release downloads, so nothing
// reaches the network or the real cache.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PINNED_BUN = join(import.meta.dir, "pinned-bun");
const posix = process.platform !== "win32";
const VERSION = "9.8.7";
// Every asset name the script can pick, so the stand-in serves whichever this machine asks for.
const ASSETS = ["darwin-aarch64", "darwin-x64", "darwin-x64-baseline", "linux-aarch64", "linux-aarch64-musl", "linux-x64", "linux-x64-baseline", "linux-x64-musl", "linux-x64-musl-baseline"].map((a) => `bun-${a}`);

/** The stand-in binary inside every zip. */
const standIn = (prints: string): string => `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${prints}; else command -v bun; echo "args: $*"; fi\n`;

/** A checkout pinning `version`, so the script reads its `.bun-version` and not this repo's, and the binary's SHA-256
 *  in `.bun-sha256` (by default the stand-in's that prints the version; `null` pins nothing). */
function checkout(version = VERSION, pinned: string | null = createHash("sha256").update(standIn(version)).digest("hex")): string {
  const dir = mkdtempSync(join(tmpdir(), "clover-pinned-bun-checkout-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".bun-version"), `${version}\n`);
  writeFileSync(join(dir, ".bun-sha256"), `# test pins\n${pinned === null ? "" : ASSETS.map((a) => `${version} ${a} ${pinned}`).join("\n")}\n`);
  return dir;
}

/** A zip per asset holding `<asset>/bun`, a stand-in that prints `prints` for --version and else the `bun` PATH finds. */
function zips(prints: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const asset of ASSETS) {
    const dir = mkdtempSync(join(tmpdir(), "clover-pinned-bun-zip-"));
    mkdirSync(join(dir, asset));
    writeFileSync(join(dir, asset, "bun"), standIn(prints), { mode: 0o755 });
    const r = spawnSync("zip", ["-qr", `${asset}.zip`, asset], { cwd: dir });
    if (r.status !== 0) throw new Error(`zip failed: ${r.stderr}`);
    out.set(`${asset}.zip`, readFileSync(join(dir, `${asset}.zip`)));
  }
  return out;
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

let server: ReturnType<typeof Bun.serve> | undefined;
// What the stand-in release serves, per test: its zips and its SHASUMS256.txt.
let release: { files: Map<string, Buffer>; shasums: string } = { files: new Map(), shasums: "" };
let requests: string[] = [];

function serve(files: Map<string, Buffer>, shasums = [...files].map(([name, b]) => `${sha(b)}  ${name}`).join("\n") + "\n"): void {
  release = { files, shasums };
  requests = [];
}

/** Async, never spawnSync: the stand-in release is served by this process, which must keep running meanwhile. */
async function run(args: string[], cwd: string, cache: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn([PINNED_BUN, ...args], {
    cwd,
    env: { ...process.env, CLOVER_BUN_CACHE: cache, CLOVER_BUN_RELEASES: `http://127.0.0.1:${server!.port}/download` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { status, stdout, stderr };
}

describe.if(posix)("scripts/pinned-bun", () => {
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        requests.push(path);
        const m = /^\/download\/bun-v([^/]+)\/(.+)$/.exec(path);
        if (m === null || m[1] !== VERSION) return new Response("not found", { status: 404 });
        if (m[2] === "SHASUMS256.txt") return new Response(release.shasums);
        const body = release.files.get(m[2]!);
        return body === undefined ? new Response("not found", { status: 404 }) : new Response(new Uint8Array(body));
      },
    });
  });
  afterAll(() => server?.stop(true));

  test("first use fetches the pinned version, checks its SHA-256 against the release, and runs it with its folder first on PATH", async () => {
    serve(zips(VERSION));
    const cwd = checkout();
    const cache = mkdtempSync(join(tmpdir(), "clover-pinned-bun-cache-"));
    const r = await run(["test", "x"], cwd, cache);
    expect(r.stderr).toContain(`fetching Bun ${VERSION}`);
    expect(r.stderr).toContain("matches the release");
    expect(r.status).toBe(0);
    const bin = join(cache, VERSION, "bun");
    // A `bun` the pinned one runs (a package script's) is the pinned one too.
    expect(r.stdout).toBe(`${bin}\nargs: test x\n`);
    expect(readdirSync(join(cache, VERSION))).toEqual(["bun"]);
    // Later runs use the cache; --dir prints the folder.
    const again = await run(["--dir"], cwd, cache);
    expect(again.status).toBe(0);
    expect(again.stdout).toBe(`${join(cache, VERSION)}\n`);
    expect(requests.filter((p) => p.endsWith(".zip"))).toHaveLength(1);
  });

  test("a zip whose SHA-256 is not the release's installs nothing", async () => {
    const files = zips(VERSION);
    serve(files, [...files].map(([name]) => `${"0".repeat(64)}  ${name}`).join("\n") + "\n");
    const cache = mkdtempSync(join(tmpdir(), "clover-pinned-bun-cache-"));
    const r = await run(["--dir"], checkout(), cache);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("but the release lists");
    expect(r.stderr).toContain("nothing installed");
    expect(existsSync(join(cache, VERSION, "bun"))).toBe(false);
    expect(readdirSync(join(cache, VERSION))).toEqual([]);
  });

  test("a binary that prints another version installs nothing", async () => {
    serve(zips("1.0.0"));
    const cache = mkdtempSync(join(tmpdir(), "clover-pinned-bun-cache-"));
    // Pinned to exactly that binary, so the version answer is what refuses it.
    const r = await run(["--dir"], checkout(VERSION, createHash("sha256").update(standIn("1.0.0")).digest("hex")), cache);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`prints "1.0.0", not ${VERSION}`);
    expect(existsSync(join(cache, VERSION, "bun"))).toBe(false);
  });

  test("a version the release does not have fails without installing", async () => {
    serve(zips(VERSION));
    const cache = mkdtempSync(join(tmpdir(), "clover-pinned-bun-cache-"));
    const r = await run(["--dir"], checkout("9.9.9"), cache);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not download");
    expect(existsSync(join(cache, "9.9.9", "bun"))).toBe(false);
  });

  test("every run checks the cached binary against .bun-sha256: a replaced one is fetched again", async () => {
    serve(zips(VERSION));
    const cwd = checkout();
    const cache = mkdtempSync(join(tmpdir(), "clover-pinned-bun-cache-"));
    expect((await run(["--dir"], cwd, cache)).status).toBe(0);
    const bin = join(cache, VERSION, "bun");
    // Something that can write the user's cache swaps the binary (same version answer, other code).
    writeFileSync(bin, `#!/bin/sh\necho ${VERSION}\necho swapped >&2\n`, { mode: 0o755 });
    const r = await run(["x"], cwd, cache);
    expect(r.stderr).toContain("not the pinned");
    expect(r.stderr).toContain("fetching it again");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${bin}\nargs: x\n`);
    expect(readFileSync(bin, "utf8")).toBe(standIn(VERSION));
    expect(requests.filter((p) => p.endsWith(".zip"))).toHaveLength(2);
    // An unchanged cache is not fetched again.
    expect((await run(["--dir"], cwd, cache)).status).toBe(0);
    expect(requests.filter((p) => p.endsWith(".zip"))).toHaveLength(2);
  });

  test("a downloaded binary whose SHA-256 is not the pinned one installs nothing, even when the release agrees", async () => {
    serve(zips(VERSION));
    const cache = mkdtempSync(join(tmpdir(), "clover-pinned-bun-cache-"));
    const r = await run(["--dir"], checkout(VERSION, "1".repeat(64)), cache);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("but");
    expect(r.stderr).toContain(".bun-sha256 pins");
    expect(r.stderr).toContain("nothing installed");
    expect(existsSync(join(cache, VERSION, "bun"))).toBe(false);
  });

  test("a .bun-sha256 with no line for this version and asset is refused before anything runs", async () => {
    serve(zips(VERSION));
    const cache = mkdtempSync(join(tmpdir(), "clover-pinned-bun-cache-"));
    const r = await run(["--dir"], checkout(VERSION, null), cache);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pins no SHA-256");
    expect(requests).toEqual([]);
  });

  test("a .bun-version that holds no version is refused", async () => {
    const cache = mkdtempSync(join(tmpdir(), "clover-pinned-bun-cache-"));
    const r = await run(["--dir"], checkout("latest"), cache);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not hold a version");
  });
});
