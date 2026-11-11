// Every method a plugin's layer may call that changes what is the user's (`userOnly` and a layer role in the
// protocol's table): the gate lets a layer's `change` method through for its handler to decide (clover-caller.ts), so
// each handler must refuse a plugin caller or answer with a pending sealed card, never apply it. A method added to the
// table without an entry here fails the walk, so none is missed.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { CLOVER_METHODS } from "@waifucave/clover-protocol";
import { gateCloverRequest } from "../../auth/clover-caller";
import { sessionsMethods } from "../../bots/rpc";
import { boot, botManifest, pluginFromFolder, removeTemps, tempDir, writePlugin } from "../../bots/tests/fixtures";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import type { MethodHandler } from "../../rpc/handler";
import { openPluginRegistry } from "../../registry/open";
import { pluginSettingsMethods } from "../api/settings";
import { pluginRegistryMethods } from "../registry-methods";
import { uiSettingsMethods } from "../ui-settings";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  removeTemps();
});

/** Valid params for each such method, so the walk reaches its handler (never a params error). */
const PARAMS: Record<string, unknown> = {
  "plugin.setEnabled": { id: "tarot", enabled: false },
  "plugin.setScope": { id: "tarot", scope: "bots" },
  "plugin.setComputers": { id: "tarot", target: "*", computers: [] },
  "plugin.settings.set": { id: "tarot", key: "k", value: "v" },
  "plugin.install": { source: { from: "folder", path: "/nowhere" } },
  "plugin.pin": { id: "tarot", pinned: true },
  "bot.setUserLayer": { id: "luna", patch: { theme: "night" } },
  "ui.set": { patch: { theme: "night" } },
};

describe("a layer's change methods, called by a plugin", () => {
  test("each is refused or answers with a pending sealed card, never applied", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-layer-")));
    temps.push(home);
    mkdirSync(join(home, "plugins", "tarot"), { recursive: true });
    writeFileSync(join(home, "plugins", "tarot", "clover.json"), JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } }));
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
    const settingsCalls: unknown[] = [];
    const bots = await boot({ home: tempDir(), plugins: (await pluginFromFolder(writePlugin(tempDir(), "luna", { "clover.json": botManifest("luna", "Luna"), "bot/instructions.md": "Hi." }))).inputs });
    try {
      await opened.registry.approve("tarot", opened.registry.get("tarot")!.treeHash!);
      const handlers: Record<string, MethodHandler> = {
        ...pluginRegistryMethods({ opened, host: { restart: async () => {} }, home, indexes: undefined as never }),
        ...pluginSettingsMethods({ views: async () => [], setByUser: async (...a: unknown[]) => { settingsCalls.push(a); } } as never),
        ...uiSettingsMethods({ home }),
        ...sessionsMethods({ home: tempDir(), bots: bots.bots, host: bots.host, clock: new FakeClock(), localDevice: "d", computer: "Studio" } as never),
      };
      const layerChanges = [...CLOVER_METHODS].filter(([, s]) => s.roles.includes("layer") && (s.userOnly || s.change !== undefined)).map(([n]) => n);
      expect(layerChanges.filter((n) => !(n in PARAMS))).toEqual([]);
      const caller = { kind: "plugin", pluginId: "tarot" } as const;
      const outcomes: Record<string, string> = {};
      for (const name of layerChanges) {
        const spec = CLOVER_METHODS.get(name)!;
        // The gate: a userOnly method without `change` is refused there; one with it reaches its handler.
        const gate = gateCloverRequest("layer", caller, name);
        if (gate !== null) {
          expect([name, spec.change]).toEqual([name, undefined]);
          outcomes[name] = "refused at the gate";
          continue;
        }
        const h = handlers[name];
        expect([name, h !== undefined]).toEqual([name, true]);
        const r = await Promise.resolve(h!(PARAMS[name], { caller } as never)).then((v) => v as { applied?: boolean; card?: string }, (e: Error & { data?: { code?: string } }) => e);
        if (r instanceof Error) {
          outcomes[name] = "refused";
          expect([name, r.message]).toEqual([name, expect.stringMatching(/only the user|plugin's change goes to the user|a layer's UI change is a card/)]);
        } else {
          outcomes[name] = "card";
          expect([name, r.applied, typeof r.card]).toEqual([name, false, "string"]);
        }
      }
      expect(outcomes).toEqual({
        "plugin.setEnabled": "refused", "plugin.setScope": "refused", "plugin.setComputers": "refused", "plugin.settings.set": "refused",
        "plugin.install": "refused at the gate", "plugin.pin": "refused", "bot.setUserLayer": "refused", "ui.set": "refused",
      });
      expect(settingsCalls).toEqual([]);
      expect(bots.bots.userLayer("luna")).toEqual({});
      expect(opened.registry.get("tarot")!.enabled).toBe(true);
    } finally {
      opened.close();
      await bots.shutdown();
    }
  });
});
