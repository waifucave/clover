// Another computer's local MCP servers, listed here (spec §9.1; J-M2's follow-up for lane A). A local server runs only
// on the computers ticked for it (`mcp-ticks.ts`), and this computer's host lists only the ones it runs. A bot here can
// still call one that runs elsewhere (`McpRouter` sends the call there), so its tools come from a computer that runs
// it: `mcp.list` answers that computer's own listing of the local servers ticked on it.
//
// * Fetched after each hello that names local servers, one request per computer at a time (a hello that arrives during
//   the fetch fetches again after it); a hello with none drops that computer's listing. A revoked device's goes.
// * Kept only for the servers that computer's latest hello names: a listing is never trusted for a name the computer
//   doesn't say it runs.
// * Bounded: the number of servers and tools, each name, description, schema and the instructions. A server or tool
//   that doesn't fit is left out (and logged), never cut; the rest of the listing stays.
// * A server listed by several computers takes the listing of the first in the registry's order that answered.
// * This computer's own listing wins: a server its host lists is never filled from another's (lane A's
//   `PluginMcp.servers`), and the router asks the host first (`node.ts`).
import { z } from "zod";
import { utf16 } from "@waifucave/clover-protocol";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { DeviceRegistry } from "../contracts/device-registry";
import type { LinkTransport } from "../contracts/link-transport";
import type { BotMcpServer } from "../runtime-sdk/turn-loop/servers";
import { placementFields, type McpToolDef } from "./mcp";

export const MCP_LIST_MAX_SERVERS = 1024;
export const MCP_LIST_MAX_TOOLS = 512;
export const MCP_LIST_DESCRIPTION_MAX = 8192;
export const MCP_LIST_INSTRUCTIONS_MAX = 16_384;
/** One tool's input schema, as JSON. */
export const MCP_LIST_SCHEMA_MAX_BYTES = 64 * 1024;
/** One computer's whole answer, as JSON. */
export const MCP_LIST_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** A server's name as plugin MCP serves it (`plugin__name`, plain characters). */
const ServerName = utf16(256, 1).regex(/^[A-Za-z0-9_-]+$/);
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
  plugin: utf16(256, 1),
  tools: z.array(z.unknown()).max(MCP_LIST_MAX_TOOLS),
  instructions: z.string().max(MCP_LIST_INSTRUCTIONS_MAX).optional(),
  scope: Scope.optional(),
});

/** One local server as the computer running it lists it: its plugin's tools as they are, without placement fields. */
export interface McpListing {
  server: string;
  plugin: string;
  tools: readonly (McpToolDef & { load?: "preload" | "on-demand" })[];
  instructions?: string;
  /** Who gets it: bots (and their side threads), coding agents, or both (the default). */
  scope?: "bots" | "agents" | "both";
}

/** Serves this computer's listing of the local servers ticked here to the paired computers. */
export function serveMcpList(o: { transport: LinkTransport; mayCall: (device: string) => boolean; listing: () => readonly McpListing[] }): Unsubscribe {
  return o.transport.handle("mcp.list", (_raw, from) => {
    if (!o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
    return { servers: o.listing().slice(0, MCP_LIST_MAX_SERVERS) };
  });
}

/** Parses one computer's answer: the servers its hello names, each within bounds; anything else left out. */
export function parseMcpList(raw: unknown, named: readonly string[], log?: (line: string) => void): McpListing[] {
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
  const seen = new Set<string>();
  for (const s of raw.servers.slice(0, MCP_LIST_MAX_SERVERS)) {
    const p = ListedServer.safeParse(s);
    if (!p.success) {
      log?.(`a server was left out: ${p.error.issues[0]?.message ?? "it didn't parse"}`);
      continue;
    }
    const { server, plugin, instructions, scope } = p.data;
    if (!named.includes(server) || seen.has(server)) {
      if (!named.includes(server)) log?.(`${server} was left out: its hello doesn't name it`);
      continue;
    }
    seen.add(server);
    const tools: McpListing["tools"][number][] = [];
    const names = new Set<string>();
    for (const t of p.data.tools) {
      const tp = ListedTool.safeParse(t);
      if (!tp.success || names.has(tp.data.name)) {
        log?.(`${server}: a tool was left out: ${tp.success ? `${tp.data.name} is listed twice` : tp.error.issues[0]?.message ?? "it didn't parse"}`);
        continue;
      }
      names.add(tp.data.name);
      tools.push({
        name: tp.data.name,
        ...(tp.data.description === undefined ? {} : { description: tp.data.description }),
        inputSchema: { ...tp.data.inputSchema, type: "object" },
        ...(tp.data.load === undefined ? {} : { load: tp.data.load }),
      });
    }
    out.push({ server, plugin, tools, ...(instructions === undefined ? {} : { instructions }), ...(scope === undefined ? {} : { scope }) });
  }
  return out;
}

/** The kinds of session a scope serves (lane A's `PluginMcp.servers`). */
export function scopeServes(scope: McpListing["scope"], kind: "bot" | "side-thread" | "agent" | "coding"): boolean {
  const s = scope ?? "both";
  return s === "both" || (s === "bots" ? kind === "bot" || kind === "side-thread" : kind === "agent" || kind === "coding");
}

/** A listing as a session's prompt lists it, on the computers that run it (their `computer` field when two or more). */
export function botServer(l: McpListing, computers: readonly string[]): BotMcpServer {
  const tools = placementFields({ name: l.server, kind: "local", computers }, l.tools.map(({ load: _, ...t }) => t)).tools;
  return {
    server: l.server,
    plugin: l.plugin,
    tools: tools.map((t, i) => ({
      name: t.name,
      ...(t.description === undefined ? {} : { description: t.description }),
      inputSchema: t.inputSchema as BotMcpServer["tools"][number]["inputSchema"],
      load: l.tools[i]!.load ?? "on-demand",
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
  log?: (line: string) => void;
  timeoutMs?: number;
}

/** The other computers' listings, fetched after their hellos. */
export class RemoteMcpListings {
  readonly #o: RemoteMcpListingsOptions;
  readonly #listings = new Map<string, McpListing[]>();
  readonly #fetching = new Map<string, { again: boolean }>();
  readonly #off: Unsubscribe[] = [];
  #closed = false;

  constructor(o: RemoteMcpListingsOptions) {
    this.#o = o;
    this.#off.push(o.onHello((device) => this.#heard(device)));
    this.#off.push(o.devices.watch((change) => {
      if (change.type === "revoked") this.#listings.delete(change.id);
    }));
  }

  /** `server`'s listing from the first of `devices` (in that order) that has one its hello still names. */
  listing(server: string, devices: readonly string[]): McpListing | undefined {
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
    if (this.#closed) return;
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
      const link = await this.#o.transport.connect(device);
      const raw = await link.request("mcp.list", {}, { priority: "control", timeoutMs: this.#o.timeoutMs ?? FETCH_TIMEOUT_MS });
      if (this.#closed) return;
      const d = this.#o.devices.get(device);
      if (d === undefined || d.revokedAt !== undefined) return;
      this.#listings.set(device, parseMcpList(raw, this.#o.named(device), log));
    } catch (e) {
      // The last listing stays (as the hello's list does while a computer is off); the next hello fetches again.
      log(`couldn't be fetched: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
