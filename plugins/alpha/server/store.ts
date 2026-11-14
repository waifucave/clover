// The stage's keeper in her server. The plugin store is the one source: each change reads the stored document (and
// the catalogue and scenes), applies itself through `applyStage`, writes the result back and sends it to her tab
// (`ui.send("stage", …)`). Nothing is kept in memory between changes, so her MCP server and her hooks, which the plugin
// host may run in separate module instances, never write over each other's changes with a stale copy. Changes in one
// instance run one after another; at most STAGE_WRITES_PER_SECOND a second, and a change past that is refused (a hook's
// reaction is dropped; a tool says to try again).
// Types only (erased when it runs): her server has no dependencies, so the SDK is named by its path.
import type { PointsApi, SettingsApi, SyncedStore, UiSendApi } from "../../../packages/plugin-sdk/src/api/plugin-api";
import type { AvatarApi, AvatarCue, AvatarCueResult } from "../../../packages/plugin-sdk/src/catalogs/avatar-cues";
import { DEFAULT_OUTFIT, isOutfit, OUTFIT_SETTING, OUTFIT_VALUES, outfitCues, outfitOf, outfitTitle, pickOutfit, wearsHerOutfits } from "./outfits";
import {
  applyStage, CATALOG_KEY, CATALOG_WRITES_PER_MINUTE, CONTROLS, OWN_SCENES, readCatalog, readStage, SCENES_KEY, STAGE_KEY, STAGE_MAX_BYTES, STAGE_TOPIC,
  STAGE_WRITES_PER_SECOND, stageBytes, type Scene, type StageCatalog, type StageChange, type StageResult, type StageState,
} from "./stage";

/** The parts of the plugin API the stage uses: the SDK's own types (`HostPluginApi`), never a member of its own. */
export interface StageApi {
  readonly storage: { readonly synced: Pick<SyncedStore, "get" | "set"> };
  readonly ui: UiSendApi;
  /** Her settings: `scene` read, `outfit` read and written (her outfit lives there, client/outfits.ts). */
  readonly settings?: Pick<SettingsApi, "get"> & Partial<Pick<SettingsApi, "set">>;
  /** `bots.read`: whether the user picked another avatar for her (the user layer's `avatar`), which leaves her outfit setting aside. */
  readonly bots?: { get(bot: string): Promise<{ readonly userLayer?: readonly string[] }> };
  readonly points?: Pick<PointsApi, "entries">;
  /** The public avatar calls (`avatar.control`, `avatar.read`): how her stage reaches her figure, whatever draws it. */
  readonly avatar?: Pick<AvatarApi, "cue" | "catalogue">;
}

