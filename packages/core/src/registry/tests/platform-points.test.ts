// The platform has no data points of its own now: the avatar's (`avatar.formats`, `avatar.packs`) left with the figure for
// the bundled avatar plugin, which declares its own (spec revision 19, G7). A third-party plugin that still names one, or
// asks for a retired capability, fails closed with the name of what replaced it; the avatar plugin's own points work as
// any plugin's do: a filler waits for their declarer, and the declarer reads them.
import { describe, expect, test } from "bun:test";
import { DATA_POINTS, RETIRED_CAPABILITIES, RETIRED_POINTS, catalogPointDecl, isPlatformDataPoint, validateManifest } from "@waifucave/moss-plugin-sdk";
import type { Manifest } from "../../contracts/sdk-types";
import { pointsApi } from "../../plugin-host/api/points";
import { RegistryCore, type RegistryInput } from "../core";
import { memoryRegistryStore } from "../state";

const m = (over: Partial<Manifest> = {}): Manifest => ({ manifest: 1, name: "A plugin", ...over });
const issues = (manifest: unknown) => validateManifest(manifest).issues.map((i) => ({ code: i.code, refuses: i.refuses, message: i.message }));

describe("no data point is the platform's", () => {
  test("the catalog lists none the core declares; the old names are not among its points", () => {
    expect(Object.keys(DATA_POINTS).filter(isPlatformDataPoint)).toEqual([]);
    for (const name of ["avatar.formats", "avatar.packs"]) expect(Object.keys(DATA_POINTS)).not.toContain(name);
  });

  test("a third-party manifest that fills a retired point, or holds a retired capability, is refused, saying what replaced it", () => {
    const base = { manifest: 1, id: "acme-figure", name: "Acme figure", engines: { moss: "^1.0.0" }, client: { entry: "client/index.tsx" } };
    const filled = issues({ ...base, contributes: { "avatar.formats": [{ id: "png", format: "png" }] } });
    // The entry is refused (it reaches nothing); the plugin's other parts stand.
    expect(filled).toContainEqual(expect.objectContaining({ code: "point_retired", refuses: "contribution" }));
    expect(filled.find((i) => i.code === "point_retired")!.message).toContain("moss.character.formats");
    // (Declaring a point of that name is a plugin's own point, which nothing of the platform reads: no finding, and no filler can reach it.)
    for (const r of RETIRED_CAPABILITIES) {
      const held = issues({ ...base, capabilities: [r.name] });
      const found = held.find((i) => i.code === "capability_retired");
      expect(found, r.name).toBeDefined();
      expect(found!.refuses).toBe("plugin");
      expect(found!.message).toContain(r.replacedBy);
    }
    for (const r of RETIRED_POINTS.filter((p) => p.name.includes("stage") || p.name === "avatar")) {
      const spot = issues({ ...base, contributes: { ui: [{ spot: r.name, key: "png", id: "s", component: "S" }] } });
      expect(spot.some((i) => (i.code === "spot_retired" || i.code === "point_retired") && i.refuses !== "none"), r.name).toBe(true);
    }
  });
});

describe("the avatar plugin's points are a plugin's points", () => {
  const declarer: RegistryInput = {
    id: "acme-stage", approved: true, treeHash: "sha256:s",
    manifest: m({ name: "Stage", host: { entry: "host/index.js", declares: { "acme-stage.formats": { shape: "list", fields: { type: "object" } } } } } as Partial<Manifest>),
  };
  const filler: RegistryInput = {
    id: "acme-renderer", approved: true, treeHash: "sha256:r",
    manifest: m({ name: "Renderer", contributes: { "acme-stage.formats": [{ id: "png", format: "png" }] } as Manifest["contributes"] }),
  };

  test("a filler waits for its declarer and is active beside it; the declarer reads its entries, another plugin is refused", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    const nosy: RegistryInput = { id: "nosy", approved: true, treeHash: "sha256:n", manifest: m({ name: "nosy", client: { entry: "client/index.js" } }) };
    reg.putAll([filler, nosy]);
    expect(reg.entries("acme-stage.formats").map((c) => c.state)).not.toContain("active");
    reg.putAll([declarer, filler, nosy]);
    expect(reg.entries("acme-stage.formats").map((c) => [c.pluginId, c.state])).toEqual([["acme-renderer", "active"]]);
    const api = pointsApi({ registry: reg, host: { invoke: async () => undefined } as never, assetUrl: (id, p) => `asset://${id}/${p}` });
    const call = (pluginId: string, args: unknown[]) => (api["points.entries"] as (c: unknown, a: unknown[]) => unknown)({ pluginId, caller: { kind: "plugin", pluginId }, record: reg.get(pluginId) }, args);
    expect((call("acme-stage", ["acme-stage.formats"]) as { pluginId: string }[]).map((e) => e.pluginId)).toEqual(["acme-renderer"]);
    expect(() => call("nosy", ["acme-stage.formats"])).toThrow();
  });
});
