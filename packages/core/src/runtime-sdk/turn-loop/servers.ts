// The in-process MCP servers a bot's session gets (spec §6.7): the core tools under their plain names, and every
// plugin's MCP server as `mcp__<server>__<Tool>`, each call routed by lane J's MCP router to the computer that runs it.
// Owner: lane A.
//
// * **Core tools** (`SendMessage`, `ListAgents` from lane D; `Agent`, `TaskStop` from lane K; `Glossary` here) come
//   in lane K's neutral `CoreToolDef` shape and are served by one in-process server, `clover_core`, whose tools the
//   model sees under their plain names (the SDK's `toolNames`), preloaded (`anthropic/alwaysLoad`).
// * **Plugin MCP servers** are served by one in-process server each, under the server's own name, so a tool reads
//   `mcp__<server>__<Tool>`. Each call goes to `McpRouter.run` (J's `node.mcp.run`) as the session, with its call id
//   and the lease epoch; the router picks the computer, strips the `computer` and `saveTo` fields, and saves files.
//   A tool the manifest marks `preload` is loaded up front; the rest are on-demand, found through `Glossary`.
// * The runtime's own copies of these names (`TaskStop`, `SendMessage`, `ListAgents`, `Agent`) are never offered to a
//   bot's session (driver.ts leaves them out of `tools`), so the plain names never collide.
import type { Caller } from "@waifucave/clover-protocol";
import type { McpSdkServerConfigWithInstance, WinterMcpServerInstance } from "@waifucave/clover-agent-sdk";
import { isContractError } from "../../contracts/common";

/** A core tool in lane K's neutral shape (`agents/tools.ts`, `bots/tools.ts`). */
export interface CoreToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: unknown): Promise<{ text: string; isError: boolean; meta?: Record<string, unknown> }>;
}

/** The core tools' server name; never a plugin's (plugin ids can't hold `_`). */
export const CORE_TOOLS_SERVER = "clover_core";

/** One MCP tool as the MCP host lists it (lane J's `McpToolDef`), with its loading (§6.7). */
export interface BotMcpTool {
  name: string;
  description?: string;
  inputSchema: { type: "object"; [k: string]: unknown };
  /** `preload` is always visible; `on-demand` is found and loaded through `Glossary` (the default). */
  load?: "preload" | "on-demand";
}

/** A plugin's MCP server as the session sees it (lanes B and D's host, J's placement). */
export interface BotMcpServer {
  /** The server's name: its tools are `mcp__<server>__<Tool>`. */
  server: string;
  /** The plugin that contributes it. */
  plugin: string;
  instructions?: string;
  tools: readonly BotMcpTool[];
  /** The computers it runs on, for a local server. */
  computers?: readonly string[];
  reachable?: boolean;
}

/** Lane J's MCP router (`ComputerNode.mcp`, `McpRouter.run`), as the driver calls it. */
export interface McpRunner {
  run(server: string, tool: string, input: Record<string, unknown>, ctx: { session: string; as: Caller; callId: string; epoch?: number; signal?: AbortSignal }): Promise<{ result: { content: unknown[]; isError?: boolean }; computer: string }>;
}

function text(t: string, isError: boolean): { content: unknown[]; isError: boolean } {
  return { content: [{ type: "text", text: t }], isError };
}

/** The core tools as one in-process server, each under its plain name. */
export function coreToolsServer(tools: () => readonly CoreToolDef[]): McpSdkServerConfigWithInstance {
  const initial = tools();
  const toolNames: Record<string, string> = {};
  for (const t of initial) toolNames[t.name] = t.name;
  const instance: WinterMcpServerInstance = {
    listTools: () => tools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, _meta: { "anthropic/alwaysLoad": true } })),
    async callTool(name, args) {
      const def = tools().find((t) => t.name === name);
      if (def === undefined) return text(`unknown tool: ${name}`, true);
      try {
        const r = await def.run(args);
        return { ...text(r.text, r.isError), ...(r.meta === undefined ? {} : { _meta: r.meta }) };
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    },
  };
  return { type: "sdk", name: CORE_TOOLS_SERVER, instance, toolNames };
}

/** The call id and abort of the call the runtime is making now, which the driver's tool hook records (the runtime's
 *  `tool_use_id`), so a routed call carries the id its approval and its files are keyed by. */
export interface CallIds {
  /** The id of the call to `mcp__<server>__<tool>` that is starting, taken once. */
  take(server: string, tool: string): string | undefined;
}

/** A plugin's MCP server as an in-process server whose calls lane J's router runs. */
export function routedMcpServer(o: {
  server: BotMcpServer;
  runner: McpRunner;
  session: string;
  as: Caller;
  epoch?: () => number | undefined;
  callIds?: CallIds;
  /** Called once a routed call answers, with the computer that ran it. */
  onRan?(call: { server: string; tool: string; computer: string }): void;
}): McpSdkServerConfigWithInstance {
  const { server } = o;
  const names = new Set(server.tools.map((t) => t.name));
  const instance: WinterMcpServerInstance = {
    listTools: () => server.tools.map((t) => ({
      name: t.name,
      ...(t.description === undefined ? {} : { description: t.description }),
      inputSchema: t.inputSchema,
      ...(t.load === "preload" ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
    })),
    async callTool(name, args, extra) {
      if (!names.has(name)) return text(`unknown tool: ${name}`, true);
      const callId = o.callIds?.take(server.server, name) ?? `mcp-${crypto.randomUUID()}`;
      const epoch = o.epoch?.();
      try {
        const { result, computer } = await o.runner.run(server.server, name, args, {
          session: o.session, as: o.as, callId, ...(epoch === undefined ? {} : { epoch }), ...(extra?.signal === undefined ? {} : { signal: extra.signal }),
        });
        o.onRan?.({ server: server.server, tool: name, computer });
        return { content: Array.isArray(result.content) && result.content.length > 0 ? result.content : [{ type: "text", text: "" }], isError: result.isError === true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return text(isContractError(err) ? `${msg} (${err.code})` : msg, true);
      }
    },
  };
  return { type: "sdk", name: server.server, instance };
}
