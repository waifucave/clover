// Her outfit is a setting (the owner's Edit page section: her six settings plus an outfit picker). On her own model her
// `toggle_outfit` tool and `/outfit` write it and dress her figure in it, one outfit at a time; with another avatar picked for
// her (the user layer's), the setting is left aside and that model's own parts switch as before. Her tab, her server, her
// manifest's options and her model's marks name the same three outfits.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AvatarCatalogue, AvatarCue, AvatarCueResult } from "../../../../packages/plugin-sdk/src/catalogs/avatar-cues";
import * as tab from "../../client/outfits";
import { glbJson } from "../../../clover/plugins/vrm/src/vrm/glb";
import { OUTFITS as MODEL_OUTFITS } from "../../../clover/plugins/vrm/src/placeholder/model";
import { outfit as outfitCommand } from "../index";
import { DEFAULT_OUTFIT, OUTFIT_VALUES, OUTFITS, outfitCues, pickOutfit, wearsHerOutfits } from "../outfits";
import { STAGE_KEY } from "../stage";
import { StageStore } from "../store";
import { runStageTool } from "../tools";
import { ALPHA, fakeApi, fakeAvatar, MODEL } from "./fakes";

const HERS: AvatarCatalogue = {
  format: "vrm", renderer: "clover/vrm", capabilities: ["lipsync", "expressions", "lookat", "pace", "outfits"],
  expressions: ["happy"], motions: [], outfits: OUTFIT_VALUES.map((name, i) => ({ name, on: i === 0 })),
};

function setup(o: { catalogue?: AvatarCatalogue; answer?: (cue: AvatarCue) => AvatarCueResult; userLayer?: string[]; outfit?: string } = {}) {
  const f = fakeApi({ settings: o.outfit === undefined ? {} : { outfit: o.outfit } });
  const settings: Record<string, unknown> = o.outfit === undefined ? {} : { outfit: o.outfit };
  const set: [string, unknown][] = [];
  const a = fakeAvatar({ ...(o.catalogue !== undefined ? { catalogue: o.catalogue } : {}), ...(o.answer ? { answer: o.answer } : {}) });
  let t = 0;
  const api = {
    ...f.api, avatar: a.avatar,
    settings: { get: async <T>(k: string) => settings[k] as T | undefined, set: async (k: string, v: unknown) => { set.push([k, v]); settings[k] = v; } },
    bots: { get: async (id: string) => ({ id, userLayer: o.userLayer ?? [] }) },
  };
  const s = new StageStore(api, { now: () => (t += 200), bot: "alpha" });
  return { f, a, s, set, settings, run: (name: string, args: unknown = {}) => runStageTool(name, args, s, api.settings.get) };
}