/** The expressions a celebration tries, best first. */
const JOY = ["love", "smile", "happy"] as const;
/** Where she looks while a turn runs: down, toward the conversation, in the stage's own square (-1 to 1 from its centre). */
const WORKING_LOOK = { x: 0, y: 0.7 } as const;

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
  /** Her bot's id (her plugin's). */
  readonly #bot: string;
  #chain: Promise<unknown> = Promise.resolve();
  #window = { start: 0, n: 0 };
  #catalogWindow = { start: 0, n: 0 };

  constructor(api: StageApi, o: { now?: () => number; bot?: string } = {}) {
    this.#api = api;
    this.#now = o.now ?? Date.now;
    this.#bot = o.bot ?? "alpha";
  }

  /** Whether the model her stage shows wears her outfits: no other avatar picked for her (the user layer's), and the loaded
   *  model's outfit parts are hers (or no model has said its names yet: her own is the one she starts with). */
  async wearsHers(catalog: StageCatalog | undefined): Promise<boolean> {
    const bot = await this.#api.bots?.get(this.#bot).catch(() => undefined);
    if (bot?.userLayer?.includes("avatar") === true) return false;
    return catalog === undefined || wearsHerOutfits(catalog.outfit);
  }

  /** The outfit her setting says (the default when it says none). */
  async outfit(): Promise<string> {
    return outfitOf(await this.#api.settings?.get(OUTFIT_SETTING).catch(() => undefined));
  }

  /** One of her outfits on or off, on her own model: her `outfit` setting picks it (the Edit page's picker shows the same),
   *  and her figure is dressed in it while it is drawn. Nothing drawing her keeps the choice for when it is. */
  async #dress(change: { part: string; on?: boolean }, state: StageState): Promise<StageResult> {
    const part = change.part.normalize("NFC");
    if (!isOutfit(part)) return { ok: false, said: `Her outfits are ${OUTFIT_VALUES.join(", ")} (her own model's; ${DEFAULT_OUTFIT} is the one she starts in).` };
    const set = this.#api.settings?.set;
    if (set === undefined) return { ok: false, said: "Her outfit setting can't be changed here." };
    const next = pickOutfit(outfitOf(await this.#api.settings?.get(OUTFIT_SETTING).catch(() => undefined)), part, change.on);
    // The renderer's no comes first, from what it says it does (the catalogue the core judges cues by), so a refusal saves
    // nothing. Then the setting, then the cues: her tab dresses her from the setting too, and a cue sent before the setting
    // changed would have it dress her back in the old one.
    const drawn = await this.#api.avatar?.catalogue().catch(() => undefined);
    if (drawn !== undefined && !drawn.capabilities.includes("outfits")) return { ok: false, said: `this renderer (${drawn.renderer}) doesn't do outfits` };
    await set.call(this.#api.settings, OUTFIT_SETTING, next);
    if (drawn !== undefined) for (const cue of outfitCues(next)) if ((await this.#cue(cue)).ok === false) break;
    const dressed: StageState = { ...state, outfit: Object.fromEntries(OUTFIT_VALUES.map((o) => [o, o === next])) };
    await this.#write(dressed);
    return { ok: true, state: dressed, said: `Outfit: ${outfitTitle(next)}`, shown: { kind: "outfit", label: "Outfit", value: outfitTitle(next) } };
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
    return this.#serial(() => this.#keepCatalog(raw));
  }

  /** The loaded model's names as the renderer publishes them (`avatar.catalogue()`), kept like a catalogue her tab
   *  handed over. Nothing loaded, or no avatar calls: what is kept stays. */
  refreshCatalogue(): Promise<void> {
    return this.#serial(() => this.#syncCatalogue());
  }

  async #syncCatalogue(): Promise<void> {
    const c = await this.#api.avatar?.catalogue().catch(() => undefined);
    if (c === undefined) return;
    await this.#keepCatalog({ v: 1, expressions: c.expressions, motions: c.motions, outfit: c.outfits.map((o) => o.name) });
  }

  /** A cue to her figure; undefined when it was played. */
  async #cue(cue: AvatarCue): Promise<AvatarCueResult> {
    const a = this.#api.avatar;
    if (a === undefined) return { ok: true };
    try { return await a.cue(cue); } catch (e) { return { ok: false, reason: "invalid", message: e instanceof Error ? e.message : "her figure could not be reached" }; }
  }

  /** After a model loads: the outfit she wears goes on again (the new figure starts from its own defaults). */
  reapplyOutfit(): Promise<void> {
    return this.#serial(async () => {
      await this.#syncCatalogue();
      const { state, catalog } = await this.read();
      for (const [part, on] of Object.entries(state.outfit)) if (catalog?.outfit.includes(part)) await this.#cue({ type: "outfit", part, on });
    });
  }

  async #keepCatalog(raw: unknown): Promise<{ ok: true } | { ok: false; said: string }> {
    {
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
    }
  }

  /** One change: applied to the stored stage, written and sent on; or refused with the reason. */
  change(change: StageChange): Promise<StageResult> {
    return this.#serial(async (): Promise<StageResult> => {
      const now = this.#now();
      if (now - this.#window.start >= 1000) this.#window = { start: now, n: 0 };
      // A count is never refused for the rate (a burst of tool calls would otherwise drop the day's tool tally); it is not counted against it either.
      const counting = change.kind === "tally";
      if (!counting && this.#window.n >= STAGE_WRITES_PER_SECOND) return { ok: false, said: "Her stage is changing too fast; try again in a moment." };
      if (change.kind === "expression" || change.kind === "motion" || change.kind === "outfit" || change.kind === "celebrate") await this.#syncCatalogue();
      const v = await this.read();
      if (change.kind === "outfit" && (await this.wearsHers(v.catalog))) {
        const dressed = await this.#dress(change, v.state);
        if (dressed.ok) this.#window.n++;
        return dressed;
      }
      const r = applyStage(v.state, change, { ...(v.catalog ? { catalog: v.catalog } : {}), scenes: v.scenes });
      if (!r.ok) return r;
      if (stageBytes(r.state) > STAGE_MAX_BYTES) return { ok: false, said: "Her stage is full; unpin a note first." };
      // Her figure first: a cue it won't play (nothing draws her, or her renderer lacks it) is answered as the tool's
      // refusal, and the stage keeps what it had.
      const cue = change.kind === "expression" || change.kind === "motion" ? ({ type: change.kind, name: change.kind === "expression" ? r.state.expression! : r.state.motion! } as const)
        : change.kind === "outfit" ? ({ type: "outfit", part: change.part.normalize("NFC"), on: r.state.outfit[change.part.normalize("NFC")] === true } as const) : undefined;
      if (cue !== undefined) {
        const played = await this.#cue(cue);
        if (!played.ok) return { ok: false, said: played.message };
      }
      if (!counting) this.#window.n++;
      await this.#write(r.state);
      if (change.kind === "celebrate") {
        const names = v.catalog?.expressions ?? [];
        const joy = JOY.find((n) => names.includes(n));
        if (joy !== undefined) void this.#cue({ type: "expression", name: joy });
      }
      if (change.kind === "activity") {
        const working = (a?: { kind: string }) => a?.kind === "thinking" || a?.kind === "tool";
        if (working(r.state.activity) !== working(v.state.activity)) void this.#cue({ type: "lookAt", point: working(r.state.activity) ? { ...WORKING_LOOK } : null });
      }
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
