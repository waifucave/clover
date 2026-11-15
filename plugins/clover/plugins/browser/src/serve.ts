// The `browser` MCP server: the hand-written MCP server (`server.ts`) with the one `Browser` tool (`tool.ts`), and the
// caller each tool call is for, from the plugin host's context only (`caller.ts`).
import { parseCaller, type CallerOf } from "./caller";
import { TOOL } from "./schema";
import { serveMcp, type McpServerHandle } from "./server";
import { BrowserTool, type BrowserToolOptions } from "./tool";
import type { McpServerTransport, PluginApi } from "./types";

export const SERVER_NAME = "clover-browser";

export async function serveBrowser(transport: McpServerTransport, api: PluginApi, opts: BrowserToolOptions & { callerOf?: CallerOf } = {}): Promise<McpServerHandle> {
  // The caller is the core's to say: `api.browser.toolCaller()` answers, inside the tool call the plugin host is serving, with
  // the session the core bound to that call (never anything in the request). Outside a call, or in a host that says
  // nothing, it is undefined and the tool refuses.
  const { callerOf = (): Promise<unknown> => Promise.resolve(api.browser?.toolCaller?.()).catch(() => undefined), ...toolOpts } = opts;
  const tool = new BrowserTool(api, toolOpts);
  // In the plugin host's worker every property of the API is a callable proxy (each call goes to the daemon), so
  // `api.plugin.version` is a function there, never a string: one in `serverInfo` made the answer to `initialize`
  // impossible to send ("The object can not be cloned"), and the server never answered (the core waited out its 30 s
  // listing timeout). Only a real string is taken.
  const version = api.plugin?.version;
  return await serveMcp(transport, {
    info: { name: SERVER_NAME, title: "Clover Browser", version: typeof version === "string" ? version : "0.0.0" },
    tools: [TOOL],
    call: async (_name, args, request) => {
      const raw = await callerOf({ id: request.id });
      // The site the core's approval check judged the tab to be on, from the host's context only (never the request).
      const checked = typeof raw === "object" && raw !== null && typeof (raw as { checkedHost?: unknown }).checkedHost === "string" ? (raw as { checkedHost: string }).checkedHost : undefined;
      return tool.call(args, parseCaller(raw), request.signal, checked);
    },
  });
}
