// The one-time copy of the old install's home (spec §12, item 125; the controller's rulings 1 to 6): built against
// fixture old homes (`fixture.ts`), never a real one.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { ruleKeyHash } from "../../../src/approvals/strings";
import { applyCarry, carryFromOldRegistry } from "../../../src/migration/old-home/carry";
import { readChoice } from "../../../src/migration/old-home/choice";
import { copyOldHome, OldEngineRunning, stagedCopyReady } from "../../../src/migration/old-home/copy";
import { leftBehindFrom, leftBehindLines, modelProvidersOf } from "../../../src/migration/old-home/left-behind";
import { NEW_MANIFEST_FILE, NEW_PLUGIN_SDK, NEW_ROOT_PLUGIN, NEW_SDK_CONFIG, NEW_USAGE_LEDGER, OLD_MANIFEST_FILE, OLD_PLUGIN_SDK, OLD_ROOT_PLUGIN, OLD_USAGE_LEDGER } from "../../../src/migration/old-home/names";
import { oldHomePaths } from "../../../src/migration/old-home/paths";
import { applyStagedCopy } from "../../../src/migration/old-home/swap";
import { fileRegistryStore, memoryRegistryStore } from "../../../src/registry/state";
import { buildOldHome, treeHash } from "./fixture";

const dirs: string[] = [];
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const notAlive = async () => ({ alive: false });

/** A fresh home as the new engine's first start leaves it (the parts the swap must keep and the ones it replaces). */
function freshHome(root: string): string {
  const home = join(root, ".new-home");
  for (const d of ["sessions", "memory", "logs", "run", "runtimes/backups", "credentials", "devices", "plugins-state", "sdk/projects"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "settings.json"), "{\"schemaVersion\":1}\n");
  writeFileSync(join(home, "credentials", "index.json"), "{\"version\":1,\"items\":{\"new\":{}}}\n");
  writeFileSync(join(home, "devices", "registry.json"), "{\"v\":1,\"self\":\"d_new\"}\n");
  writeFileSync(join(home, "run", "core.lock"), "{\"pid\":1}\n");
  writeFileSync(join(home, "secrets.key"), "fresh-key\n");
  return home;
}

function setup() {
  const root = temp("moss-old-home-");
  const user = join(root, "user");
  const fx = buildOldHome(user, join(root, "scratch"));
  const home = freshHome(root);
  return { root, user, fx, home };
}

const rowsOf = (path: string): string[] => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT v FROM fixture_rows ORDER BY id").all() as { v: string }[]).map((r) => r.v);
  } finally {
    db.close();
  }
};

