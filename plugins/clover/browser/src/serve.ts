// The `browser` MCP server: the hand-written MCP server (`server.ts`) with the one `Browser` tool (`tool.ts`), and the
// caller read off each request (`caller.ts`).
import { callerFromRequest } from "./caller";
import { TOOL } from "./schema";
import { serveMcp, type McpServerHandle } from "./server";
import { BrowserTool, type BrowserToolOptions } from "./tool";
import type { McpServerTransport, PluginApi } from "./types";

export const SERVER_NAME = "clover-browser";

export async function serveBrowser(transport: McpServerTransport, api: PluginApi, opts: BrowserToolOptions = {}): Promise<McpServerHandle> {
  const tool = new BrowserTool(api, opts);
  return await serveMcp(transport, {
    info: { name: SERVER_NAME, title: "Clover Browser", version: api.plugin?.version ?? "0.0.0" },
    tools: [TOOL],
    call: (_name, args, request) => tool.call(args, callerFromRequest(request.params), request.signal),
  });
}
