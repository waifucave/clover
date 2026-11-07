import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, readFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { runFenceConformance } from "../../src/contracts/conformance/fence";
import { CLOUD_METADATA_ADDRESSES } from "../../src/contracts/fence";
import { CloverFence } from "../../src/fence/fence";
import { canonicalPath } from "../../src/fence/canonical";
import { botFolders, pendingFenced } from "../../src/fence/layout";
import { makeBotFolders } from "../../src/fence/per-caller";
import { FENCED_SPAWN_NOT_YET } from "../../src/fence/spawn";
import { judge, type FencedPath, type FenceOp } from "../../src/contracts/fence";
import { diskName, foldName, foldPath, nonAsciiAlias } from "../../src/fence/fold";

// C-M2: the real fence. B's conformance suite runs against it with the suite's own fictional paths (no disk), then
// the folding and the disk's links are checked on real folders.

runFenceConformance((opts) => new CloverFence({ ...opts, canonical: (p) => posix.normalize(p) }));

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
    const { home, clover } = make();
    let ports = [41001];
    const f = new CloverFence({ home, cloverHome: clover, loopbackPorts: () => ports });
    expect(f.policy().blockedAddresses).toEqual([...CLOUD_METADATA_ADDRESSES, "127.0.0.1:41001", "[::1]:41001"]);
    ports = [];
    expect(f.policy().blockedAddresses).toEqual([...CLOUD_METADATA_ADDRESSES]); // read each time: the ports change with the browser
  });

  test("the pending kinds' paths: transcripts, usage, the browser's partitions, login-start places, OK'd agents' installs, the plugins folder and the bot driver's state", () => {
    const p = pendingFenced({ home: "/Users/me", cloverHome: "/Users/me/.clover", os: "macos", userData: "/Users/me/Library/Application Support/Clover",
      agentInstalls: ["/opt/homebrew/lib/node_modules/@zed-industries/codex-acp", "/Applications/Cursor.app/Contents/Resources/app/bin"] });
    expect(p.transcripts).toEqual(["/Users/me/.clover/transcripts"]);
    expect(p["browser-profiles"]).toEqual(["/Users/me/Library/Application Support/Clover/Partitions"]);
    expect(p["login-start"]).toContain("/Users/me/Library/LaunchAgents");
    expect(p["agent-installs"]).toEqual(["/opt/homebrew/lib/node_modules/@zed-industries/codex-acp", "/Applications/Cursor.app/Contents/Resources/app/bin"]);
    expect(p.plugins).toEqual(["/Users/me/.clover/plugins"]);
    expect(p["hook-shell"]).toEqual([]);
    expect(pendingFenced({ home: "C:\\Users\\me", cloverHome: "C:\\Users\\me\\.clover", os: "windows" })["hook-shell"]).toEqual(["C:\\Users\\me\\AppData\\Local\\Programs\\Git"]);
    expect(p["sessions-runtime"]).toEqual(["/Users/me/.clover/sessions-runtime"]);
    expect(pendingFenced({ home: "C:\\Users\\me", cloverHome: "C:\\Users\\me\\.clover", os: "windows" }).plugins).toEqual(["C:\\Users\\me\\.clover\\plugins"]);
  });

  test("bots' memory by pattern (the owner's decision): only the bot's own sessions, for any bot, listed or not", () => {
    const { home, clover, fence } = make();
    mkdirSync(join(clover, "bots", "luna", "memory"), { recursive: true });
    const b = (...parts: string[]) => join(clover, "bots", ...parts);
    const luna = fence.forCaller({ kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" });
    expect(luna.check({ op: "write", path: b("luna", "memory", "MEMORY.md") })).toEqual({ allowed: true });
    expect(luna.check({ op: "read", path: b("LUNA", "Memory", "MEMORY.md") })).toEqual({ allowed: true }); // folded
    expect(luna.check({ op: "read", path: b("sol", "memory", "MEMORY.md") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    expect(luna.check({ op: "write", path: b("luna", "agents", "t.json") })).toMatchObject({ allowed: false, reason: "bot-memory" }); // agents are read-only, even to its own bot
    expect(luna.check({ op: "read", path: b("luna", "agents", "t.json") })).toEqual({ allowed: true });
    expect(luna.check({ op: "move", path: b("luna"), to: b("luna2") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    // The memory folder itself: not deleted or moved, by its own bot either.
    expect(luna.check({ op: "delete", path: b("luna", "memory") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    expect(luna.check({ op: "move", path: b("luna", "memory"), to: join(home, "m") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    expect(luna.check({ op: "move", path: b("luna", "memory", "a.md"), to: b("luna", "memory", "b.md") })).toEqual({ allowed: true });
    // Not luna's own session (its agent, a coding session): denied both ways, for a bot that doesn't exist yet too.
    for (const other of [fence.forCaller({ kind: "session", sessionId: "a1", sessionKind: "agent", bot: "luna" }), fence.forCaller({ kind: "session", sessionId: "c1", sessionKind: "coding" }), fence.forCaller({ kind: "session", sessionId: "s2", sessionKind: "bot", bot: "sol" })]) {
      expect(other.check({ op: "read", path: b("luna", "memory", "MEMORY.md") })).toMatchObject({ allowed: false, reason: "bot-memory" });
      expect(other.check({ op: "write", path: b("future-bot", "memory", "MEMORY.md") })).toMatchObject({ allowed: false, reason: "bot-memory" });
      expect(other.check({ op: "write", path: b("future-bot") })).toMatchObject({ allowed: false });
      expect(other.touches([b("luna", "memory")])).toMatchObject({ kind: "bot-memory" });
      // Another bot, a coding session, its agent: luna's agents folder is never theirs to write, and (#234's home
      // default-deny, the controller's ruling) not theirs to read either; luna's own sessions read it.
      expect(other.check({ op: "read", path: b("luna", "agents", "t.json") })).toMatchObject({ allowed: false });
      expect(other.check({ op: "write", path: b("luna", "agents", "t.json") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    }
    // A plugin writing another bot's agents folder: refused too.
    const plugin = fence.forCaller({ kind: "plugin", pluginId: "tarot" });
    expect(plugin.check({ op: "write", path: b("luna", "agents", "t.json") })).toMatchObject({ allowed: false, reason: "bot-memory" });
    expect(plugin.check({ op: "read", path: b("luna", "agents", "t.json") })).toMatchObject({ allowed: false }); // the home default-deny
    expect(fence.forCaller({ kind: "session", sessionId: "c1", sessionKind: "coding" }).check({ op: "write", path: join(home, "project", "x") })).toEqual({ allowed: true });
    expect(botFolders(clover)).toEqual(["luna"]);
  });

  test("a bot's folders are made plain, never through a link (#205's S6)", () => {
    const { home, clover } = make();
    expect(makeBotFolders(clover, "pack/luna").memory).toBe(join(clover, "bots", "pack--luna", "memory"));
    mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(clover, "bots", "sol"));
    expect(() => makeBotFolders(clover, "sol")).toThrow(/link/);
  });

  test("the bot driver's state: write-denied to all, and no tool reads it, its own session's included (#234's home default-deny)", () => {
    const { clover, fence } = make();
    const rt = (n: string) => join(clover, "sessions-runtime", n);
    const s1 = fence.forCaller({ kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" });
    // The core reads a session's state for it; through a tool, the home default-deny refuses even its own.
    expect(s1.check({ op: "read", path: rt("s1.json") })).toMatchObject({ allowed: false });
    expect(fence.forCaller({ kind: "user", client: "app" }).check({ op: "read", path: rt("s1.json") })).toEqual({ allowed: true });
    expect(s1.check({ op: "read", path: rt("s2.json") })).toMatchObject({ allowed: false, reason: "sessions-runtime" });
    expect(s1.check({ op: "list", path: join(clover, "sessions-runtime") })).toMatchObject({ allowed: false, reason: "sessions-runtime" });
    expect(s1.check({ op: "write", path: rt("s1.json") })).toMatchObject({ allowed: false, reason: "sessions-runtime" });
    expect(fence.forCaller({ kind: "session", sessionId: "c1", sessionKind: "coding" }).check({ op: "read", path: rt("s1.json") })).toMatchObject({ allowed: false });
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

  test("the fenced spawn door (a hook's command, A-M3) is closed until the fenced process lands: refused, never run outside", async () => {
    expect(FENCED_SPAWN_NOT_YET.available).toBe(false);
    const r = await FENCED_SPAWN_NOT_YET.run({ command: "touch /tmp/never", cwd: "/", env: {}, timeoutMs: 1000, who: { sessionId: "s1", pluginId: "p", hook: "h" } });
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
