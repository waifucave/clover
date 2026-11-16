// The platform's own data points (`avatar.formats`, `avatar.packs`): the core and the app read them, so no plugin
// declares them (the owner's ruling for the stage, F6). A filler is in force as soon as its plugin runs, and a plugin
// that tries to declare one is refused.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl, validateManifest } from "@waifucave/clover-plugin-sdk";
import type { Manifest } from "../../contracts/sdk-types";
import { pointChanges, pointsApi } from "../../plugin-host/api/points";
import { RegistryCore, type RegistryInput } from "../core";
import { memoryRegistryStore } from "../state";

const m = (over: Partial<Manifest> = {}): Manifest => ({ manifest: 1, name: "A plugin", ...over });
const renderer: RegistryInput = {
  id: "pngtuber", approved: true, treeHash: "sha256:p",
  manifest: m({ name: "Picture swap", contributes: { "avatar.formats": [{ id: "png", format: "png", name: "Pictures", entry: { extensions: [".png"] }, files: { kinds: [{ ext: [".png"], type: "image" }] } }] } as Manifest["contributes"] }),
};

describe("the platform's data points", () => {
  test("a renderer's avatar.formats entry is active with no declarer in the registry", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll([renderer]);
    expect(reg.points().some((p) => p.name === "avatar.formats")).toBe(false);
    expect(reg.entries("avatar.formats").map((c) => [c.pluginId, c.state])).toEqual([["pngtuber", "active"]]);
  });

  test("a plugin that declares avatar.formats or avatar.packs is refused: it is the platform's", () => {
    for (const name of ["avatar.formats", "avatar.packs"]) {
      const codes = validateManifest({ manifest: 1, id: "stage", name: "Stage", engines: { clover: "^1.0.0" }, client: { entry: "client/index.tsx" }, contributes: { ui: [{ spot: "bot.stage", id: "s", component: "S", declares: { [name]: { shape: "list", fields: { type: "object" } } } }] } }).issues?.map((i: { code: string }) => i.code) ?? [];
      expect(codes).toContain("point_declares_core");
    }
  });

  test("a plugin that holds avatar.report (any id) reads the formats, one without a reading capability is refused, and a change reaches the reader", async () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    const stage = (id: string, caps: string[]): RegistryInput => ({ id, approved: true, treeHash: `sha256:${id}`, manifest: m({ name: id, client: { entry: "client/index.js" }, capabilities: caps as Manifest["capabilities"] }) });
    reg.putAll([stage("mystage", ["avatar.report"]), stage("nosy", []), renderer]);
    const api = pointsApi({ registry: reg, host: { invoke: async () => undefined } as never, assetUrl: (id, p) => `asset://${id}/${p}` });
    const call = (pluginId: string, args: unknown[]) => (api["points.entries"] as (c: unknown, a: unknown[]) => unknown)({ pluginId, caller: { kind: "plugin", pluginId }, record: reg.get(pluginId) }, args);
    expect((call("mystage", ["avatar.formats"]) as { pluginId: string; value: { format: string } }[]).map((e) => [e.pluginId, e.value.format])).toEqual([["pngtuber", "png"]]);
    expect(() => call("nosy", ["avatar.formats"])).toThrow(/platform's/);
    expect(() => call("mystage", ["avatar.packs"])).toThrow(/bots\.avatar/);
  });

  test("a change reaches the running holders of a reading capability, never a plugin without one; a filler without it fills but reads nothing", async () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    const plug = (id: string, caps: string[], contributes?: Manifest["contributes"]): RegistryInput => ({ id, approved: true, treeHash: `sha256:${id}`, manifest: m({ name: id, client: { entry: "client/index.js" }, capabilities: caps as Manifest["capabilities"], ...(contributes ? { contributes } : {}) }) });
    reg.putAll([plug("holder", ["avatar.report"]), plug("editor", ["bots.avatar"]), plug("nosy", [])]);
    const heard: [string, string][] = [];
    const stop = pointChanges({ registry: reg, assetUrl: (id, p) => `asset://${id}/${p}` }, (id, point) => heard.push([id, point]), 5);
    reg.putAll([plug("holder", ["avatar.report"]), plug("editor", ["bots.avatar"]), plug("nosy", []), renderer]);
    await new Promise((r) => setTimeout(r, 60));
    stop();
    const formats = heard.filter(([, p]) => p === "avatar.formats").map(([id]) => id).sort();
    expect(formats).toEqual(["editor", "holder"]);
    // The packs go to bots.avatar's holder alone.
    expect(heard.filter(([, p]) => p === "avatar.packs").map(([id]) => id)).toEqual([]);
    // The renderer fills the point (it is active) without the capability to read it.
    expect(reg.entries("avatar.formats").map((c) => [c.pluginId, c.state])).toEqual([["pngtuber", "active"]]);
  });
});
