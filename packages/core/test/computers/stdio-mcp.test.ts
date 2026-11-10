// A plugin's stdio MCP servers on this computer (`stdio-mcp.ts`): started per open, stopped on every path with what
// they wrote released once, crashes delayed and counted, and a plugin that crashed 3 times in 10 minutes stopped with
// its reason until it is restarted. Real processes (a small MCP server on the test's Bun), temp folders only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpChannel } from "../../src/contracts/plugin-host";
import { ensurePluginRunFiles } from "../../src/registry/plugin-run";
import { PluginSecretFiles, secretFilesFolder } from "../../src/registry/secret-files";
import { pluginStdioPrepare, reapStdioMcpLeftovers, reapTargets, StdioMcpLauncher, stdioStderrLog, type SeenProcess, type StdioServerSpec } from "../../src/computers/stdio-mcp";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

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
if (mode === "big-exit") { process.stdout.write("x".repeat(5000)); process.exit(4); }
if (mode === "flood") { for (let i = 0; i < 50; i++) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { i } }) + "\\n"); }
if (mode === "no-read") { setInterval(() => {}, 1000); }
console.error("server up " + process.pid);
let buf = "";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
if (mode !== "no-read") process.stdin.setEncoding("utf8");
if (mode !== "no-read") process.stdin.on("data", (c) => {
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
function rig(o: { mode?: () => string; clock?: { now(): number }; sleep?: (ms: number) => Promise<void>; lineMax?: number; stdinMax?: number; messagesPerSecond?: number; records?: string; onRelease?: () => void } = {}) {
  const dir = fixture();
  const releases: string[] = [];
  const starts: string[] = [];
  const restarted: string[] = [];
  const logs: string[] = [];
  let n = 0;
  const launcher = new StdioMcpLauncher({
    prepare: async (pluginId, server): Promise<StdioServerSpec> => {
      const id = `${pluginId}/${server}#${++n}`;
      starts.push(id);
      return { config: { command: process.execPath, args: [join(dir, "server.js")], env: { MODE: o.mode?.() ?? "ok" } }, cwd: join(dir, "data"), release: () => { o.onRelease?.(); releases.push(id); } };
    },
    stopGraceMs: 500,
    onRestart: (id) => restarted.push(id),
    log: (l) => logs.push(l),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.lineMax ? { lineMax: o.lineMax } : {}),
    ...(o.stdinMax ? { stdinMax: o.stdinMax } : {}),
    ...(o.messagesPerSecond ? { messagesPerSecond: o.messagesPerSecond } : {}),
    ...(o.records ? { records: o.records } : {}),
  });
  return { launcher, releases, starts, restarted, logs };
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

describe("bounds and signals", () => {
  test("no signal reaches its group id after it exited, but the one sweep (a late chunk of its output kills nothing)", async () => {
    const calls: number[] = [];
    const real = process.kill;
    let pid = 0;
    let atRelease = -1;
    process.kill = ((p: number, sig?: string | number) => {
      if (p === -pid) calls.push(p);
      return real.call(process, p, sig as never);
    }) as typeof process.kill;
    try {
      const { launcher, releases } = rig({ mode: () => "big-exit", lineMax: 1000, onRelease: () => { atRelease = calls.length; } });
      await launcher.openMcp("acme/tools", "echo");
      pid = launcher.running()[0]?.pid ?? 0;
      await until(() => releases.length === 1);
      await new Promise((r) => setTimeout(r, 200));
      // Every call happened by the time it was released (the sweep is the last); none after.
      expect(calls.length).toBe(atRelease);
      expect(calls.length).toBeLessThanOrEqual(2);
      await launcher.close();
    } finally {
      process.kill = real;
    }
  });

  test("a server that stops reading its input is ended as a crash once its waiting input passes the cap", async () => {
    const { launcher, releases } = rig({ mode: () => "no-read", stdinMax: 256 * 1024 });
    const ch = await launcher.openMcp("acme/tools", "echo");
    const big = "y".repeat(16 * 1024);
    let err: unknown;
    for (let i = 0; i < 200 && err === undefined; i++) {
      try {
        ch.send({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "Echo", arguments: { big } } });
      } catch (e) {
        err = e;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    expect((err as Error).message).toContain("stopped reading its input");
    await until(() => releases.length === 1);
    expect(launcher.state("acme/tools").crashes).toBe(1);
    await launcher.close();
  });

  test("more messages in a second than the cap end it as a crash", async () => {
    const { launcher, releases, logs } = rig({ mode: () => "flood", messagesPerSecond: 10 });
    await launcher.openMcp("acme/tools", "echo");
    await until(() => releases.length === 1);
    expect(logs.some((l) => l.includes("more than 10 messages in a second"))).toBe(true);
    await launcher.close();
  });

  test("its stderr goes to the plugin's log with lane B's caps, each line marked with its server", () => {
    const home = temp("lane-j-stdio-log-");
    let now = 0;
    const write = stdioStderrLog({ cloverHome: home, log: () => {}, now: () => now, perWindow: 2, windowMs: 1000 });
    write("acme/tools", "echo", "one");
    write("acme/tools", "echo", "two");
    write("acme/tools", "echo", "three");
    now = 2000;
    write("acme/tools", "echo", "four");
    const text = readFileSync(join(home, "logs", "plugins", "acme", "tools.log"), "utf8");
    expect(text).toContain("[mcp echo] one");
    expect(text).toContain("[mcp echo] two");
    expect(text).not.toContain("three");
    expect(text).toContain("1 more lines dropped");
    expect(text).toContain("[mcp echo] four");
  });
});

describe("reapTargets", () => {
  const nonce = "a".repeat(32);
  const rec = { pid: 500, startedAt: 1_000_000, nonce, exe: "/opt/bun" };
  const p = (pid: number, o: Partial<SeenProcess> = {}): SeenProcess => ({ pid, pgid: 500, started: 1_000_500, ...o });
  const self = { pid: 1, ppid: 1 };

  test("leader alive, leading its group, the recorded program and start time: its group (marks or not: a restricted binary hides them)", () => {
    expect(reapTargets([rec], [p(500, { program: "/opt/bun" }), p(501), p(502, { marked: nonce })], self)).toEqual({ groups: [500], pids: [] });
    // Another program, another start time, or not leading its own group: a reused pid, so no group; marked ones alone.
    for (const leader of [p(500, { program: "/usr/bin/other" }), p(500, { program: "/opt/bun", started: 1_000_000 + 60_000 }), p(500, { program: "/opt/bun", started: undefined }), p(500, { program: "/opt/bun", pgid: 77 }), p(500)]) {
      expect(reapTargets([rec], [leader, p(501), p(502, { marked: nonce })], self)).toEqual({ groups: [], pids: [502] });
    }
  });

  test("leader gone: only processes visibly carrying the mark, started after the record, each on its own", () => {
    const seen = [p(501), p(502, { marked: nonce }), p(503, { marked: "b".repeat(32) }), p(504, { marked: nonce, started: undefined }), p(505, { marked: nonce, started: 1_000_000 - 10_000 })];
    expect(reapTargets([rec], seen, self)).toEqual({ groups: [], pids: [502] });
  });

  test("never this daemon, its parent or its group, as a leader or a marked process", () => {
    const seen = [p(700, { pgid: 700, marked: nonce }), p(701, { pgid: 9, marked: nonce }), p(702, { pgid: 9, marked: nonce }), p(703, { pgid: 9, marked: nonce })];
    expect(reapTargets([rec], seen, { pid: 701, ppid: 702, pgid: 700 })).toEqual({ groups: [], pids: [703] });
    const ownLeader = { ...rec, pid: 701 };
    expect(reapTargets([ownLeader], [p(701, { pgid: 701, program: "/opt/bun", started: 1_000_000 })], { pid: 701, ppid: 1, pgid: 701 })).toEqual({ groups: [], pids: [] });
  });
});

describe("a daemon that died", () => {
  const posix = process.platform !== "win32";
  const leaderScript = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); process.exit(0);`;
  /** A leader that starts a child and exits (the child keeps its group and environment). */
  const startOrphan = (env: Record<string, string>) => new Promise<{ leader: number; child: number }>((resolve) => {
    const l = spawn(process.execPath, ["-e", leaderScript], { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...env } });
    let out = "";
    l.stdout!.on("data", (d) => { out += d; });
    l.on("exit", () => resolve({ leader: l.pid!, child: Number(out.trim()) }));
  });

  test("leader alive: the next daemon kills its group by the leader's identity", async () => {
    if (!posix) return;
    const records = join(temp("lane-j-stdio-rec-"), "run", "stdio-mcp");
    const { launcher } = rig({ records });
    const ch = await launcher.openMcp("acme/tools", "echo");
    await request(ch, 1, "initialize");
    const grandchild = Number(((await request(ch, 2, "tools/call", { name: "Spawn", arguments: {} })).result as { content: { text: string }[] }).content[0]!.text);
    const pid = launcher.running()[0]!.pid!;
    // The daemon died: nothing stopped its server. The next one reaps.
    const reaped = await reapStdioMcpLeftovers({ dir: records });
    expect(reaped.groups).toEqual([pid]);
    await until(() => !alive(pid) && !alive(grandchild));
    expect(readdirSync(records)).toEqual([]);
    await launcher.close();
  });

  test("leader gone: an orphan carrying the mark is killed; a stranger in a reused-pid group is spared", async () => {
    if (!posix) return;
    const records = join(temp("lane-j-stdio-rec-"), "run", "stdio-mcp");
    mkdirSync(records, { recursive: true });
    const nonce = randomBytes(16).toString("hex");
    const ours = await startOrphan({ CLOVER_STDIO_RUN: nonce });
    writeFileSync(join(records, `${ours.leader}.json`), JSON.stringify({ pid: ours.leader, startedAt: Date.now() - 2_000, nonce, exe: process.execPath, pluginId: "acme/tools", server: "echo" }));
    // The stranger: its leader is gone too, its child carries no mark, and a record names that leader's pid.
    const stranger = await startOrphan({});
    writeFileSync(join(records, `${stranger.leader}.json`), JSON.stringify({ pid: stranger.leader, startedAt: Date.now() - 2_000, nonce: randomBytes(16).toString("hex"), exe: process.execPath, pluginId: "x", server: "y" }));
    expect(alive(ours.child) && alive(stranger.child)).toBe(true);
    const reaped = await reapStdioMcpLeftovers({ dir: records });
    expect(reaped).toEqual({ groups: [], pids: [ours.child] });
    await until(() => !alive(ours.child));
    expect(alive(stranger.child)).toBe(true);
    process.kill(stranger.child, "SIGKILL");
  });

  test("a live process at a recorded pid that isn't the recorded program (a reused pid) is spared with its group", async () => {
    if (!posix) return;
    const records = join(temp("lane-j-stdio-rec-"), "run", "stdio-mcp");
    mkdirSync(records, { recursive: true });
    const other = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(records, `${other.pid}.json`), JSON.stringify({ pid: other.pid, startedAt: Date.now() - 100, nonce: randomBytes(16).toString("hex"), exe: process.execPath }));
    expect(await reapStdioMcpLeftovers({ dir: records })).toEqual({ groups: [], pids: [] });
    expect(alive(other.pid!)).toBe(true);
    process.kill(-other.pid!, "SIGKILL");
  });

  test("the daemon's own pid, its parent and its group are never signalled", async () => {
    const records = join(temp("lane-j-stdio-rec-"), "run", "stdio-mcp");
    mkdirSync(records, { recursive: true });
    const nonce = randomBytes(16).toString("hex");
    writeFileSync(join(records, `${process.pid}.json`), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 1_000, nonce, exe: process.execPath }));
    const signalled: number[] = [];
    const real = process.kill;
    process.kill = ((pid: number) => { signalled.push(pid); return true; }) as typeof process.kill;
    try {
      const reaped = await reapStdioMcpLeftovers({
        dir: records,
        seen: async (marks) => {
          // The reaper hands over only the exact words it looks for.
          expect([...marks.keys()]).toEqual([`CLOVER_STDIO_RUN=${nonce}`]);
          return [
            { pid: process.pid, pgid: process.pid, started: Date.now() - 1_000, program: process.execPath, marked: nonce },
            { pid: process.ppid, pgid: 4242, started: Date.now(), marked: nonce },
            { pid: 999_991, pgid: process.pid, started: Date.now(), marked: nonce },
          ];
        },
      });
      expect(reaped).toEqual({ groups: [], pids: [] });
      expect(signalled).toEqual([]);
    } finally {
      process.kill = real;
    }
  });
});

describe("the reaper's environment reads (the stage 1 review's narrowing)", () => {
  test("only processes started since the earliest record, less the slack, are asked for their environment", async () => {
    const records = join(temp("lane-j-stdio-rec-"), "run", "stdio-mcp");
    mkdirSync(records, { recursive: true });
    const early = Date.now() - 60_000;
    for (const [pid, at] of [[999_981, early], [999_982, early + 10_000]] as const) {
      writeFileSync(join(records, `${pid}.json`), JSON.stringify({ pid, startedAt: at, nonce: randomBytes(16).toString("hex"), exe: process.execPath }));
    }
    let since: number | undefined;
    await reapStdioMcpLeftovers({ dir: records, seen: async (_marks, s) => { since = s; return []; } });
    expect(since).toBe(early - 3_000);
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

/** A stdio server whose one tool, Reach, tries 127.0.0.1:<REACH_PORT> straight (no proxy) and says what happened. */
const REACH_SERVER = `
const { connect } = require("node:net");
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
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "r", version: "1" } } });
    else if (m.method === "tools/call") {
      const s = connect({ host: "127.0.0.1", port: Number(process.env.REACH_PORT) });
      const done = (v) => { s.destroy(); out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: v }] } }); };
      s.setTimeout(2000, () => done("denied"));
      s.once("connect", () => done("reached"));
      s.once("error", () => done("denied"));
    }
  }
});
`;

describe("a wrapped plugin's stdio server (the owner's ruling of 2026-11-10: lane B's grant on its install record)", () => {
  test("with the grant it reaches a host straight; a Clover-native plugin's, under the same fence, doesn't", async () => {
    // The fence is macOS's sandbox here; elsewhere this test has nothing to show.
    if (process.platform !== "darwin") return;
    const home = temp("lane-j-stdio-wrap-");
    const hits: number[] = [];
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { hits.push(1); s.end(); }, data() {} } });
    const entries: { point: string; pluginId: string; ref: string; entryId: string; value: unknown; state: "active" }[] = [];
    const folders: Record<string, string> = {};
    for (const id of ["wrapped", "native"]) {
      const root = join(home, "plugins", id);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "server.js"), REACH_SERVER);
      folders[id] = root;
      entries.push({ point: "mcpServers", pluginId: id, ref: "mcpServers/reach", entryId: "reach", value: { type: "stdio", name: "reach", command: process.execPath, args: [join(root, "server.js")], env: { REACH_PORT: String(listener.port) } }, state: "active" });
    }
    const registry = { entries: () => entries, get: (id: string) => (folders[id] === undefined ? undefined : ({ folder: folders[id] } as never)) };
    // B's guard as the daemon builds it: the fence on, no tree proxy here (a native plugin then reaches no host at all),
    // and the grant read by plugin id (B's `openNetwork`, from the install record).
    const guard = { files: ensurePluginRunFiles(join(home, "run", "plugin-host"), { cloverHome: home }), shared: [], fence: { userHome: temp("lane-j-stdio-wrap-user-") }, openNetwork: (id: string) => id === "wrapped" };
    const prepare = pluginStdioPrepare({
      registry, guard, secretFiles: new PluginSecretFiles(home), dataDir: (id) => join(home, "plugin-data", id),
      settings: () => ({ account: {}, device: {} }), secrets: () => ({ get: async () => null }),
    });
    const launcher = new StdioMcpLauncher({ prepare, stopGraceMs: 500, sleep: async () => {} });
    const reach = async (id: string): Promise<string> => {
      const ch = await launcher.openMcp(id, "reach");
      await request(ch, 1, "initialize");
      const r = await request(ch, 2, "tools/call", { name: "Reach", arguments: {} });
      return (r.result as { content: { text: string }[] }).content[0]!.text;
    };
    try {
      expect(await reach("native")).toBe("denied");
      expect(hits).toHaveLength(0);
      expect(await reach("wrapped")).toBe("reached");
      expect(hits).toHaveLength(1);
    } finally {
      await launcher.close();
      listener.stop(true);
    }
  }, 30_000);
});

