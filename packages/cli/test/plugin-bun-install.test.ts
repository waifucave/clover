// Plain Bun for plugins on a server (src/plugin-bun-install.ts), against a fake release served from memory with a
// throwaway key, on a temp home with shell scripts for binaries: the install, a Bun-version bump that refetches, a
// tampered binary and a tampered update file refused, a rollback put back from `.old`, and a binary that won't answer
// left out. Nothing reaches the network or a real home.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCoreFeed, generateFeedKey, pluginBunBinaryFile, pluginBunFeedFile, signFeed } from "@waifucave/clover-update-feed";
import { ensurePluginBun, serverPluginBun } from "../src/plugin-bun-install";
import { runVersion, type Fetcher } from "../src/self-update";

const posix = test.if(process.platform !== "win32");
const enc = (s: string) => new TextEncoder().encode(s);
const TARGET = "linux-x64" as const;
const RELEASES = "https://api.github.com/repos/waifucave/clover/releases?per_page=30";
/** Plain Bun as a shell script: `--version` prints its version. */
const bunScript = (version: string, extra = "") => `#!/bin/sh\n${extra}echo "${version}"\n`;

interface Release { tag: string; bun: string; binary?: string; spoil?: "binary" | "feed signature" }

function github(key: { privateKey: string }, releases: Release[]) {
  const files = new Map<string, Uint8Array>();
  const list = releases.map((r) => {
    const url = (name: string) => `https://github.com/waifucave/clover/releases/download/${r.tag}/${name}`;
    const binName = pluginBunBinaryFile(r.bun, TARGET);
    const signed = enc(r.binary ?? bunScript(r.bun));
    // Tampered at the same length, so only the signature (not the size cap) can catch it.
    const served = r.spoil === "binary" ? enc((r.binary ?? bunScript(r.bun)).replace("echo", "ecHo")) : signed;
    const feed = enc(formatCoreFeed({ version: r.bun, file: binName, sha512: createHash("sha512").update(signed).digest("base64"), size: signed.length }));
    const assets: Array<{ name: string; browser_download_url: string }> = [];
    const put = (name: string, bytes: Uint8Array) => { files.set(url(name), bytes); assets.push({ name, browser_download_url: url(name) }); };
    for (const ch of ["latest", "beta"] as const) {
      const name = pluginBunFeedFile(ch, TARGET);
      put(name, feed);
      put(`${name}.sig`, enc(signFeed(name, r.spoil === "feed signature" ? enc("another file") : feed, key.privateKey)));
    }
    put(binName, served);
    put(`${binName}.sig`, enc(signFeed(binName, signed, key.privateKey)));
    return { tag_name: r.tag, draft: false, prerelease: false, assets };
  });
  files.set(RELEASES, enc(JSON.stringify(list)));
  const asked: string[] = [];
  const fetch: Fetcher = async (u, opts) => {
    asked.push(u);
    const b = files.get(u);
    return b !== undefined && b.length <= opts.maxBytes ? b : undefined;
  };
  return { fetch, asked };
}

function server(releases: Release[]) {
  const home = mkdtempSync(join(tmpdir(), "clover-plugin-bun-"));
  mkdirSync(join(home, "bin"));
  const key = generateFeedKey();
  const gh = github(key, releases);
  const lines: string[] = [];
  const path = serverPluginBun(home, "linux");
  const ensure = (bunVersion: string) => ensurePluginBun({ path, bunVersion, target: TARGET, channel: "latest", publicKey: key.publicKey, fetch: gh.fetch, log: (l) => lines.push(l) });
  return { home, path, ensure, gh, lines };
}

