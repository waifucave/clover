// A running stdio MCP server stops when it may no longer run here (the adversarial review of stage 1): its plugin
// switched off, its OK revoked, its tree changed (the OK no longer covers it), the plugin removed, or this computer
// unticked for the server. Each case runs a REAL server process through lane J's launcher, opened by lane A's
// PluginMcp, which also starts a child of its own; after the change, both pids are gone within the bound and the
// launcher holds nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Listeners } from "../../src/contracts/common";
import type { Contribution, PluginRecord, RegistryChange } from "../../src/contracts/plugin-registry";
import { StdioMcpLauncher } from "../../src/computers/stdio-mcp";
import { PluginMcp } from "../../src/runtime-sdk/turn-loop/plugin-mcp";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** An MCP stdio server that, at start, starts a long-lived child of its own and writes both pids to the file it's given. */
const SERVER = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.argv[2], JSON.stringify({ leader: process.pid, child: child.pid }));
let buf = "";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } } });
    else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "Echo", inputSchema: { type: "object" } }] } });
    else out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
  }
});
`;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function until(what: string, ms: number, ok: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(50);
  }
}

/** The plugin's world: its record (switch, OK, tree), its stdio entry, and this computer's tick, each changeable. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "lane-j-stdio-stops-"));
  temps.push(dir);
  writeFileSync(join(dir, "server.js"), SERVER);
  const pids = join(dir, "pids.json");
  const watchers = new Listeners<RegistryChange>();
  const state = { removed: false, enabled: true, okHash: "t1" as string | undefined, treeHash: "t1", ticked: true };
  const entry = { point: "mcpServers", pluginId: "acme", ref: "mcpServers/files", entryId: "files", value: { name: "files", type: "stdio", command: "bun", tools: { "*": "preload" } }, state: "active" } as unknown as Contribution;
  const registry = {
    entries: (point: string) => (point === "mcpServers" && !state.removed ? [entry] : []),
    get: (id: string) => (id !== "acme" || state.removed ? undefined : { id, source: "user", folder: dir, enabled: state.enabled, state: state.enabled ? "running" : "disabled", treeHash: state.treeHash, ...(state.okHash === undefined ? {} : { okHash: state.okHash }) } as unknown as PluginRecord),
    watch: (fn: (c: RegistryChange) => void) => watchers.add(fn),
  };
  const launcher = new StdioMcpLauncher({
    prepare: async () => ({ config: { command: process.execPath, args: [join(dir, "server.js"), pids] }, cwd: dir, release: () => {} }),
    stopGraceMs: 500,
  });
  const mcp = new PluginMcp({
    registry: registry as never, host: { openMcp: async () => { throw new Error("not the plugin host"); } } as never,
    self: () => "Studio", computers: () => (state.ticked ? ["Studio"] : []), stdio: launcher,
  });
  /** The registry's change for this plugin, as the real one emits it (a state change, then its entries). */
  const changed = (): void => {
    if (state.removed) watchers.emit({ type: "removed", id: "acme" } as RegistryChange);
    else watchers.emit({ type: "plugin", id: "acme", state: state.enabled ? "running" : "disabled" } as RegistryChange);
    watchers.emit({ type: "entries", point: "mcpServers" });
  };
  return { dir, pids, state, mcp, launcher, changed };
}

async function started(w: ReturnType<typeof world>): Promise<{ leader: number; child: number }> {
  await w.mcp.refresh();
  expect(w.mcp.placement("acme-files")).toEqual({ name: "acme-files", kind: "local", computers: ["Studio"] });
  await until("the server and its child to start", 10_000, () => existsSync(w.pids));
  const p = JSON.parse(readFileSync(w.pids, "utf8")) as { leader: number; child: number };
  expect(alive(p.leader)).toBe(true);
  expect(alive(p.child)).toBe(true);
  return p;
}

async function gone(w: ReturnType<typeof world>, p: { leader: number; child: number }): Promise<void> {
  // Bounded: the stop's SIGTERM, then SIGKILL after the grace (500 ms here), for the whole group.
  await until("the server and its child to be gone", 5_000, () => !alive(p.leader) && !alive(p.child));
  expect(w.mcp.placement("acme-files")).toBeUndefined();
}

describe("a running stdio server stops when it may no longer run here", () => {
  const cases: [string, (w: ReturnType<typeof world>) => void][] = [
    ["its plugin switched off", (w) => { w.state.enabled = false; w.changed(); }],
    ["its OK revoked", (w) => { w.state.okHash = undefined; w.changed(); }],
    ["its tree changed (the OK no longer covers it)", (w) => { w.state.treeHash = "t2"; w.changed(); }],
    ["its plugin removed", (w) => { w.state.removed = true; w.changed(); }],
    // The node tells the host of a tick change (`onTicksChanged`, node.ts); the host lists again.
    ["this computer unticked for it", (w) => { w.state.ticked = false; void w.mcp.refresh(); }],
  ];
  for (const [what, change] of cases) {
    test(what, async () => {
      if (process.platform === "win32") return;
      const w = world();
      try {
        const p = await started(w);
        change(w);
        await gone(w, p);
      } finally {
        w.mcp.close();
        await w.launcher.close();
      }
    }, 20_000);
  }
});
