// A plugin's stdio MCP servers on this computer (`stdio-mcp.ts`): started per open, stopped on every path with what
// they wrote released once, crashes delayed and counted, and a plugin that crashed 3 times in 10 minutes stopped with
// its reason until it is restarted. Real processes (a small MCP server on the test's Bun), temp folders only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpChannel } from "../../src/contracts/plugin-host";
import { ensurePluginRunFiles } from "../../src/registry/plugin-run";
import { PluginSecretFiles, secretFilesFolder } from "../../src/registry/secret-files";
import { pluginStdioPrepare, StdioMcpLauncher, type StdioServerSpec } from "../../src/computers/stdio-mcp";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A small MCP server: `initialize`, `tools/list` (Echo, Crash, Spawn) and `tools/call`. `MODE=crash-at-start` exits
 *  at once; `Crash` exits with code 3; `Spawn` leaves a child running in its group; `Big` writes one huge line. */
const SERVER = `
const mode = process.env.MODE ?? "ok";
if (mode === "crash-at-start") { console.error("boom: no config"); process.exit(2); }
console.error("server up " + process.pid);
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
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } } });
    else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "Echo", inputSchema: { type: "object" } }] } });
    else if (m.method === "tools/call") {
      const name = m.params.name;
      if (name === "Crash") { console.error("crashing on purpose"); process.exit(3); }
      if (name === "Spawn") {
        const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(c.pid) }] } });
        continue;
      }
      if (name === "Big") { process.stdout.write("x".repeat(5000)); continue; }
      if (name === "Env") { out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ key: process.env.KEY_FILE ? require("node:fs").readFileSync(process.env.KEY_FILE, "utf8") : null, cwd: process.cwd(), leak: process.env.CLOVER_TEST_LEAK ?? null }) }] } }); continue; }
      out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(m.params.arguments) }] } });
    }
  }
});
`;

function fixture(): string {
  const dir = temp("lane-j-stdio-");
  writeFileSync(join(dir, "server.js"), SERVER);
  return dir;
}

/** A JSON-RPC request over a channel, answered or failed when the channel closes. */
function request(ch: McpChannel, id: number, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const off = ch.onMessage((m) => {
      if (m.id !== id) return;
      off();
      clearInterval(poll);
      resolve(m);
    });
    const poll = setInterval(() => {
      if (!ch.closed) return;
      off();
      clearInterval(poll);
      reject(new Error("closed"));
    }, 10);
    ch.send({ jsonrpc: "2.0", id, method, params });
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A launcher over the fixture, counting each start's release. */
function rig(o: { mode?: () => string; clock?: { now(): number }; sleep?: (ms: number) => Promise<void>; lineMax?: number } = {}) {
  const dir = fixture();
  const releases: string[] = [];
  const starts: string[] = [];
  const restarted: string[] = [];
  let n = 0;
  const launcher = new StdioMcpLauncher({
    prepare: async (pluginId, server): Promise<StdioServerSpec> => {
      const id = `${pluginId}/${server}#${++n}`;
      starts.push(id);
      return { config: { command: process.execPath, args: [join(dir, "server.js")], env: { MODE: o.mode?.() ?? "ok" } }, cwd: join(dir, "data"), release: () => releases.push(id) };
    },
    stopGraceMs: 500,
    onRestart: (id) => restarted.push(id),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.lineMax ? { lineMax: o.lineMax } : {}),
  });
  return { launcher, releases, starts, restarted };
}