describe("plain Bun for plugins on a server", () => {
  posix("install: fetched, checked and put beside the daemon; then left in place", async () => {
    const s = server([{ tag: "v1.0.0", bun: "1.4.4" }]);
    expect(await s.ensure("1.4.4")).toEqual({ kind: "installed", version: "1.4.4", from: "release" });
    expect(s.path).toBe(join(s.home, "bin", "daemon", "clover-plugin-bun"));
    expect(await runVersion(s.path)).toBe("1.4.4");
    const asked = s.gh.asked.length;
    expect(await s.ensure("1.4.4")).toEqual({ kind: "in place" });
    expect(s.gh.asked.length).toBe(asked);
  });

  posix("a Bun-version bump (a self-update moved the daemon's Bun) fetches the new one; the old one waits as .old", async () => {
    const s = server([{ tag: "v1.1.0", bun: "1.5.0" }, { tag: "v1.0.0", bun: "1.4.4" }]);
    expect((await s.ensure("1.4.4")).kind).toBe("installed");
    expect(await s.ensure("1.5.0")).toEqual({ kind: "installed", version: "1.5.0", from: "release" });
    expect(await runVersion(s.path)).toBe("1.5.0");
    expect(await runVersion(`${s.path}.old`)).toBe("1.4.4");
    // A rollback to the older daemon (its Bun 1.4.4) puts the old one back without a download.
    const asked = s.gh.asked.length;
    expect(await s.ensure("1.4.4")).toEqual({ kind: "installed", version: "1.4.4", from: "old" });
    expect(s.gh.asked.length).toBe(asked);
    expect(await runVersion(s.path)).toBe("1.4.4");
    expect(await runVersion(`${s.path}.old`)).toBe("1.5.0");
  });

  posix("a tampered binary (its signature or hash) is refused, and nothing is installed", async () => {
    const s = server([{ tag: "v1.0.0", bun: "1.4.4", spoil: "binary" }]);
    const r = await s.ensure("1.4.4");
    expect(r.kind).toBe("refused");
    expect(r.kind === "refused" && r.why).toContain("clover-plugin-bun-1.4.4-linux-x64: bad signature");
    expect(existsSync(s.path)).toBe(false);
    expect(existsSync(`${s.path}.new`)).toBe(false);
  });

  posix("a tampered update file is refused before it is read", async () => {
    const s = server([{ tag: "v1.0.0", bun: "1.4.4", spoil: "feed signature" }]);
    const r = await s.ensure("1.4.4");
    expect(r.kind === "refused" && r.why).toBe("latest-plugin-bun-linux-x64.yml: bad signature");
    expect(s.gh.asked.some((u) => u.endsWith("clover-plugin-bun-1.4.4-linux-x64"))).toBe(false);
  });

  posix("a release with another Bun, or none for this one, installs nothing", async () => {
    const s = server([{ tag: "v1.0.0", bun: "1.4.3" }]);
    const r = await s.ensure("1.4.4");
    expect(r.kind === "refused" && r.why).toBe("no release carries clover-plugin-bun-1.4.4-linux-x64");
    expect(existsSync(s.path)).toBe(false);
  });

  posix("a binary that doesn't answer its version is never put in place; the installed one stays", async () => {
    const s = server([{ tag: "v1.1.0", bun: "1.5.0", binary: bunScript("9.9.9") }, { tag: "v1.0.0", bun: "1.4.4" }]);
    expect((await s.ensure("1.4.4")).kind).toBe("installed");
    const r = await s.ensure("1.5.0");
    expect(r.kind === "refused" && r.why).toContain("--version said \"9.9.9\", not 1.5.0");
    expect(readFileSync(s.path, "utf8")).toBe(bunScript("1.4.4"));
    expect(existsSync(`${s.path}.new`)).toBe(false);
  });
});

test("the server's plugin Bun is <home>/bin/daemon/clover-plugin-bun, beside the daemon, .exe on Windows", () => {
  expect(serverPluginBun("/srv/home", "darwin")).toBe(join("/srv/home", "bin", "daemon", "clover-plugin-bun"));
  expect(serverPluginBun("C:/h", "win32")).toBe(join("C:/h", "bin", "daemon", "clover-plugin-bun.exe"));
});
