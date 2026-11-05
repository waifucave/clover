// The browser tool's host half (clover/browser): serves the `browser` MCP server, whose one tool is `Browser`
// (mcp__clover__Browser). The server and the tool live in src/; this file only hands each transport to them.
//
// Exports (lane B's `HostModule`):
//   start(api) / stop(reason)   the host half's lifecycle
//   mcp.browser                 serves the `browser` MCP server (clover.json) on one in-process transport

import { serveBrowser } from "../src/serve";
import type { McpServerHandle } from "../src/server";
import type { McpServerFactory, McpServerTransport, PluginApi } from "../src/types";

const servers = new Set<McpServerHandle>();

/** Nothing to set up: each server starts with its own transport. */
export async function start(_api: PluginApi): Promise<void> {}

/** Closes every server this half is serving; their in-flight calls are stopped. */
export async function stop(_reason?: "reload" | "stop" | "removed"): Promise<void> {
  const all = [...servers];
  servers.clear();
  await Promise.allSettled(all.map((s) => s.close()));
}

export const mcp: Record<string, McpServerFactory> = {
  browser: async (transport: McpServerTransport, api: PluginApi): Promise<void> => {
    const server = await serveBrowser(transport, api);
    servers.add(server);
    void server.closed.then(() => servers.delete(server));
  },
};
