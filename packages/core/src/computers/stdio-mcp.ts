// A plugin's `stdio` MCP servers, run on this computer (spec §5.1, §5.4, §9.1; the controller's assignment to lane J).
// A stdio server is a local server: it runs on the computers ticked for it (`mcp-ticks.ts`), and the bots on every
// computer reach it through `McpRouter`. Lane A's `PluginMcp` lists, keys, scopes and calls it exactly as a `host`
// server, through this launcher's `openMcp` (the `PluginHost.openMcp` contract) in place of the plugin host's.
//
// * **Started** through lane B's `resolvedPluginStdioMcpServer`: the plugin's guarded environment, its fence
//   (`toolFence`: its own folders, its tree's network proxy, its secret files) and its `${…}` filled in, in its data
//   folder. One process per open: the channel is its stdin and stdout, a JSON-RPC message per line (MCP's stdio
//   transport). The channel ignores the caller (`as`): a stdio server makes no plugin API calls to bind.
// * **Stopped** on every path, each releasing what `resolvedPluginStdioMcpServer` wrote (its secret files) exactly once:
//   the channel's close (the normal stop: `PluginMcp` closes it when the server is unticked, its plugin goes or the
//   daemon stops), a crash (the process exits on its own), `stop` (one server, unticked here), `stopPlugin` (the
//   plugin removed) and `close` (the daemon stops). A stop ends the whole process group: SIGTERM, then SIGKILL after
//   the grace.
// * **Crashes** (§5.1, "Crashes and logs"): a server that exits on its own is a crash of its plugin on this computer.
//   The next open waits 1 second after it, the wait doubling with each crash in a row up to 1 minute (a run that lasted
//   the whole window starts the count again). After 3 crashes in 10 minutes the plugin stops here: every open of its
//   servers answers "plugin stopped: <reason>" (`plugin_stopped`), which its tools then answer (lane A keeps the last
//   listing), until `restart`, which has the MCP host list them again. Nothing restarts on its
//   own: a crashed server starts again at its next open, so none runs that nothing wants.
// * **Bounded:** a line from the server over `lineMax` (8 MiB) ends it as a crash; the last 50 lines of its stderr are
//   kept, each cut to 1,000 characters, for the plugin's log and Settings (`lastLines`), never in the reason a tool
//   answers: a server may print its own key.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { parseInterpolation } from "@waifucave/clover-plugin-sdk";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { McpChannel } from "../contracts/plugin-host";
import type { Contribution, PluginRegistry } from "../contracts/plugin-registry";
import type { Secret } from "../contracts/secret-store";
import type { PluginRunGuard } from "../registry/plugin-run";
import type { PluginSecretFiles } from "../registry/secret-files";
import { resolvedPluginStdioMcpServer } from "../runtime-sdk/external-mcp";

/** A server ready to start: its command (guarded and fenced), the folder it starts in, and what to undo when it stops. */
export interface StdioServerSpec {
  config: { command: string; args?: string[]; env?: Record<string, string> };
  cwd: string;
  /** Undoes what preparing it did (its secret files). Called once, whenever it stops. */
  release(): void;
}

/** Prepares `server` (its name in the manifest) of `pluginId` to start; throws when it can't (a missing setting or
 *  secret: it never starts half-configured). */
export type StdioPrepare = (pluginId: string, server: string) => Promise<StdioServerSpec>;

export const STDIO_MCP_FIRST_DELAY_MS = 1_000;
export const STDIO_MCP_MAX_DELAY_MS = 60_000;
export const STDIO_MCP_CRASH_WINDOW_MS = 10 * 60_000;
export const STDIO_MCP_CRASHES_TO_STOP = 3;
export const STDIO_MCP_LINE_MAX = 8 * 1024 * 1024;
const STOP_GRACE_MS = 3_000;
const STDERR_LINES = 50;
const STDERR_LINE_MAX = 1_000;

/** The names a server's process takes from Clover's own environment; everything else is its config's (`guardedMcpServer`
 *  sets PATH and the guard's), as the MCP stdio transport does. */
const BASE_ENV = process.platform === "win32"
  ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"]
  : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

export interface StdioMcpLauncherOptions {
  prepare: StdioPrepare;
  clock?: { now(): number };
  log?: (line: string) => void;
  /** Each line a server writes to stderr (the plugin's log, `logs/plugins/<id>.log`). */
  stderr?: (pluginId: string, server: string, line: string) => void;
  /** Told after `restart`: the MCP host lists the plugin's servers again (lane A's `PluginMcp.refresh`), which clears
   *  their stopped listing. */
  onRestart?: (pluginId: string) => void;
  /** Waits the crash delay (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** How long a stop waits after SIGTERM before SIGKILL. */
  stopGraceMs?: number;
  lineMax?: number;
}

