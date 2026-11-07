// The bridge for an agent that runs inside the daemon (Clover's coding agent, `clover-code`): the same tools the stdio
// bridge serves (`SendMessage`, `Glossary`, the plugin tools in the agent's scope), as an in-process MCP server the
// embedded runtime calls directly. There is no bridge process to start, so there is no socket hello and no pid to bind:
// the server is made for one session and calls that session's handlers, and each call checks the session's token is
// still live (revoked at the agent's stop or exit), as the socket's `bridgeCloverParts` does.
import { randomUUID } from "node:crypto";
import type { McpSdkServerConfigWithInstance, WinterMcpServerInstance } from "@waifucave/clover-agent-sdk";
import type { BridgeHandlers } from "./handlers";
import type { BridgeToolDef } from "./tools";

export interface InProcessBridgeOptions {
  /** The server's name: the session's bridge server name (`clover_<id>`), as the stdio bridge's. */
  name: string;
  sessionId: string;
  /** The session's token is still live; once it isn't, every call is refused. */
  live(): boolean;
}

const result = (text: string, isError: boolean) => ({ content: [{ type: "text", text }], isError });

/** The session's bridge as an in-process MCP server. Its tool list is read once, at the start, as the stdio bridge's. */
export async function inProcessBridgeServer(h: BridgeHandlers, o: InProcessBridgeOptions): Promise<McpSdkServerConfigWithInstance> {
  const { tools } = await h.tools(o.sessionId);
  const list: BridgeToolDef[] = [...tools];
  const instance: WinterMcpServerInstance = {
    listTools: () => list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    async callTool(name, args) {
      if (!o.live()) return result("Not run: this agent's bridge was closed.", true);
      try {
        if (name === "SendMessage") {
          const text = String(args["message"] ?? args["text"] ?? "");
          if (!text) return result("SendMessage needs a message.", true);
          await h.sendMessage(o.sessionId, { text, ...(typeof args["to"] === "string" && args["to"] ? { to: args["to"] } : {}) });
          return result("Sent.", false);
        }
        if (name === "Glossary") {
          const r = await h.glossary(o.sessionId, {
            ...(args["query"] === undefined ? {} : { query: args["query"] as string | string[] }),
            ...(args["load"] === undefined ? {} : { load: args["load"] as string | string[] }),
          });
          return result(JSON.stringify(r, null, 2), false);
        }
        if (!list.some((t) => t.name === name)) return result(`No tool named ${name} is available to this agent.`, true);
        const r = await h.call(o.sessionId, { callId: randomUUID(), tool: name, input: args });
        return { content: r.content, isError: r.isError };
      } catch (err) {
        return result(err instanceof Error ? err.message : String(err), true);
      }
    },
  };
  return { type: "sdk", name: o.name, instance };
}
