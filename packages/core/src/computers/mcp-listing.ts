// Another computer's local MCP servers, listed here (spec §9.1; J-M2's follow-up for lane A). A local server runs only
// on the computers ticked for it (`mcp-ticks.ts`), and this computer's host lists only the ones it runs. A bot here can
// still call one that runs elsewhere (`McpRouter` sends the call there), so its tools come from a computer that runs
// it: `mcp.list` answers that computer's own listing of the local servers ticked on it.
//
// * Fetched after each hello that names local servers, one request per computer at a time (a hello that arrives during
//   the fetch fetches again after it); a hello with none drops that computer's listing. A revoked device's goes.
// * Kept only for the servers that computer's latest hello names: a listing is never trusted for a name the computer
//   doesn't say it runs.
// * Names round-trip: a server's name is a namespace (lower-case letters and digits, single hyphens: the driver's own
//   rule), and `mcp__<server>__<tool>` parses back to exactly that server and tool, so approvals, saved allow rules and
//   hooks name the server that really runs the call. The plugin is a plugin id, and the server's key must be the one
//   this computer's own registry gives that plugin's server of that name (`KnownMcpPlugin`, lane A's key scheme): a
//   plugin this computer doesn't know, or a key it wouldn't give, is left out. Without that record nothing from
//   another computer is listed.
// * Collisions are refused, never resolved: a key two plugins claim (two computers' listings, or one listing twice) is
//   left out for both, and so is a key this computer's own local servers give a different plugin.
// * Bounded: the number of servers and tools, each name, description, schema and the instructions, and each server's
//   text in all (its descriptions and instructions). A server or tool that doesn't fit is left out (and logged), never
//   cut; the rest of the listing stays.
// * Scope and load are the other computer's claim, so they only narrow: a server without a scope serves no one, a
//   scope is cut to what this computer's own record of the plugin allows, and every tool loads on demand.
// * Trust is the pairing's: a paired computer is believed for the servers its hello names. A server several computers
//   list takes the listing of the first in the registry's order that answered.
// * This computer's own listing wins: a server its host lists is never filled from another's (lane A's
//   `PluginMcp.servers`), and the router asks the host first (`node.ts`).
import { z } from "zod";
import { AnyPluginId, utf16 } from "@waifucave/clover-protocol";
import { NAMESPACE_RE } from "@waifucave/clover-plugin-sdk";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { DeviceRegistry } from "../contracts/device-registry";
import type { LinkTransport } from "../contracts/link-transport";
import type { BotMcpServer } from "../runtime-sdk/turn-loop/servers";
import { mcpToolName, parseMcpToolName, placementFields, type McpToolDef } from "./mcp";

export const MCP_LIST_MAX_SERVERS = 1024;
export const MCP_LIST_MAX_TOOLS = 512;
export const MCP_LIST_DESCRIPTION_MAX = 8192;
export const MCP_LIST_INSTRUCTIONS_MAX = 16_384;
/** One tool's input schema, as JSON. */
export const MCP_LIST_SCHEMA_MAX_BYTES = 64 * 1024;
/** One computer's whole answer, as JSON. */
export const MCP_LIST_MAX_BYTES = 4 * 1024 * 1024;
/** One server's text in all: its tools' descriptions and its instructions. */
export const MCP_LIST_SERVER_TEXT_MAX = 64 * 1024;
/** One server's tool schemas in all, as JSON. */
export const MCP_LIST_SERVER_SCHEMAS_MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** A server's name: a namespace, as the driver serves one (`NAMESPACE_RE`): no `_`, so its tool names split cleanly. */
const ServerName = utf16(64, 1).regex(NAMESPACE_RE);
/** A tool's name, as MCP allows it. */
const ToolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const Load = z.enum(["preload", "on-demand"]);
const Scope = z.enum(["bots", "agents", "both"]);

