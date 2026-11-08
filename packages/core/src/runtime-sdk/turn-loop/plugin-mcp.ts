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
// * **Placement** (lane J's `McpRouter`): a server `perComputer` runs on this computer (local); any other only talks to
//   the web and runs where the session does (remote), its tools taking J's optional `saveTo`. The router runs a call
//   here through `call`, and files it returns are saved by the router.
// * **Scope:** a server's own `scope`, else its plugin's, says whether bots get it (`both` by default).
// * Only `host` servers are served here; a plugin's `stdio` and `http` servers are the MCP host's (lanes B and D).
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../../contracts/common";
import type { McpChannel, PluginHost } from "../../contracts/plugin-host";
import type { Contribution, PluginRegistry } from "../../contracts/plugin-registry";
import { placementFields, type McpCaller, type McpFields, type McpResult, type McpServerPlacement, type McpToolDef } from "../../computers/mcp";
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
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();

  constructor(private readonly open: () => Promise<McpChannel>) {}

  async #ready(): Promise<McpChannel> {
    if (this.#channel !== undefined && !this.#channel.closed) return this.#channel;
    this.#drop(new ContractError("closed", "the plugin's MCP channel closed"));
    this.#opening ??= (async () => {
      const channel = await this.open();
      this.#off = channel.onMessage((m) => this.#answer(m));
      this.#channel = channel;
      try {
        await this.#send(channel, "initialize", { protocolVersion: PLUGIN_MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "clover", version: "1" } }, undefined, undefined, LIST_TIMEOUT_MS);
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
    this.#drop(new ContractError("closed", "the plugin's MCP channel was closed"));
  }
}

export interface PluginMcpOptions {
  registry: Pick<PluginRegistry, "entries" | "get" | "watch">;
  host: Pick<PluginHost, "openMcp">;
  /** This computer's name: where a `perComputer` server runs. */
  self(): string;
  log?(line: string): void;
}

interface Listed {
  plugin: string;
  entry: HostServerEntry;
  tools: McpToolDef[];
  instructions?: string;
}

/** The plugins' `host` MCP servers for bots: listed, placed and called through the plugin host. */
export class PluginMcp {
  readonly #o: PluginMcpOptions;
  readonly #clients = new Map<string, ChannelClient>();
  #listed = new Map<string, Listed>();
  #refreshing: Promise<void> | undefined;
  #again = false;
  readonly #off: Unsubscribe;

  constructor(o: PluginMcpOptions) {
    this.#o = o;
    this.#off = o.registry.watch((change) => {
      if (change.type !== "entries" || change.point === "mcpServers") void this.refresh();
    });
  }

  #client(plugin: string, server: string): ChannelClient {
    const key = `${plugin}\u0000${server}`;
    let c = this.#clients.get(key);
    if (c === undefined) {
      c = new ChannelClient(() => this.#o.host.openMcp(plugin, server));
      this.#clients.set(key, c);
    }
    return c;
  }

  #hostEntries(): Contribution[] {
    return this.#o.registry.entries("mcpServers").filter((c) => c.state === "active" && isObject(c.value) && (c.value as { type?: unknown }).type === "host");
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

  /** Lists every active `host` server's tools; servers that went away are forgotten and their channels closed. */
  refresh(): Promise<void> {
    if (this.#refreshing !== undefined) {
      this.#again = true;
      return this.#refreshing;
    }
    this.#refreshing = (async () => {
      do {
        this.#again = false;
        const next = new Map<string, Listed>();
        for (const c of this.#hostEntries()) {
          const name = this.#nameOf(c);
          if (next.has(name)) continue;
          try {
            const r = await this.#client(c.pluginId, name).request("tools/list", {}, { timeoutMs: LIST_TIMEOUT_MS });
            const tools = (isObject(r) && Array.isArray(r.tools) ? r.tools : []).filter((t): t is Record<string, unknown> => isObject(t) && typeof t.name === "string").map((t) => ({
              name: t.name as string,
              ...(typeof t.description === "string" ? { description: t.description } : {}),
              inputSchema: (isObject(t.inputSchema) ? { ...t.inputSchema, type: "object" } : { type: "object" }) as McpToolDef["inputSchema"],
            }));
            const instructions = this.#instructions(c);
            next.set(name, { plugin: c.pluginId, entry: c.value as HostServerEntry, tools, ...(instructions === undefined ? {} : { instructions }) });
          } catch (err) {
            this.#o.log?.(`plugin MCP ${c.pluginId}/${name}: its tools couldn't be listed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        for (const [key, client] of this.#clients) {
          const [plugin, server] = key.split("\u0000") as [string, string];
          if (next.get(server)?.plugin !== plugin) {
            client.close();
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
    return l.entry.perComputer === true ? { name: server, kind: "local", computers: [this.#o.self()] } : { name: server, kind: "remote", computers: [] };
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
      const scope = l.entry.scope ?? (this.#o.registry.get(l.plugin)?.manifest as { scope?: HostServerEntry["scope"] } | undefined)?.scope ?? "both";
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
    return out;
  }

  /** Runs one tool call on this computer (lane J's `McpCaller`), as the session's caller. */
  readonly call: McpCaller = async ({ server, tool, input, as, signal }) => {
    const l = this.#listed.get(server);
    if (l === undefined) throw new ContractError("not_installed", `no MCP server ${server}`);
    const r = await this.#client(l.plugin, server).request("tools/call", { name: tool, arguments: input }, { as, ...(signal === undefined ? {} : { signal }), timeoutMs: CALL_TIMEOUT_MS });
    if (!isObject(r)) return { content: [{ type: "text", text: "" }], isError: true };
    return { ...(r as McpResult), content: Array.isArray(r.content) ? r.content as McpResult["content"] : [] };
  };

  close(): void {
    this.#off();
    for (const c of this.#clients.values()) c.close();
    this.#clients.clear();
    this.#listed.clear();
  }
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
