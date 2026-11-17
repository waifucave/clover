// The avatar plugin's host half (moss/character): it serves the plugin's own `figure` MCP server (tools.ts) and hands
// each call to the figures its components draw. A call goes out as `ui.send("figure-tool", { id, cue | status })`,
// which the core stamps with whose call it is (the session, its kind, its bot); a figure that takes it (client/figure.tsx,
// `figureTakesCall`) judges and plays it as it does a controller's cue on `moss.character.figure`, and answers through
// this half's `ui.answered`. The first answer wins; none within ANSWER_MS means no figure took it.
//
// Exports (the SDK's `HostModule`):
//   start(api) / stop(reason)   the host half's lifecycle
//   mcp.figure                  serves the `figure` server on one in-process transport
//   ui.answered                 a figure's answer to one call
import type { HostPluginApi } from "@waifucave/moss-plugin-sdk";
import { serveMcp, type McpServerTransport } from "./mcp";
import { FIGURE_TOOLS, runFigureTool } from "./tools";

/** The event the figures listen for (client/figure.tsx `TOOL_EVENT`). */
export const TOOL_EVENT = "figure-tool";
/** How long a call waits for a figure's answer. */
export const ANSWER_MS = 3_000;

type Api = Pick<HostPluginApi, "ui">;
const waiting = new Map<string, (answer: unknown) => void>();
let n = 0;

export async function start(_a: Api): Promise<void> {}

export async function stop(): Promise<void> {
  for (const done of waiting.values()) done(undefined);
  waiting.clear();
}

/** Hands one request to the figures, as the session whose call this is, and waits for the first answer. */
export async function ask(a: Api, request: { cue?: unknown; status?: true }, ms = ANSWER_MS): Promise<never | undefined | Record<string, unknown>> {
  const id = `t${++n}-${Date.now().toString(36)}`;
  const answered = new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve(undefined); }, ms);
    waiting.set(id, (answer) => { clearTimeout(timer); waiting.delete(id); resolve(answer); });
  });
  await a.ui.send(TOOL_EVENT, { id, ...request });
  return (await answered) as Record<string, unknown> | undefined;
}

export const mcp = {
  figure: async (transport: McpServerTransport, a: Api): Promise<void> => {
    await serveMcp(transport, {
      name: "figure", version: "1.0.0", tools: FIGURE_TOOLS,
      // The api handed with this transport: its calls made inside a `tools/call` act as that call's session, so the
      // core stamps the message with whose call it is.
      call: (name, args) => runFigureTool(name, args, (request) => ask(a, request) as never),
    });
  },
};

export const ui = {
  /** A figure's answer to a call it took; one for a call no longer waiting is nothing. */
  answered: (args: unknown): boolean => {
    const v = args as { id?: unknown; result?: unknown } | null;
    if (typeof v?.id !== "string") return false;
    const done = waiting.get(v.id);
    if (done === undefined) return false;
    done(v.result);
    return true;
  },
};
