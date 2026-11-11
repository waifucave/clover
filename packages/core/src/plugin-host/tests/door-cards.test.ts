// The Plugins page's door (the controller's ruling of 2026-11-11), the core's half: a removal asked on a sealed card
// removes only on the yes; a setting that feeds a host the plugin's keys or requests go to changes only on the yes of a
// card naming the old host and the new, from any client; an update can be listed without applying anything.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, settingHost, settingHostTemplates } from "@waifucave/clover-plugin-sdk";
import type { ApprovalRequest } from "../../contracts/approval-broker";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { memoryPluginSettings, PluginSettings } from "../api/settings";
import { pluginRegistryMethods } from "../registry-methods";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const APP = { caller: { kind: "user", client: "app" } } as never;
const CLI = { caller: { kind: "user", client: "cli" } } as never;

/** A card opener the test answers: each request kept, answered yes or no when told. */
function cards() {
  const asked: { req: ApprovalRequest; answer: (yes: boolean) => void }[] = [];
  const open = async (req: ApprovalRequest) => {
    let answer: (yes: boolean) => void = () => undefined;
    const allowed = new Promise<boolean>((r) => (answer = r));
    asked.push({ req, answer });
    return { card: `card_${asked.length}`, allowed };
  };
  return { asked, open };
}
const flush = () => new Promise((r) => setTimeout(r, 30));

describe("removing a plugin on a sealed card", () => {
  test("with card, nothing is removed until the yes; a no keeps it; without card (the CLI's, safe mode's) it goes at once", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-door-")));
    temps.push(home);
    for (const id of ["tarot", "nova"]) {
      mkdirSync(join(home, "plugins", id), { recursive: true });
      writeFileSync(join(home, "plugins", id, "clover.json"), JSON.stringify({ manifest: 1, id, name: id === "tarot" ? "Tarot" : "Nova", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } }));
    }
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets, settleMs: 50 });
    const c = cards();
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home, secrets, openCard: c.open as never });
    try {
      await secrets.set({ owner: { kind: "plugin", pluginId: "tarot" }, name: "KEY" }, "s3cret");
      const r = await m["plugin.remove"]!({ id: "tarot", card: true }, APP);
      expect(r).toEqual({ applied: false, card: "card_1" });
      expect(c.asked[0]!.req).toMatchObject({ kind: "change", change: "plugin-remove", fields: { title: { text: "Remove Tarot?" } } });
      expect(JSON.stringify(c.asked[0]!.req.fields)).toContain("Its saved keys and settings on this computer are deleted. Its data is set aside.");
      expect(existsSync(join(home, "plugins", "tarot"))).toBe(true);
      c.asked[0]!.answer(false);
      await flush();
      expect(existsSync(join(home, "plugins", "tarot"))).toBe(true);
      expect((await secrets.list({ kind: "plugin", pluginId: "tarot" })).length).toBe(1);
      await m["plugin.remove"]!({ id: "tarot", card: true }, APP);
      c.asked[1]!.answer(true);
      await flush();
      expect(existsSync(join(home, "plugins", "tarot"))).toBe(false);
      expect(await secrets.list({ kind: "plugin", pluginId: "tarot" })).toEqual([]);
      expect(await m["plugin.remove"]!({ id: "nova" }, CLI)).toEqual({ ok: true });
      expect(existsSync(join(home, "plugins", "nova"))).toBe(false);
    } finally {
      opened.close();
    }
  });
});

describe("a setting that moves a plugin's host", () => {
  const manifest = {
    manifest: 1, id: "relay", name: "Relay", version: "1.0.0",
    capabilities: ["network:${setting:region}.relay.example.com"],
    settings: { region: { type: "string", title: "Region", default: "eu" }, theme: { type: "string", title: "Theme" } },
    contributes: { models: [{ id: "m", provider: "relay", name: "Relay", catalog: [], auth: [], endpoint: { protocol: "openai-chat", baseUrl: "https://${setting:region}.relay.example.com/v1" } }] },
  };
  const make = (openCard?: ReturnType<typeof cards>["open"]) => new PluginSettings({
    registry: { get: (id: string) => (id === "relay" ? ({ id, name: "Relay", manifest } as never) : undefined) },
    backend: memoryPluginSettings(), ...(openCard ? { openCard: openCard as never } : {}),
  });

  test("the templates and their hosts", () => {
    const t = settingHostTemplates(manifest as never);
    expect(t).toEqual([{ template: "${setting:region}.relay.example.com", keys: ["region"] }]);
    expect(settingHost(t[0]!.template, { region: "us" })).toBe("us.relay.example.com");
  });

  test("only after the yes on a card naming the old host and the new; a no keeps it; another setting applies at once; no broker, refused", async () => {
    const c = cards();
    const s = make(c.open);
    expect(await s.setByUser("relay", "theme", "dark")).toEqual({ applied: true });
    const r = await s.setByUser("relay", "region", "us");
    expect(r).toEqual({ applied: false, card: "card_1" });
    expect(c.asked[0]!.req).toMatchObject({ kind: "change", change: "plugin-setting-host" });
    expect(JSON.stringify(c.asked[0]!.req.fields)).toContain("eu.relay.example.com → us.relay.example.com");
    expect(s.get("relay", "region")).toBe("eu");
    c.asked[0]!.answer(false);
    await flush();
    expect(s.get("relay", "region")).toBe("eu");
    await s.setByUser("relay", "region", "us");
    c.asked[1]!.answer(true);
    await flush();
    expect(s.get("relay", "region")).toBe("us");
    // The same value again moves nothing: no card.
    expect(await s.setByUser("relay", "region", "us")).toEqual({ applied: true });
    // A bad value is refused before any card.
    await expect(s.setByUser("relay", "region", 7)).rejects.toThrow();
    expect(c.asked.length).toBe(2);
    await expect(make().setByUser("relay", "region", "jp")).rejects.toThrow("needs a sealed card");
  });
});