const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const ListedTool = z.object({
  name: ToolName,
  description: z.string().max(MCP_LIST_DESCRIPTION_MAX).optional(),
  // Kept as sent (no copy by assignment), held to its size.
  inputSchema: z.custom<Record<string, unknown>>((v) => plainObject(v) && JSON.stringify(v).length <= MCP_LIST_SCHEMA_MAX_BYTES),
  load: Load.optional(),
});

const ListedServer = z.object({
  server: ServerName,
  plugin: AnyPluginId,
  name: utf16(256, 1),
  tools: z.array(z.unknown()).max(MCP_LIST_MAX_TOOLS),
  instructions: z.string().max(MCP_LIST_INSTRUCTIONS_MAX).optional(),
  scope: Scope.optional(),
});

/** One local server as the computer running it lists it: its plugin's tools as they are, without placement fields. */
export interface McpListing {
  /** The key it is served under: `mcp__<server>__<tool>`. */
  server: string;
  plugin: string;
  /** The server's own name, as its plugin declares it (the key comes from the plugin and this). */
  name: string;
  tools: readonly (McpToolDef & { load?: "preload" | "on-demand" })[];
  instructions?: string;
  /** Who gets it: bots (and their side threads), coding agents, or both. From another computer, a listing without
   *  one serves no one (`servedKinds`). */
  scope?: McpScope;
}

export type McpScope = "bots" | "agents" | "both";
type SessionKind = "bot" | "side-thread" | "agent" | "coding";

/** This computer's own record of a plugin's server, by the plugin and the server's declared name (lane A, from the
 *  plugin registry): the key this computer would serve it under, and its scope here (both by default). `undefined`
 *  when this computer doesn't know the plugin, or gives that server no key (refused here). */
export type KnownMcpPlugin = (plugin: string, name: string) => { server: string; scope?: McpScope } | undefined;

