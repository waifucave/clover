// The stage's keeper in her server. The plugin store is the one source: each change reads the stored document (and
// the catalogue and scenes), applies itself through `applyStage`, writes the result back and sends it to her tab
// (`ui.send("stage", …)`). Nothing is kept in memory between changes, so her MCP server and her hooks, which the plugin
// host may run in separate module instances, never write over each other's changes with a stale copy. Changes in one
// instance run one after another; at most STAGE_WRITES_PER_SECOND a second, and a change past that is refused (a hook's
// reaction is dropped; a tool says to try again).
// Types only (erased when it runs): her server has no dependencies, so the SDK is named by its path.
import type { PointsApi, SettingsApi, SyncedStore, UiSendApi } from "../../../packages/plugin-sdk/src/api/plugin-api";
import {
  applyStage, CATALOG_KEY, CATALOG_WRITES_PER_MINUTE, CONTROLS, OWN_SCENES, readCatalog, readStage, SCENES_KEY, STAGE_KEY, STAGE_MAX_BYTES, STAGE_TOPIC,
  STAGE_WRITES_PER_SECOND, stageBytes, type Scene, type StageCatalog, type StageChange, type StageResult, type StageState,
} from "./stage";

/** The parts of the plugin API the stage uses: the SDK's own types (`HostPluginApi`), never a member of its own. */
export interface StageApi {
  readonly storage: { readonly synced: Pick<SyncedStore, "get" | "set"> };
  readonly ui: UiSendApi;
  readonly settings?: Pick<SettingsApi, "get">;
  readonly points?: Pick<PointsApi, "entries">;
}

/** The scenes point other plugins fill (her `host.declares`). */
export const SCENES_POINT = "alpha.scenes";

export interface StageView {
  state: StageState;
  catalog?: StageCatalog;
  scenes: readonly Scene[];
}

function readScenes(raw: unknown): Scene[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((s): s is Scene => s !== null && typeof s === "object" && typeof (s as Scene).id === "string" && typeof (s as Scene).title === "string" && typeof (s as Scene).from === "string");
  return out.length > 0 ? out.slice(0, 64) : undefined;
}

export class StageStore {
  readonly #api: StageApi;
  readonly #now: () => number;
  #chain: Promise<unknown> = Promise.resolve();
  #window = { start: 0, n: 0 };
  #catalogWindow = { start: 0, n: 0 };

  constructor(api: StageApi, o: { now?: () => number } = {}) {
    this.#api = api;
    this.#now = o.now ?? Date.now;
  }

  /** Publishes the scenes (hers and those other plugins add through `alpha.scenes`: `{ id, title }` each) under
   *  SCENES_KEY, for her tools and her tab. */
  async refreshScenes(): Promise<readonly Scene[]> {
    const added: Scene[] = [];
    for (const e of (await this.#api.points?.entries(SCENES_POINT).catch(() => [])) ?? []) {
      const id = e.value.id, title = e.value.title;
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || OWN_SCENES.some((s) => s.id === id) || added.some((s) => s.id === id)) continue;
      const t = typeof title === "string" ? title : typeof (title as { en?: unknown } | undefined)?.en === "string" ? (title as { en: string }).en : id;
      const shown = t.replace(CONTROLS, " ").trim().slice(0, 64);
      added.push({ id, title: shown === "" ? id : shown, from: e.pluginId });
    }
    const scenes = [...OWN_SCENES, ...added.slice(0, 32)];
    await this.#api.storage.synced.set(SCENES_KEY, scenes).catch(() => {});
    return scenes;
  }

  /** The stage as stored now, with the catalogue and the scenes. */
  async read(): Promise<StageView> {
    const get = (k: string) => this.#api.storage.synced.get(k).catch(() => undefined);
    const scene = await this.#api.settings?.get("scene").catch(() => undefined);
    const state = readStage(await get(STAGE_KEY), typeof scene === "string" ? scene : "meadow");
    const catalog = readCatalog(await get(CATALOG_KEY));
    const scenes = readScenes(await get(SCENES_KEY)) ?? [...OWN_SCENES];
    return { state, ...("error" in catalog ? {} : { catalog }), scenes };
  }

  /** Her tab's catalogue of the loaded model, checked and kept (CATALOG_KEY); toggles the new model lacks go. The
   *  same catalogue again writes nothing; at most CATALOG_WRITES_PER_MINUTE new ones a minute are kept (a page calling
   *  it in a loop never churns the synced store). */
  setCatalog(raw: unknown): Promise<{ ok: true } | { ok: false; said: string }> {
    return this.#serial(async () => {
      const c = readCatalog(raw);
      if ("error" in c) return { ok: false as const, said: c.error };
      const kept = readCatalog(await this.#api.storage.synced.get(CATALOG_KEY).catch(() => undefined));
      if (!("error" in kept) && JSON.stringify(kept) === JSON.stringify(c)) return { ok: true as const };
      const now = this.#now();
      if (now - this.#catalogWindow.start >= 60_000) this.#catalogWindow = { start: now, n: 0 };
      if (this.#catalogWindow.n >= CATALOG_WRITES_PER_MINUTE) return { ok: false as const, said: "The catalogue is changing too fast; try again in a minute." };
      this.#catalogWindow.n++;
      await this.#api.storage.synced.set(CATALOG_KEY, c);
      const { state } = await this.read();
      const outfit = Object.fromEntries(Object.entries(state.outfit).filter(([k]) => c.outfit.includes(k)));
      if (Object.keys(outfit).length !== Object.keys(state.outfit).length) await this.#write({ ...state, outfit });
      return { ok: true as const };
    });
  }

  /** One change: applied to the stored stage, written and sent on; or refused with the reason. */
  change(change: StageChange): Promise<StageResult> {
    return this.#serial(async (): Promise<StageResult> => {
      const now = this.#now();
      if (now - this.#window.start >= 1000) this.#window = { start: now, n: 0 };
      if (this.#window.n >= STAGE_WRITES_PER_SECOND) return { ok: false, said: "Her stage is changing too fast; try again in a moment." };
      const v = await this.read();
      const r = applyStage(v.state, change, { ...(v.catalog ? { catalog: v.catalog } : {}), scenes: v.scenes });
      if (!r.ok) return r;
      if (stageBytes(r.state) > STAGE_MAX_BYTES) return { ok: false, said: "Her stage is full; unpin a note first." };
      this.#window.n++;
      await this.#write(r.state);
      return r;
    });
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #write(state: StageState): Promise<void> {
    await this.#api.storage.synced.set(STAGE_KEY, state);
    await this.#api.ui.send(STAGE_TOPIC, state);
  }
}
