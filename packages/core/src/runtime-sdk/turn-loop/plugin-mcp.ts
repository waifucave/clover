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
// * **Names:** a bundled plugin's server (registry source `bundled`, top plugin `clover`) keeps its plain name, so
//   `mcp__web__WebSearch` is the web plugin's. Any other plugin's server is served under the key
//   `pluginMcpServerKey`: `<plugin id, its "/" as "-">-<server>`, a namespace that round-trips through a tool name, so
//   it can't take another's tools. A
//   non-bundled server named like a reserved name (`clover`, `clover_core`) or like any bundled plugin's server is
//   refused and logged. Two servers that come to the same key are refused and logged (never first wins): both of them,
//   unless exactly one is bundled, which keeps the key.
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
/** Server names only the core owns, which no non-bundled plugin may serve under. */
const RESERVED_NAMES: readonly string[] = ["clover", "clover_core"];

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
  host: Pick<PluginHost, "openMcp">;
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
}

/** One per-computer server as this computer lists it, for lane J's node to serve to the others (`mcp.list`): the raw
 *  tools (the node adds the placement fields), their loading, its instructions and scope. */
export interface PluginMcpListing {
  server: string;
  plugin: string;
  /** The server's own name, as its plugin declares it: `server` is `pluginMcpServerKey(plugin, name)`, or `name` itself
   *  for a bundled plugin's server; either way `isServerKey(server)`. */
  name: string;
  tools: (McpToolDef & { load: "preload" | "on-demand" })[];
  instructions?: string;
  scope: "bots" | "agents" | "both";
}

