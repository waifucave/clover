// Alpha's server (her `host.entry`): her stage's keeper, her `stage` MCP server, her hooks, her commands, and what her
// tab calls (`host.call`). It runs in her tree's own fenced plugin process, like any third-party plugin's, with no
// network and no capability beyond reading Clover's state: her tree declares none (a test holds it to that).
//
// Exports (the plugin SDK's `HostModule` and handlers):
//   start(api) / stop(reason)     loads the stage from her store; writes it back on stop
//   mcp.stage                     her stage tools (tools.ts)
//   onTurnStart, onToolAfter, onTurnEnd   her hooks, which only observe (hooks.ts)
//   scene, outfit, mood           her commands (/scene, /outfit, /mood)
//   ui                            what her tab may call (nothing: her figure is reached through `api.avatar`)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stageHooks, type HookArgs } from "./hooks";
import { serveMcp, type McpServerTransport } from "./mcp";
import { StageStore, type StageApi } from "./store";
// Types only (erased when it runs): her server has no dependencies, so the SDK is named by its path.
import type { PluginSelf, SettingsApi } from "../../../packages/plugin-sdk/src/api/plugin-api";
import type { AvatarApi } from "../../../packages/plugin-sdk/src/catalogs/avatar-cues";
import { runStageTool, STAGE_TOOLS } from "./tools";

interface AlphaApi extends StageApi {
  readonly plugin?: Pick<PluginSelf, "id">;
  readonly settings: Pick<SettingsApi, "get">;
  readonly avatar?: Pick<AvatarApi, "cue" | "catalogue" | "watch">;
}

let api: AlphaApi | undefined;
let store: StageStore | undefined;
let unwatch: (() => void) | undefined;

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
  // Her figure's model loads or changes: keep its names, and put her outfit back on.
  unwatch = a.avatar?.watch((change) => { if (change.kind === "catalogue" && change.catalogue !== undefined) void store?.reapplyOutfit().catch(() => undefined); });
  void store.reapplyOutfit().catch(() => undefined);
}

export async function stop(): Promise<void> {
  try { unwatch?.(); } catch { /* already closed */ }
  unwatch = undefined;
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

/** What her tab may call (`host.call(name, args)`): only this table, never her tool, hook or command handlers. It is
 *  empty: her figure's names reach her server through `api.avatar.catalogue()`, not from her tab. */
export const ui: Record<string, never> = {};

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
