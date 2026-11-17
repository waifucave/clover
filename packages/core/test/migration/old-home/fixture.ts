// An old install's home, built from nothing for the copy's tests: what the old engine left on disk, its names as they
// were (the old root plugin, its standing server's tools, its turn ledger, the old manifest file name and SDK import),
// two SQLite databases in WAL mode with committed pages only in the WAL and a transaction's pages that never committed,
// an installed third-party plugin, saved "always" rules, a signed registry, and what must not travel. Never a real
// home: everything is under a temp folder the test made.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ruleDisplay, ruleKeyHash } from "../../../src/approvals/strings";
import {
  OLD_HOME_INSTRUCTIONS, OLD_MANIFEST_FILE, OLD_MCP_PREFIX, OLD_PLUGIN_SDK, OLD_ROOT_PLUGIN, OLD_SDK_CONFIG, OLD_USAGE_LEDGER,
} from "../../../src/migration/old-home/names";

const R = OLD_ROOT_PLUGIN;

function put(root: string, rel: string, data: string | Buffer, mode = 0o600): void {
  const at = join(root, ...rel.split("/"));
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, data, { mode });
}

/** A WAL database at `rel` holding `committed` rows (only in its WAL: no checkpoint ran) and a transaction's spilled
 *  pages that never committed; the files are snapshotted while the writer still holds them, as a cut-off engine
 *  leaves them. Returns the WAL's size with only the committed frames and with the spilled ones. */
