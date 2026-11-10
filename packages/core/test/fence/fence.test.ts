import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, readFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { runFenceConformance } from "../../src/contracts/conformance/fence";
import { CLOUD_METADATA_ADDRESSES, policyAllows } from "../../src/contracts/fence";
import { CloverFence, isRefusedShare, unmapIpv4 } from "../../src/fence/fence";
import { canonicalPath } from "../../src/fence/canonical";
import { botFolders, loginStartDirs, loginStartPaths, loginStartSafeFiles, loginStartUnsafeFiles, pendingFenced } from "../../src/fence/layout";
import { makeBotFolders } from "../../src/fence/per-caller";
import { FENCED_SPAWN_NOT_YET } from "../../src/fence/spawn";
import { linkedRouterSupportsRunHome } from "../../src/runtime-sdk/run-home-support";
import type { FenceOp, FencedKind } from "../../src/contracts/fence";
import { diskName, foldName, foldPath, nonAsciiAlias } from "../../src/fence/fold";

// C-M2: the real fence. B's conformance suite runs against it with the suite's own fictional paths (no disk), then
// the folding and the disk's links are checked on real folders. The `real-paths` case drives a real disk.

// The kinds enforced ahead of the contract (the per-user Git on Windows, the transcript store) stay off for the
// suite's harness, and are tested below.
const diskRoot = realpathSync(mkdtempSync(join(tmpdir(), "fence-conformance-")));
afterEach(() => { for (const name of ["d", "l"] as const) { try { rmSync(join(diskRoot, name), { recursive: true, force: true }); } catch { /* gone */ } } });
let diskN = 0;
const canonicalForSuite = (p: string) => {
  // The suite's fictional world (`/Users/me`, `/tmp`, install paths) compares as written, the way the fake
  // compares it; real disk paths (under this run's disk root) resolve through their links, for `real-paths`.
  if (p === diskRoot || p.startsWith(`${diskRoot}/`)) {
    try { return canonicalPath(p); } catch { return posix.normalize(p); }
  }
  return posix.normalize(p);
};
runFenceConformance((opts) => new CloverFence({ ...opts, canonical: canonicalForSuite, enforceAhead: false }), {
  disk: {
    folder: () => { const p = join(diskRoot, "d", String(diskN++)); mkdirSync(p, { recursive: true }); return p; },
    link: (target: string) => { const p = join(diskRoot, "l", String(diskN++)); mkdirSync(join(diskRoot, "l"), { recursive: true }); symlinkSync(target, p); return p; },
  },
});

type SessionKind = "bot" | "side-thread" | "agent" | "coding";
const session = (bot: string | undefined, sessionKind: SessionKind, sessionId = "s_1"): Caller =>
  ({ kind: "session", sessionId, sessionKind, ...(bot ? { bot } : {}) }) as Caller;

describe("the fence's fold (B-M1's review, J-M1's B1)", () => {
  test("long s, sharp s and the Kelvin sign fold as the disks take them; NFC and NFD are one name", () => {
    expect(foldName("ſettings.json")).toBe("settings.json");
    expect(foldName("ſettings.json")).toBe(foldName("SETTINGS.JSON"));
    expect(foldName("Straße")).toBe(foldName("STRASSE"));
    expect(foldName("\u212Aey")).toBe("key"); // the Kelvin sign
    expect(foldName("Cafe\u0301")).toBe(foldName("Café"));
  });

  test("Windows: trailing dots and spaces, and a stream suffix, name the same file; the drive folds", () => {
    expect(diskName("settings.json. . ", "windows")).toBe("settings.json");
    expect(diskName("settings.json::$DATA", "windows")).toBe("settings.json");
    expect(diskName("settings.json:hidden", "windows")).toBe("settings.json");
    expect(diskName("settings.json.", "macos")).toBe("settings.json.");
    expect(foldPath("C:\\Users\\Me\\.clover\\Settings.json::$DATA", "windows")).toBe("c:/users/me/.clover/settings.json");
  });

  test("a non-ASCII name is named only where Clover names things: the home's top level and folders holding a fenced item", () => {
    const H = "/Users/José/.clover";
    const fenced = [`${H}/levels`, `${H}/plugins-state/oks`];
    expect(nonAsciiAlias(`${H}/ſettings.json`, fenced, H, "macos")).toBe("ſettings.json");
    expect(nonAsciiAlias(`${H}/plugins-state/ökay.json`, fenced, H, "macos")).toBe("ökay.json");
    expect(nonAsciiAlias(`${H}/levels/x.json`, fenced, H, "macos")).toBeNull(); // the home's own name may be anything
    expect(nonAsciiAlias(`${H}/bots/alpha/memory/café.md`, fenced, H, "macos")).toBeNull(); // a bot's note
    expect(nonAsciiAlias(`${H}/plugins/lüna/clover.json`, fenced, H, "macos")).toBeNull(); // a plugin's files
    expect(nonAsciiAlias("/Users/me/project/ſ.txt", fenced, H, "macos")).toBeNull();
  });
});

