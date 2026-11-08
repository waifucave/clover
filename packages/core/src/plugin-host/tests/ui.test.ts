// The app's side of plugins with UI (`plugin.ui`, `plugin.layer.api`, `plugin_ui_message`, `plugin_ui_changed`), over a
// real registry and a real plugin-host process. Temp homes, the fake approval broker, an in-memory secret store.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { PLUGINS_METHODS } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";
import { layerOf, pluginUi, uiPluginViews } from "../ui";

const ctx = { caller: { kind: "core" } } as never;

describe("plugin.ui and plugin.layer.api", () => {
  test("views carry the real tree hash, files, grants and entries; a component's calls go through the ui side of the gate", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-ui-"));
    const folder = join(home, "plugins", "tarot");
    const files: Record<string, string> = {
      "clover.json": JSON.stringify({
        manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
        host: { entry: "host/index.js" }, client: { entry: "client/index.js", css: ["client/index.css"] },
        contributes: { themes: [{ id: "night", file: "themes/night.json" }], locales: [{ lang: "fr", file: "locales/fr.json" }] },
      }),
      "package.json": JSON.stringify({ type: "module" }),
      "host/index.js": "export const draw = async (args, ctx) => { await ctx.api.ui.send(\"drawn\", { card: args.card }); return { drew: args.card, by: ctx.caller.kind, session: ctx.session ?? null }; };\n",
      "client/index.js": "export const Tarot = () => null;\n",
      "client/index.css": ".x { color: red }\n",
      "themes/night.json": JSON.stringify({ tokens: {} }),
      "locales/fr.json": JSON.stringify({}),
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(folder, rel)), { recursive: true });
      writeFileSync(join(folder, rel), text);
    }
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const events: { type: string; [k: string]: unknown }[] = [];
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, emit: (e) => events.push(e) });
    const ui = pluginUi({ registry: opened.registry, router: ph.gate, emit: (e) => events.push(e) });
    try {
      // Not OK'd yet: no view.
      expect(uiPluginViews(opened.registry)).toEqual([]);
      const { card } = await opened.registry.installed("tarot", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await Bun.sleep(150);
      // The OK nudged the app (one event for the burst).
      expect(events.filter((e) => e.type === "plugin_ui_changed").at(-1)?.pluginIds).toEqual(["tarot"]);

      const views = (await ui.methods[PLUGINS_METHODS.pluginUi.name]!({}, ctx)) as { plugins: Record<string, unknown>[] };
      const record = opened.registry.get("tarot")!;
      expect(views.plugins).toEqual([{
        pluginId: "tarot", name: "Tarot", treeHash: record.treeHash, source: "local", capabilities: [...record.granted],
        css: ["client/index.css"], layer: "tarot", assetBase: folder, clientEntry: "client/index.js",
        ui: [], themes: [{ id: "night", file: "themes/night.json" }], locales: [{ lang: "fr", file: "locales/fr.json" }], bots: "all",
      }]);
      expect(views.plugins[0]!.treeHash).toMatch(/^sha256:[0-9a-f]{64}$/);

      // host.call: the plugin's host handler runs, as the user, for the session the component shows; its ui.send
      // reaches the app as plugin_ui_message.
      const api = ui.methods[PLUGINS_METHODS.pluginLayerApi.name]!;
      expect(await api({ pluginId: "tarot", call: "host.call", args: [{ handler: "draw", args: { card: "The Star" } }], session: "s_1" }, ctx))
        .toEqual({ result: { drew: "The Star", by: "user", session: "s_1" } });
      expect(events.find((e) => e.type === "plugin_ui_message")).toMatchObject({ pluginId: "tarot", event: "drawn", value: { card: "The Star" } });
      // A "both" call works from a component; a host-only one doesn't exist there.
      expect(await api({ pluginId: "tarot", call: "storage.synced.set", args: ["k", 1] }, ctx)).toEqual({ result: undefined });
      const refused = (await api({ pluginId: "tarot", call: "ui.send", args: ["x", 1] }, ctx).catch((x: unknown) => x)) as ContractError;
      expect(refused.message).toBe("ui.send exists only in a plugin's host code");

      // Switched off: no view, and a nudge.
      events.length = 0;
      await opened.registry.setEnabled("tarot", false);
      await Bun.sleep(150);
      expect(uiPluginViews(opened.registry)).toEqual([]);
      expect(events.some((e) => e.type === "plugin_ui_changed" && (e.pluginIds as string[]).includes("tarot"))).toBe(true);
    } finally {
      ui.close();
      await ph.close();
      opened.close();
    }
  }, 60_000);

  test("layers: the whole clover tree shares `clover`; any other id writes `/` as `--`", () => {
    expect([layerOf("clover"), layerOf("clover/island"), layerOf("luna"), layerOf("luna/tarot-panel"), layerOf("cloverish")]).toEqual(["clover", "clover", "luna", "luna--tarot-panel", "cloverish"]);
  });
});
