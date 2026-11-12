// A plugin's stdio MCP server follows the files the user picks for it (the coordinator's ruling): its fence is fixed
// when it starts, so a pick added or taken back replaces it; an added pick waits for its calls in flight to end (an
// export isn't cut short) up to a limit, a taken-back one gets the grace. Real servers under the real fence (lane B's
// `pluginStdioPrepare` with the guard on), the real grants store; temp folders only, nothing opens a window.
import { afterAll, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpChannel } from "../../src/contracts/plugin-host";
import { PluginGrants } from "../../src/fence/plugin-grants";
import { ensurePluginRunFiles } from "../../src/registry/plugin-run";
import { PluginSecretFiles } from "../../src/registry/secret-files";
import { pluginStdioPrepare, StdioMcpLauncher } from "../../src/computers/stdio-mcp";
import { darwinTest } from "../helpers/darwin-only";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** `Read` answers a file's text (or "denied"); `Sleep` answers after `ms` (a long export). */
const SERVER = `
const fs = require("node:fs");
let buf = "";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const text = (id, v) => out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: v }] } });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "p", version: "1" } } });
    else if (m.method === "tools/call" && m.params.name === "Read") {
      try { text(m.id, fs.readFileSync(m.params.arguments.path, "utf8")); } catch { text(m.id, "denied"); }
    } else if (m.method === "tools/call" && m.params.name === "Sleep") setTimeout(() => text(m.id, "slept"), m.params.arguments.ms);
  }
});
`;

let nextId = 1;
/** A request over a channel: its answer, or "closed" when the channel closes first. */
function request(ch: McpChannel, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown> | "closed"> {
  const id = nextId++;
  return new Promise((resolve) => {
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
      resolve("closed");
    }, 10);
    ch.send({ jsonrpc: "2.0", id, method, params });
  });
}
const textOf = (r: Record<string, unknown> | "closed") => (r === "closed" ? "closed" : (r.result as { content: { text: string }[] }).content[0]!.text);

darwinTest("a stdio server follows the picks: replaced at once when idle, after its call for an added pick, after the grace for a taken-back one or past the wait", async () => {
  const home = temp("cf-stdio-picks-");
  const userHome = temp("cf-stdio-picks-user-");
  const movies = join(userHome, "Movies");
  mkdirSync(movies, { recursive: true });
  const clip = join(movies, "clip.txt");
  const second = join(movies, "second.txt");
  writeFileSync(clip, "the first clip");
  writeFileSync(second, "the second clip");
  const root = join(home, "plugins", "vid");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "server.js"), SERVER);
  const entries = [{ point: "mcpServers", pluginId: "vid", ref: "mcpServers/cut", entryId: "cut", value: { type: "stdio", name: "cut", command: process.execPath, args: [join(root, "server.js")] }, state: "active" as const }];
  const registry = { entries: () => entries, get: (id: string) => (id === "vid" ? ({ folder: root } as never) : undefined) };
  const grants = new PluginGrants({ cloverHome: home, userHome });
  // The daemon's guard and launcher: the fence on, the picks read from the grants store at each start.
  const guard = { files: ensurePluginRunFiles(join(home, "run", "plugin-host"), { cloverHome: home }), shared: [], fence: { userHome }, picked: (id: string) => grants.fencePaths(id) };
  const prepare = pluginStdioPrepare({
    registry, guard, secretFiles: new PluginSecretFiles(home), dataDir: (id) => join(home, "plugin-data", id),
    settings: () => ({ account: {}, device: {} }), secrets: () => ({ get: async () => null }),
  });
  const launcher = new StdioMcpLauncher({ prepare, stopGraceMs: 500, sleep: async () => {}, picked: (id) => grants.fencePaths(id), pickWaitMs: 3_000, pickGraceMs: 1_000 });
  const changed: Promise<void>[] = [];
  const off = grants.watch((id) => void changed.push(launcher.picksChanged(id)));
  const open = async () => {
    const ch = await launcher.openMcp("vid", "cut");
    await request(ch, "initialize");
    return ch;
  };
  const read = async (ch: McpChannel, path: string) => textOf(await request(ch, "tools/call", { name: "Read", arguments: { path } }));
  const sleep = (ch: McpChannel, ms: number) => request(ch, "tools/call", { name: "Sleep", arguments: { ms } }).then(textOf);
  try {
    // Nothing picked: the user's file is out of reach.
    const ch1 = await open();
    expect(await read(ch1, clip)).toBe("denied");
    // Picked while idle: replaced at once; reopened (the MCP host does so at the next use), it reads the pick.
    grants.add({ pluginId: "vid", token: "grant:a1111111-2222-4333-8444-555555555555", path: clip, kind: "file", access: "read" });
    await Promise.all(changed.splice(0));
    expect(ch1.closed).toBe(true);
    const ch2 = await open();
    expect(await read(ch2, clip)).toBe("the first clip");

    // Picked while a call runs (an export): the call ends normally, then the server is replaced; the next one reads it.
    const exporting = sleep(ch2, 1_500);
    await Bun.sleep(100);
    grants.add({ pluginId: "vid", token: "grant:b1111111-2222-4333-8444-555555555555", path: second, kind: "file", access: "read" });
    await Bun.sleep(300);
    expect(ch2.closed).toBe(false);
    expect(await exporting).toBe("slept");
    await Promise.all(changed.splice(0));
    expect(ch2.closed).toBe(true);
    const ch3 = await open();
    expect(await read(ch3, second)).toBe("the second clip");

    // Taken back while a call runs: the grace (1 s here), then replaced, the call cut short; the file is out of reach.
    const running = sleep(ch3, 20_000);
    await Bun.sleep(100);
    const t0 = Date.now();
    grants.remove("vid", "grant:b1111111-2222-4333-8444-555555555555");
    expect(await running).toBe("closed");
    expect(Date.now() - t0).toBeLessThan(5_000);
    await Promise.all(changed.splice(0));
    const ch4 = await open();
    expect(await read(ch4, second)).toBe("denied");
    expect(await read(ch4, clip)).toBe("the first clip");

    // Picked while a call runs past the wait (3 s here, 10 minutes in Clover): replaced anyway, after the grace.
    const long = sleep(ch4, 30_000);
    await Bun.sleep(100);
    grants.add({ pluginId: "vid", token: "grant:c1111111-2222-4333-8444-555555555555", path: second, kind: "file", access: "read" });
    await Bun.sleep(1_500);
    expect(ch4.closed).toBe(false);
    expect(await long).toBe("closed");
    await Promise.all(changed.splice(0));
    const ch5 = await open();
    expect(await read(ch5, second)).toBe("the second clip");
    // Replacements for picks are no crashes.
    expect(launcher.state("vid").crashes).toBe(0);
  } finally {
    off();
    await launcher.close();
  }
}, 60_000);
