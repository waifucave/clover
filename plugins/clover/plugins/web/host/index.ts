// The web plugin's host half (clover/web): serves the `web` MCP server, whose tools are `WebSearch` and `WebFetch`
// (mcp__clover__WebSearch, mcp__clover__WebFetch). The tools live in src/tools.ts; this file hands each transport to
// a server over them, with the plugin API's fetch (the core's, which keeps the network floors; search runs on Exa's
// anonymous tier, since the plugin declares no key).
//
// Exports (lane B's `HostModule`):
//   start(api) / stop(reason)   the host half's lifecycle
//   mcp.web                     serves the `web` MCP server (clover.json) on one in-process transport
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serveMcp, type McpServerTransport } from "../src/server";
import { WEB_TOOLS, webTools } from "../src/tools";

/** The parts of the plugin API this half uses. Each call goes to the daemon and answers later. */
interface WebPluginApi {
  net: { fetch(url: string, init?: RequestInit): Promise<Response> };
  settings?: { get(key: string): Promise<unknown> };
}

/** The `blockedDomains` setting's value as domains: a string of domains split at commas or white space (a setting
 *  has no list type), or a list. */
export function domainList(v: unknown): readonly string[] {
  const parts = typeof v === "string" ? v.split(/[\s,]+/) : Array.isArray(v) ? v : [];
  return parts.filter((d): d is string => typeof d === "string").map((d) => d.trim().toLowerCase()).filter((d) => d !== "");
}

const servers = new Set<{ close(): Promise<void>; closed: Promise<void> }>();

function instructions(): string | undefined {
  try {
    return readFileSync(join(import.meta.dir, "..", "instructions.md"), "utf8");
  } catch {
    return undefined;
  }
}

export async function start(_api: WebPluginApi): Promise<void> {}

export async function stop(_reason?: "reload" | "stop" | "removed"): Promise<void> {
  const all = [...servers];
  servers.clear();
  await Promise.allSettled(all.map((s) => s.close()));
}

export const mcp = {
  web: async (transport: McpServerTransport, api: WebPluginApi): Promise<void> => {
    // The user's extra blocked domains (the `blockedDomains` setting): every plugin-API call is the daemon's, so it
    // answers later, and it is read again before each call. A read that fails (an unreadable setting) keeps the last
    // list; it never rejects unawaited, which would end this worker (a crash) and with it the server.
    let blockedNow: readonly string[] = [];
    const readBlocked = async (): Promise<void> => {
      try {
        blockedNow = domainList(await api.settings?.get("blockedDomains"));
      } catch {
        // keeps the last list
      }
    };
    await readBlocked();
    const tools = webTools({ fetch: (url, init) => api.net.fetch(url, init), blockedDomains: () => blockedNow });
    const text = instructions();
    const call = async (n: string, a: unknown, s: AbortSignal) => {
      await readBlocked();
      return tools.call(n, a, s);
    };
    const server = await serveMcp(transport, { name: "clover-web", version: "1", ...(text === undefined ? {} : { instructions: text }), tools: WEB_TOOLS, call });
    servers.add(server);
    void server.closed.then(async () => {
      servers.delete(server);
      await tools.close().catch(() => {});
    });
  },
};
