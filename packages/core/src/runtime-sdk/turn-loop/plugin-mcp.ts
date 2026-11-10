// Plugins' own code served as MCP servers (`mcpServers` entries of `type: "host"`, spec §5.4, §6.7, §9.1), for a
// bot's session: their tools listed, placed and called through lane B's plugin host (`PluginHost.openMcp`). Owner:
// lane A. The web plugin's `mcp__clover__WebSearch` and `WebFetch` are the first such server.
//
// * **One channel per (plugin, server),** shared by every session: the caller is per request. Each `tools/call` goes
//   `as` the session's caller, so the plugin API calls the server makes while serving it act as that caller (R7); the
//   listing goes as the plugin. A channel that closed (a crash, a reload) is opened again at the next use, and a
//   request it left unanswered fails `closed`.
// * **The tools** are listed when the registry changes (`refresh`), each with its loading from the manifest (`preload`
//   or `on-demand`, `"*"` the default for the rest, on-demand when it says nothing). A server not listed yet isn't
//   offered; the MCP block reaches the conversation at the next turn once it is (driver.ts).
// * **Placement** (lane J's `McpRouter`): a `stdio` server, and a `host` one marked `perComputer`, is local: it runs on
//   the computers that tick it, and starts here only when this one does (fail closed with no tick list). Any other
//   only talks to the web and runs where the session does (remote), its tools taking J's optional `saveTo`. The router
//   runs a call here through `call`, and files it returns are saved by the router.
// * **stdio servers** open through lane J's launcher (`stdio`, the fenced process with the plugin's key files), and
//   are otherwise the same as host ones: listing, keys, scope, deferral and the prompt's `<mcp-server>` block. A
//   stopped plugin's server (crashed too often) keeps its last listing, and its calls answer why.
// * **Scope:** a server's own `scope`, else its plugin's, says whether bots get it (`both` by default).
// * **Names:** every bundled plugin's tools (registry source `bundled`, top plugin `clover`) read `mcp__clover__…`
//   (§5.3): the web plugin's are `mcp__clover__WebSearch` and `mcp__clover__WebFetch`. Inside, each bundled server
//   keeps its own key, its plain name (`web`), so channels, ticks and listings stay apart by plugin and server; only
//   the session sees `clover` (`BUNDLED_SERVER`), and a call to `clover` finds its server by the tool's name. A tool
//   name two bundled servers both give is refused for both, logged with both named, never first wins. Any other
//   plugin's server is served under the key `pluginMcpServerKey`: `<plugin id, its "/" as "-">-<server>`, a namespace
//   that round-trips through a tool name, so it can't take another's tools. A non-bundled server named like a reserved
//   name (`clover`, `clover_core`) or like any bundled plugin's server is refused and logged. Two servers that come to
//   the same key are refused and logged (never first wins): both of them, unless exactly one is bundled, which keeps
//   the key.
// * Only `host` servers are served here; a plugin's `stdio` and `http` servers are the MCP host's (lanes B and D).
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { topPluginIdOf, type Caller } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../../contracts/common";
import type { McpChannel, PluginHost } from "../../contracts/plugin-host";
import type { Contribution, PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";
import { NAMESPACE_RE } from "@waifucave/clover-plugin-sdk";
import { mcpToolName, parseMcpToolName, placementFields, type McpCaller, type McpFields, type McpResult, type McpServerPlacement, type McpToolDef } from "../../computers/mcp";
import { isBundledClover } from "../model-plugins/load";
import type { BotMcpServer, BotMcpTool, McpRunner } from "./servers";

/** The MCP protocol version the core asks for (the host's servers speak it: the web plugin's `PROTOCOL_VERSIONS`). */
export const PLUGIN_MCP_PROTOCOL_VERSION = "2025-06-18";
/** How long a listing or the handshake may take. */
const LIST_TIMEOUT_MS = 30_000;
/** How long a tool call may take at most (the plugin host's own longest call). */
const CALL_TIMEOUT_MS = 10 * 60_000;
/** How often a waiting request looks whether its channel closed (the channel says nothing when it does). */
const CLOSED_POLL_MS = 1_000;
/** The most an MCP block's instructions may hold (spec §6.1, "about 4 KB"). */
const INSTRUCTIONS_MAX_CHARS = 4_096;
/** The most a tool call's result may hold, as JSON text; past it the content is cut and a marker added. */
export const RESULT_MAX_CHARS = 1_048_576;
/** The server every bundled plugin's tools are offered under (§5.3): `mcp__clover__WebSearch`. */
export const BUNDLED_SERVER = "clover";
/** Server names only the core owns, which no non-bundled plugin may serve under. */
const RESERVED_NAMES: readonly string[] = [BUNDLED_SERVER, "clover_core"];

/** The longest server key. */
export const SERVER_KEY_MAX = 64;

/** Whether `key` can name a server: a namespace (the driver's grammar, lower-case letters and digits joined by single
 *  hyphens, so never `__`), at most `SERVER_KEY_MAX` characters, and it comes back whole from a tool name
 *  (`parseMcpToolName(mcpToolName(key, tool))`), so approvals, saved rules and hooks see the server it is. */
export function isServerKey(key: string): boolean {
  if (key.length > SERVER_KEY_MAX || !NAMESPACE_RE.test(key)) return false;
  const parsed = parseMcpToolName(mcpToolName(key, "Tool"));
  return parsed !== null && parsed.server === key && parsed.tool === "Tool";
}

/** The key a plugin's `host` server is served under (settled with lane J, whose node checks a remote listing against
 *  it): a bundled plugin's server keeps its own `name`; any other's is `<plugin id with its "/" as "-">-<name>`. The
 *  name must already be a namespace (`NAMESPACE_RE`): nothing is escaped, so no two names map to one key by spelling.
 *  Undefined when the result can't name a server (`isServerKey`). The key is never parsed back: which plugin and server
 *  it is comes from the registry. A key two plugins reach by the hyphen (`acme` + `x-y`, `acme-x` + `y`), or one that is
 *  a bundled server's name or a reserved one, is refused for every claimant, here and in a remote listing. */
export function pluginMcpServerKey(pluginId: string, name: string, bundled = false): string | undefined {
  if (!NAMESPACE_RE.test(name)) return undefined;
  const key = bundled ? name : `${pluginId.replace("/", "-")}-${name}`;
  return isServerKey(key) ? key : undefined;
}
/** The note a cut result ends with. */
const TRUNCATED_NOTE = "[result truncated: it was over 1 MiB]";

interface HostServerEntry {
  type: "host" | "stdio" | "http";
  name?: string;
  tools?: Record<string, "preload" | "on-demand">;
  instructions?: string;
  perComputer?: boolean;
  scope?: "bots" | "agents" | "both";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A JSON-RPC client over one `McpChannel`, opened (and opened again after it closes) on demand. */
class ChannelClient {
  #channel: McpChannel | undefined;
  #opening: Promise<McpChannel> | undefined;
  #off: Unsubscribe | undefined;
  #next = 1;
  #closed = false;
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();

  constructor(private readonly open: () => Promise<McpChannel>, private readonly handshakeMs: number = LIST_TIMEOUT_MS) {}

  async #ready(): Promise<McpChannel> {
    if (this.#channel !== undefined && !this.#channel.closed) return this.#channel;
    if (this.#closed) throw new ContractError("closed", "the plugin's MCP channel was closed");
    this.#drop(new ContractError("closed", "the plugin's MCP channel closed"));
    this.#opening ??= (async () => {
      const channel = await this.open();
      if (this.#closed) {
        if (!channel.closed) channel.close();
        throw new ContractError("closed", "the plugin's MCP channel was closed");
      }
      this.#off = channel.onMessage((m) => this.#answer(m));
      this.#channel = channel;
      try {
        await this.#send(channel, "initialize", { protocolVersion: PLUGIN_MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "clover", version: "1" } }, undefined, undefined, this.handshakeMs);
        channel.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      } catch (err) {
        this.#drop(err);
        throw err;
      }
      return channel;
    })().finally(() => { this.#opening = undefined; });
    return this.#opening;
  }

  /** Lets go of the channel, failing what waits on it. */
  #drop(err: unknown): void {
    const channel = this.#channel;
    this.#channel = undefined;
    this.#off?.();
    this.#off = undefined;
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    if (channel !== undefined && !channel.closed) channel.close();
  }

  #answer(m: Record<string, unknown>): void {
    if (typeof m.id !== "number" || (!("result" in m) && !("error" in m))) return;
    const p = this.#pending.get(m.id);
    if (p === undefined) return;
    this.#pending.delete(m.id);
    if (isObject(m.error)) p.reject(new ContractError("failed", typeof m.error.message === "string" ? m.error.message : "the plugin's MCP server answered with an error"));
    else p.resolve(m.result);
  }

  #send(channel: McpChannel, method: string, params: Record<string, unknown>, as: Caller | undefined, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
    const id = this.#next++;
    return new Promise<unknown>((resolve, reject) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const done = () => {
        for (const t of timers) clearTimeout(t);
        clearInterval(watch);
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
      };
      const onAbort = () => {
        done();
        if (!channel.closed) channel.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } });
        reject(new ContractError("cancelled", "the call was cancelled"));
      };
      const watch = setInterval(() => {
        if (!channel.closed) return;
        done();
        reject(new ContractError("closed", "the plugin's MCP channel closed during the call"));
      }, CLOSED_POLL_MS);
      (watch as { unref?: () => void }).unref?.();
      timers.push(setTimeout(() => {
        done();
        reject(new ContractError("timeout", `the plugin's MCP server didn't answer ${method} in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs));
      this.#pending.set(id, { resolve: (v) => { done(); resolve(v); }, reject: (e) => { done(); reject(e); } });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        channel.send({ jsonrpc: "2.0", id, method, params }, as);
      } catch (err) {
        done();
        reject(err);
      }
    });
  }

  async request(method: string, params: Record<string, unknown>, o: { as?: Caller; signal?: AbortSignal; timeoutMs: number }): Promise<unknown> {
    const channel = await this.#ready();
    return this.#send(channel, method, params, o.as, o.signal, o.timeoutMs);
  }

  close(): void {
    this.#closed = true;
    this.#drop(new ContractError("closed", "the plugin's MCP channel was closed"));
  }
}

export interface PluginMcpOptions {
  registry: Pick<PluginRegistry, "entries" | "get" | "watch">;
  /** The plugin host; its `status`, when it has one, says why a server's plugin went (a failed listing's log line). */
  host: Pick<PluginHost, "openMcp"> & Partial<Pick<PluginHost, "status">>;
  /** This computer's name: where a `perComputer` server runs. */
  self(): string;
  log?(line: string): void;
  /** How long one server's listing may take, its `open()` included (default 30 s). */
  listTimeoutMs?: number;
  /** The computers that run a `perComputer` server (lane J's node: each computer ticks its own, `mcpComputers`), none
   *  when none ticks it. Read at each placement, so the prompt's `computer` field follows its next refresh and the
   *  router checks the live list meanwhile. Its process starts here only when this computer is on the list, and it
   *  fails closed: with no list (the option left out, or no node yet), no per-computer server starts here. The host
   *  calls `refresh()` when the ticks change. */
  computers?(server: string): readonly string[];
  /** Per-computer servers another computer runs and lists (lane J's node, `mcpRemoteServers`), ready for the prompt:
   *  placement fields, scope applied, `load` set. They fill only names this computer doesn't list itself. */
  remoteServers?(kind: "bot" | "side-thread" | "agent" | "coding"): readonly BotMcpServer[];
  /** The door to the plugins' `stdio` servers (lane J's `StdioMcpLauncher`: each open spawns the server fenced, a close
   *  stops it and releases what it held). Left out, `stdio` entries aren't served here. */
  stdio?: Pick<PluginHost, "openMcp">;
  /** Why a `host` server can't work in this build, when it can't (its plugin needs `net.fetch`, which can't cross the
   *  plugin host yet: `NET_FETCH_CROSSES_PLUGIN_HOST`). Such a server is neither started nor listed nor waited for;
   *  the reason is logged once, here and in its plugin's own log (`pluginLog`, shown on its Settings page). */
  notServed?(server: { pluginId: string; name: string; type: string }): string | undefined;
  pluginLog?(pluginId: string, line: string): void;
}

/** One per-computer server as this computer lists it, for lane J's node to serve to the others (`mcp.list`): the raw
 *  tools (the node adds the placement fields), their loading, its instructions and scope. */
export interface PluginMcpListing {
  server: string;
  plugin: string;
  /** The server's own name, as its plugin declares it: `server` is `pluginMcpServerKey(plugin, name)`, or `name` itself
   *  for a bundled plugin's server; either way `isServerKey(server)`. */
  name: string;
  /** The name a session sees it under: `clover` (`BUNDLED_SERVER`) for a bundled plugin's server, else `server`. */
  exposed: string;
  tools: (McpToolDef & { load: "preload" | "on-demand" })[];
  instructions?: string;
  scope: "bots" | "agents" | "both";
}

interface Listed {
  plugin: string;
  /** A bundled plugin's server: offered under `clover`, its tools found by name. */
  bundled: boolean;
  /** The server's own name, as its plugin knows it (`server` in `openMcp`); the served key may differ. */
  name: string;
  entry: HostServerEntry;
  tools: McpToolDef[];
  instructions?: string;
  /** Its plugin is stopped (a stdio server that crashed too often, §5.1): its last listing is kept, and its calls
   *  answer this reason. */
  stopped?: string;
}

/** A server that runs on the computers that tick it (local): a `stdio` one always, a `host` one marked `perComputer`
 *  (spec §5.4). */
function isLocal(entry: HostServerEntry): boolean {
  return entry.perComputer === true || entry.type === "stdio";
}

/** A bundled tool offered only while its plugin holds a capability: one that could only refuse without it isn't
 *  listed (the web plugin's WebFetch reads any public page through `network:public`; without it, it could reach only
 *  the plugin's own `network:` hosts). */
export const BUNDLED_TOOL_NEEDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "clover/web": { WebFetch: "network:public" },
};

/** How long a bot's turn waits, at its start, for the first listing of a server just installed or enabled. */
export const MCP_FIRST_LISTING_WAIT_MS = 5_000;

/** The plugins' `host` MCP servers for bots: listed, placed and called through the plugin host. */
export class PluginMcp {
  readonly #o: PluginMcpOptions;
  readonly #clients = new Map<string, { plugin: string; name: string; client: ChannelClient }>();
  #listed = new Map<string, Listed>();
  /** The servers wanted now, by key, with their latest contribution: what each server's listing task reads. */
  #want = new Map<string, Contribution>();
  /** Each server's listing in flight (one per server at a time, so a slow one holds up only itself). */
  readonly #inflight = new Map<string, Promise<void>>();
  /** A server asked to list again while its listing ran: it lists once more when that one ends. */
  readonly #againKeys = new Set<string>();
  /** Servers whose last listing failed: `settled` doesn't wait for them (a server that never answers would hold every
   *  turn). */
  readonly #failed = new Set<string>();
  /** The reason last logged for each server not served (`notServed`), so it's said once, not at each refresh. */
  readonly #notServedSaid = new Map<string, string>();
  /** The bundled tool names refused for a clash, as last logged. */
  #clashSaid = "";
  #closed = false;
  readonly #off: Unsubscribe;

  constructor(o: PluginMcpOptions) {
    this.#o = o;
    this.#off = o.registry.watch((change) => {
      if (change.type !== "entries" || change.point === "mcpServers") void this.refresh();
    });
  }

  #client(key: string, plugin: string, name: string, stdio = false): ChannelClient {
    let c = this.#clients.get(key);
    if (c !== undefined && (c.plugin !== plugin || c.name !== name)) {
      c.client.close();
      c = undefined;
    }
    if (c === undefined) {
      const door: Pick<PluginHost, "openMcp"> = stdio && this.#o.stdio !== undefined ? this.#o.stdio : this.#o.host;
      c = { plugin, name, client: new ChannelClient(() => door.openMcp(plugin, name), this.#o.listTimeoutMs ?? LIST_TIMEOUT_MS) };
      this.#clients.set(key, c);
    }
    return c.client;
  }

  #hostEntries(): Contribution[] {
    return this.#o.registry.entries("mcpServers").filter((c) => {
      if (c.state !== "active" || !isObject(c.value)) return false;
      const type = (c.value as { type?: unknown }).type;
      return type === "host" || (type === "stdio" && this.#o.stdio !== undefined);
    });
  }

  #nameOf(c: Contribution): string {
    return (c.value as HostServerEntry).name ?? c.entryId ?? c.ref.split("/").pop()!;
  }

  /** The manifest's instructions file, read inside the plugin's folder, capped. */
  #instructions(c: Contribution): string | undefined {
    const path = (c.value as HostServerEntry).instructions;
    const folder = this.#o.registry.get(c.pluginId)?.folder;
    if (path === undefined || folder === undefined) return undefined;
    try {
      const root = realpathSync(folder);
      const file = realpathSync(join(root, path));
      const rel = relative(root, file);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
      const text = readFileSync(file, "utf8").trim();
      return text === "" ? undefined : text.slice(0, INSTRUCTIONS_MAX_CHARS);
    } catch {
      return undefined;
    }
  }

  /** The key each active `host` server is served under, and the ones refused (with why). */
  #keys(): { served: { key: string; c: Contribution }[]; refused: { c: Contribution; why: string }[] } {
    const bundled = (c: Contribution): boolean => {
      const record = this.#o.registry.get(c.pluginId);
      return record !== undefined && isBundledClover(record);
    };
    const bundledNames = new Set<string>();
    for (const c of this.#o.registry.entries("mcpServers")) if (bundled(c)) bundledNames.add(this.#nameOf(c));
    const refused: { c: Contribution; why: string }[] = [];
    const groups = new Map<string, { c: Contribution; bundled: boolean }[]>();
    for (const c of this.#hostEntries()) {
      const name = this.#nameOf(c);
      const isBundled = bundled(c);
      let key = name;
      if (isBundled) {
        if (pluginMcpServerKey(c.pluginId, name, true) === undefined) {
          refused.push({ c, why: `the name ${name} can't name a server (lower-case letters and digits, single hyphens)` });
          continue;
        }
      } else {
        if (RESERVED_NAMES.includes(name) || bundledNames.has(name)) {
          refused.push({ c, why: `the name ${name} is reserved` });
          continue;
        }
        const minted = pluginMcpServerKey(c.pluginId, name);
        if (minted === undefined) {
          refused.push({ c, why: `the name ${name} gives no server key (it must be lower-case letters and digits, single hyphens)` });
          continue;
        }
        if (RESERVED_NAMES.includes(minted) || bundledNames.has(minted)) {
          refused.push({ c, why: `its key ${minted} is reserved` });
          continue;
        }
        key = minted;
      }
      const group = groups.get(key) ?? [];
      group.push({ c, bundled: isBundled });
      groups.set(key, group);
    }
    const served: { key: string; c: Contribution }[] = [];
    for (const [key, group] of groups) {
      const winners = group.filter((g) => g.bundled);
      if (group.length === 1 || winners.length === 1) {
        const winner = group.length === 1 ? group[0]! : winners[0]!;
        served.push({ key, c: winner.c });
        for (const g of group) if (g !== winner) refused.push({ c: g.c, why: `the key ${key} is taken by a bundled server` });
      } else {
        for (const g of group) refused.push({ c: g.c, why: `the key ${key} is also used by another server` });
      }
    }
    return { served, refused };
  }

  async #list(key: string, c: Contribution): Promise<Listed> {
    const name = this.#nameOf(c);
    const timeoutMs = this.#o.listTimeoutMs ?? LIST_TIMEOUT_MS;
    const client = this.#client(key, c.pluginId, name, (c.value as HostServerEntry).type === "stdio");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        client.close();
        this.#clients.delete(key);
        reject(new ContractError("timeout", `the plugin's MCP server didn't answer in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
    });
    try {
      const r = await Promise.race([client.request("tools/list", {}, { timeoutMs }), timeout]);
      const needs = BUNDLED_TOOL_NEEDS[c.pluginId];
      const granted = needs === undefined ? [] : (this.#o.registry.get(c.pluginId)?.granted ?? []);
      const tools = (isObject(r) && Array.isArray(r.tools) ? r.tools : []).filter((t): t is Record<string, unknown> => isObject(t) && typeof t.name === "string").filter((t) => {
        const need = needs?.[t.name as string];
        return need === undefined || granted.includes(need);
      }).map((t) => ({
        name: t.name as string,
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        inputSchema: (isObject(t.inputSchema) ? { ...t.inputSchema, type: "object" } : { type: "object" }) as McpToolDef["inputSchema"],
      }));
      const instructions = this.#instructions(c);
      const record = this.#o.registry.get(c.pluginId);
      return { plugin: c.pluginId, bundled: record !== undefined && isBundledClover(record), name, entry: c.value as HostServerEntry, tools, ...(instructions === undefined ? {} : { instructions }) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Lists every active `host` server's tools, each on its own, within its own time, and publishes each listing as
   *  it comes: a server installed or enabled since is served as soon as it answers, never behind one that hangs.
   *  Servers that went away or were refused are dropped at once, their channels closed; one that didn't answer is
   *  dropped when it fails. Resolves when every listing this call started (or joined) has ended. */
  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const { served, refused } = this.#keys();
    for (const { c, why } of refused) this.#o.log?.(`plugin MCP ${c.pluginId}/${this.#nameOf(c)}: refused, ${why}`);
    // A per-computer server's process starts only on a computer that ticks it: one this computer doesn't is neither
    // listed (a listing starts it) nor called here, and a channel left open to it is closed below.
    const want = new Map(served.filter(({ key, c }) => this.#runsHere(key, c) && !this.#notServed(key, c)).map(({ key, c }) => [key, c] as const));
    this.#want = want;
    for (const key of [...this.#listed.keys()]) if (!want.has(key)) this.#listed.delete(key);
    for (const [key, c] of this.#clients) {
      if (!want.has(key)) {
        c.client.close();
        this.#clients.delete(key);
      }
    }
    for (const key of [...this.#failed]) if (!want.has(key)) this.#failed.delete(key);
    this.#sayClashes();
    return Promise.all([...want.keys()].map((key) => this.#listOne(key))).then(() => {});
  }

  /** Whether a server can't work in this build (`notServed`): logged once per reason, here and in its plugin's log. */
  #notServed(key: string, c: Contribution): boolean {
    const entry = c.value as HostServerEntry;
    let why: string | undefined;
    try {
      why = entry.type === "host" ? this.#o.notServed?.({ pluginId: c.pluginId, name: this.#nameOf(c), type: entry.type }) : undefined;
    } catch {
      why = undefined;
    }
    if (why === undefined) {
      this.#notServedSaid.delete(key);
      return false;
    }
    if (this.#notServedSaid.get(key) !== why) {
      this.#notServedSaid.set(key, why);
      const line = `MCP server ${this.#nameOf(c)} isn't served: ${why}`;
      this.#o.log?.(`plugin MCP ${c.pluginId}/${this.#nameOf(c)}: not served: ${why}`);
      try { this.#o.pluginLog?.(c.pluginId, line); } catch { /* its log is best effort */ }
    }
    return true;
  }

  /** What the host says of a plugin that isn't running (`restarting: the worker failed: …`), for a log line. */
  #why(pluginId: string): string {
    try {
      const s = this.#o.host.status?.(pluginId);
      return s === undefined || s.state === "running" || s.state === "idle" ? "" : ` (the plugin is ${s.state}${s.reason ? `: ${(s.reason.match(/^\s*[A-Za-z]*Error: .*$/m)?.[0] ?? s.reason.split("\n")[0]!).trim()}`.slice(0, 300) : ""})`;
    } catch {
      return "";
    }
  }

  /** One server's listing task: lists it, again while it was asked to, and publishes each result. */
  #listOne(key: string): Promise<void> {
    const running = this.#inflight.get(key);
    if (running !== undefined) {
      this.#againKeys.add(key);
      return running;
    }
    const task = (async () => {
      do {
        this.#againKeys.delete(key);
        const c = this.#want.get(key);
        if (c === undefined || this.#closed) return;
        try {
          let listed: Listed;
          try {
            listed = await this.#list(key, c);
          } catch (err) {
            // The channel closed under the listing: its plugin's worker went (a crash, a reload; the host closes its
            // channels then). Once more, on the worker that replaces it; a plugin that keeps failing fails here.
            if ((err as { code?: unknown } | null)?.code !== "closed" || this.#closed || this.#want.get(key) === undefined) throw err;
            this.#o.log?.(`plugin MCP ${c.pluginId}/${this.#nameOf(c)}: its plugin's worker went during the listing${this.#why(c.pluginId)}; listing again`);
            listed = await this.#list(key, c);
          }
          if (this.#closed || this.#want.get(key) === undefined) return;
          const names = listed.tools.map((t) => t.name).join(", ");
          const before = this.#listed.get(key);
          if (before === undefined || before.stopped !== undefined || before.tools.map((t) => t.name).join(", ") !== names) {
            this.#o.log?.(`plugin MCP ${c.pluginId}/${this.#nameOf(c)}: listed ${listed.tools.length} tool(s)${names === "" ? "" : `: ${names}`}`);
          }
          this.#listed.set(key, listed);
          this.#failed.delete(key);
          this.#sayClashes();
        } catch (err) {
          if (this.#closed) return;
          this.#o.log?.(`plugin MCP ${c.pluginId}/${this.#nameOf(c)}: its tools couldn't be listed: ${err instanceof Error ? err.message : String(err)}${this.#why(c.pluginId)}`);
          this.#failed.add(key);
          // A stopped plugin's server keeps its last listing, its calls answering why (§5.1); any other failure
          // drops it until a listing succeeds.
          const before = this.#listed.get(key);
          if ((err as { code?: unknown } | null)?.code === "plugin_stopped" && before !== undefined) {
            this.#listed.set(key, { ...before, stopped: err instanceof Error ? err.message : "plugin stopped" });
          } else {
            this.#listed.delete(key);
            this.#clients.get(key)?.client.close();
            this.#clients.delete(key);
          }
        }
      } while (this.#againKeys.has(key));
    })().finally(() => { this.#inflight.delete(key); });
    this.#inflight.set(key, task);
    return task;
  }

  /** Waits, at most `timeoutMs`, for the first listing of every server wanted but not yet listed (one just installed
   *  or enabled), so a turn that starts right after it sees its tools. A server whose last listing failed isn't
   *  waited for. */
  async settled(timeoutMs: number): Promise<void> {
    const pending = [...this.#inflight].filter(([key]) => !this.#listed.has(key) && !this.#failed.has(key)).map(([, p]) => p);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(pending), new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
  }

  /** The bundled tools by name, each with its server's key, and the names two or more bundled servers give (refused
   *  for all of them: `mcp__clover__<name>` must be one server's). */
  #bundledTools(): { byName: Map<string, string>; clashes: Map<string, string[]> } {
    const claims = new Map<string, string[]>();
    for (const [key, l] of this.#listed) {
      if (!l.bundled) continue;
      for (const t of l.tools) claims.set(t.name, [...(claims.get(t.name) ?? []), key]);
    }
    const byName = new Map<string, string>();
    const clashes = new Map<string, string[]>();
    for (const [name, keys] of claims) (keys.length === 1 ? byName.set(name, keys[0]!) : clashes.set(name, keys));
    return { byName, clashes };
  }

  /** Logs the bundled tool names refused for a clash, once each time the set changes, naming every server that gives one. */
  #sayClashes(): void {
    const { clashes } = this.#bundledTools();
    const lines = [...clashes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, keys]) =>
      `the tool ${mcpToolName(BUNDLED_SERVER, name)} is refused: ${keys.map((k) => `${this.#listed.get(k)!.plugin}/${this.#listed.get(k)!.name}`).join(" and ")} both give it`);
    const said = lines.join("\n");
    if (said === this.#clashSaid) return;
    this.#clashSaid = said;
    for (const line of lines) this.#o.log?.(`plugin MCP: ${line}`);
  }

  /** The key of the server that runs `server`'s `tool` as a session names them: `clover` and a bundled tool's name give
   *  its bundled server; a bundled server's own key is never a session's name; any other key is itself. */
  #resolve(server: string, tool: string | undefined): string | undefined {
    if (server === BUNDLED_SERVER) return tool === undefined ? undefined : this.#bundledTools().byName.get(tool);
    return this.#listed.get(server)?.bundled === true ? undefined : server;
  }

  /** Where `server`'s `tool` runs, as a session names them (`mcp__clover__WebSearch` is `clover` and `WebSearch`):
   *  lane J's router asks per tool, since the bundled servers share one name. */
  placement(server: string, tool?: string): McpServerPlacement | undefined {
    const key = this.#resolve(server, tool);
    return key === undefined ? undefined : this.#placementOf(key, server);
  }

  #placementOf(key: string, name: string = key): McpServerPlacement | undefined {
    const l = this.#listed.get(key);
    if (l === undefined) return undefined;
    if (!isLocal(l.entry)) return { name, kind: "remote", computers: [] };
    // Exactly the computers that tick it: none ticked (no OK card answered on any computer), or no list, runs it nowhere.
    return { name, kind: "local", computers: [...(this.#o.computers?.(key) ?? [])] };
  }

  /** The `perComputer` servers the plugins declare, with their plugin, whether this computer ticks them or not: what
   *  lane J's node ticks per computer (`localServers`). Read from the registry, so naming one starts nothing. */
  localServers(): { server: string; plugin: string }[] {
    // Only plugins installed, enabled and OK'd HERE (a synced plugin not OK'd here is never offered for a tick, so J's
    // first-run adoption can't tick it), whether their servers run yet or not.
    return this.#keys().served.filter(({ c }) => {
      if (!isLocal(c.value as HostServerEntry)) return false;
      const record = this.#o.registry.get(c.pluginId);
      return record !== undefined && record.enabled === true && this.#okd(record);
    }).map(({ key, c }) => ({ server: key, plugin: c.pluginId }));
  }

  /** Whether `key`'s process may start on this computer: any server but a per-computer one, and a per-computer one only
   *  where it's ticked (lane J's `computers`). With no list it fails closed: no per-computer server starts. */
  #runsHere(key: string, c: Contribution): boolean {
    if (!isLocal(c.value as HostServerEntry)) return true;
    return this.#o.computers?.(key).includes(this.#o.self()) ?? false;
  }

  /** The fields `server`'s `tool` carries, as a session names them. */
  fields(server: string, tool?: string): McpFields {
    const key = this.#resolve(server, tool);
    const l = key === undefined ? undefined : this.#listed.get(key);
    const p = key === undefined ? undefined : this.#placementOf(key);
    return l === undefined || p === undefined ? {} : placementFields(p, l.tools).fields;
  }

  /** The servers a session of `kind` gets, as the driver lists them (`BotDriverDeps.mcp.servers`). */
  servers(kind: "bot" | "side-thread" | "agent" | "coding"): BotMcpServer[] {
    const out: BotMcpServer[] = [];
    const { clashes } = this.#bundledTools();
    for (const [key, l] of this.#listed) {
      const scope = this.#scopeOf(l.plugin, l.entry);
      const serves = scope === "both" || (scope === "bots" ? kind === "bot" || kind === "side-thread" : kind === "agent" || kind === "coding");
      if (!serves) continue;
      const server = l.bundled ? BUNDLED_SERVER : key;
      const p = this.#placementOf(key, server)!;
      const loads = l.entry.tools ?? {};
      const offered = l.bundled ? l.tools.filter((t) => !clashes.has(t.name)) : l.tools;
      if (l.bundled && offered.length === 0) continue;
      const tools: BotMcpTool[] = placementFields(p, offered).tools.map((t) => ({
        name: t.name,
        ...(t.description === undefined ? {} : { description: t.description }),
        inputSchema: t.inputSchema,
        load: loads[t.name] ?? loads["*"] ?? "on-demand",
      }));
      out.push({ server, plugin: l.plugin, tools, ...(l.instructions === undefined ? {} : { instructions: l.instructions }), ...(p.kind === "local" ? { computers: p.computers } : {}), reachable: true });
    }
    // Servers other computers run fill the names this one doesn't list. This computer's own listing wins, a server it
    // lists but scopes out for this kind included; a reserved name, or one this computer's registry gives to another
    // plugin, is never taken from a remote listing. A bundled plugin's server another computer lists comes as `clover`:
    // taken only for a plugin this computer's registry says is bundled, and only for tool names no bundled server
    // listed here gives.
    const declared = new Map(this.#keys().served.map(({ key, c }) => [key, c.pluginId] as const));
    const ownBundled = new Set([...this.#listed.values()].filter((l) => l.bundled).flatMap((l) => l.tools.map((t) => t.name)));
    for (const r of this.#o.remoteServers?.(kind) ?? []) {
      if (r.server === BUNDLED_SERVER) {
        const record = this.#o.registry.get(r.plugin);
        if (record === undefined || !isBundledClover(record)) continue;
        const tools = r.tools.filter((t) => !ownBundled.has(t.name) && !clashes.has(t.name));
        if (tools.length > 0) out.push({ ...r, tools });
        continue;
      }
      if (this.#listed.has(r.server) || out.some((s) => s.server === r.server)) continue;
      if (RESERVED_NAMES.includes(r.server) || !isServerKey(r.server)) continue;
      const owner = declared.get(r.server);
      if (owner !== undefined && owner !== r.plugin) continue;
      out.push(r);
    }
    return out;
  }

  /** What this computer's own registry says of `plugin`'s server `name`, for lane J's node to check a remote listing
   *  against: its key here and its scope here. It answers only when the plugin is installed HERE, enabled, running (or
   *  stopped, still on), OK'd for its folder as it is now (a bundled one is the core's own), and its manifest declares
   *  a per-computer `host` server of exactly that name, served under a key no other plugin here also reaches (`#keys`
   *  refuses every claimant of a shared key: `a-b/c`'s and `a/b-c`'s `x` are both `a-b-c-x`). The key always comes
   *  from this registry, never from the peer's strings. Undefined otherwise. */
  known(plugin: string, name: string): { server: string; exposed: string; scope: "bots" | "agents" | "both" } | undefined {
    const record = this.#o.registry.get(plugin);
    if (record === undefined || record.enabled !== true || (record.state !== "running" && record.state !== "stopped")) return undefined;
    if (!this.#okd(record)) return undefined;
    const hit = this.#keys().served.find(({ c }) => c.pluginId === plugin && this.#nameOf(c) === name);
    if (hit === undefined || !isLocal(hit.c.value as HostServerEntry)) return undefined;
    return { server: hit.key, exposed: isBundledClover(record) ? BUNDLED_SERVER : hit.key, scope: this.#scopeOf(plugin, hit.c.value as HostServerEntry) };
  }

  /** Whether the user's OK covers the plugin's folder as it is now: a bundled one is the core's own; a child carries
   *  no OK of its own when its tree's covers it, so a child without one is judged by its tree's top-level plugin. */
  #okd(record: PluginRecord): boolean {
    if (isBundledClover(record)) return true;
    const own = record.okHash !== undefined ? record : this.#o.registry.get(topPluginIdOf(record.id));
    return own !== undefined && own.okHash !== undefined && own.okHash === own.treeHash;
  }

  #scopeOf(plugin: string, entry: HostServerEntry): "bots" | "agents" | "both" {
    return entry.scope ?? (this.#o.registry.get(plugin)?.manifest as { scope?: HostServerEntry["scope"] } | undefined)?.scope ?? "both";
  }

  /** The per-computer servers listed here, for lane J's node to serve to the other computers (`mcp.list`; the node
   *  keeps only what's ticked here). */
  listing(): PluginMcpListing[] {
    const out: PluginMcpListing[] = [];
    for (const [server, l] of this.#listed) {
      if (!isLocal(l.entry)) continue;
      const loads = l.entry.tools ?? {};
      out.push({
        server, plugin: l.plugin, name: l.name, exposed: l.bundled ? BUNDLED_SERVER : server,
        tools: l.tools.map((t) => ({ ...t, load: loads[t.name] ?? loads["*"] ?? "on-demand" })),
        ...(l.instructions === undefined ? {} : { instructions: l.instructions }),
        // Always stated: a remote listing with no scope serves no one (lane J's node).
        scope: this.#scopeOf(l.plugin, l.entry),
      });
    }
    return out;
  }

  /** Runs one tool call on this computer (lane J's `McpCaller`), as the session's caller. */
  readonly call: McpCaller = async ({ server: named, tool, input, as, signal }) => {
    const server = this.#resolve(named, tool);
    if (server === undefined && named === BUNDLED_SERVER) throw new ContractError("not_found", `no tool ${mcpToolName(BUNDLED_SERVER, tool)}`);
    const l = server === undefined ? undefined : this.#listed.get(server);
    if (l === undefined || server === undefined) throw new ContractError("not_installed", `no MCP server ${named}`);
    // Its tick may have gone since the listing: then nothing starts it here, and its channel closes.
    if (isLocal(l.entry) && !(this.#o.computers?.(server).includes(this.#o.self()) ?? false)) {
      this.#clients.get(server)?.client.close();
      this.#clients.delete(server);
      throw new ContractError("not_installed", `the MCP server ${server} isn't ticked on this computer`);
    }
    if (l.stopped !== undefined) throw new ContractError("plugin_stopped", l.stopped);
    if (!l.tools.some((t) => t.name === tool)) throw new ContractError("not_found", `the MCP server ${server} has no tool ${tool}`);
    const r = await this.#client(server, l.plugin, l.name, l.entry.type === "stdio").request("tools/call", { name: tool, arguments: input }, { as, ...(signal === undefined ? {} : { signal }), timeoutMs: CALL_TIMEOUT_MS });
    if (!isObject(r)) return { content: [{ type: "text", text: "" }], isError: true };
    return capResult({ ...(r as McpResult), content: Array.isArray(r.content) ? r.content as McpResult["content"] : [] });
  };

  close(): void {
    this.#closed = true;
    this.#off();
    for (const c of this.#clients.values()) c.client.close();
    this.#clients.clear();
    this.#listed.clear();
  }
}

/** A result held to `RESULT_MAX_CHARS` of JSON: items past the cap are dropped, a text item is cut where it crosses it,
 *  and a note says so. */
function capResult(r: McpResult): McpResult {
  if (JSON.stringify(r.content).length <= RESULT_MAX_CHARS) return r;
  const content: McpResult["content"] = [];
  let left = RESULT_MAX_CHARS - TRUNCATED_NOTE.length - 64;
  for (const item of r.content) {
    const size = JSON.stringify(item).length;
    if (size <= left) {
      content.push(item);
      left -= size;
      continue;
    }
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string") {
      let keep = Math.min(text.length, left);
      let cut = { ...item, text: text.slice(0, keep) } as McpResult["content"][number];
      while (keep > 0 && JSON.stringify(cut).length > left) {
        keep = Math.floor(keep / 2);
        cut = { ...item, text: text.slice(0, keep) } as McpResult["content"][number];
      }
      content.push(cut);
    }
    break;
  }
  content.push({ type: "text", text: TRUNCATED_NOTE });
  return { ...r, content };
}

/** Runs the plugins' host servers on this computer when there is no computer node (no links): lane J's `McpRunner`
 *  without the router, so no `computer` choice and no files saved elsewhere; a remote server's `saveTo` is dropped. */
export function localMcpRunner(mcp: PluginMcp, self: () => string): McpRunner {
  return {
    async run(server, tool, input, ctx) {
      const args = { ...input };
      const saveTo = mcp.fields(server, tool).saveTo;
      if (saveTo !== undefined) delete args[saveTo];
      const result = await mcp.call({ server, tool, input: args, as: ctx.as, session: ctx.session, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) });
      return { result, computer: self() };
    },
  };
}