describe("the copy", () => {
  test("the old home is byte for byte what it was: after the copy, after the swap, and after the copied home is used", async () => {
    const { fx, home } = setup();
    const before = treeHash(fx.old);
    await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    expect(treeHash(fx.old)).toBe(before);
    applyStagedCopy(home);
    expect(treeHash(fx.old)).toBe(before);
    // The new engine writes through what was copied: the links that pointed into the old home now point here.
    if (process.platform !== "win32") {
      writeFileSync(join(home, "bots", "alpha", "shared-memory", "new-note.md"), "written by MOSS\n");
      writeFileSync(join(home, "agents", "new-agent.md"), "written by MOSS\n");
      writeFileSync(join(home, "bots", "alpha", "notes-hard.md"), "changed through the copied hard link\n");
    }
    const ledger = new Database(join(home, ...NEW_USAGE_LEDGER.split("/")));
    ledger.run("INSERT INTO fixture_rows (v) VALUES ('after')");
    ledger.close();
    expect(treeHash(fx.old)).toBe(before);
    expect(readFileSync(join(fx.old, "memory", "notes.md"), "utf8")).toBe("# notes\nremember the meadow\n");
  });

  test("both WAL databases arrive whole: the rows committed only in the WAL, never the uncommitted transaction's pages", async () => {
    const { fx, home } = setup();
    // The fixture really has both on disk: committed frames in the WAL, and a spill of uncommitted ones after them.
    expect(fx.wal.usage.walCommitted).toBeGreaterThan(0);
    expect(fx.wal.usage.walWithSpill).toBeGreaterThan(fx.wal.usage.walCommitted);
    expect(fx.wal.routines.walWithSpill).toBeGreaterThan(fx.wal.routines.walCommitted);
    const report = await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    applyStagedCopy(home);
    expect(rowsOf(join(home, ...NEW_USAGE_LEDGER.split("/")))).toEqual(["usage-1", "usage-2", "usage-3"]);
    expect(rowsOf(join(home, "routines.db"))).toEqual(["routine-1", "routine-2"]);
    // One file each, no sidecar: SQLite wrote them (VACUUM INTO), nothing was copied beside a live WAL.
    for (const f of [NEW_USAGE_LEDGER, "routines.db"]) {
      expect(existsSync(join(home, `${f}-wal`))).toBe(false);
      expect(existsSync(join(home, `${f}-shm`))).toBe(false);
    }
    expect(existsSync(join(home, ...OLD_USAGE_LEDGER.split("/")))).toBe(false);
    expect(report.databases.sort()).toEqual(["routines.db", "runtimes/runtime-state.db", "sessions/index.db", NEW_USAGE_LEDGER].sort());
    // The scratch copies SQLite read are gone.
    expect(existsSync(oldHomePaths(home).scratch)).toBe(false);
  });

  test("what never travels is left out; what does is in place, renamed where the table says", async () => {
    const { fx, home } = setup();
    const report = await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    applyStagedCopy(home);
    for (const gone of ["logs/daemon.log", "cache", "bin", "login", "update", "install.json", "runtimes/backups/old.db.bak", "migration/manifest.json", "plugins/.acceptance-echo.previous-abc123", "run/harness-token", "secrets.enc", "secrets.key.cred"]) {
      expect(existsSync(join(home, gone))).toBe(false);
    }
    // This home's own secret index, device registry and run files are its own, never replaced.
    expect(readFileSync(join(home, "credentials", "index.json"), "utf8")).toContain("\"new\"");
    expect(readFileSync(join(home, "devices", "registry.json"), "utf8")).toContain("d_new");
    expect(readFileSync(join(home, "run", "core.lock"), "utf8")).toBe("{\"pid\":1}\n");
    expect(readFileSync(join(home, "secrets.key"), "utf8")).toBe("fresh-key\n");
    // A file the mapping changed nothing in is its bytes as they were, UTF-8 or not.
    expect(readFileSync(join(home, "notes", "latin1.txt"))).toEqual(readFileSync(join(fx.old, "notes", "latin1.txt")));
    expect(readFileSync(join(home, "plugins", "acceptance-echo", "latin1.css"))).toEqual(readFileSync(join(fx.old, "plugins", "acceptance-echo", "latin1.css")));
    expect(readdirSync(join(home, "plugins-state"))).toEqual([]);
    expect(report.leftOut).toEqual(expect.arrayContaining(["run", "logs", "cache", "bin", "login", "update", "install.json", "credentials", "devices", "plugins-state", "runtimes", "migration", "secrets.enc", "secrets.key", "secrets.key.cred"]));
    expect(readFileSync(join(home, "migration", "c", "CURRENT_LAYOUT"), "utf8")).toBe("1\n");
    // Copied as they are.
    expect(readFileSync(join(home, "memory", "notes.md"), "utf8")).toBe(readFileSync(join(fx.old, "memory", "notes.md"), "utf8"));
    expect(readFileSync(join(home, "bots", "alpha", "routines", "daily.md"), "utf8")).toBe("---\nid: r_1\n---\nsay hi\n");
    expect(readFileSync(join(home, "sessions", "bot", "s_alpha.jsonl"), "utf8")).toBe(readFileSync(join(fx.old, "sessions", "bot", "s_alpha.jsonl"), "utf8"));
    // Renamed.
    expect(existsSync(join(home, "plugin-data", NEW_ROOT_PLUGIN, "state.json"))).toBe(true);
    expect(existsSync(join(home, "plugin-data", OLD_ROOT_PLUGIN))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "settings", "plugins", NEW_ROOT_PLUGIN, "settings.json"), "utf8"))).toEqual({ "notifications.needsYou": false });
    expect(existsSync(join(home, "settings", "plugins", `${NEW_ROOT_PLUGIN}.json`))).toBe(true);
    expect(existsSync(join(home, "settings", "plugins", "acceptance-echo.json"))).toBe(true);
    expect(existsSync(join(home, "settings", "plugin-stores", NEW_ROOT_PLUGIN, "voice.json"))).toBe(true);
    expect(existsSync(join(home, "MOSS.md"))).toBe(true);
    expect(existsSync(join(home, "sdk", "MOSS.md"))).toBe(true);
    expect(existsSync(join(home, "sdk", NEW_SDK_CONFIG))).toBe(true);
    // Modes kept.
    if (process.platform !== "win32") expect(statSync(join(home, "settings.json")).mode & 0o777).toBe(0o600);
    // What the fresh home held where the copy took its place is set aside, never deleted.
    const aside = readdirSync(oldHomePaths(home).replaced);
    expect(aside.length).toBe(1);
    expect(existsSync(join(oldHomePaths(home).replaced, aside[0]!, "settings.json"))).toBe(true);
  });

  test("the record stores' old-root ids and old standing-server tool names are mapped; other values stay", async () => {
    const { fx, home } = setup();
    await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    applyStagedCopy(home);
    const s = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(s.mcp.toolsOwner).toEqual({ web: `${NEW_ROOT_PLUGIN}/web`, "acceptance-echo-echo": "acceptance-echo" });
    expect(s.mcp.toolPermissions).toEqual({ web: { WebSearch: "allow" } });
    expect(s.notifications).toEqual({ sound: "soft" });
    expect(JSON.parse(readFileSync(join(home, "levels", "mcp-servers.json"), "utf8"))).toEqual({ plugins: { [`${NEW_ROOT_PLUGIN}/web`]: true, "acceptance-echo": true }, servers: { web: false } });
    expect(JSON.parse(readFileSync(join(home, "trust", "agent-oks.json"), "utf8")).oks[0].plugin).toBe(`${NEW_ROOT_PLUGIN}/agents`);
    const sdk = JSON.parse(readFileSync(join(home, "sdk", NEW_SDK_CONFIG), "utf8"));
    expect(sdk.allowed).toEqual(["mcp__moss__research__Search"]);
    expect(sdk.mcpServers).toEqual({ blender: { command: "blender-mcp" } });
  });

  test("saved rules: re-hashed where the display is the exact key, every other rule as it was", async () => {
    const { fx, home } = setup();
    const report = await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    applyStagedCopy(home);
    expect(report.rehashedRules).toBe(1);
    const rules = JSON.parse(readFileSync(join(home, "rules", "saved-rules.json"), "utf8")).rules as { keyHash: string; display: string; bot?: string }[];
    expect(rules[0]!.keyHash).toBe(ruleKeyHash("tool:mcp__moss__web__WebSearch"));
    expect(rules[0]!.display).toBe("tool:mcp__moss__web__WebSearch");
    expect(rules[0]!.bot).toBe("alpha");
    expect(rules[1]!.keyHash).toBe(ruleKeyHash(fx.ruleKeys.plain));
    // Its display was scrubbed, so it doesn't prove its key: kept as it was (that call asks again).
    const old = JSON.parse(readFileSync(join(fx.old, "rules", "saved-rules.json"), "utf8")).rules;
    expect(rules[2]).toEqual(old[2]);
  });

  test("the installed third-party plugin is rewritten through the rename's content map; its node_modules are not", async () => {
    const { fx, home } = setup();
    const report = await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    applyStagedCopy(home);
    const dir = join(home, "plugins", "acceptance-echo");
    expect(existsSync(join(dir, NEW_MANIFEST_FILE))).toBe(true);
    expect(existsSync(join(dir, OLD_MANIFEST_FILE))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, NEW_MANIFEST_FILE), "utf8")).requires).toEqual([`${NEW_ROOT_PLUGIN}/settings`]);
    const index = readFileSync(join(dir, "index.ts"), "utf8");
    expect(index).toContain(`from "${NEW_PLUGIN_SDK}"`);
    expect(index).toContain(`from "${NEW_PLUGIN_SDK}/ui"`);
    expect(index).toContain("process.env.MOSS_PLUGIN_DIR");
    expect(index).toContain("moss-asset://icon.png");
    expect(index).toContain("mcp__moss__web__WebSearch");
    expect(index).not.toContain(OLD_PLUGIN_SDK);
    expect(readFileSync(join(dir, "style.css"), "utf8")).toBe(".card { color: var(--moss-color-text); background: url(moss-plugin://acceptance-echo/bg.png); }\n");
    expect(readFileSync(join(dir, "node_modules", "dep", "index.js"), "utf8")).toContain(OLD_PLUGIN_SDK);
    expect(readFileSync(join(dir, "icon.png"))).toEqual(readFileSync(join(fx.old, "plugins", "acceptance-echo", "icon.png")));
    expect(report.plugins).toEqual(["acceptance-echo"]);
  });

  test.skipIf(process.platform === "win32")("links: into the old home now point at the same place here, out of it are left out; a hard link is a new file", async () => {
    const { fx, home } = setup();
    const report = await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    applyStagedCopy(home);
    expect(readlinkSync(join(home, "agents"))).toBe(join("sdk", "agents"));
    expect(readlinkSync(join(home, "bots", "alpha", "shared-memory"))).toBe(join(resolve(home), "memory"));
    expect(existsSync(join(home, "bots", "alpha", "outside"))).toBe(false);
    expect(report.linksLeftOut.sort()).toEqual(["bots/alpha/key-link", "bots/alpha/memory/notes-link.md", "bots/alpha/outside", "bots/alpha/run-link"]);
    for (const gone of ["key-link", "run-link", join("memory", "notes-link.md")]) expect(existsSync(join(home, "bots", "alpha", gone))).toBe(false);
    expect(lstatSync(join(home, "bots", "alpha", "notes-hard.md")).nlink).toBe(1);
  });

  test("no staged record or database names the old home's path, but history and memory, which are copied as written", async () => {
    const { fx, home } = setup();
    await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    const staging = oldHomePaths(home).staging;
    // The session index is checked by its rows below: a title that merely mentions the old path keeps it.
    const asWritten = [/^sessions\/.*\.jsonl$/, /^transcripts\//, /^memory\//, /^bots\/[^/]+\/memory\//, /^audit\.jsonl$/, /^sessions\/index\.db$/];
    const hits: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(staging, rel), { withFileTypes: true })) {
        const r = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { walk(r); continue; }
        if (asWritten.some((re) => re.test(r))) continue;
        if (readFileSync(join(staging, r)).includes(Buffer.from(fx.old))) hits.push(r);
      }
    };
    walk("");
    expect(hits).toEqual([]);
    applyStagedCopy(home);
    const db = new Database(join(home, "sessions", "index.db"), { readonly: true });
    const rows = db.query("SELECT session_id, cwd FROM sessions ORDER BY session_id").all() as { session_id: string; cwd: string }[];
    const note = db.query("SELECT text FROM notes").get() as { text: string };
    db.close();
    expect(rows[0]!.cwd).toBe(join(resolve(home), "scratch", "alpha"));
    expect(rows[1]!.cwd).toBe("/Users/someone/project");
    // A path's start only: text that merely mentions the old path is as it was.
    expect(note.text).toBe(`a talk about ${join(fx.old, "x")}`);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).workingDirectories).toEqual([join(resolve(home), "scratch", "alpha")]);
    // History as it was written.
    expect(readFileSync(join(home, "sessions", "bot", "s_alpha.jsonl"), "utf8")).toContain(fx.old);
  });

  test("the old engine running: nothing is copied, before or after", async () => {
    const { fx, home } = setup();
    const before = treeHash(fx.old);
    await expect(copyOldHome({ oldHome: fx.old, home, alive: async () => ({ alive: true, how: "its endpoint answers" }) })).rejects.toBeInstanceOf(OldEngineRunning);
    expect(existsSync(oldHomePaths(home).staging)).toBe(false);
    // It came up while the copy ran: the staged copy is discarded.
    let asked = 0;
    await expect(copyOldHome({ oldHome: fx.old, home, alive: async () => ({ alive: asked++ > 0, how: "its lock names a live process" }) })).rejects.toBeInstanceOf(OldEngineRunning);
    expect(existsSync(oldHomePaths(home).staging)).toBe(false);
    expect(existsSync(oldHomePaths(home).complete)).toBe(false);
    expect(stagedCopyReady(home)).toBe(false);
    expect(applyStagedCopy(home)).toEqual({ kind: "none" });
    expect(treeHash(fx.old)).toBe(before);
  });

  test("a crash mid-copy leaves the home as it was, and the next start offers again; the copy then finishes", async () => {
    const { fx, home } = setup();
    const homeBefore = treeHash(home);
    let n = 0;
    await expect(copyOldHome({ oldHome: fx.old, home, alive: notAlive, afterFile: () => { if (++n === 10) throw new Error("power cut"); } })).rejects.toThrow("power cut");
    // A real cut leaves the staging folder behind (the catch above removed it; put a half one back as a cut would).
    mkdirSync(join(oldHomePaths(home).staging, "sessions"), { recursive: true });
    writeFileSync(join(oldHomePaths(home).staging, "settings.json"), "{}");
    expect(applyStagedCopy(home)).toEqual({ kind: "discarded" });
    expect(existsSync(oldHomePaths(home).staging)).toBe(false);
    expect(readChoice(home)).toBeUndefined();
    // As it was, but for the copy's own (now empty) records folder.
    rmSync(join(home, "migration"), { recursive: true, force: true });
    expect(treeHash(home)).toBe(homeBefore);
    await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    expect(applyStagedCopy(home).kind).toBe("swapped");
    expect(readChoice(home)?.choice).toBe("copied");
  });

  test("a start cut short during the swap finishes it at the next start", async () => {
    const { fx, home } = setup();
    await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    const p = oldHomePaths(home);
    // The journal written and the first entries moved, then the cut: do the first two steps by hand.
    const entries = readdirSync(p.staging).sort();
    writeFileSync(p.journal, JSON.stringify({ v: 1, at: 5, from: fx.old, entries }));
    mkdirSync(join(p.replaced, "5"), { recursive: true });
    const { renameSync } = await import("node:fs");
    renameSync(join(home, "sessions"), join(p.replaced, "5", "sessions"));
    renameSync(join(p.staging, "sessions"), join(home, "sessions"));
    renameSync(join(home, "settings.json"), join(p.replaced, "5", "settings.json")); // set aside, not yet replaced
    const r = applyStagedCopy(home);
    expect(r.kind).toBe("swapped");
    expect(existsSync(p.journal)).toBe(false);
    expect(existsSync(p.staging)).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).notifications).toEqual({ sound: "soft" });
    expect(readChoice(home)).toEqual({ v: 1, choice: "copied", at: 5, from: fx.old });
    expect(existsSync(join(home, "sessions", "index.db"))).toBe(true);
    expect(existsSync(join(p.replaced, "5", "sessions"))).toBe(true);
  });
});