describe("the real fence on a real disk", () => {
  let root = "";
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });
  const make = (os?: "macos" | "linux" | "windows") => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "fence-")));
    const home = join(root, "home");
    const clover = join(home, ".clover");
    mkdirSync(join(clover, "levels"), { recursive: true });
    mkdirSync(join(home, "project"), { recursive: true });
    return { home, clover, fence: new CloverFence({ home, cloverHome: clover, temp: join(root, "tmp"), ...(os ? { os } : {}) }) };
  };

  test("a fenced name in another case or Unicode form, existing or not, on every OS (Linux included)", () => {
    // Each OS's rules on a disk of its own kind: Windows paths on Windows, macOS's and Linux's on POSIX.
    for (const os of process.platform === "win32" ? (["windows"] as const) : (["macos", "linux"] as const)) {
      const { clover, fence } = make(os);
      expect(fence.check({ op: "write", path: join(clover, "LEVELS", "computer.json") })).toMatchObject({ allowed: false, reason: "levels" });
      expect(fence.check({ op: "write", path: join(clover, "Settings.JSON") })).toMatchObject({ allowed: false, reason: "settings" });
      expect(fence.check({ op: "write", path: join(clover, "rules", "allow.json") })).toMatchObject({ allowed: false, reason: "saved-rules" });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ſettings, and a non-ASCII name where Clover names things, is refused outright; elsewhere any name is fine", () => {
    const { clover, home, fence } = make();
    expect(fence.check({ op: "write", path: join(clover, "ſettings.json") })).toEqual({ allowed: false, reason: "settings", path: join(clover, "settings.json") }); // folds onto it
    expect(fence.check({ op: "write", path: join(clover, "plugins-state", "öks") })).toMatchObject({ allowed: false, reason: "clover-home" });
    expect(fence.check({ op: "write", path: join(clover, "plugins", "lüna", "clover.json") })).toMatchObject({ allowed: false, reason: "plugins" }); // the plugins folder is fenced now
    // The home default-deny reaches even where no kind is fenced, whatever the name.
    expect(fence.check({ op: "write", path: join(clover, "scratch", "lüna", "notes.md") })).toMatchObject({ allowed: false, reason: "clover-home" });
    expect(fence.forCaller(session("luna", "bot", "s1")).check({ op: "write", path: join(clover, "scratch", "luna", "café.md") })).toEqual({ allowed: true }); // its own scratch takes any name
    expect(fence.check({ op: "write", path: join(home, "project", "lüna.txt") })).toEqual({ allowed: true });
  });

  test("links: through a link, a `..` after a link, and a dangling link whose target would be fenced", () => {
    const { home, clover, fence } = make();
    symlinkSync(join(clover, "levels"), join(home, "project", "lv"));
    expect(fence.check({ op: "write", path: join(home, "project", "lv", "computer.json") })).toMatchObject({ allowed: false, reason: "levels" });
    // `lv/..` is `.clover`, not `project`: lexically it would be project/settings.json, which isn't fenced.
    expect(fence.check({ op: "write", path: `${join(home, "project", "lv")}/../settings.json` })).toMatchObject({ allowed: false, reason: "settings" });
    symlinkSync(join(clover, "trust", "agent-oks.json"), join(home, "project", "notes.json")); // dangling: trust/ isn't there
    expect(fence.check({ op: "write", path: join(home, "project", "notes.json") })).toMatchObject({ allowed: false, reason: "trust" });
    symlinkSync(clover, join(home, "c"));
    expect(fence.check({ op: "read", path: join(home, "c", "run", "core.sock") })).toMatchObject({ allowed: false, reason: "run-folder" });
    expect(fence.checkAgentRoot(join(home, "project"))).toEqual({ allowed: true });
    // Never inside the Clover home or a fenced item either, folded (#197's check 3): an agent runs unsandboxed.
    for (const inner of [join(clover, "plugins", "luna"), join(clover, "settings"), join(clover, "plugin-data"), join(clover, "PLUGINS", "luna"), clover, join(home, "c", "plugins", "luna")]) {
      expect(fence.checkAgentRoot(inner)).toMatchObject({ allowed: false, reason: "clover-home" });
    }
  });

  test("a home that is itself reached through a link is fenced at its real path", () => {
    const { home, clover } = make();
    symlinkSync(clover, join(root, "alias"));
    const f = new CloverFence({ home, cloverHome: join(root, "alias") });
    expect(f.check({ op: "write", path: join(clover, "levels", "x.json") })).toMatchObject({ allowed: false, reason: "levels" });
    expect(f.fencedSet().find((i) => i.kind === "levels")!.path).toBe(join(clover, "levels"));
    writeFileSync(join(home, "project", "a.txt"), "x");
    expect(canonicalPath(join(root, "alias", "..", "home", "project", "a.txt"))).toBe(join(home, "project", "a.txt"));
  });

  test("a hard link to a fenced file is the fenced file: writing, deleting or moving it is refused", () => {
    const { home, clover, fence } = make();
    writeFileSync(join(clover, "levels", "computer.json"), "{}");
    linkSync(join(clover, "levels", "computer.json"), join(home, "project", "innocent.json"));
    expect(fence.check({ op: "write", path: join(home, "project", "innocent.json") })).toEqual({ allowed: false, reason: "levels", path: join(clover, "levels") });
    expect(fence.check({ op: "delete", path: join(home, "project", "innocent.json") }).allowed).toBe(false);
    expect(fence.check({ op: "read", path: join(home, "project", "innocent.json") })).toEqual({ allowed: true });
    writeFileSync(join(home, "project", "a.txt"), "x");
    linkSync(join(home, "project", "a.txt"), join(home, "project", "b.txt")); // two links, neither fenced
    expect(fence.check({ op: "write", path: join(home, "project", "b.txt") })).toEqual({ allowed: true });
  });

  test("the Clover Browser's SOCKS5 filter ports are blocked for fenced commands, after the metadata address (L's ask)", () => {
    const { home, clover, fence } = make();
    let ports = [41001];
    const f = new CloverFence({ home, cloverHome: clover, loopbackPorts: () => ports });
    expect(f.policy().blockedAddresses).toEqual([...CLOUD_METADATA_ADDRESSES, "127.0.0.1:41001", "[::1]:41001"]);
    ports = [];
    expect(f.policy().blockedAddresses).toEqual([...CLOUD_METADATA_ADDRESSES]); // read each time: the ports change with the browser
  });

  test("the layout's paths: contract kinds under the home, and the pending transcript store", () => {
    const p = pendingFenced({ home: "/Users/me", cloverHome: "/Users/me/.clover", os: "macos" });
    expect(p["session-transcripts"]).toEqual(["/Users/me/.clover/projects", ...(linkedRouterSupportsRunHome() ? ["/Users/me/.clover/sdk/projects"] : [])]);
    expect(pendingFenced({ home: "C:\\Users\\me", cloverHome: "C:\\Users\\me\\.clover", os: "windows" })["hook-shell"]).toEqual(["C:\\Users\\me\\AppData\\Local\\Programs\\Git"]);
    // The secrets key, and the systemd-creds-sealed key on headless Linux: key-file on Linux, neither on macOS.
    expect(new CloverFence({ os: "linux", home: "/h", cloverHome: "/h/.clover", canonical: (p) => posix.normalize(p) }).fencedSet().filter((i) => i.kind === "key-file").map((i) => i.path).sort())
      .toEqual(["/h/.clover/secrets.key", "/h/.clover/secrets.key.cred"]);
    expect(new CloverFence({ os: "macos", home: "/h", cloverHome: "/h/.clover", canonical: (p) => posix.normalize(p) }).fencedSet().some((i) => i.kind === "key-file")).toBe(false);
    const { clover, fence } = make("macos");
    const kinds = new Map(fence.fencedSet().map((i) => [i.kind, i.path] as const));
    expect(kinds.get("plugins")).toBe(join(clover, "plugins"));
    const transcriptPaths = fence.fencedSet().filter((i) => i.kind === "transcripts").map((i) => i.path).sort();
    expect(transcriptPaths).toEqual([join(clover, "sessions"), join(clover, "transcripts")].sort());
    expect(kinds.get("usage")).toBe(join(clover, "usage"));
    expect(kinds.get("sessions-runtime")).toBe(join(clover, "sessions-runtime"));
    expect(fence.fencedSet().filter((i) => i.kind === "login-start").map((i) => i.path)).toEqual(expect.arrayContaining([
      join(root, "home", "Library", "LaunchAgents"), join(root, "home", "Library", "LaunchDaemons"),
      join(root, "home", ".zshrc"), join(root, "home", ".bashrc"), join(root, "home", ".config", "fish"),
    ]));
    expect(fence.fencedSet().filter((i) => i.kind === "browser-profiles").map((i) => i.path)).toEqual([join(root, "home", "Library", "Application Support", "Clover", "Partitions"), join(root, "home", "Library", "Application Support", "Clover Dev", "Partitions")]);
    // A headless session data dir fences its own Partitions (lane E passes app.getPath("sessionData")).
    const headless = new CloverFence({ home: join(root, "home"), cloverHome: join(root, "home", ".clover"), sessionData: join(root, "home", "app-data", "default", "session"), canonical: (x) => x });
    expect(headless.fencedSet().filter((i) => i.kind === "browser-profiles").map((i) => i.path)).toContain(join(root, "home", "app-data", "default", "session", "Partitions"));
    // Both orders: a dev app passing its own userData, and the shipped app passing its own, still fence both profiles.
    const devApp = new CloverFence({ os: "macos", home: join(root, "home"), cloverHome: join(root, "home", ".clover"), userData: join(root, "home", "Library", "Application Support", "Clover Dev"), canonical: (x) => x });
    expect(devApp.fencedSet().filter((i) => i.kind === "browser-profiles").map((i) => i.path)).toEqual([join(root, "home", "Library", "Application Support", "Clover", "Partitions"), join(root, "home", "Library", "Application Support", "Clover Dev", "Partitions")]);
    const shippedApp = new CloverFence({ os: "macos", home: join(root, "home"), cloverHome: join(root, "home", ".clover"), userData: join(root, "home", "Library", "Application Support", "Clover"), canonical: (x) => x });
    expect(shippedApp.fencedSet().filter((i) => i.kind === "browser-profiles").map((i) => i.path)).toEqual([join(root, "home", "Library", "Application Support", "Clover", "Partitions"), join(root, "home", "Library", "Application Support", "Clover Dev", "Partitions")]);
  });

  test("login-start kinds partition the list: every path is a made dir, a safe file, an unsafe file, or Clover's own", () => {
    for (const os of ["macos", "linux"] as const) {
      const home = os === "macos" ? "/Users/me" : "/h";
      const clover = os === "macos" ? "/Users/me/.clover" : "/h/.clover";
      const all = new Set(loginStartPaths(home, clover, os));
      const dirs = new Set(loginStartDirs(home, clover, os));
      const safe = new Set(loginStartSafeFiles(home, os));
      const unsafe = new Set(loginStartUnsafeFiles(home, os));
      for (const p of [...dirs, ...safe, ...unsafe]) expect(all.has(p), `${os}: ${p} is listed`).toBe(true);
      const own = os === "macos"
        ? [join(home, "Library", "LaunchAgents", "com.waifucave.clover.core.plist"), join(clover, "login")]
        : [];
      expect([...all].sort()).toEqual([...dirs, ...safe, ...unsafe, ...own].sort());
    }
  });

  test("python user site folders are fenced by the folders on the disk", () => {
    const { home, clover, fence } = make("macos");
    mkdirSync(join(home, ".local", "lib", "python3.12", "site-packages"), { recursive: true });
    mkdirSync(join(home, ".local", "lib", "other"), { recursive: true });
    const kinds = fence.fencedSet().filter((i) => i.kind === "login-start").map((i) => i.path);
    expect(kinds).toContain(join(home, ".local", "lib", "python3.12", "site-packages"));
    expect(kinds).not.toContain(join(home, ".local", "lib", "other"));
    expect(kinds).toContain(join(home, "Library", "Python"));
    expect(fence.check({ op: "write", path: join(home, ".local", "lib", "python3.12", "site-packages", "evil.py") })).toMatchObject({ allowed: false, reason: "login-start" });
    void clover;
  });

  test("git hooks in any repo under the home are login-start, for every caller", () => {
    const { home, clover, fence } = make();
    mkdirSync(join(home, "project", ".git", "hooks"), { recursive: true });
    mkdirSync(join(home, "archive.git", "hooks"), { recursive: true });
    const hooks = join(home, "project", ".git", "hooks");
    const hook = join(hooks, "post-checkout");
    const bareHooks = join(home, "archive.git", "hooks");
    const bare = join(bareHooks, "post-checkout");
    for (const f of [fence, fence.forCaller(session("luna", "bot", "s1")), fence.forCaller(session(undefined, "coding", "c1")), fence.forCaller({ kind: "plugin", pluginId: "tarot" })]) {
      expect(f.check({ op: "write", path: hook })).toEqual({ allowed: false, reason: "login-start", path: hooks });
      expect(f.check({ op: "write", path: bare })).toEqual({ allowed: false, reason: "login-start", path: bareHooks });
      expect(f.check({ op: "delete", path: hook })).toMatchObject({ allowed: false, reason: "login-start" });
      expect(f.check({ op: "move", path: hook, to: join(hooks, "pre-commit") })).toMatchObject({ allowed: false, reason: "login-start" });
    }
    expect(fence.touches([hook])).toMatchObject({ kind: "login-start", path: hooks });
    expect(fence.touches([bare])).toMatchObject({ kind: "login-start", path: bareHooks });
    // `.git/config` stays writable: normal git use writes it, so it is no fenced item.
    expect(fence.check({ op: "write", path: join(home, "project", ".git", "config") })).toEqual({ allowed: true });
    // Like every fenced kind, hooks stay shut for user-context writes too; the user's own surfaces bypass earlier.
    expect(fence.forCaller({ kind: "user", client: "app" }).check({ op: "write", path: hook })).toMatchObject({ allowed: false, reason: "login-start" });
    void clover;
  });

  test("the user's global core.hooksPath folder is fenced too, read without following links", () => {
    const { home, clover, fence } = make();
    // Absolute, ~/ and relative values resolve under the home; /dev/null (hooks off) is skipped.
    writeFileSync(join(home, ".gitconfig"), ["[core]", "\thooksPath = ~/my-hooks", "[core]", "\thooksPath = /dev/null"].join("\n"));
    writeFileSync(join(home, ".config-git"), "x");
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    writeFileSync(join(home, ".config", "git", "config"), ["[core]", "\thooksPath = shared/hooks"].join("\n"));
    const kinds = fence.fencedSet().filter((i) => i.kind === "login-start").map((i) => i.path);
    expect(kinds).toContain(join(home, "my-hooks"));
    expect(kinds).toContain(join(home, "shared", "hooks"));
    expect(fence.check({ op: "write", path: join(home, "my-hooks", "pre-commit") })).toMatchObject({ allowed: false, reason: "login-start" });
    expect(fence.touches([join(home, "shared", "hooks", "x")])).toMatchObject({ kind: "login-start" });
    void clover;
  });

  test("a linked global git config is never followed for the hooks folder", () => {
    const { home, clover, fence } = make();
    mkdirSync(join(home, "evil"), { recursive: true });
    writeFileSync(join(home, "evil", "config"), "[core]\n\thooksPath = ~/hooked\n");
    symlinkSync(join(home, "evil", "config"), join(home, ".gitconfig"));
    const kinds = fence.fencedSet().filter((i) => i.kind === "login-start").map((i) => i.path);
    expect(kinds).not.toContain(join(home, "hooked"));
    expect(fence.check({ op: "write", path: join(home, "hooked", "pre-commit") })).toEqual({ allowed: true });
    void clover;
  });

  test("lane M's self-update files are a never-own, read-only kind (#198 B1)", () => {
    // pendingFenced names them under the Clover home on macOS and Linux, in that OS's form (lane M's `<home>`
    // is the Clover home). Windows keeps its updater in Task Scheduler (a closed door): none.
    expect(pendingFenced({ home: "/h", cloverHome: "/h/.clover", os: "linux" })["self-update"]).toEqual([
      "/h/.clover/update",
      "/h/.clover/bin/clover-core", "/h/.clover/bin/clover-core.new", "/h/.clover/bin/clover-core.old",
      "/h/.clover/bin/.new", "/h/.clover/bin/.old", "/h/.clover/install.json",
    ]);
    expect(pendingFenced({ home: "C:\\Users\\me", cloverHome: "C:\\Users\\me\\.clover", os: "windows" })["self-update"]).toEqual([]);
    const { home, clover, fence } = make();
    const kinds = fence.fencedSet().filter((i) => i.kind === ("self-update" as FencedKind)).map((i) => i.path);
    expect(kinds).toEqual(expect.arrayContaining([
      join(clover, "bin", "clover-core"), join(clover, "update"), join(clover, "install.json"),
    ]));
    // Never owned: every runner denied, user-context writes too; reads pass (read-only, not read-denied).
    for (const f of [fence, fence.forCaller(session("luna", "bot", "s1")), fence.forCaller(session(undefined, "coding", "c1")), fence.forCaller({ kind: "plugin", pluginId: "tarot" }), fence.forCaller({ kind: "user", client: "app" })]) {
      expect(f.check({ op: "write", path: join(clover, "bin", "clover-core") })).toEqual({ allowed: false, reason: "self-update" as FencedKind, path: join(clover, "bin", "clover-core") });
      expect(f.check({ op: "write", path: join(clover, "update", "boot.json") })).toEqual({ allowed: false, reason: "self-update" as FencedKind, path: join(clover, "update") });
      expect(f.check({ op: "write", path: join(clover, "install.json") })).toEqual({ allowed: false, reason: "self-update" as FencedKind, path: join(clover, "install.json") });
      expect(f.check({ op: "delete", path: join(clover, "update", "rolled-back.json") })).toMatchObject({ allowed: false, reason: "self-update" });
      expect(f.check({ op: "move", path: join(home, "x"), to: join(clover, "bin", "clover-core.new") })).toMatchObject({ allowed: false, reason: "self-update" });
    }
    // Read-only as a kind: the kind itself never read-denies. Reads still follow the Clover home default-deny:
    // the user's own surfaces read freely, runners don't.
    expect(fence.forCaller({ kind: "user", client: "app" }).check({ op: "read", path: join(clover, "update", "boot.json") })).toEqual({ allowed: true });
    expect(fence.forCaller(session("luna", "bot", "s1")).check({ op: "read", path: join(clover, "update", "boot.json") })).toMatchObject({ allowed: false, reason: "clover-home" });
    expect(fence.touches([join(clover, "update", "boot.json")])).toMatchObject({ kind: "self-update", path: join(clover, "update") });
    expect(fence.policy().denyWrite).toEqual(expect.arrayContaining([join(clover, "update"), join(clover, "install.json")]));
    // Off for the contract suite: the Clover home's default-deny still refuses (less precise reason).
    expect(new CloverFence({ home, cloverHome: clover, enforceAhead: false }).check({ op: "write", path: join(clover, "update", "boot.json") })).toMatchObject({ allowed: false });
    void clover;
  });

  test("the home default-deny: every runner denied the whole home, each caller its own ways back in", () => {
    const { home, clover, fence } = make();
    const main = session("luna", "bot", "s_1");
    const reach = (caller: Caller | undefined, path: string, op: "read" | "write" = "read") => {
      const check = caller === undefined ? (o: FenceOp) => fence.check(o) : fence.forCaller(caller).check;
      return check({ op, path } as FenceOp).allowed;
    };
    // The whole home is denied: projects, sdk, sessions, transcripts, diffs, cache, logs, other bots' folders.
    for (const top of ["projects", "sdk/projects", "sessions", "transcripts", "diffs", "cache/runs", "logs", "usage", "whatever-comes-next"]) {
      for (const c of [main, session("luna", "side-thread", "s_1"), session("luna", "agent", "a_1"), session(undefined, "coding", "c_1"), session("alpha", "bot", "s_9"), { kind: "plugin", pluginId: "tarot" } as Caller, undefined]) {
        expect([top, reach(c, join(clover, top, "x.json"))]).toEqual([top, false]);
        expect([top, reach(c, join(clover, top, "x.json"), "write")]).toEqual([top, false]);
      }
    }
    // 1. A session's own outputs, read and write; another session's, neither.
    expect([reach(main, join(clover, "outputs", "s_1", "r.md")), reach(main, join(clover, "outputs", "s_1", "r.md"), "write")]).toEqual([true, true]);
    expect(reach(session("alpha", "bot", "s_9"), join(clover, "outputs", "s_1", "r.md"))).toBe(false);
    // 2. A bot's own scratch and routines, for its main conversation and side threads; nobody else's.
    for (const area of ["scratch", "routines"]) {
      expect(reach(main, join(clover, area, "luna", "a.md"), "write")).toBe(true);
      expect(reach(session("luna", "side-thread", "s_1"), join(clover, area, "luna", "a.md"), "write")).toBe(true);
      expect(reach(session("luna", "agent", "a_1"), join(clover, area, "luna", "a.md"))).toBe(false);
      expect(reach(main, join(clover, area, "alpha", "a.md"))).toBe(false);
    }
    // A plugin's own data folder, for that plugin alone.
    const plugin = { kind: "plugin", pluginId: "tarot" } as Caller;
    expect(reach(plugin, join(clover, "plugin-data", "tarot", "d.json"), "write")).toBe(true);
    expect(reach(plugin, join(clover, "plugin-data", "luna", "d.json"))).toBe(false);
    expect(reach(main, join(clover, "plugin-data", "tarot", "d.json"))).toBe(false);
    // 3. Its own bot folder reads; its memory reads and writes; another bot's neither.
    expect([reach(main, join(clover, "bots", "luna", "agents", "t.json")), reach(main, join(clover, "bots", "luna", "agents", "t.json"), "write")]).toEqual([true, false]);
    expect(reach(main, join(clover, "bots", "luna", "memory", "MEMORY.md"), "write")).toBe(true);
    expect(reach(session("newbot", "bot", "s_2"), join(clover, "bots", "newbot", "memory", "n.md"), "write")).toBe(true);
    expect(reach(main, join(clover, "bots", "sol", "memory", "MEMORY.md"))).toBe(false);
    // `..`, case and folding don't walk around it; an unlisted bot is covered by pattern.
    expect(reach(main, join(clover, "scratch", "luna", "..", "..", "settings", "settings.json"))).toBe(false);
    expect(reach(main, join(clover, "SCRATCH", "LUNA", "a.md"))).toBe(true);
    expect(reach(main, join(clover, "bots", "luna", "..", "sol", "memory", "MEMORY.md"))).toBe(false);
    // The user's surfaces and the core reach it, less what is fenced by kind.
    expect(reach({ kind: "user", client: "app" }, join(clover, "sessions", "s_1.jsonl"))).toBe(true);
    expect(reach({ kind: "core" }, join(clover, "projects", "k", "s.jsonl"))).toBe(true);
    void home;
  });

  test("the policy's own folders agree with policyAllows, caller by caller", () => {
    const { clover, fence } = make();
    const callers: Caller[] = [
      session("luna", "bot", "s_1"), session("luna", "side-thread", "s_1"), session("luna", "agent", "a_1"),
      session(undefined, "coding", "c_1"), session("alpha", "bot", "s_9"), { kind: "plugin", pluginId: "tarot" },
      { kind: "user", client: "app" }, { kind: "core" },
    ];
    const paths = ["outputs/s_1/r.md", "scratch/luna/a.md", "routines/luna/m.md", "bots/luna/agents/t.json",
      "bots/luna/memory/MEMORY.md", "bots/sol/memory/MEMORY.md", "plugin-data/tarot/d.json", "plugin-data/luna/d.json",
      "projects/k/s.jsonl", "sessions/s_1.jsonl", "settings/settings.json", "run/token", "README.md"];
    for (const caller of callers) {
      const f = fence.forCaller(caller);
      const p = f.policy();
      for (const rel of paths) {
        const abs = rel === "README.md" ? join(root, "home", rel) : join(clover, rel);
        for (const op of ["read", "write"] as const) {
          const judged = f.check({ op, path: abs } as FenceOp).allowed;
          // Reads outside the home and user/core reads are the fence's other walls, not the runner's sandbox order.
          if (rel === "README.md" || caller.kind === "user" || caller.kind === "core") continue;
          expect([caller, op, rel, policyAllows(p, op, abs, "macos")]).toEqual([caller, op, rel, judged]);
        }
      }
    }
  });

  test("bots' folders by pattern: reads only the owning bot's own folder; writes stay as the memory rule", () => {
    const { home, clover, fence } = make();
    mkdirSync(join(clover, "bots", "luna", "memory"), { recursive: true });
    mkdirSync(join(clover, "bots", "luna", "agents"), { recursive: true });
    mkdirSync(join(clover, "bots", "sol", "memory"), { recursive: true });
    writeFileSync(join(clover, "bots", "luna", "memory", "MEMORY.md"), "luna's");
    writeFileSync(join(clover, "bots", "luna", "agents", "t.json"), "{}");
    writeFileSync(join(clover, "bots", "sol", "memory", "MEMORY.md"), "sol's");
    const b = (...parts: string[]) => join(clover, "bots", ...parts);
    const luna = fence.forCaller(session("luna", "bot", "s1"));
    expect(botFolders(clover).sort()).toEqual(["luna", "sol"]);
    // The bot whose id folds equal to <x>, from its main conversation or a side thread: its whole folder.
    for (const p of [b("luna"), b("luna", "agents", "t.json"), b("LUNA", "Memory", "MEMORY.md")]) {
      expect(luna.check({ op: "read", path: p })).toEqual({ allowed: true });
    }
    expect(luna.check({ op: "list", path: b("luna") })).toEqual({ allowed: true });
    expect(luna.check({ op: "read", path: b("sol", "memory", "MEMORY.md") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    expect(luna.check({ op: "read", path: b("SOL", "AGENTS", "t.json") })).toMatchObject({ allowed: false }); // not memory: the home default-deny
    // Listing bots/ itself is denied to every runner; a bot folder not made yet is covered by pattern.
    expect(luna.check({ op: "list", path: b() })).toMatchObject({ allowed: false, reason: "bot-memory" });
    expect(luna.check({ op: "read", path: b("future-bot", "memory", "MEMORY.md") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    // Writes are exactly the memory rule: its own memory, nothing else.
    expect(luna.check({ op: "write", path: b("luna", "memory", "MEMORY.md") })).toEqual({ allowed: true });
    expect(luna.check({ op: "write", path: b("luna", "agents", "t.json") })).toMatchObject({ allowed: false }); // not memory: the home default-deny
    expect(luna.check({ op: "write", path: b("future-bot", "memory", "MEMORY.md") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    expect(luna.check({ op: "delete", path: b("luna", "memory") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    expect(luna.check({ op: "move", path: b("luna"), to: b("luna2") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    expect(luna.check({ op: "move", path: b("luna", "memory", "a.md"), to: b("luna", "memory", "b.md") })).toEqual({ allowed: true });
    // Everyone else: its agent, a coding session, another bot, a caller with no identity (a plugin's or a peer's check).
    for (const other of [fence.forCaller(session("luna", "agent", "a1")), fence.forCaller(session(undefined, "coding", "c1")), fence.forCaller(session("sol", "bot", "s2")), fence.forCaller({ kind: "plugin", pluginId: "tarot" })]) {
      for (const p of [b("luna"), b("luna", "memory", "MEMORY.md")]) {
        expect(other.check({ op: "read", path: p })).toMatchObject({ allowed: false, reason: "bot-memory" });
      }
      // The rest of its folder isn't memory: the home default-deny.
      expect(other.check({ op: "read", path: b("luna", "agents", "t.json") })).toMatchObject({ allowed: false });
      for (const p of [b("luna"), b("luna", "memory", "MEMORY.md")]) {
        expect(other.check({ op: "write", path: p })).toMatchObject({ allowed: false });
      }
      expect(other.check({ op: "list", path: b() })).toMatchObject({ allowed: false, reason: "bot-memory" });
      expect(other.check({ op: "write", path: b("future-bot", "memory", "MEMORY.md") })).toMatchObject({ allowed: false, reason: "bot-memory" });
      expect(other.check({ op: "write", path: b("future-bot") })).toMatchObject({ allowed: false });
      expect(other.touches([b("luna", "memory")])).toMatchObject({ kind: "bot-memory" });
    }
    // A link and a `..` can't lead to another bot's folder; a link from outside into its own does open it.
    symlinkSync(b("sol", "memory"), b("luna", "peek"));
    expect(luna.check({ op: "read", path: b("luna", "peek", "MEMORY.md") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    expect(luna.check({ op: "read", path: b("luna", "..", "sol", "memory", "MEMORY.md") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    symlinkSync(b("luna", "memory"), join(home, "project", "mine"));
    expect(luna.check({ op: "read", path: join(home, "project", "mine", "MEMORY.md") })).toEqual({ allowed: true });
    expect(fence.forCaller(session(undefined, "coding", "c1")).check({ op: "read", path: join(home, "project", "mine", "MEMORY.md") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    expect(fence.forCaller(session(undefined, "coding", "c1")).check({ op: "write", path: join(home, "project", "x") })).toEqual({ allowed: true });
  });

  test("the runtime's transcript store is hidden from every runner, its own bot's included", () => {
    const { home, clover, fence } = make();
    mkdirSync(join(clover, "projects", "key"), { recursive: true });
    mkdirSync(join(clover, "sdk", "projects", "key"), { recursive: true });
    writeFileSync(join(clover, "sdk", "projects", "key", "s.jsonl"), "{}");
    const store = (...parts: string[]) => join(clover, "sdk", "projects", ...parts);
    const own = fence.forCaller(session("luna", "bot", "s1"));
    for (const f of [fence, own, fence.forCaller(session(undefined, "coding", "c1")), fence.forCaller(session("luna", "agent", "a1")), fence.forCaller({ kind: "plugin", pluginId: "tarot" })]) {
      // Reads are the home default-deny; writes name the store.
      expect(f.check({ op: "read", path: store("key", "s.jsonl") })).toMatchObject({ allowed: false, reason: "clover-home" });
      expect(f.check({ op: "list", path: join(clover, "sdk", "projects") })).toMatchObject({ allowed: false, reason: "clover-home" });
      expect(f.check({ op: "write", path: store("key", "s.jsonl") })).toMatchObject({ allowed: false, reason: "session-transcripts" });
      expect(f.check({ op: "read", path: join(clover, "projects", "key", "s.jsonl") })).toMatchObject({ allowed: false, reason: "clover-home" });
      expect(f.check({ op: "read", path: join(clover, "PROJECTS", "x") })).toMatchObject({ allowed: false, reason: "clover-home" }); // folded
    }
    // The core and the user's own surfaces still reach the store.
    expect(fence.forCaller({ kind: "user", client: "app" }).check({ op: "read", path: store("key", "s.jsonl") })).toEqual({ allowed: true });
    expect(fence.policy().denyWrite).toEqual(expect.arrayContaining([join(clover, "projects"), join(clover, "sdk", "projects")]));
    // A link to the store, and a `..` through it, are the store.
    symlinkSync(join(clover, "sdk", "projects"), join(home, "project", "t"));
    expect(own.check({ op: "read", path: join(home, "project", "t", "key", "s.jsonl") })).toMatchObject({ allowed: false, reason: "clover-home" });
    expect(own.check({ op: "read", path: `${join(clover, "sdk")}/../projects/key/s.jsonl` })).toMatchObject({ allowed: false, reason: "clover-home" });
    expect(own.check({ op: "write", path: join(home, "project", "t", "key", "s.jsonl") })).toMatchObject({ allowed: false, reason: "session-transcripts" });
    // Only the store: a project's own folder of that name is ordinary.
    expect(own.check({ op: "read", path: join(home, "projects", "x") })).toEqual({ allowed: true });
  });

  test("a bot's folders are made plain, never through a link (#205's S6)", () => {
    const { home, clover } = make();
    expect(makeBotFolders(clover, "pack/luna").memory).toBe(join(clover, "bots", "pack--luna", "memory"));
    mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(clover, "bots", "sol"));
    expect(() => makeBotFolders(clover, "sol")).toThrow(/link/);
  });

  test("the bot driver's state is hidden from every runner, its own session's included", () => {
    const { clover, fence } = make();
    const rt = (n: string) => join(clover, "sessions-runtime", n);
    const s1 = fence.forCaller(session("luna", "bot", "s1"));
    expect(s1.check({ op: "read", path: rt("s1.json") })).toMatchObject({ allowed: false, reason: "sessions-runtime" });
    expect(s1.check({ op: "write", path: rt("s1.json") })).toMatchObject({ allowed: false, reason: "sessions-runtime" });
    expect(s1.check({ op: "list", path: join(clover, "sessions-runtime") })).toMatchObject({ allowed: false, reason: "sessions-runtime" });
    expect(fence.forCaller(session(undefined, "coding", "c1")).check({ op: "read", path: rt("s1.json") })).toMatchObject({ allowed: false });
    expect(fence.forCaller({ kind: "user", client: "app" }).check({ op: "read", path: rt("s1.json") })).toEqual({ allowed: true });
    expect(fence.policy().denyWrite).toEqual(expect.arrayContaining([join(clover, "sessions-runtime")]));
  });

  test("#205 B1: a `..` after a link is judged both ways, the link's target and the text; `\\\\?\\` paths with dots are refused", () => {
    const { home, clover, fence } = make();
    mkdirSync(join(root, "elsewhere", "deep"), { recursive: true });
    symlinkSync(join(root, "elsewhere", "deep"), join(home, "X")); // a junction's part on Windows
    // The disk climbs from X's target; Win32 (and path code) from X itself, onto the fenced file.
    expect(fence.check({ op: "write", path: `${join(home, "X")}/../.clover/settings.json` })).toMatchObject({ allowed: false, reason: "settings" });
    expect(fence.check({ op: "read", path: `${join(home, "X")}/../.clover/run/app.token` })).toMatchObject({ allowed: false, reason: "run-folder" });
    expect(fence.checkAgentRoot(`${join(home, "X")}/../.clover/plugins`)).toMatchObject({ allowed: false });
    expect(fence.check({ op: "write", path: join(home, "X", "fine.txt") })).toEqual({ allowed: true });
    const win = new CloverFence({ os: "windows", home: "C:\\Users\\me", cloverHome: "C:\\Users\\me\\.clover", canonical: (p) => p });
    expect(win.check({ op: "write", path: "\\\\?\\C:\\Users\\me\\x\\..\\.clover\\settings.json" })).toMatchObject({ allowed: false, reason: "clover-home" });
    expect(win.check({ op: "read", path: "\\\\?\\C:\\Users\\me\\.\\notes.txt" })).toMatchObject({ allowed: false });
    expect(win.check({ op: "read", path: "\\\\?\\C:\\Users\\me\\notes.txt" })).toEqual({ allowed: true });
    void clover;
  });

  test.skipIf(process.platform !== "win32")("#205 B1 on Windows: `..` after a real junction, as Win32 opens it, is the fenced file", () => {
    const { home, clover, fence } = make("windows");
    writeFileSync(join(clover, "settings.json"), "orig");
    mkdirSync(join(root, "elsewhere", "deep"), { recursive: true });
    symlinkSync(join(root, "elsewhere", "deep"), join(home, "X"), "junction");
    const sneaky = `${join(home, "X")}\\..\\.clover\\settings.json`;
    expect(readFileSync(sneaky, "utf8")).toBe("orig"); // what Win32 opens
    expect(fence.check({ op: "write", path: sneaky })).toMatchObject({ allowed: false, reason: "settings" });
    expect(fence.checkAgentRoot(`${join(home, "X")}\\..\\.clover`)).toMatchObject({ allowed: false });
  });

  test("#205 check 2: Windows device paths: \\??\\ and \\\\?\\ are the drive path they name; anything else behind a prefix is refused", () => {
    const win = new CloverFence({ os: "windows", home: "C:\\Users\\me", cloverHome: "C:\\Users\\me\\.clover", canonical: (p) => p });
    const settings = "C:\\Users\\me\\.clover\\settings.json";
    for (const prefix of ["\\??\\", "\\\\?\\", "\\\\.\\", "//?/"]) {
      expect(win.check({ op: "write", path: `${prefix}${settings}` })).toMatchObject({ allowed: false, reason: "settings" });
      expect(win.touches([`${prefix}${settings}`])).toMatchObject({ kind: "settings" });
      expect(win.checkAgentRoot(`${prefix}C:\\Users\\me`)).toMatchObject({ allowed: false, reason: "clover-home" });
      expect(win.check({ op: "write", path: `${prefix}C:\\Users\\me\\project\\a.txt` })).toEqual({ allowed: true });
    }
    expect(win.check({ op: "write", path: "\\??\\UNC\\nas\\share\\x.txt" })).toEqual({ allowed: true });
    for (const odd of ["\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\Users\\me\\.clover\\settings.json", "\\??\\Volume{0a1b2c3d-0000-0000-0000-000000000000}\\Users\\me\\.clover\\settings.json", "\\\\.\\pipe\\x", "\\??\\C:\\Users\\me\\x\\..\\.clover\\settings.json"]) {
      expect(win.check({ op: "read", path: odd })).toMatchObject({ allowed: false });
      expect(win.checkAgentRoot(odd)).toMatchObject({ allowed: false });
      expect(win.touches([odd])).not.toBeNull();
    }
    expect(win.check({ op: "read", path: "\\\\nas\\share\\notes.txt" })).toEqual({ allowed: true });
  });

  test("#205 check 3: shares back to this computer and admin shares are refused; so are drive-relative paths", () => {
    const win = new CloverFence({ os: "windows", home: "C:\\Users\\me", cloverHome: "C:\\Users\\me\\.clover", canonical: (p) => p });
    const host = require("node:os").hostname() as string;
    const tail = "Users\\me\\.clover\\settings.json";
    for (const p of [
      `\\\\localhost\\C$\\${tail}`, `\\\\127.0.0.1\\C$\\${tail}`, `\\\\127.9.9.9\\share\\x`,
      `\\\\?\\UNC\\localhost\\C$\\${tail}`, `\\??\\UNC\\127.0.0.1\\c$\\${tail}`, `//localhost/C$/Users/me/.clover/settings.json`,
      `\\\\${host}\\Users\\me\\.clover\\settings.json`, `\\\\${host.toUpperCase()}\\C$\\${tail}`,
      `\\\\0--1.ipv6-literal.net\\C$\\${tail}`, "\\\\nas\\backup$\\x.txt",
    ]) {
      expect(win.check({ op: "write", path: p })).toMatchObject({ allowed: false });
      expect(win.check({ op: "read", path: p })).toMatchObject({ allowed: false });
      expect(win.touches([p])).not.toBeNull();
    }
    expect(win.checkAgentRoot("\\\\localhost\\C$\\Users\\me")).toMatchObject({ allowed: false });
    expect(win.checkAgentRoot(`\\\\${host}\\Users\\me`)).toMatchObject({ allowed: false });
    // IPv4-mapped forms of this computer's own addresses are known by the address they map (check 4's note).
    expect(unmapIpv4("::ffff:192.168.1.5")).toBe("192.168.1.5");
    expect(unmapIpv4("::ffff:c0a8:105")).toBe("192.168.1.5");
    expect(unmapIpv4("0:0:0:0:0:ffff:7f00:1")).toBe("127.0.0.1");
    expect(unmapIpv4("fe80::1")).toBe("fe80::1");
    const mine = () => new Set(["192.168.1.5"]);
    for (const server of ["::ffff:192.168.1.5", "[::ffff:c0a8:105]", "0:0:0:0:0:ffff:c0a8:0105"]) expect(isRefusedShare(`\\\\${server}\\Users\\x`, mine)).toBe(true);
    expect(isRefusedShare("\\\\::ffff:7f00:1\\share\\x", () => new Set())).toBe(true); // loopback, mapped
    expect(isRefusedShare("\\\\::ffff:10.0.0.9\\share\\x", mine)).toBe(false); // another computer
    // Drive-relative: against that drive's own current folder, which the fence doesn't track.
    for (const p of ["C:.clover\\settings.json", "c:settings.json", "C:"]) expect(win.check({ op: "read", path: p })).toMatchObject({ allowed: false });
    // Another computer's ordinary share, and drive paths, stay as they were.
    expect(win.check({ op: "write", path: "\\\\nas\\share\\x.txt" })).toEqual({ allowed: true });
    expect(win.check({ op: "write", path: "C:\\Users\\me\\project\\a.txt" })).toEqual({ allowed: true });
  });

  test("#205 B2: a hard link to a read-denied file can't be read either; past 40 links a path is refused", () => {
    const { home, clover, fence } = make();
    mkdirSync(join(clover, "run"), { recursive: true });
    writeFileSync(join(clover, "run", "app.token"), "t");
    linkSync(join(clover, "run", "app.token"), join(home, "project", "innocent.txt"));
    expect(fence.check({ op: "read", path: join(home, "project", "innocent.txt") })).toMatchObject({ allowed: false, reason: "run-folder" });
    writeFileSync(join(clover, "levels", "computer.json"), "{}");
    linkSync(join(clover, "levels", "computer.json"), join(home, "project", "lv.json"));
    expect(fence.check({ op: "read", path: join(home, "project", "lv.json") })).toEqual({ allowed: true }); // write-only item: reads stay
    symlinkSync(join(home, "loop-b"), join(home, "loop-a"));
    symlinkSync(join(home, "loop-a"), join(home, "loop-b"));
    expect(fence.check({ op: "write", path: join(home, "loop-a", "x") })).toMatchObject({ allowed: false });
  });

  test("an agent's root reached through a link to the Clover home is refused at its real path", () => {
    const { home, clover, fence } = make();
    symlinkSync(clover, join(home, "link-to-clover"));
    symlinkSync(home, join(home, "..", "link-to-home"));
    expect(fence.checkAgentRoot(join(home, "link-to-clover"))).toMatchObject({ allowed: false, reason: "clover-home" });
    expect(fence.checkAgentRoot(join(home, "link-to-clover", "plugins", "x"))).toMatchObject({ allowed: false, reason: "clover-home" });
    expect(fence.checkAgentRoot(join(home, "..", "link-to-home"))).toMatchObject({ allowed: false, reason: "clover-home" });
  });

  test("enforced ahead of the contract: the per-user Git on Windows, and the runtime's transcript store", () => {
    const { home, clover, fence } = make("macos");
    // Reads are the home default-deny; writes name the store.
    expect(fence.check({ op: "read", path: join(clover, "sdk", "projects", "k", "s.jsonl") })).toMatchObject({ allowed: false, reason: "clover-home" });
    expect(fence.check({ op: "write", path: join(clover, "projects", "k", "s.jsonl") })).toMatchObject({ allowed: false, reason: "session-transcripts" });
    expect(fence.policy().denyWrite).toEqual(expect.arrayContaining([join(clover, "projects")]));
    const win = new CloverFence({ os: "windows", home: "C:\\Users\\me", cloverHome: "C:\\Users\\me\\.clover", canonical: (p) => p });
    expect(win.check({ op: "write", path: "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe" })).toMatchObject({ allowed: false, reason: "hook-shell" });
    // Off for the contract suite: the store falls back to the home default-deny.
    expect(new CloverFence({ home, cloverHome: clover, enforceAhead: false }).check({ op: "read", path: join(clover, "projects", "k", "s.jsonl") })).toMatchObject({ allowed: false, reason: "clover-home" });
    // The plugins folder and the login-start places are contract kinds now, fenced with or without the ahead flag.
    expect(fence.check({ op: "write", path: join(clover, "plugins", "x") })).toMatchObject({ allowed: false, reason: "plugins" });
    expect(fence.check({ op: "write", path: join(home, "Library", "LaunchAgents", "com.waifucave.clover.core.plist") })).toMatchObject({ allowed: false, reason: "login-start" });
  });

  test("the fenced spawn door (a hook's command, A-M3) is closed until the fenced process lands: refused, never run outside", async () => {
    expect(FENCED_SPAWN_NOT_YET.available).toBe(false);
    const r = await FENCED_SPAWN_NOT_YET.run({ command: "touch /tmp/never", cwd: "/", env: {}, timeoutMs: 1000, who: { caller: { kind: "plugin", pluginId: "p" }, hook: "h" } });
    expect(r.kind).toBe("refused");
  });

  test("development folders follow the plugin registry's list (B's PluginFolders, #197)", () => {
    const { home, clover, fence } = make();
    let list = [join(home, "dev", "luna")];
    let notify: () => void = () => {};
    let changes = 0;
    fence.watch(() => changes++);
    const stop = fence.followDevFolders({ devFolderPaths: () => list, onDevFoldersChanged: (fn) => { notify = fn; return () => { notify = () => {}; }; } });
    expect(fence.check({ op: "write", path: join(home, "dev", "luna", "x.ts") })).toMatchObject({ allowed: false, reason: "dev-folders" });
    list = [];
    notify();
    expect(fence.check({ op: "write", path: join(home, "dev", "luna", "x.ts") })).toEqual({ allowed: true });
    expect(changes).toBe(2);
    stop();
    void clover;
  });
});