/** Serves this computer's listing of the local servers ticked here to the paired computers. */
export function serveMcpList(o: { transport: LinkTransport; mayCall: (device: string) => boolean; listing: () => readonly McpListing[] }): Unsubscribe {
  return o.transport.handle("mcp.list", (_raw, from) => {
    if (!o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
    return { servers: o.listing().slice(0, MCP_LIST_MAX_SERVERS) };
  });
}

/** Parses one computer's answer: the servers its hello names, each within bounds; anything else left out. */
export function parseMcpList(raw: unknown, named: readonly string[], known: KnownMcpPlugin, log?: (line: string) => void): McpListing[] {
  if (!plainObject(raw) || !Array.isArray(raw.servers)) {
    log?.("its answer isn't a listing");
    return [];
  }
  let size: number;
  try {
    size = JSON.stringify(raw).length;
  } catch {
    size = Infinity;
  }
  if (size > MCP_LIST_MAX_BYTES) {
    log?.(`its listing is larger than ${MCP_LIST_MAX_BYTES} bytes`);
    return [];
  }
  const out: McpListing[] = [];
  /** Each key's plugin, as this answer gives it; a key given to two is left out for both. */
  const seen = new Map<string, string>();
  const clashed = new Set<string>();
  for (const s of raw.servers.slice(0, MCP_LIST_MAX_SERVERS)) {
    const p = ListedServer.safeParse(s);
    if (!p.success) {
      log?.(`a server was left out: ${p.error.issues[0]?.message ?? "it didn't parse"}`);
      continue;
    }
    const { server, plugin, name, instructions, scope } = p.data;
    if (!named.includes(server)) {
      log?.(`${server} was left out: its hello doesn't name it`);
      continue;
    }
    const had = seen.get(server);
    if (had !== undefined) {
      if (had !== plugin) clashed.add(server);
      continue;
    }
    seen.set(server, plugin);
    const here = known(plugin, name);
    if (here?.server !== server) {
      log?.(`${server} was left out: ${here === undefined ? `this computer doesn't know ${plugin}'s server ${name}` : `${plugin}'s server ${name} is ${here.server} here`}`);
      continue;
    }
    const tools: McpListing["tools"][number][] = [];
    const names = new Set<string>();
    let text = instructions?.length ?? 0;
    let schemas = 0;
    for (const t of p.data.tools) {
      const tp = ListedTool.safeParse(t);
      if (!tp.success || names.has(tp.data.name)) {
        log?.(`${server}: a tool was left out: ${tp.success ? `${tp.data.name} is listed twice` : tp.error.issues[0]?.message ?? "it didn't parse"}`);
        continue;
      }
      const back = parseMcpToolName(mcpToolName(server, tp.data.name));
      if (back === null || back.server !== server || back.tool !== tp.data.name) {
        log?.(`${server}: the tool ${tp.data.name} was left out: its name doesn't read back as this server's`);
        continue;
      }
      names.add(tp.data.name);
      text += tp.data.description?.length ?? 0;
      schemas += JSON.stringify(tp.data.inputSchema).length;
      // Loading is this computer's choice: a tool from elsewhere is found through the glossary, never preloaded.
      tools.push({
        name: tp.data.name,
        ...(tp.data.description === undefined ? {} : { description: tp.data.description }),
        inputSchema: { ...tp.data.inputSchema, type: "object" },
        load: "on-demand",
      });
    }
    if (text > MCP_LIST_SERVER_TEXT_MAX || schemas > MCP_LIST_SERVER_SCHEMAS_MAX_BYTES) {
      log?.(`${server} was left out: its ${text > MCP_LIST_SERVER_TEXT_MAX ? `text is over ${MCP_LIST_SERVER_TEXT_MAX}` : `schemas are over ${MCP_LIST_SERVER_SCHEMAS_MAX_BYTES} bytes`}`);
      continue;
    }
    out.push({ server, plugin, name, tools, ...(instructions === undefined ? {} : { instructions }), ...(scope === undefined ? {} : { scope }) });
  }
  for (const c of clashed) log?.(`${c} was left out: two plugins claim it`);
  return out.filter((l) => !clashed.has(l.server));
}

const sides = (scope: McpScope): ("bots" | "agents")[] => (scope === "both" ? ["bots", "agents"] : [scope]);

/** Who another computer's server serves: its own claim (none without one), cut to this computer's record of the
 *  plugin when there is one. */
export function servedKinds(remote: McpScope | undefined, local: { scope?: McpScope } | undefined): Set<"bots" | "agents"> {
  const out = new Set(remote === undefined ? [] : sides(remote));
  if (local !== undefined) {
    const here = new Set(sides(local.scope ?? "both"));
    for (const s of out) if (!here.has(s)) out.delete(s);
  }
  return out;
}

/** Whether those sides serve a session of `kind` (lane A's `PluginMcp.servers`). */
export function kindServed(sides: Set<"bots" | "agents">, kind: SessionKind): boolean {
  return sides.has(kind === "bot" || kind === "side-thread" ? "bots" : "agents");
}

/** A listing as a session's prompt lists it, on the computers that run it (their `computer` field when two or more). */
export function botServer(l: McpListing, computers: readonly string[]): BotMcpServer {
  const tools = placementFields({ name: l.server, kind: "local", computers }, l.tools.map(({ load: _, ...t }) => t)).tools;
  return {
    server: l.server,
    plugin: l.plugin,
    tools: tools.map((t) => ({
      name: t.name,
      ...(t.description === undefined ? {} : { description: t.description }),
      inputSchema: t.inputSchema as BotMcpServer["tools"][number]["inputSchema"],
      load: "on-demand" as const,
    })),
    ...(l.instructions === undefined ? {} : { instructions: l.instructions }),
    computers,
    reachable: true,
  };
}

export interface RemoteMcpListingsOptions {
  transport: LinkTransport;
  devices: DeviceRegistry;
  /** The local servers a computer's latest hello names. */
  named: (device: string) => readonly string[];
  onHello: (fn: (device: string) => void) => Unsubscribe;
  /** This computer's record of a plugin's server (`KnownMcpPlugin`). */
  known: KnownMcpPlugin;
  log?: (line: string) => void;
  timeoutMs?: number;
}

/** The other computers' listings, fetched after their hellos. */
export class RemoteMcpListings {
  readonly #o: RemoteMcpListingsOptions;
  readonly #listings = new Map<string, McpListing[]>();
  readonly #fetching = new Map<string, { again: boolean }>();
  readonly #off: Unsubscribe[] = [];
  /** Devices revoked while this ran (until paired again): a fetch in flight for one keeps nothing. */
  readonly #revoked = new Set<string>();
  /** Each device's revokes so far: a fetch started before one keeps nothing, even once the device is paired again. */
  readonly #revokes = new Map<string, number>();
  #closed = false;

  constructor(o: RemoteMcpListingsOptions) {
    this.#o = o;
    this.#off.push(o.onHello((device) => this.#heard(device)));
    this.#off.push(o.devices.watch((change) => {
      if (change.type !== "revoked") {
        // Paired again under the same id: its hellos count again.
        if (change.device.revokedAt === undefined) this.#revoked.delete(change.device.id);
        return;
      }
      this.#revoked.add(change.id);
      this.#revokes.set(change.id, (this.#revokes.get(change.id) ?? 0) + 1);
      this.#listings.delete(change.id);
    }));
  }

  /** `server`'s listing from the first of `devices` (in that order) that has one its hello still names; none when two
   *  computers give the key to different plugins. */
  listing(server: string, devices: readonly string[]): McpListing | undefined {
    const plugins = new Set<string>();
    for (const [d, list] of this.#listings) {
      if (!this.#o.named(d).includes(server)) continue;
      for (const l of list) if (l.server === server) plugins.add(l.plugin);
    }
    if (plugins.size > 1) return undefined;
    for (const d of devices) {
      if (!this.#o.named(d).includes(server)) continue;
      const l = this.#listings.get(d)?.find((s) => s.server === server);
      if (l !== undefined) return l;
    }
    return undefined;
  }

  /** Every server some computer's listing has (that its hello still names). */
  servers(): Set<string> {
    const out = new Set<string>();
    for (const [d, list] of this.#listings) for (const l of list) if (this.#o.named(d).includes(l.server)) out.add(l.server);
    return out;
  }

  /** Settles once no fetch is running (tests). */
  async idle(): Promise<void> {
    while (this.#fetching.size > 0) await new Promise((r) => setTimeout(r, 10));
  }

  close(): void {
    this.#closed = true;
    for (const off of this.#off.splice(0)) off();
    this.#listings.clear();
  }

  #heard(device: string): void {
    if (this.#closed || this.#revoked.has(device)) return;
    if (this.#o.named(device).length === 0) {
      this.#listings.delete(device);
      return;
    }
    const running = this.#fetching.get(device);
    if (running !== undefined) {
      running.again = true;
      return;
    }
    const state = { again: false };
    this.#fetching.set(device, state);
    void (async () => {
      do {
        state.again = false;
        await this.#fetch(device);
      } while (state.again && !this.#closed);
    })().finally(() => this.#fetching.delete(device));
  }

  async #fetch(device: string): Promise<void> {
    const log = (line: string) => this.#o.log?.(`computers: MCP listing from ${device}: ${line}`);
    try {
      const revokes = this.#revokes.get(device) ?? 0;
      const link = await this.#o.transport.connect(device);
      const raw = await link.request("mcp.list", {}, { priority: "control", timeoutMs: this.#o.timeoutMs ?? FETCH_TIMEOUT_MS });
      if (this.#closed || this.#revoked.has(device) || (this.#revokes.get(device) ?? 0) !== revokes) return;
      const d = this.#o.devices.get(device);
      if (d === undefined || d.revokedAt !== undefined || !d.runsCore) return;
      this.#listings.set(device, parseMcpList(raw, this.#o.named(device), this.#o.known, log));
    } catch (e) {
      // The last listing stays (as the hello's list does while a computer is off); the next hello fetches again.
      log(`couldn't be fetched: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