describe("her outfit, on her own model", () => {
  test("her tool puts an outfit on: the setting the Edit page's picker shows says it, and her figure wears it alone", async () => {
    const { a, set, run, f } = setup({ catalogue: HERS });
    expect(await run("toggle_outfit", { part: "navy-uniform", on: true })).toMatchObject({ content: [{ text: "Outfit: Navy uniform" }] });
    expect(set).toEqual([["outfit", "navy-uniform"]]);
    expect(a.cues).toEqual(outfitCues("navy-uniform"));
    expect((f.store.get(STAGE_KEY) as { outfit: Record<string, boolean> }).outfit).toEqual({ "lilac-dress": false, "navy-uniform": true, "yellow-raincoat": false });
    // stage_status says what she wears from the setting.
    const st = JSON.parse((await run("stage_status")).content[0]!.text.split("\n")[1]!);
    expect([st.her_outfit, st.her_outfits]).toEqual(["navy-uniform", OUTFIT_VALUES]);
  });

  test("off goes back to her lilac dress; a flip with no `on` puts on one she isn't wearing; a name that isn't hers is refused", async () => {
    const { set, run } = setup({ catalogue: HERS, outfit: "yellow-raincoat" });
    await run("toggle_outfit", { part: "yellow-raincoat", on: false });
    await run("toggle_outfit", { part: "navy-uniform" });
    expect(set.map(([, v]) => v)).toEqual([DEFAULT_OUTFIT, "navy-uniform"]);
    expect(await run("toggle_outfit", { part: "hat" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Her outfits are lilac-dress, navy-uniform, yellow-raincoat") }] });
    expect(pickOutfit("navy-uniform", "yellow-raincoat", false)).toBe("navy-uniform");
  });

  test("/outfit writes the same setting", async () => {
    const f = fakeApi();
    const set: [string, unknown][] = [];
    const mod = await import("../index");
    await mod.start({ ...f.api, settings: { get: async () => undefined, set: async (k: string, v: unknown) => void set.push([k, v]) }, bots: { get: async () => ({ userLayer: [] }) }, avatar: fakeAvatar({ catalogue: HERS }).avatar } as never);
    try {
      expect(await outfitCommand({ part: "yellow-raincoat", on: true })).toEqual({ text: "Outfit: Yellow raincoat" });
      expect(set).toEqual([["outfit", "yellow-raincoat"]]);
    } finally {
      await mod.stop();
    }
  });

  test("nothing drawing her keeps the choice for when her stage is drawn; a renderer's plain no is the tool's refusal and nothing is saved", async () => {
    const quiet = setup({ answer: () => ({ ok: false, reason: "no-renderer", message: "nothing is drawing this bot's figure right now" }) });
    expect(await quiet.run("toggle_outfit", { part: "yellow-raincoat", on: true })).toMatchObject({ content: [{ text: "Outfit: Yellow raincoat" }] });
    expect(quiet.set).toEqual([["outfit", "yellow-raincoat"]]);
    const old = setup({ catalogue: HERS, answer: () => ({ ok: false, reason: "unsupported", message: "this renderer (x) doesn't do outfits" }) });
    expect(await old.run("toggle_outfit", { part: "navy-uniform", on: true })).toMatchObject({ isError: true });
    expect(old.set).toEqual([]);
  });
});

describe("another avatar picked for her", () => {
  test("the setting is left aside: her tool switches that model's own parts as before", async () => {
    const { a, set, run } = setup({ catalogue: MODEL, userLayer: ["avatar"] });
    expect(await run("toggle_outfit", { part: "hat", on: true })).toMatchObject({ content: [{ text: "Outfit: hat on" }] });
    expect([a.cues, set]).toEqual([[{ type: "outfit", part: "hat", on: true }], []]);
    // The user layer decides even when the picked model happens to carry parts by her outfits' names.
    const named = setup({ catalogue: HERS, userLayer: ["avatar"] });
    await named.run("toggle_outfit", { part: "navy-uniform", on: true });
    expect([named.a.cues, named.set]).toEqual([[{ type: "outfit", part: "navy-uniform", on: true }], []]);
    expect(wearsHerOutfits(["hat"])).toBe(false);
  });
});

describe("one list of her outfits", () => {
  test("her tab, her server, her manifest's options and her model's marks name the same three, the lilac dress first and the default", () => {
    const manifest = JSON.parse(readFileSync(join(ALPHA, "clover.json"), "utf8")) as { settings: Record<string, { type: string; default: unknown; options: { value: string; title: { en: string } }[]; scope?: string }> };
    const setting = manifest.settings.outfit!;
    expect(setting.type).toBe("enum");
    expect(setting.options.map((o) => ({ value: o.value, title: o.title.en }))).toEqual(OUTFITS.map((o) => ({ ...o })));
    expect(setting.default).toBe(DEFAULT_OUTFIT);
    expect(tab.OUTFITS.map((o) => ({ ...o }))).toEqual(OUTFITS.map((o) => ({ ...o })));
    expect(tab.DEFAULT_OUTFIT).toBe(DEFAULT_OUTFIT);
    expect([...MODEL_OUTFITS]).toEqual([...OUTFIT_VALUES]);
    const json = glbJson(new Uint8Array(readFileSync(join(ALPHA, "assets", "alpha.vrm")))) as { nodes: { extras?: { clover?: { outfit?: string; on?: boolean } } }[] };
    const marked = [...new Set(json.nodes.flatMap((n) => (n.extras?.clover?.outfit !== undefined ? [n.extras.clover.outfit] : [])))];
    expect(marked).toEqual([...OUTFIT_VALUES]);
    // Shown at load: the default only, so her look with nothing set is the one she always had.
    expect(json.nodes.filter((n) => n.extras?.clover?.outfit !== undefined && n.extras.clover.on !== false).every((n) => n.extras!.clover!.outfit === DEFAULT_OUTFIT)).toBe(true);
  });
});

describe("her tab dresses her from what her figure shows", () => {
  const showing = (...on: string[]) => OUTFIT_VALUES.map((name) => ({ name, on: on.includes(name) }));
  test("the same cues as her server's, less those her figure already shows", () => {
    expect<unknown>(tab.outfitCues("navy-uniform")).toEqual(outfitCues("navy-uniform"));
    expect(tab.cuesToDress(showing("lilac-dress"), "navy-uniform")).toEqual([{ type: "outfit", part: "lilac-dress", on: false }, { type: "outfit", part: "navy-uniform", on: true }]);
    expect(tab.cuesToDress(showing(), "navy-uniform")).toEqual([{ type: "outfit", part: "navy-uniform", on: true }]);
    expect(tab.cuesToDress(showing("navy-uniform"), "navy-uniform")).toEqual([]);
  });
  test("a model loaded again mid-way (its default back on beside the new outfit) gets the default off", () => {
    expect(tab.cuesToDress(showing("lilac-dress", "navy-uniform"), "navy-uniform")).toEqual([{ type: "outfit", part: "lilac-dress", on: false }]);
    expect(tab.dressedIn(showing("lilac-dress", "navy-uniform"), "navy-uniform")).toBe(false);
  });
});