describe("a stdio server's life", () => {
  test("it starts per open, speaks MCP over its stdio, and a normal stop ends its group and releases once", async () => {
    const { launcher, releases } = rig();
    const ch = await launcher.openMcp("acme/tools", "echo");
    expect((await request(ch, 1, "initialize")).result).toMatchObject({ protocolVersion: "2025-06-18" });
    expect((await request(ch, 2, "tools/list")).result).toEqual({ tools: [{ name: "Echo", inputSchema: { type: "object" } }] });
    expect((await request(ch, 3, "tools/call", { name: "Echo", arguments: { a: 1 } })).result).toEqual({ content: [{ type: "text", text: '{"a":1}' }] });
    // A child it left running in its group goes with it.
    const grandchild = Number(((await request(ch, 4, "tools/call", { name: "Spawn", arguments: {} })).result as { content: { text: string }[] }).content[0]!.text);
    const pid = launcher.running()[0]!.pid!;
    expect(alive(pid) && alive(grandchild)).toBe(true);
    ch.close();
    await until(() => launcher.running().length === 0);
    await until(() => !alive(pid));
    // The whole tree goes (a process group on POSIX, `taskkill /T` on Windows).
    await until(() => !alive(grandchild));
    expect(releases).toEqual(["acme/tools/echo#1"]);
    expect(launcher.state("acme/tools")).toEqual({ crashes: 0 });
    // A send after the stop says so.
    expect(() => ch.send({ jsonrpc: "2.0", id: 9, method: "tools/list" })).toThrow("stopped");
  });

  test("a second open replaces the first: stopped and released before the next one's prepare", async () => {
    const { launcher, releases, starts } = rig();
    const first = await launcher.openMcp("acme/tools", "echo");
    const second = await launcher.openMcp("acme/tools", "echo");
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(starts).toEqual(["acme/tools/echo#1", "acme/tools/echo#2"]);
    expect(releases).toEqual(["acme/tools/echo#1"]);
    expect(launcher.running()).toHaveLength(1);
    await launcher.close();
    expect(releases).toEqual(["acme/tools/echo#1", "acme/tools/echo#2"]);
  });

  test("a crash closes its channel, releases, counts, and the next open waits 1 s after it", async () => {
    const sleeps: number[] = [];
    const { launcher, releases } = rig({ sleep: async (ms) => { sleeps.push(ms); } });
    const ch = await launcher.openMcp("acme/tools", "echo");
    await request(ch, 1, "initialize");
    await expect(request(ch, 2, "tools/call", { name: "Crash", arguments: {} })).rejects.toThrow("closed");
    await until(() => releases.length === 1);
    expect(launcher.state("acme/tools")).toEqual({ crashes: 1 });
    const again = await launcher.openMcp("acme/tools", "echo");
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]!).toBeGreaterThan(900);
    expect(sleeps[0]!).toBeLessThanOrEqual(1000);
    expect((await request(again, 1, "initialize")).result).toBeDefined();
    await launcher.close();
    expect(releases).toHaveLength(2);
  });

  test("3 crashes in 10 minutes stop the plugin with its reason; restart clears it and has the host list again", async () => {
    const { launcher, releases, restarted } = rig({ mode: () => "crash-at-start", sleep: async () => {} });
    for (let i = 1; i <= 3; i++) {
      await launcher.openMcp("acme/tools", "echo");
      await until(() => releases.length === i);
    }
    const s = launcher.state("acme/tools");
    expect(s.crashes).toBe(3);
    expect(s.stopped).toContain("crashed 3 times in 10 minutes");
    // What it printed stays out of the reason (a tool's answer); Settings reads it.
    expect(s.stopped).not.toContain("boom");
    expect(launcher.lastLines("acme/tools")).toEqual(["boom: no config"]);
    const err = await launcher.openMcp("acme/tools", "other").catch((e: { code?: string; message: string }) => e);
    expect(err).toMatchObject({ code: "plugin_stopped" });
    expect((err as Error).message).toStartWith("plugin stopped: it crashed 3 times");
    // Another plugin isn't touched.
    expect(launcher.state("acme/other")).toEqual({ crashes: 0 });
    launcher.restart("acme/tools");
    expect(restarted).toEqual(["acme/tools"]);
    expect(launcher.state("acme/tools")).toEqual({ crashes: 0 });
    await launcher.openMcp("acme/tools", "echo");
    await until(() => releases.length === 4);
    await launcher.close();
  });

  test("the delay doubles with crashes in a row, up to 1 minute; a run that lasted the window starts it again", async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const { launcher, releases } = rig({
      mode: () => "crash-at-start",
      clock: { now: () => now },
      // Each wait passes 11 minutes, so the window never holds 3 crashes and the plugin keeps restarting.
      sleep: async (ms) => { sleeps.push(ms); now += 11 * 60_000; },
    });
    for (let i = 1; i <= 9; i++) {
      await launcher.openMcp("acme/tools", "echo");
      await until(() => releases.length === i);
    }
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(launcher.state("acme/tools").stopped).toBeUndefined();
  });

  test("untick (stop), plugin removal (stopPlugin) and shutdown (close) each stop and release, none counted as a crash", async () => {
    const { launcher, releases } = rig();
    await launcher.openMcp("acme/tools", "a");
    await launcher.openMcp("acme/tools", "b");
    await launcher.openMcp("acme/other", "c");
    await launcher.stop("acme/tools", "a");
    expect(releases).toEqual(["acme/tools/a#1"]);
    await launcher.stopPlugin("acme/tools");
    expect(releases.sort()).toEqual(["acme/tools/a#1", "acme/tools/b#2"]);
    await launcher.close();
    expect(releases.sort()).toEqual(["acme/other/c#3", "acme/tools/a#1", "acme/tools/b#2"]);
    expect(launcher.running()).toEqual([]);
    for (const p of ["acme/tools", "acme/other"]) expect(launcher.state(p)).toEqual({ crashes: 0 });
    // Nothing starts after the shutdown.
    await expect(launcher.openMcp("acme/tools", "a")).rejects.toMatchObject({ code: "closed" });
  });

  test("a line over the cap ends it as a crash; a prepare that throws starts nothing and counts nothing", async () => {
    const { launcher, releases } = rig({ lineMax: 1000 });
    const ch = await launcher.openMcp("acme/tools", "echo");
    await request(ch, 1, "initialize");
    await expect(request(ch, 2, "tools/call", { name: "Big", arguments: {} })).rejects.toThrow("closed");
    await until(() => releases.length === 1);
    expect(launcher.state("acme/tools").crashes).toBe(1);
    const failing = new StdioMcpLauncher({ prepare: async () => { throw new Error("secret KEY is not set"); } });
    await expect(failing.openMcp("acme/tools", "echo")).rejects.toThrow("secret KEY is not set");
    expect(failing.state("acme/tools")).toEqual({ crashes: 0 });
    await launcher.close();
  });
});

