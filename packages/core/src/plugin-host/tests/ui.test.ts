// The app's side of plugins with UI (`plugin.ui`, `plugin.layer.api`, `plugin_ui_message`, `plugin_ui_changed`), over a
// real registry and a real plugin-host process. Temp homes, the fake approval broker, an in-memory secret store.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync as makeTemp, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { layerApiCall, PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { PLUGINS_METHODS } from "@waifucave/clover-protocol";
import { ContractError } from "../../contracts/common";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";
import { layerOf, pluginUi, uiPluginViews } from "../ui";

const temps: string[] = [];
const mkdtempSync = (prefix: string): string => {
  const d = makeTemp(prefix);
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

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
      // What its components may call is its `ui` table only; `onToolAfter` stands for a tool's or a hook's handler.
      "host/index.js": "export const onToolAfter = async () => \"a hook ran\";\nconst draw = async (args, ctx) => { await ctx.api.ui.send(\"drawn\", { card: args.card }); return { drew: args.card, by: ctx.caller.kind, as: ctx.caller.pluginId ?? null, session: ctx.session ?? null }; };\n"
        + "const big = async (args, ctx) => { try { await ctx.api.ui.send(\"big\", \"x\".repeat(70000)); return \"sent\"; } catch (e) { return e.message; } };\n"
        + "const remember = async (args, ctx) => { for (let i = 0; i < 5; i++) await ctx.api.storage.synced.set(\"stage\", { v: 1, n: i, ...args }); return { by: ctx.caller.kind, as: ctx.caller.pluginId ?? null, session: ctx.session ?? null }; };\n"
        + "export const ui = { draw: (a, c) => draw(a, c), big: (a, c) => big(a, c), spam: (a, c) => spam(a, c), remember: (a, c) => remember(a, c) };\n"
        + "const spam = async (args, ctx) => { for (let i = 0; i < 60; i++) { try { await ctx.api.ui.send(\"s\", i); } catch (e) { return [i, e.message]; } } return \"all sent\"; };\n",
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

      // host.call: the plugin's host handler runs, as the plugin (never the user, the coordinator's ruling), for the
      // session the component shows; its ui.send reaches the app as plugin_ui_message.
      const api = ui.methods[PLUGINS_METHODS.pluginLayerApi.name]!;
      expect(await api({ pluginId: "tarot", ...layerApiCall("host.call", "draw", { card: "The Star" }), session: "s_1" }, ctx))
        .toEqual({ result: { drew: "The Star", by: "plugin", as: "tarot", session: "s_1" } });
      // ui.send: a value over 64 KiB is refused, and so is a plugin's 51st message in a second (#333's review).
      expect(await api({ pluginId: "tarot", ...layerApiCall("host.call", "big", null) }, ctx)).toEqual({ result: expect.stringContaining("at most 65536") });
      expect(await api({ pluginId: "tarot", ...layerApiCall("host.call", "spam", null) }, ctx)).toEqual({ result: [expect.any(Number), expect.stringContaining("more than 50 UI messages this second")] });
      expect(events.find((e) => e.type === "plugin_ui_message")).toMatchObject({ pluginId: "tarot", event: "drawn", value: { card: "The Star" } });
      // A component reads its plugin's store; only the host half writes it (the seam's rule: what a component hands
      // over goes through its plugin's own code).
      const write = (await api({ pluginId: "tarot", ...layerApiCall("storage.synced.set", "k", 1) }, ctx).catch((x: unknown) => x)) as Error;
      expect(write).toBeInstanceOf(Error);
      expect(await api({ pluginId: "tarot", ...layerApiCall("storage.synced.get", "k") }, ctx)).toEqual({ result: undefined });

      // The plugin's own layer, on its own connection (`plugin.layer.call`): the plugin is the connection's, never a
      // parameter; host.call runs as the plugin with no session; the store reads back what the host half wrote, and
      // its change reaches the layer once per key in a burst (`plugin_store_changed`, the key only).
      const own = ui.methods[PLUGINS_METHODS.pluginLayerCall.name]!;
      const layer = { caller: { kind: "plugin", pluginId: "tarot" } } as never;
      events.length = 0;
      expect(await own({ call: "host.call", args: ["remember", { scene: "beach" }] }, layer)).toEqual({ result: { by: "plugin", as: "tarot", session: null } });
      expect(await own({ call: "storage.synced.get", args: ["stage"] }, layer)).toEqual({ result: { v: 1, n: 4, scene: "beach" } });
      expect(await own({ call: "storage.synced.keys", args: [] }, layer)).toEqual({ result: ["stage"] });
      await Bun.sleep(250);
      expect(events.filter((e) => e.type === "plugin_store_changed")).toEqual([{ type: "plugin_store_changed", pluginId: "tarot", key: "stage" }]);
      // Never the user's or another connection's: a user's connection can't use it, and nothing else is reachable.
      expect(((await own({ call: "host.call", args: ["remember", {}] }, ctx).catch((x: unknown) => x)) as Error).message).toContain("only a plugin's UI layer");
      expect(((await own({ call: "storage.synced.set", args: ["k", 1] }, layer).catch((x: unknown) => x)) as Error)).toBeInstanceOf(Error);
      // Only the `ui` table: never a tool's, a hook's or any other export, nor the table itself.
      for (const h of ["onToolAfter", "ui", "start", "toString", "constructor"]) {
        const e = (await own({ call: "host.call", args: [h, {}] }, layer).catch((x: unknown) => x)) as Error;
        expect([h, e instanceof Error, e.message]).toEqual([h, true, expect.stringContaining("has no handler")]);
      }
      // Capped: args over 64 KiB, and a plugin's 21st call in a second.
      expect(((await own({ call: "host.call", args: ["remember", { x: "y".repeat(70_000) }] }, layer).catch((x: unknown) => x)) as Error).message).toContain("at most 65536");
      const refused = (await api({ pluginId: "tarot", call: "ui.send", args: ["x", 1] }, ctx).catch((x: unknown) => x)) as ContractError;
      expect(refused.message).toBe("ui.send exists only in a plugin's host code");
      // A failure names the plugin and the call, which the app maps to its own parts (it never needs the mount back).
      expect((refused as unknown as { data?: Record<string, unknown> }).data).toMatchObject({ pluginId: "tarot", call: "ui.send" });

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

  test("every layer call is the plugin's: commands.run, host.call and the areas see the plugin, never the user", async () => {
    const seen: unknown[] = [];
    const registry = { list: () => [], entries: () => [], get: () => undefined, watch: () => () => {} } as never;
    const ui = pluginUi({ registry, router: async (call) => (seen.push([call.path, call.caller, call.process]), null), emit: () => {} });
    try {
      const api = ui.methods[PLUGINS_METHODS.pluginLayerApi.name]!;
      for (const call of ["commands.run", "host.call", "conversation.history", "conversation.send", "storage.synced.get"]) await api({ pluginId: "luna/tarot", call, args: [] }, ctx);
      expect(seen).toEqual(["commands.run", "host.call", "conversation.history", "conversation.send", "storage.synced.get"].map((p) => [p, { kind: "plugin", pluginId: "luna/tarot" }, "ui"]));
    } finally {
      ui.close();
    }
  });

  test("plugin.layer.call: the connection's plugin, never a parameter's; as the plugin, with no session; capped per plugin", async () => {
    const seen: unknown[] = [];
    const registry = { list: () => [], entries: () => [], get: () => undefined, watch: () => () => {} } as never;
    const ui = pluginUi({ registry, router: async (call) => (seen.push([call.pluginId, call.path, call.caller, call.process, call.session]), null), emit: () => {} });
    try {
      const own = ui.methods[PLUGINS_METHODS.pluginLayerCall.name]!;
      const luna = { caller: { kind: "plugin", pluginId: "luna" } } as never;
      // A parameter naming another plugin or a session isn't one the method takes: it is dropped, never used.
      await own({ call: "host.call", args: ["draw", null], pluginId: "other", session: "s_1" }, luna);
      await own({ call: "host.call", args: ["draw", null] }, luna);
      expect(seen).toEqual([0, 1].map(() => ["luna", "host.call", { kind: "plugin", pluginId: "luna" }, "ui", undefined]));
      for (const caller of [{ kind: "user", client: "app" }, { kind: "core" }]) {
        expect(((await own({ call: "host.call", args: ["draw", null] }, { caller } as never).catch((x: unknown) => x)) as Error).message).toContain("only a plugin's UI layer");
      }
      // 20 calls a second per plugin; another plugin has its own count.
      let refused: Error | undefined;
      for (let i = 0; i < 25 && refused === undefined; i++) refused = (await own({ call: "storage.synced.keys", args: [] }, luna).then(() => undefined, (x: unknown) => x as Error));
      expect(refused?.message).toContain("more than 20 calls this second");
      expect(await own({ call: "storage.synced.keys", args: [] }, { caller: { kind: "plugin", pluginId: "sol" } } as never)).toEqual({ result: null });
    } finally {
      ui.close();
    }
  });

  test("layers: the whole clover tree shares `clover`; any other id writes `/` as `--`", () => {
    expect([layerOf("clover"), layerOf("clover/island"), layerOf("luna"), layerOf("luna/tarot-panel"), layerOf("cloverish")]).toEqual(["clover", "clover", "luna", "luna--tarot-panel", "cloverish"]);
  });
});
