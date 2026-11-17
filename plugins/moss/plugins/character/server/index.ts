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
//   ui.importModel, removeModel the person's own models, from a pick in its Settings section (import.ts)
import type { HandlerContext, HostPluginApi } from "@waifucave/moss-plugin-sdk";
import { ImportRefused, importModel, removeModelFiles, type ImportFormat, type OwnModel } from "./import";
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

const FORMATS_POINT = "moss.character.formats";
/** The `ownModels` setting's list (a JSON string, as the setting holds it). */
const ownList = (raw: unknown): OwnModel[] => {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : "[]") as unknown;
    return Array.isArray(v) ? (v as OwnModel[]) : [];
  } catch {
    return [];
  }
};

export const ui = {
  /** The person's pick (a token of the app's picker) copied in as one of their own models: its line, or why not. */
  importModel: async (args: unknown, ctx: HandlerContext): Promise<{ model: OwnModel } | { refused: string }> => {
    const { token, name } = (args ?? {}) as { token?: unknown; name?: unknown };
    if (typeof token !== "string" || !token.startsWith("grant:")) return { refused: "pick a folder or a file first" };
    const api = ctx.api;
    const files = api.files;
    const folder = api.storage?.dataFolder;
    if (files === undefined || folder === undefined) return { refused: "this plugin can't read a pick here" };
    const formats: ImportFormat[] = (await api.points.entries<{ format?: unknown; name?: unknown; entry?: unknown }>(FORMATS_POINT)).flatMap((e) => {
      const v = e.value;
      return typeof v?.format === "string" && Array.isArray(v.entry) ? [{ format: v.format, name: typeof v.name === "string" ? v.name : v.format, entry: (v.entry as unknown[]).filter((x): x is string => typeof x === "string"), on: true }] : [];
    });
    try {
      const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const model = await importModel(files as never, token, formats, folder, id, typeof name === "string" ? name : undefined);
      const list = ownList(await api.settings.get("ownModels"));
      await api.settings.set("ownModels", JSON.stringify([...list.filter((m) => m.file !== model.file), model]));
      return { model };
    } catch (e) {
      return { refused: e instanceof ImportRefused ? e.message : `it couldn't be copied: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` };
    }
  },
  /** One of the person's own models removed: its copy and its line; the figure goes back to the default if it was this one. */
  removeModel: async (args: unknown, ctx: HandlerContext): Promise<{ removed: true } | { refused: string }> => {
    const file = (args as { file?: unknown } | null)?.file;
    const api = ctx.api;
    const folder = api.storage?.dataFolder;
    const list = ownList(await api.settings.get("ownModels"));
    const model = list.find((m) => m.file === file);
    if (model === undefined || folder === undefined) return { refused: "that isn't one of your own models" };
    try {
      removeModelFiles(folder, model.file);
    } catch (e) {
      return { refused: e instanceof Error ? e.message : String(e) };
    }
    await api.settings.set("ownModels", JSON.stringify(list.filter((m) => m.file !== model.file)));
    if ((await api.settings.get("figure")) === `own:${model.format}:${model.file}`) await api.settings.set("figure", null);
    return { removed: true };
  },
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
