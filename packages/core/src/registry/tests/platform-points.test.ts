// The platform's own data points (`avatar.formats`, `avatar.packs`): the core and the app read them, so no plugin
// declares them (the owner's ruling for the stage, F6). A filler is in force as soon as its plugin runs, and a plugin
// that tries to declare one is refused.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl, validateManifest } from "@waifucave/clover-plugin-sdk";
import type { Manifest } from "../../contracts/sdk-types";
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
});