/** One plugin's crashes on this computer. */
interface PluginCrashes {
  /** When each crash in the window was. */
  times: number[];
  /** Crashes in a row (a run that lasted the window starts it again), for the delay. */
  streak: number;
  last?: number;
  stopped?: string;
  /** The last stderr lines of its last crash, for Settings (never in the reason). */
  lines?: string[];
}

interface Running {
  pluginId: string;
  server: string;
  child: ChildProcess;
  channel: StdioChannel;
  spec: StdioServerSpec;
  startedAt: number;
  stopping: boolean;
  released: boolean;
  exited: Promise<void>;
  stderr: string[];
  /** Why it ended, when it ended on its own. */
  crash?: string;
}

class StdioChannel implements McpChannel {
  #closed = false;
  readonly #listeners = new Listeners<Record<string, unknown>>();
  constructor(private readonly write: (line: string) => void, private readonly stop: () => void) {}

  get closed(): boolean {
    return this.#closed;
  }

  send(message: Record<string, unknown>): void {
    if (this.#closed) throw new ContractError("closed", "the MCP server stopped");
    this.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(fn: (message: Record<string, unknown>) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stop();
  }

  /** The process ended (or is ending): nothing more is sent or heard. */
  ended(): void {
    this.#closed = true;
  }

  deliver(message: Record<string, unknown>): void {
    if (!this.#closed) this.#listeners.emit(message);
  }
}

const keyOf = (pluginId: string, server: string) => `${pluginId}\u0000${server}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class StdioMcpLauncher {
  readonly #o: StdioMcpLauncherOptions;
  readonly #now: () => number;
  readonly #running = new Map<string, Running>();
  readonly #crashes = new Map<string, PluginCrashes>();
  /** Each server's opens and stops, one at a time. */
  readonly #queue = new Map<string, Promise<unknown>>();
  #closed = false;

  constructor(o: StdioMcpLauncherOptions) {
    this.#o = o;
    this.#now = () => (o.clock ?? Date).now();
  }

  /** Starts `server` of `pluginId` and answers its channel (`PluginHost.openMcp`'s contract). A running one is stopped
   *  first (one process per server). */
  openMcp(pluginId: string, server: string): Promise<McpChannel> {
    return this.#serial(pluginId, server, () => this.#open(pluginId, server));
  }

  /** Stops one server here (unticked); its plugin's crash record stays. */
  stop(pluginId: string, server: string): Promise<void> {
    return this.#serial(pluginId, server, () => this.#stop(this.#running.get(keyOf(pluginId, server))));
  }

  /** Stops every server of `pluginId` (removed), and forgets its crashes. */
  async stopPlugin(pluginId: string): Promise<void> {
    const mine = [...this.#running.values()].filter((r) => r.pluginId === pluginId);
    await Promise.all(mine.map((r) => this.stop(r.pluginId, r.server)));
    this.#crashes.delete(pluginId);
  }

  /** The user restarts a stopped plugin: its crashes are forgotten, and its servers start at their next open. */
  restart(pluginId: string): void {
    this.#crashes.delete(pluginId);
    try {
      this.#o.onRestart?.(pluginId);
    } catch (err) {
      this.#o.log?.(`stdio MCP ${pluginId}: the MCP host didn't take the restart: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Why `pluginId` stopped here, if it did, and its crashes in the window. */
  state(pluginId: string): { stopped?: string; crashes: number } {
    const c = this.#crashes.get(pluginId);
    return { crashes: c?.times.length ?? 0, ...(c?.stopped === undefined ? {} : { stopped: c.stopped }) };
  }

  /** The last stderr lines of `pluginId`'s last crash here (Settings shows them, §5.1); empty when none. */
  lastLines(pluginId: string): string[] {
    return [...(this.#crashes.get(pluginId)?.lines ?? [])];
  }

  /** The servers running now, as `pluginId`/`server`. */
  running(): { pluginId: string; server: string; pid?: number }[] {
    return [...this.#running.values()].map((r) => ({ pluginId: r.pluginId, server: r.server, ...(r.child.pid === undefined ? {} : { pid: r.child.pid }) }));
  }

  /** The daemon stops: every server stops, and nothing starts again. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#running.values()].map((r) => this.#stop(r)));
  }

  #serial<T>(pluginId: string, server: string, run: () => Promise<T>): Promise<T> {
    const key = keyOf(pluginId, server);
    const next = (this.#queue.get(key) ?? Promise.resolve()).then(run, run);
    const settled = next.then(() => {}, () => {});
    this.#queue.set(key, settled);
    void settled.then(() => {
      if (this.#queue.get(key) === settled) this.#queue.delete(key);
    });
    return next;
  }

  #refuseIfStopped(pluginId: string): void {
    if (this.#closed) throw new ContractError("closed", "Clover is stopping");
    const stopped = this.#crashes.get(pluginId)?.stopped;
    if (stopped !== undefined) throw new ContractError("plugin_stopped", `plugin stopped: ${stopped}`);
  }

  async #open(pluginId: string, server: string): Promise<McpChannel> {
    this.#refuseIfStopped(pluginId);
    await this.#stop(this.#running.get(keyOf(pluginId, server)));
    const c = this.#crashes.get(pluginId);
    if (c !== undefined && c.streak > 0 && c.last !== undefined) {
      const delay = Math.min(STDIO_MCP_FIRST_DELAY_MS * 2 ** (c.streak - 1), STDIO_MCP_MAX_DELAY_MS);
      const left = c.last + delay - this.#now();
      if (left > 0) await (this.#o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(left);
      this.#refuseIfStopped(pluginId);
    }
    const spec = await this.#o.prepare(pluginId, server);
    if (this.#closed) {
      spec.release();
      throw new ContractError("closed", "Clover is stopping");
    }
    return this.#spawn(pluginId, server, spec);
  }

  #spawn(pluginId: string, server: string, spec: StdioServerSpec): McpChannel {
    const env: Record<string, string> = {};
    for (const k of BASE_ENV) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, spec.config.env ?? {});
    try {
      mkdirSync(spec.cwd, { recursive: true, mode: 0o700 });
    } catch {
      // The spawn says why it can't start there.
    }
    let child: ChildProcess;
    try {
      child = nodeSpawn(spec.config.command, spec.config.args ?? [], {
        cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
      });
    } catch (err) {
      spec.release();
      throw new ContractError("failed", `${server} couldn't start: ${err instanceof Error ? err.message : String(err)}`);
    }
    let resolveExited!: () => void;
    const exited = new Promise<void>((r) => { resolveExited = r; });
    const r: Running = {
      pluginId, server, child, spec, startedAt: this.#now(), stopping: false, released: false, exited, stderr: [],
      channel: undefined as unknown as StdioChannel,
    };
    r.channel = new StdioChannel(
      (line) => {
        if (child.stdin?.writable) child.stdin.write(line);
        else throw new ContractError("closed", "the MCP server stopped");
      },
      () => { void this.#stop(r); },
    );
    this.#running.set(keyOf(pluginId, server), r);
    child.stdin?.on("error", () => {});
    // Its messages, a line each, held to the line cap.
    let buffer = "";
    const lineMax = this.#o.lineMax ?? STDIO_MCP_LINE_MAX;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (isObject(message)) r.channel.deliver(message);
      }
      if (buffer.length > lineMax) {
        buffer = "";
        r.crash ??= `${server} sent a line over ${lineMax} bytes`;
        this.#kill(r);
      }
    });
    // Its stderr: the plugin's log, and the last lines for the reason.
    let errBuffer = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      errBuffer += chunk;
      const lines = errBuffer.split("\n");
      errBuffer = (lines.pop() ?? "").slice(-STDERR_LINE_MAX);
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "").slice(0, STDERR_LINE_MAX);
        if (line.trim() === "") continue;
        r.stderr.push(line);
        if (r.stderr.length > STDERR_LINES) r.stderr.shift();
        this.#o.stderr?.(pluginId, server, line);
      }
    });
    const ended = (why: string) => {
      if (r.released) return;
      r.channel.ended();
      // What it left running in its group goes with it.
      this.#signalGroup(child, "SIGKILL");
      this.#release(r);
      if (this.#running.get(keyOf(pluginId, server)) === r) this.#running.delete(keyOf(pluginId, server));
      if (!r.stopping) this.#crashed(r, r.crash ?? why);
      resolveExited();
    };
    child.on("error", (err) => ended(`${server} couldn't start: ${err.message}`));
    // The reason names how it ended, never what it printed: it reaches the bots' tool results, and a server may print
    // its own key. Its last lines go to the plugin's log and `state` (Settings) only.
    child.on("exit", (code, signal) => ended(`${server} exited ${signal !== null ? `on ${signal}` : `with code ${code ?? "?"}`}`));
    return r.channel;
  }

  #release(r: Running): void {
    if (r.released) return;
    r.released = true;
    try {
      r.spec.release();
    } catch (err) {
      this.#o.log?.(`stdio MCP ${r.pluginId}/${r.server}: its files couldn't be removed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #crashed(r: Running, reason: string): void {
    const now = this.#now();
    const c = this.#crashes.get(r.pluginId) ?? { times: [], streak: 0 };
    if (now - r.startedAt >= STDIO_MCP_CRASH_WINDOW_MS) c.streak = 0;
    c.streak++;
    c.last = now;
    c.lines = [...r.stderr];
    c.times = [...c.times.filter((t) => now - t < STDIO_MCP_CRASH_WINDOW_MS), now];
    if (c.times.length >= STDIO_MCP_CRASHES_TO_STOP) c.stopped = `it crashed ${c.times.length} times in 10 minutes (last: ${reason})`;
    this.#crashes.set(r.pluginId, c);
    this.#o.log?.(`stdio MCP ${r.pluginId}/${r.server}: crashed (${reason})${c.stopped === undefined ? "" : `; the plugin stopped on this computer`}`);
  }

  #signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  }

  #kill(r: Running): void {
    this.#signalGroup(r.child, "SIGKILL");
  }

  /** Stops `r` on purpose (not a crash) and waits for it; its files are released whatever happens. */
  async #stop(r: Running | undefined): Promise<void> {
    if (r === undefined || r.released) return;
    r.stopping = true;
    r.channel.ended();
    this.#signalGroup(r.child, "SIGTERM");
    const grace = this.#o.stopGraceMs ?? STOP_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([r.exited, new Promise<void>((res) => { timer = setTimeout(res, grace); })]);
    clearTimeout(timer);
    if (!r.released) {
      this.#kill(r);
      await Promise.race([r.exited, new Promise<void>((res) => { timer = setTimeout(res, 1_000); })]);
      clearTimeout(timer);
    }
    // Released even if the process never said it exited.
    this.#release(r);
    if (this.#running.get(keyOf(r.pluginId, r.server)) === r) this.#running.delete(keyOf(r.pluginId, r.server));
  }
}

/** A plugin's stdio entry as its manifest gives it. */
interface StdioEntry {
  type: "stdio";
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** The daemon's `prepare`: `server` (by name) of `pluginId` from the registry's active `mcpServers` entries, its
 *  settings read once, the secrets its `${secret:…}` and `${secretFile:…}` name fetched for this start only, and lane
 *  B's `resolvedPluginStdioMcpServer` (the guard, the fence, the proxy, the secret files), started in its data folder. */
export function pluginStdioPrepare(o: {
  registry: Pick<PluginRegistry, "entries" | "get">;
  guard: PluginRunGuard;
  /** `pluginDataFolder(cloverHome, id)`. */
  dataDir: (pluginId: string) => string;
  /** The plugin's own settings (`filePluginSettings(cloverHome).read(id)`): a device value wins over the account's. */
  settings: (pluginId: string) => { account: Record<string, unknown>; device: Record<string, unknown> };
  /** The plugin's own secrets (`pluginHost.pluginSecrets.forPlugin(id)`). */
  secrets: (pluginId: string) => { get(name: string): Promise<{ value: Secret } | null> };
  secretFiles: PluginSecretFiles;
}): StdioPrepare {
  const nameOf = (c: Contribution) => (c.value as { name?: string }).name ?? c.entryId ?? c.ref.split("/").pop()!;
  return async (pluginId, server) => {
    const c = o.registry.entries("mcpServers").find((e) => e.pluginId === pluginId && e.state === "active" && isObject(e.value) && e.value.type === "stdio" && nameOf(e) === server);
    const folder = o.registry.get(pluginId)?.folder;
    if (c === undefined || folder === undefined) throw new ContractError("not_installed", `${pluginId} has no stdio MCP server ${server} here`);
    const entry = c.value as StdioEntry;
    if (typeof entry.command !== "string") throw new ContractError("invalid", `${pluginId}'s MCP server ${server} has no command`);
    // The secrets it names, fetched now and dropped once it's prepared.
    const names = new Set<string>();
    for (const v of [entry.command, ...(entry.args ?? []), ...Object.values(entry.env ?? {})]) {
      const parsed = parseInterpolation(v);
      if (!parsed.ok) continue;
      for (const p of parsed.parts) if (p.kind === "secret" || p.kind === "secretFile") names.add(p.key);
    }
    const store = o.secrets(pluginId);
    const secrets = new Map<string, string>();
    for (const name of names) {
      const v = await store.get(name);
      if (v !== null) secrets.set(name, v.value.reveal());
    }
    const settings = o.settings(pluginId);
    const dataDir = o.dataDir(pluginId);
    try {
      const { config, release } = resolvedPluginStdioMcpServer(entry, folder, o.guard, {
        pluginId, server, dataDir, secretFiles: o.secretFiles,
        setting: (k) => {
          const v = Object.prototype.hasOwnProperty.call(settings.device, k) ? settings.device[k] : Object.prototype.hasOwnProperty.call(settings.account, k) ? settings.account[k] : undefined;
          return v === undefined || v === null ? undefined : String(v);
        },
        secret: (k) => secrets.get(k),
      });
      const c2 = config as { command: string; args?: string[]; env?: Record<string, string> };
      return { config: { command: c2.command, ...(c2.args === undefined ? {} : { args: c2.args }), ...(c2.env === undefined ? {} : { env: c2.env }) }, cwd: dataDir, release };
    } finally {
      secrets.clear();
    }
  };
}
