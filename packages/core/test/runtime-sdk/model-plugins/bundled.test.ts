// A-M2: every provider a plugin. The bundled `clover` tree holds one model plugin per provider of the SDK's catalog,
// generated and committed; this is the check that they match (CI fails while they don't), and that each one is a
// valid child of `clover` that the plugin SDK classifies as it should: data for an endpoint, code for an adapter.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GENERIC_ADAPTER_IDS, loadCatalog } from "@waifucave/clover-provider-catalog";
import { pluginFromFolder } from "../../../src/bots/tests/fixtures";
import { BUNDLED_CHILDREN_DIR, CODE_PLUGINS, modelPluginFolder } from "../../../src/runtime-sdk/model-plugins/bundled";
import { checkModelPlugins, generateModelPlugins } from "../../../src/runtime-sdk/model-plugins/generate";

const sdk = loadCatalog();

describe("the bundled model plugins", () => {
  test("the committed folders match what the SDK's catalog generates (run generate.ts --write if not)", () => {
    expect(checkModelPlugins()).toEqual([]);
  });

  test("one plugin per provider: 218 of them, 6 with code, the rest data on a generic adapter", () => {
    expect(generateModelPlugins().size).toBe(sdk.providers.length);
    expect(sdk.providers.length).toBe(218);
    const code = sdk.providers.filter((p) => !GENERIC_ADAPTER_IDS.has(p.adapterId)).map((p) => p.id).sort();
    expect(code).toEqual(Object.keys(CODE_PLUGINS).sort());
    for (const id of code) {
      expect(existsSync(join(BUNDLED_CHILDREN_DIR, modelPluginFolder(id), "host", "index.ts"))).toBe(true);
      expect(existsSync(join(BUNDLED_CHILDREN_DIR, modelPluginFolder(id), "package.json"))).toBe(true);
    }
  });

  test("each is a valid child of `clover`: data with its endpoint and key placement, or code with its adapter", async () => {
    const { report } = await pluginFromFolder(join(BUNDLED_CHILDREN_DIR, ".."), { bundled: true });
    const models = report.children.filter((c) => c.folder.startsWith("model-"));
    expect(models.length).toBe(218);
    const bad = models.filter((c) => !c.ok || c.report.manifest === undefined).map((c) => c.folder);
    expect(bad).toEqual([]);
    for (const c of models) {
      const id = c.folder.slice("model-".length);
      const provider = sdk.providers.find((p) => p.id === id)!;
      const entry = c.report.manifest!.contributes!.models![0]!;
      expect(entry.provider).toBe(id);
      if (CODE_PLUGINS[id] !== undefined) {
        expect(c.report.class).toBe("code");
        expect(entry.adapter).toBe("adapter");
        continue;
      }
      expect(c.report.class).toBe("data");
      expect(entry.endpoint).toBeDefined();
      if (provider.defaultEndpoints["api"] !== undefined) expect(entry.endpoint!.baseUrl).toBe(provider.defaultEndpoints["api"]);
      else expect(entry.endpoint!.baseUrl).toContain("${setting:");
      // The key goes where its protocol's generic adapter sends it: Bearer for the OpenAI shapes, x-api-key for Messages.
      for (const a of entry.auth) {
        if (a.method !== "api-key") continue;
        expect(a.placement).toEqual(entry.endpoint!.protocol === "anthropic-messages" ? { header: "x-api-key" } : undefined);
      }
      expect(entry.auth.length > 0).toBe(provider.authKinds.includes("api-key"));
    }
  });
});