describe("the records read from folders the walk leaves out", () => {
  test.skipIf(process.platform === "win32")("a folder that is a link is never read through", async () => {
    const { root, fx, home } = setup();
    // Each folder moved out of the old home and a link left in its place.
    for (const d of ["plugins-state", "credentials", "devices"]) {
      const { renameSync, symlinkSync } = await import("node:fs");
      renameSync(join(fx.old, d), join(root, `moved-${d}`));
      symlinkSync(join(root, `moved-${d}`), join(fx.old, d));
    }
    await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    const p = oldHomePaths(home);
    expect(JSON.parse(readFileSync(p.carry, "utf8"))).toEqual(carryFromOldRegistry(undefined));
    expect(JSON.parse(readFileSync(p.leftBehind, "utf8"))).toEqual(leftBehindFrom({}));
  });
});

describe("the swap cut short between its two moves", () => {
  test("the fresh entry set aside and the start's setup made its folders again: they go, and the staged entry moves in", async () => {
    const { fx, home } = setup();
    await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    const p = oldHomePaths(home);
    const entries = readdirSync(p.staging).sort();
    writeFileSync(p.journal, JSON.stringify({ v: 1, at: 7, from: fx.old, entries }));
    mkdirSync(join(p.replaced, "7"), { recursive: true });
    const { renameSync } = await import("node:fs");
    // The cut: the fresh `sessions/` set aside, the staged one not yet moved in.
    renameSync(join(home, "sessions"), join(p.replaced, "7", "sessions"));
    // The next start's setup (`bootstrapMossDir`) makes the home's folders again, empty, before the swap resumes.
    mkdirSync(join(home, "sessions", "transcripts"), { recursive: true });
    const r = applyStagedCopy(home);
    expect(r.kind).toBe("swapped");
    expect(existsSync(join(home, "sessions", "index.db"))).toBe(true);
    expect(existsSync(join(p.replaced, "7", "sessions"))).toBe(true);
    expect(existsSync(join(p.replaced, "7", "sessions.1"))).toBe(false);
    expect(existsSync(p.journal)).toBe(false);
    expect(readChoice(home)?.choice).toBe("copied");
  });

  test("anything but empty folders at the target then is set aside beside the first, under a numbered name", async () => {
    const { fx, home } = setup();
    await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    const p = oldHomePaths(home);
    const entries = readdirSync(p.staging).sort();
    writeFileSync(p.journal, JSON.stringify({ v: 1, at: 8, from: fx.old, entries }));
    mkdirSync(join(p.replaced, "8"), { recursive: true });
    const { renameSync } = await import("node:fs");
    renameSync(join(home, "sessions"), join(p.replaced, "8", "sessions"));
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "made-since.txt"), "kept\n");
    // And a migration record already set aside by the cut start, with one at its place again.
    const migFile = readdirSync(join(p.staging, "migration"), { recursive: true, withFileTypes: true }).find((e) => e.isFile());
    expect(migFile).toBeDefined();
    const migRel = join(relative(join(p.staging, "migration"), migFile!.parentPath), migFile!.name);
    mkdirSync(dirname(join(home, "migration", migRel)), { recursive: true });
    writeFileSync(join(home, "migration", migRel), "second\n");
    mkdirSync(dirname(join(p.replaced, "8", "migration", migRel)), { recursive: true });
    writeFileSync(join(p.replaced, "8", "migration", migRel), "first\n");
    expect(applyStagedCopy(home).kind).toBe("swapped");
    expect(existsSync(join(home, "sessions", "index.db"))).toBe(true);
    expect(readFileSync(join(p.replaced, "8", "sessions.1", "made-since.txt"), "utf8")).toBe("kept\n");
    expect(readFileSync(join(p.replaced, "8", "migration", migRel), "utf8")).toBe("first\n");
    expect(readFileSync(join(p.replaced, "8", "migration", `${migRel}.1`), "utf8")).toBe("second\n");
  });
});

