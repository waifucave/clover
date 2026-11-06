// The web plugin's host half (clover/web): serves the `web` MCP server, whose tools are `WebSearch` and `WebFetch`
// (mcp__clover__WebSearch, mcp__clover__WebFetch). The tools live in src/tools.ts; this file hands each transport to
// a server over them, with the plugin API's fetch (the core's, which adds the plugin's own Exa key when the user gave
// one and keeps the network floors).
//
// Exports (lane B's `HostModule`):
//   start(api) / stop(reason)   the host half's lifecycle
//   mcp.web                     serves the `web` MCP server (clover.json) on one in-process transport
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serveMcp, type McpServerTransport } from "../src/server";
import { WEB_TOOLS, webTools } from "../src/tools";

/** The parts of the plugin API this half uses. */
interface WebPluginApi {
  net: { fetch(url: string, init?: RequestInit): Promise<Response> };
  settings?: { get(key: string): unknown };
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
    const blocked = (): readonly string[] => {
      const v = api.settings?.get("blockedDomains");
      return Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : [];
    };
    const tools = webTools({ fetch: (url, init) => api.net.fetch(url, init), blockedDomains: blocked });
    const text = instructions();
    const server = await serveMcp(transport, { name: "clover-web", version: "1", ...(text === undefined ? {} : { instructions: text }), tools: WEB_TOOLS, call: (n, a, s) => tools.call(n, a, s) });
    servers.add(server);
    void server.closed.then(async () => {
      servers.delete(server);
      await tools.close().catch(() => {});
    });
  },
};