describe("pluginStdioPrepare", () => {
  test("lane B's resolver: the secret file exists while it runs and is gone after a crash and after a stop; it starts in its data folder with only its own environment", async () => {
    const home = temp("lane-j-stdio-home-");
    const root = join(home, "plugins", "acme");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "server.js"), SERVER);
    const entry = { type: "stdio", name: "keyed", command: process.execPath, args: [join(root, "server.js")], env: { KEY_FILE: "${secretFile:API_KEY}", MODE: "${setting:mode}" } };
    const registry = {
      entries: () => [{ point: "mcpServers", pluginId: "acme", ref: "mcpServers/keyed", entryId: "keyed", value: entry, state: "active" as const }],
      get: (id: string) => (id === "acme" ? ({ folder: root } as never) : undefined),
    };
    const guard = { files: ensurePluginRunFiles(join(home, "run", "plugin-host"), { cloverHome: home }), shared: [], fence: false as const };
    const asked: string[] = [];
    const prepare = pluginStdioPrepare({
      registry, guard, secretFiles: new PluginSecretFiles(home),
      dataDir: (id) => join(home, "plugin-data", id),
      settings: () => ({ account: { mode: "ignored" }, device: { mode: "ok" } }),
      secrets: () => ({ get: async (name: string) => { asked.push(name); return name === "API_KEY" ? { value: { reveal: () => "sk-test-value" } as never } : null; } }),
    });
    process.env.CLOVER_TEST_LEAK = "should-not-pass";
    const launcher = new StdioMcpLauncher({ prepare, stopGraceMs: 500, sleep: async () => {} });
    try {
      const folder = join(secretFilesFolder(home, "acme"), "keyed");
      const ch = await launcher.openMcp("acme", "keyed");
      await request(ch, 1, "initialize");
      const seen = JSON.parse((((await request(ch, 2, "tools/call", { name: "Env", arguments: {} })).result as { content: { text: string }[] }).content[0]!.text));
      expect(seen).toEqual({ key: "sk-test-value", cwd: realpathSync(join(home, "plugin-data", "acme")), leak: null });
      expect(asked).toEqual(["API_KEY"]);
      expect(existsSync(folder)).toBe(true);
      // A crash removes it.
      await expect(request(ch, 3, "tools/call", { name: "Crash", arguments: {} })).rejects.toThrow("closed");
      await until(() => !existsSync(folder));
      // Started again, then stopped: written again, removed again.
      const again = await launcher.openMcp("acme", "keyed");
      await request(again, 1, "initialize");
      expect(existsSync(folder)).toBe(true);
      again.close();
      await until(() => !existsSync(folder));
      // An entry that isn't there starts nothing.
      await expect(launcher.openMcp("acme", "missing")).rejects.toMatchObject({ code: "not_installed" });
      expect(readFileSync(join(root, "server.js"), "utf8")).toBe(SERVER);
    } finally {
      delete process.env.CLOVER_TEST_LEAK;
      await launcher.close();
    }
  });
});