describe("the registry's carried records", () => {
  test("switches, order and picks are written through the registry's own signed store; no OK carries", async () => {
    const { fx, home } = setup();
    await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    applyStagedCopy(home);
    const carry = JSON.parse(readFileSync(oldHomePaths(home).carry, "utf8"));
    expect(carry).toEqual({
      v: 1,
      order: [NEW_ROOT_PLUGIN, `${NEW_ROOT_PLUGIN}/forwarder`, `${NEW_ROOT_PLUGIN}/voice`, "acceptance-echo"],
      plugins: { [`${NEW_ROOT_PLUGIN}/forwarder`]: { enabled: true }, [`${NEW_ROOT_PLUGIN}/voice`]: { enabled: false, appParts: false }, "acceptance-echo": { enabled: true } },
      active: { [`${NEW_ROOT_PLUGIN}/voice.provider`]: { pluginId: `${NEW_ROOT_PLUGIN}/voice`, entryId: "fish" } },
    });
    // Through the real file store with this engine's key: what it reads back verifies.
    const key = new Uint8Array(32).fill(7);
    let counters: Record<string, number> = {};
    const tampered: string[] = [];
    const store = fileRegistryStore(join(home, "plugins-state"), { macKey: key, counters, onCounters: (c) => { counters = c; }, onTampered: (f) => tampered.push(f) });
    store.save({ v: 1, order: ["alpha"], plugins: { alpha: { enabled: true } }, dev: [] });
    expect(applyCarry(home, store)).toBe(true);
    const reread = fileRegistryStore(join(home, "plugins-state"), { macKey: key, counters, onTampered: (f) => tampered.push(f) }).load();
    expect(tampered).toEqual([]);
    expect(reread.order).toEqual([NEW_ROOT_PLUGIN, `${NEW_ROOT_PLUGIN}/forwarder`, `${NEW_ROOT_PLUGIN}/voice`, "acceptance-echo", "alpha"]);
    expect(reread.plugins["acceptance-echo"]).toEqual({ enabled: true });
    expect(reread.plugins[`${NEW_ROOT_PLUGIN}/voice`]).toEqual({ enabled: false, appParts: false });
    expect(reread.plugins.alpha).toEqual({ enabled: true });
    expect(reread.dev).toEqual([]);
    expect(reread.active).toEqual({ [`${NEW_ROOT_PLUGIN}/voice.provider`]: { pluginId: `${NEW_ROOT_PLUGIN}/voice`, entryId: "fish" } });
    // Once.
    expect(existsSync(oldHomePaths(home).carry)).toBe(false);
    expect(applyCarry(home, memoryRegistryStore())).toBe(false);
  });
});