interface Listed {
  plugin: string;
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

/** The plugins' `host` MCP servers for bots: listed, placed and called through the plugin host. */
export class PluginMcp {
  readonly #o: PluginMcpOptions;
  readonly #clients = new Map<string, { plugin: string; name: string; client: ChannelClient }>();
  #listed = new Map<string, Listed>();
  #refreshing: Promise<void> | undefined;
  #again = false;
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
      const tools = (isObject(r) && Array.isArray(r.tools) ? r.tools : []).filter((t): t is Record<string, unknown> => isObject(t) && typeof t.name === "string").map((t) => ({
        name: t.name as string,
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        inputSchema: (isObject(t.inputSchema) ? { ...t.inputSchema, type: "object" } : { type: "object" }) as McpToolDef["inputSchema"],
      }));
      const instructions = this.#instructions(c);
      return { plugin: c.pluginId, name, entry: c.value as HostServerEntry, tools, ...(instructions === undefined ? {} : { instructions }) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Lists every active `host` server's tools, all at once, each within its own time; servers that went away, were
   *  refused or didn't answer are not served, and their channels closed. */
  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#refreshing !== undefined) {
      this.#again = true;
      return this.#refreshing;
    }
    this.#refreshing = (async () => {
      do {
        this.#again = false;
        const next = new Map<string, Listed>();
        const { served, refused } = this.#keys();
        for (const { c, why } of refused) this.#o.log?.(`plugin MCP ${c.pluginId}/${this.#nameOf(c)}: refused, ${why}`);
        // A per-computer server's process starts only on a computer that ticks it: one this computer doesn't is
        // neither listed (a listing starts it) nor called here, and a channel left open to it is closed below.
        const results = await Promise.all(served.filter(({ key, c }) => this.#runsHere(key, c)).map(async ({ key, c }) => {
          try {
            return { key, listed: await this.#list(key, c) };
          } catch (err) {
            this.#o.log?.(`plugin MCP ${c.pluginId}/${this.#nameOf(c)}: its tools couldn't be listed: ${err instanceof Error ? err.message : String(err)}`);
            // A stopped plugin's server keeps its last listing, its calls answering why (§5.1); any other failure
            // drops it until a listing succeeds.
            const before = this.#listed.get(key);
            if ((err as { code?: unknown } | null)?.code === "plugin_stopped" && before !== undefined) {
              return { key, listed: { ...before, stopped: err instanceof Error ? err.message : "plugin stopped" } };
            }
            return undefined;
          }
        }));
        if (this.#closed) break;
        for (const r of results) if (r !== undefined) next.set(r.key, r.listed);
        for (const [key, c] of this.#clients) {
          if (!next.has(key)) {
            c.client.close();
            this.#clients.delete(key);
          }
        }
        this.#listed = next;
      } while (this.#again);
    })().finally(() => { this.#refreshing = undefined; });
    return this.#refreshing;
  }

  placement(server: string): McpServerPlacement | undefined {
    const l = this.#listed.get(server);
    if (l === undefined) return undefined;
    if (!isLocal(l.entry)) return { name: server, kind: "remote", computers: [] };
    // Exactly the computers that tick it: none ticked (no OK card answered on any computer), or no list, runs it nowhere.
    return { name: server, kind: "local", computers: [...(this.#o.computers?.(server) ?? [])] };
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

  fields(server: string): McpFields {
    const l = this.#listed.get(server);
    const p = this.placement(server);
    return l === undefined || p === undefined ? {} : placementFields(p, l.tools).fields;
  }

  /** The servers a session of `kind` gets, as the driver lists them (`BotDriverDeps.mcp.servers`). */
  servers(kind: "bot" | "side-thread" | "agent" | "coding"): BotMcpServer[] {
    const out: BotMcpServer[] = [];
    for (const [server, l] of this.#listed) {
      const scope = this.#scopeOf(l.plugin, l.entry);
      const serves = scope === "both" || (scope === "bots" ? kind === "bot" || kind === "side-thread" : kind === "agent" || kind === "coding");
      if (!serves) continue;
      const p = this.placement(server)!;
      const loads = l.entry.tools ?? {};
      const tools: BotMcpTool[] = placementFields(p, l.tools).tools.map((t) => ({
        name: t.name,
        ...(t.description === undefined ? {} : { description: t.description }),
        inputSchema: t.inputSchema,
        load: loads[t.name] ?? loads["*"] ?? "on-demand",
      }));
      out.push({ server, plugin: l.plugin, tools, ...(l.instructions === undefined ? {} : { instructions: l.instructions }), ...(p.kind === "local" ? { computers: p.computers } : {}), reachable: true });
    }
    // Servers other computers run fill the names this one doesn't list. This computer's own listing wins, a server it
    // lists but scopes out for this kind included; a reserved name, or one this computer's registry gives to another
    // plugin, is never taken from a remote listing.
    const declared = new Map(this.#keys().served.map(({ key, c }) => [key, c.pluginId] as const));
    for (const r of this.#o.remoteServers?.(kind) ?? []) {
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
  known(plugin: string, name: string): { server: string; scope: "bots" | "agents" | "both" } | undefined {
    const record = this.#o.registry.get(plugin);
    if (record === undefined || record.enabled !== true || (record.state !== "running" && record.state !== "stopped")) return undefined;
    if (!this.#okd(record)) return undefined;
    const hit = this.#keys().served.find(({ c }) => c.pluginId === plugin && this.#nameOf(c) === name);
    if (hit === undefined || !isLocal(hit.c.value as HostServerEntry)) return undefined;
    return { server: hit.key, scope: this.#scopeOf(plugin, hit.c.value as HostServerEntry) };
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
        server, plugin: l.plugin, name: l.name,
        tools: l.tools.map((t) => ({ ...t, load: loads[t.name] ?? loads["*"] ?? "on-demand" })),
        ...(l.instructions === undefined ? {} : { instructions: l.instructions }),
        // Always stated: a remote listing with no scope serves no one (lane J's node).
        scope: this.#scopeOf(l.plugin, l.entry),
      });
    }
    return out;
  }

  /** Runs one tool call on this computer (lane J's `McpCaller`), as the session's caller. */
  readonly call: McpCaller = async ({ server, tool, input, as, signal }) => {
    const l = this.#listed.get(server);
    if (l === undefined) throw new ContractError("not_installed", `no MCP server ${server}`);
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
      const saveTo = mcp.fields(server).saveTo;
      if (saveTo !== undefined) delete args[saveTo];
      const result = await mcp.call({ server, tool, input: args, as: ctx.as, session: ctx.session, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) });
      return { result, computer: self() };
    },
  };
}
