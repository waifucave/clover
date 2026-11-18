// The bridge for an agent that runs inside the daemon (MOSS's coding agent, `moss-code`): the same tools the stdio
// bridge serves (`SendMessage`, `Glossary`, the plugin tools in the agent's scope), as an in-process MCP server the
// embedded runtime calls directly. There is no bridge process to start, so there is no socket hello and no pid to bind:
// the server is made for one session and calls that session's handlers, and each call checks the session's token is
// still live (revoked at the agent's stop or exit), as the socket's `bridgeMossParts` does.
import { randomUUID } from "node:crypto";
import type { McpSdkServerConfigWithInstance, WinterMcpServerInstance } from "@waifucave/clover-agent-sdk";
import type { BridgeHandlers } from "./handlers";
import { glossaryResultText, listedBridgeTool, type BridgeToolDef } from "./tools";

export interface InProcessBridgeOptions {
  /** The server's name: the session's bridge server name (`moss_<id>`), as the stdio bridge's. */
  name: string;
  sessionId: string;
  /** The session's token is still live; once it isn't, every call is refused. */
  live(): boolean;
}

const result = (text: string, isError: boolean) => ({ content: [{ type: "text", text }], isError });

/** The session's bridge as an in-process MCP server. The runtime takes its tool list once, when its query opens, so a list
 *  that changed since reaches it by the manager opening the agent again before its next turn (`toolListChanges: "next-turn"`).
 *  A call is never judged against that list: the handlers run it against the plugins' list as it is now, which refuses a tool
 *  that has gone (off, removed, out of scope) and serves one that came after the start. */
export async function inProcessBridgeServer(h: BridgeHandlers, o: InProcessBridgeOptions): Promise<McpSdkServerConfigWithInstance> {
  const { tools } = await h.tools(o.sessionId);
  const list: BridgeToolDef[] = [...tools];
  const instance: WinterMcpServerInstance = {
    listTools: () => list.map(listedBridgeTool),
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
          return result(glossaryResultText(r), false);
        }
        const r = await h.call(o.sessionId, { callId: randomUUID(), tool: name, input: args });
        return { content: r.content, isError: r.isError };
      } catch (err) {
        return result(err instanceof Error ? err.message : String(err), true);
      }
    },
  };
  return { type: "sdk", name: o.name, instance };
}