describe("the models the old install ran on", () => {
  test("their providers are named for their keys to be entered again, from the settings and the bots' records", () => {
    const records = [
      JSON.stringify({ provider: { model: "codex-oauth/gpt-5.6-sol" }, providers: { anthropic: { baseUrl: "http://127.0.0.1:1" } } }),
      JSON.stringify({ bot: "alpha", layers: [{ model: "anthropic/claude-fable-5" }] }),
      JSON.stringify({ model: "not a qualified id" }),
      "not json",
    ];
    expect(modelProvidersOf(records)).toEqual(["anthropic", "codex-oauth"]);
    const left = leftBehindFrom({ modelRecords: records });
    expect(left.models).toEqual(["anthropic", "codex-oauth"]);
    expect(leftBehindLines(left)[0]).toStartWith("Sign in again or enter your keys again for: Anthropic; Codex.");
    // A provider named by its own sign-in already is not named twice.
    const both = leftBehindLines({ ...left, plugins: [{ pluginId: "moss/model-anthropic", names: ["anthropic:default"] }] });
    expect(both[0]).toStartWith("Sign in again or enter your keys again for: Anthropic (anthropic:default); Codex.");
  });
});

describe("what does not come over", () => {
  test("named from the old home's non-secret records, and said in plain words", async () => {
    const { fx, home } = setup();
    await copyOldHome({ oldHome: fx.old, home, alive: notAlive });
    const left = JSON.parse(readFileSync(oldHomePaths(home).leftBehind, "utf8"));
    expect(left).toEqual({ v: 1, core: ["codex-oauth:default"], plugins: [{ pluginId: `${NEW_ROOT_PLUGIN}/anthropic`, names: ["anthropic:default"] }], webhooks: 1, devices: [{ name: "Pocket", kind: "phone" }] });
    const lines = leftBehindLines(left);
    expect(lines[0]).toStartWith("Sign in again or enter your keys again for: Codex; Anthropic (anthropic:default).");
    expect(lines.join("\n")).toContain("Pair these devices again: Pocket (phone).");
    expect(lines.join("\n")).toContain("webhook has a new key");
    expect(lines.join("\n")).not.toContain("plugin-registry");
  });
});
