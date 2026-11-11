// Alpha's server (her `host.entry`): her stage's keeper, her `stage` MCP server, her hooks, her commands, and what her
// tab calls (`host.call`). It runs in her tree's own fenced plugin process, like any third-party plugin's, with no
// network and no capability beyond reading Clover's state: her tree declares none (a test holds it to that).
//
// Exports (the plugin SDK's `HostModule` and handlers):
//   start(api) / stop(reason)     loads the stage from her store; writes it back on stop
//   mcp.stage                     her stage tools (tools.ts)
//   onTurnStart, onToolAfter, onTurnEnd   her hooks, which only observe (hooks.ts)
//   scene, outfit, mood           her commands (/scene, /outfit, /mood)
//   setCatalog                    her tab's catalogue of the loaded model (host.call)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stageHooks, type HookArgs } from "./hooks";
import { serveMcp, type McpServerTransport } from "./mcp";
import { StageStore, type StageApi } from "./store";
import { runStageTool, STAGE_TOOLS } from "./tools";

interface AlphaApi extends StageApi {
  plugin?: { id: string };
  settings: { get(key: string): Promise<unknown> };
}

let api: AlphaApi | undefined;
let store: StageStore | undefined;

const setting = (key: string): Promise<unknown> => api?.settings.get(key) ?? Promise.resolve(undefined);
const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const ready = (): StageStore => {
  if (store === undefined) throw new Error("Alpha's stage isn't loaded yet");
  return store;
};

export async function start(a: AlphaApi): Promise<void> {
  api = a;
  store = new StageStore(a);
  await store.refreshScenes();
}

export async function stop(): Promise<void> {
  store = undefined;
  api = undefined;
}

const hooks = () => stageHooks({
  store: ready(), bot: api?.plugin?.id ?? "alpha", today,
  reactions: async () => (await setting("reactions").catch(() => undefined)) !== false,
});
export const onTurnStart = (args: HookArgs) => hooks().onTurnStart(args);
export const onToolAfter = (args: HookArgs) => hooks().onToolAfter(args);
export const onTurnEnd = (args: HookArgs) => hooks().onTurnEnd(args);

const said = async (r: Promise<{ said: string }>) => ({ text: (await r).said });
export const scene = async (args: { scene?: unknown }) => said(ready().change({ kind: "scene", scene: typeof args?.scene === "string" ? args.scene : "" }));
export const mood = async (args: { mood?: unknown }) => said(ready().change({ kind: "mood", mood: typeof args?.mood === "string" ? args.mood : "" }));
export const outfit = async (args: { part?: unknown; on?: unknown }) =>
  said(ready().change({ kind: "outfit", part: typeof args?.part === "string" ? args.part : "", ...(typeof args?.on === "boolean" ? { on: args.on } : {}) }));

/** Her tab hands over the loaded model's names (`host.call("setCatalog", { v: 1, expressions, motions, outfit })`). */
export const setCatalog = async (args: unknown) => ready().setCatalog(args);

function instructions(): string | undefined {
  try {
    return readFileSync(join(import.meta.dir, "instructions.md"), "utf8");
  } catch {
    return undefined;
  }
}

export const mcp = {
  stage: async (transport: McpServerTransport): Promise<void> => {
    const text = instructions();
    await serveMcp(transport, {
      name: "stage", version: "1.0.0", tools: STAGE_TOOLS, ...(text === undefined ? {} : { instructions: text }),
      call: (name, args) => runStageTool(name, args, ready(), setting),
    });
  },
};