function walDb(root: string, scratch: string, rel: string, committed: string[]): { walCommitted: number; walWithSpill: number } {
  const src = join(scratch, rel.replace(/\//g, "_"));
  const db = new Database(src);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA wal_autocheckpoint=0");
  db.run("CREATE TABLE fixture_rows (id INTEGER PRIMARY KEY, v TEXT)");
  for (const v of committed) db.run("INSERT INTO fixture_rows (v) VALUES (?)", [v]);
  const walCommitted = lstatSync(`${src}-wal`).size;
  // A small page cache that spills: the open transaction's pages go to the WAL with no commit frame after them.
  db.run("PRAGMA cache_size=10");
  db.run("PRAGMA cache_spill=1");
  db.run("BEGIN");
  for (let i = 0; i < 600; i++) db.run("INSERT INTO fixture_rows (v) VALUES (?)", [`UNCOMMITTED-${i}-${"x".repeat(3000)}`]);
  const walWithSpill = lstatSync(`${src}-wal`).size;
  const at = join(root, ...rel.split("/"));
  mkdirSync(dirname(at), { recursive: true });
  for (const side of ["", "-wal", "-shm"]) if (existsSync(`${src}${side}`)) copyFileSync(`${src}${side}`, `${at}${side}`);
  db.run("ROLLBACK");
  db.close();
  return { walCommitted, walWithSpill };
}

export interface OldHomeFixture {
  old: string;
  wal: { usage: { walCommitted: number; walWithSpill: number }; routines: { walCommitted: number; walWithSpill: number } };
  ruleKeys: { mapped: string; plain: string };
}

/** Builds the old home at `<user>/<dirName>`. */
export function buildOldHome(user: string, scratch: string, dirName = ".old-home"): OldHomeFixture {
  const old = join(user, dirName);
  mkdirSync(old, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  put(old, "settings.json", `${JSON.stringify({
    schemaVersion: 1, notifications: { sound: "soft" }, mcp: { toolPermissions: { web: { WebSearch: "allow" } }, toolsOwner: { web: `${R}/web`, "acceptance-echo-echo": "acceptance-echo" }, toolsSeen: { web: ["WebSearch"] } },
    workingDirectories: [join(old, "scratch", "alpha")],
  }, null, 2)}\n`);
  put(old, `settings/plugins/${R}/settings.json`, `${JSON.stringify({ "notifications.needsYou": false })}\n`);
  put(old, `settings/plugins/${R}.json`, `${JSON.stringify({ theme: "dark" })}\n`);
  put(old, "settings/plugins/acceptance-echo.json", `${JSON.stringify({ greeting: "hi" })}\n`);
  put(old, `settings/plugin-stores/${R}/voice.json`, `${JSON.stringify({ last: "fish" })}\n`);
  put(old, "levels/mcp-servers.json", `${JSON.stringify({ plugins: { [`${R}/web`]: true, "acceptance-echo": true }, servers: { web: false } })}\n`);
  put(old, "trust/agent-oks.json", `${JSON.stringify({ v: 1, oks: [{ backend: "codex", plugin: `${R}/agents`, at: 1 }] })}\n`);
  put(old, `plugin-data/${R}/state.json`, `${JSON.stringify({ seen: 3 })}\n`);
  put(old, "plugin-data/acceptance-echo/data.txt", "echo data\n");
  // The installed third-party plugin (its manifest under the old name, the old SDK import, tokens, schemes).
  put(old, `plugins/acceptance-echo/${OLD_MANIFEST_FILE}`, `${JSON.stringify({ id: "acceptance-echo", name: "Echo", requires: [`${R}/settings`], contributes: { mcpServers: { echo: { type: "host" } } } }, null, 2)}\n`);
  put(old, "plugins/acceptance-echo/index.ts", `import { definePlugin } from "${OLD_PLUGIN_SDK}";\nimport { Card } from "${OLD_PLUGIN_SDK}/ui";\nconst dir = process.env.CLOVER_PLUGIN_DIR;\nexport default definePlugin({ id: "acceptance-echo", icon: "clover-asset://icon.png", call: "${OLD_MCP_PREFIX}web__WebSearch" });\n`);
  put(old, "plugins/acceptance-echo/style.css", ".card { color: var(--clover-color-text); background: url(clover-plugin://acceptance-echo/bg.png); }\n");
  put(old, "plugins/acceptance-echo/node_modules/dep/index.js", `module.exports = "${OLD_PLUGIN_SDK}";\n`);
  put(old, "plugins/acceptance-echo/icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  put(old, "plugins/.acceptance-echo.previous-abc123/index.ts", "old version\n");
  // The registry's signed records (the MAC is the old key's: unverifiable here).
  const body = JSON.stringify({
    v: 1, order: [R, `${R}/forwarder`, `${R}/voice`, "acceptance-echo"], dev: [{ path: "/somewhere", by: "cli", addedAt: 1, expiresAt: 2 }],
    plugins: { [`${R}/forwarder`]: { enabled: true }, [`${R}/voice`]: { enabled: false, appParts: false }, "acceptance-echo": { enabled: true, okHash: `sha256:${"a".repeat(64)}`, source: "folder" } },
    active: { [`${R}/voice.provider`]: { pluginId: `${R}/voice`, entryId: "fish" } },
  });
  put(old, "plugins-state/installed.json", `${JSON.stringify({ body, gen: 7, mac: "f".repeat(64) })}\n`);
  put(old, "plugins-state/oks/acceptance-echo.json", `${JSON.stringify({ body: "{}", gen: 1, mac: "0".repeat(64) })}\n`);
  put(old, "plugins-state/adult.json", `${JSON.stringify({ body: "{\"confirmedAt\":1}", gen: 1, mac: "0".repeat(64) })}\n`);
  // Saved rules: one whose display is its key (re-hashed), one that names no old tool, one whose display was scrubbed.
  const mapped = `tool:${OLD_MCP_PREFIX}web__WebSearch`;
  const plain = "tool:mcp__acceptance-echo-echo__echo";
  const scrubbed = `tool:${OLD_MCP_PREFIX}x__Fetch token=SECRETVALUE`;
  put(old, "rules/saved-rules.json", `${JSON.stringify({
    version: 2,
    rules: [
      { keyHash: ruleKeyHash(mapped), display: ruleDisplay(mapped), computers: ["Studio"], cardId: "card_1", savedAt: 1, bot: "alpha" },
      { keyHash: ruleKeyHash(plain), display: ruleDisplay(plain), computers: ["Studio"], cardId: "card_2", savedAt: 2, bot: "alpha" },
      { keyHash: ruleKeyHash(scrubbed), display: ruleDisplay(scrubbed), computers: ["Studio"], cardId: "card_3", savedAt: 3 },
    ],
  }, null, 2)}\n`);
  // Conversations, memory, bots, routines: copied as they are.
  put(old, "sessions/bot/s_alpha.jsonl", `${JSON.stringify({ type: "input", text: `look in ${join(old, "scratch", "alpha")}` })}\n`);
  put(old, "memory/notes.md", "# notes\nremember the meadow\n");
  put(old, "bots/alpha/bot.json", `${JSON.stringify({ id: "alpha", name: "Alpha" })}\n`);
  put(old, "bots/alpha/memory/MEMORY.md", "alpha's memory\n");
  put(old, "bots/alpha/routines/daily.md", "---\nid: r_1\n---\nsay hi\n");
  put(old, "scratch/alpha/work.txt", "scratch\n");
  put(old, "transcripts/t1.jsonl", "{}\n");
  put(old, "audit.jsonl", "{}\n");
  put(old, OLD_HOME_INSTRUCTIONS, "# the home's instructions\n");
  put(old, `sdk/${OLD_SDK_CONFIG}`, `${JSON.stringify({ mcpServers: { blender: { command: "blender-mcp" } }, allowed: [`${OLD_MCP_PREFIX}research__Search`] }, null, 2)}\n`);
  put(old, `sdk/${OLD_HOME_INSTRUCTIONS}`, "# the runtime home's instructions\n");
  put(old, "sdk/agents/helper.md", "an agent\n");
  put(old, "migration/c/CURRENT_LAYOUT", "1\n");
  put(old, "migration/manifest.json", "{\"status\":\"complete\"}\n");
  // What never travels.
  put(old, "run/core.lock", `${JSON.stringify({ pid: 999_999_999 })}\n`);
  put(old, "run/harness-token", "token\n");
  // The secret store's file and key files a Windows or Linux install keeps in its home (dummy values).
  put(old, "secrets.enc", "PROBE_SECRET=dummy123\n");
  put(old, "secrets.key", "dummy-key\n");
  put(old, "secrets.key.cred", "dummy-cred\n");
  // Text that isn't UTF-8, in a copied file and in a plugin's file: copied as its bytes.
  mkdirSync(join(old, "notes"), { recursive: true });
  writeFileSync(join(old, "notes", "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  put(old, "logs/daemon.log", "a log line\n");
  put(old, "cache/thing.bin", "cache\n");
  put(old, "bin/daemon/x", "binary\n");
  put(old, "login/label.plist", "<plist/>\n");
  put(old, "update/state.json", "{}\n");
  put(old, "install.json", `${JSON.stringify({ kind: "desktop" })}\n`);
  put(old, "credentials/index.json", `${JSON.stringify({
    version: 1,
    items: {
      a: { ref: { owner: { kind: "plugin", pluginId: `${R}/anthropic` }, name: "anthropic:default" }, generation: 1, updatedAt: 1, synced: true },
      b: { ref: { owner: { kind: "core" }, name: "plugin-registry-mac" }, generation: 1, updatedAt: 1, synced: true },
      c: { ref: { owner: { kind: "core" }, name: "routine-webhook:r_1" }, generation: 1, updatedAt: 1, synced: true },
      d: { ref: { owner: { kind: "core" }, name: "codex-oauth:default" }, generation: 1, updatedAt: 1, synced: true },
      e: { ref: { owner: { kind: "device" }, name: "device-key" }, generation: 1, updatedAt: 1, synced: false },
    },
  })}\n`);
  put(old, "devices/registry.json", `${JSON.stringify({ v: 1, self: "d_self", devices: [{ id: "d_self", name: "Studio", kind: "desktop" }, { id: "d_phone", name: "Pocket", kind: "phone" }] })}\n`);
  put(old, "runtimes/backups/old.db.bak", "backup\n");
  // Databases: two in WAL mode with committed pages only in the WAL and uncommitted spilled pages; one plain.
  const usage = walDb(old, scratch, OLD_USAGE_LEDGER, ["usage-1", "usage-2", "usage-3"]);
  const routines = walDb(old, scratch, "routines.db", ["routine-1", "routine-2"]);
  {
    const src = join(scratch, "index.db");
    const db = new Database(src);
    // The session store's own columns (sessions/store.ts), and a table of text that merely mentions the old path.
    db.run("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at INTEGER NOT NULL, last_seq INTEGER NOT NULL, cwd TEXT)");
    db.run("INSERT INTO sessions VALUES (?, 'bot', 1, 0, ?)", ["s_alpha", join(old, "scratch", "alpha")]);
    db.run("INSERT INTO sessions VALUES (?, 'code', 2, 0, ?)", ["s_code", "/Users/someone/project"]);
    db.run("CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT)");
    db.run("INSERT INTO notes VALUES ('n1', ?)", [`a talk about ${join(old, "x")}`]);
    db.close();
    mkdirSync(join(old, "sessions"), { recursive: true });
    copyFileSync(src, join(old, "sessions", "index.db"));
  }
  {
    const src = join(scratch, "runtime-state.db");
    const db = new Database(src);
    db.run("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");
    db.run("INSERT INTO kv VALUES ('schema', '21')");
    db.close();
    mkdirSync(join(old, "runtimes"), { recursive: true });
    copyFileSync(src, join(old, "runtimes", "runtime-state.db"));
  }
  writeFileSync(join(old, "plugins", "acceptance-echo", "latin1.css"), Buffer.from([0x2f, 0x2a, 0xe9, 0x2a, 0x2f, 0x0a]));
  // Links: relative inside, absolute inside, one leading out; and a hard link (not on Windows, where making a link
  // needs a privilege a test run doesn't have).
  if (process.platform !== "win32") {
    symlinkSync(join("sdk", "agents"), join(old, "agents"));
    symlinkSync(join(old, "memory"), join(old, "bots", "alpha", "shared-memory"));
    symlinkSync(scratch, join(old, "bots", "alpha", "outside"));
    // Into the old home, but to what the copy leaves out; and one in a bot's memory: both left out.
    symlinkSync(join(old, "run"), join(old, "bots", "alpha", "run-link"));
    symlinkSync(join("..", "..", "secrets.key"), join(old, "bots", "alpha", "key-link"));
    symlinkSync(join("..", "..", "..", "memory", "notes.md"), join(old, "bots", "alpha", "memory", "notes-link.md"));
    linkSync(join(old, "memory", "notes.md"), join(old, "bots", "alpha", "notes-hard.md"));
  }
  return { old, wal: { usage, routines }, ruleKeys: { mapped, plain } };
}

/** Every entry of a tree with its kind, mode and content (a link: its text), as one hash: equal hashes, equal trees,
 *  byte for byte. */
export function treeHash(root: string): string {
  const h = createHash("sha256");
  const walk = (rel: string) => {
    const abs = rel === "" ? root : join(root, rel);
    for (const name of readdirSync(abs).sort()) {
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(join(root, r));
      h.update(`${r}\0${st.mode}\0`);
      if (st.isSymbolicLink()) h.update(`link:${readlinkSync(join(root, r))}\0`);
      else if (st.isDirectory()) { h.update("dir\0"); walk(r); }
      else if (st.isFile()) { h.update(`file:${st.size}\0`); h.update(readFileSync(join(root, r))); }
      else h.update("other\0");
    }
  };
  walk("");
  return h.digest("hex");
}
