// The Plugins page's door (the controller's ruling of 2026-11-11), the core's half: a removal asked on a sealed card
// removes only on the yes; a setting that feeds a host the plugin's keys or requests go to changes only on the yes of a
// card naming the old host and the new, from any client; an update can be listed without applying anything.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, settingHost, settingHostTemplates, settingTemplated } from "@waifucave/clover-plugin-sdk";
import type { ApprovalRequest } from "../../contracts/approval-broker";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { memoryPluginSettings, PluginSettings } from "../api/settings";
import { pluginAuthMethods } from "../../runtime-sdk/plugin-auth";
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

  test("the plugin itself can't move its host through the plugin API; its other settings it sets as before", () => {
    const s = make();
    expect(() => s.setByPlugin("relay", "region", "us")).toThrow("only the user changes it, on a sealed card");
    expect(s.get("relay", "region")).toBe("eu");
    s.setByPlugin("relay", "theme", "dark");
    expect(s.get("relay", "theme")).toBe("dark");
  });
});

describe("a saved key never through the Plugins page", () => {
  test("with noSecret (main's, for the page) a secret field is refused whatever the page sends; the app's own dialog (no flag) sets it", async () => {
    const secrets = new MemorySecretStore();
    const manifest = { manifest: 1, id: "fish", name: "Fish Audio", version: "1.0.0", settings: { FISH_KEY: { type: "secret", title: "Key" }, voice: { type: "string", title: "Voice" } } };
    const s = new PluginSettings({
      registry: { get: (id: string) => (id === "fish" ? ({ id, name: "Fish Audio", manifest } as never) : undefined) },
      backend: memoryPluginSettings(), secrets,
    });
    const ref = { owner: { kind: "plugin" as const, pluginId: "fish" }, name: "FISH_KEY" };
    await secrets.set(ref, "mine");
    for (const value of ["attacker", null]) {
      await expect(s.setByUser("fish", "FISH_KEY", value, undefined, { noSecret: true })).rejects.toThrow("only in Clover's own key dialog");
    }
    expect((await secrets.get(ref))?.value.reveal()).toBe("mine");
    expect(await s.setByUser("fish", "voice", "warm", undefined, { noSecret: true })).toEqual({ applied: true });
    expect(await s.setByUser("fish", "FISH_KEY", "replaced")).toEqual({ applied: true });
    expect((await secrets.get(ref))?.value.reveal()).toBe("replaced");
  });
});

describe("every templated setting cards, not only a host's", () => {
  // A tree with open network: a setting a stdio server's command, args or env, a hook's command or args, or an http
  // server's URL takes (the manifest's own fields: the only places the core fills `${setting:k}`), from any client, is
  // the same kind of change as a host's. An agent backend is named, never templated.
  const manifest = {
    manifest: 1, id: "runner", name: "Runner", version: "1.0.0",
    capabilities: ["network"],
    settings: {
      region: { type: "string", title: "Region", default: "eu" },
      profile: { type: "string", title: "Profile", default: "default" },
      hookArg: { type: "string", title: "Hook", default: "a" },
      server: { type: "string", title: "Server", default: "small" },
      theme: { type: "string", title: "Theme" },
    },
    contributes: {
      mcpServers: {
        tools: { type: "stdio", command: "bin/server", args: ["--region", "${setting:region}"], env: { PROFILE: "${setting:profile}" } },
        remote: { type: "http", url: "https://${setting:server}.example.com/mcp" },
      },
      hooks: [{ id: "h", on: ["tool.before"], command: "bin/hook", args: ["${setting:hookArg}"] }],
      agents: [{ id: "a", name: "A", backend: "claude-code" }],
    },
  };
  // A command hook gets every plain setting in its environment (`CLAUDE_PLUGIN_OPTION_<KEY>`), so with one, every plain
  // setting feeds what runs; the same tree with its hook's arg moved to a server's arg has an untemplated setting.
  const noHook = { ...manifest, contributes: { ...manifest.contributes, hooks: [], mcpServers: { ...manifest.contributes.mcpServers, more: { type: "stdio", command: "bin/more", args: ["${setting:hookArg}"] } } } };
  const make = (openCard?: ReturnType<typeof cards>["open"], m: object = manifest) => new PluginSettings({
    registry: { get: (id: string) => (id === "runner" ? ({ id, name: "Runner", manifest: m } as never) : undefined) },
    backend: memoryPluginSettings(), ...(openCard ? { openCard: openCard as never } : {}),
  });

  test("stdio args and env, a hook's args, an http server's URL: each templated setting is found and changes only on a card's yes; an untemplated one applies", async () => {
    for (const key of ["region", "profile", "hookArg", "server"]) expect([key, settingTemplated(manifest as never, key)]).toEqual([key, true]);
    // The command hook's environment carries `theme` too: it cards like the rest.
    expect(settingTemplated(manifest as never, "theme")).toBe(true);
    expect(await make(cards().open).setByUser("runner", "theme", "dark")).toMatchObject({ applied: false });
    expect(() => make().setByPlugin("runner", "theme", "light")).toThrow("only the user changes it, on a sealed card");
    for (const key of ["region", "profile", "hookArg", "server"]) expect([key, settingTemplated(noHook as never, key)]).toEqual([key, true]);
    expect(settingTemplated(noHook as never, "theme")).toBe(false);
    const c = cards();
    const s = make(c.open, noHook);
    expect(await s.setByUser("runner", "theme", "dark")).toEqual({ applied: true });
    const wants: [string, string, string][] = [["region", "eu", "us"], ["profile", "default", "work"], ["hookArg", "a", "b"], ["server", "small", "large"]];
    for (const [i, [key, from, to]] of wants.entries()) {
      expect(await s.setByUser("runner", key, to)).toEqual({ applied: false, card: `card_${i + 1}` });
      expect(c.asked[i]!.req).toMatchObject({ kind: "change", change: "plugin-setting-host" });
      // The value line ("key: old → new"), or the host line for a URL's host.
      expect(JSON.stringify(c.asked[i]!.req.fields)).toMatch(new RegExp(`${from}(\\.example\\.com)? → ${to}`));
      expect(s.get("runner", key)).toBe(from);
      c.asked[i]!.answer(true);
      await flush();
      expect(s.get("runner", key)).toBe(to);
    }
    // The plugin API can't change any of them; its untemplated setting it can.
    for (const [key] of wants) expect(() => s.setByPlugin("runner", key, "x")).toThrow("only the user changes it, on a sealed card");
    s.setByPlugin("runner", "theme", "light");
    expect(s.get("runner", "theme")).toBe("light");
  });

  test("what the Plugins page reads for its controls: titles as the manifest has them, an enum's choices, a number's bounds, and `asks` on each setting whose change cards", async () => {
    const m = {
      ...noHook,
      settings: {
        ...noHook.settings,
        order: { type: "enum", title: { en: "Order", ja: "並び順" }, options: ["newest", { value: "oldest", title: { en: "Oldest first" } }], default: "newest" },
        size: { type: "number", title: "Size", min: 1, max: 9, default: 3 },
      },
    };
    const views = await make(undefined, m).views("runner");
    const by = (k: string) => views.find((v) => v.key === k);
    expect(by("order")).toEqual({ key: "order", type: "enum", title: { en: "Order", ja: "並び順" }, scope: "account", required: false, options: ["newest", { value: "oldest", title: { en: "Oldest first" } }], value: "newest", set: false });
    expect(by("size")).toMatchObject({ min: 1, max: 9, value: 3 });
    expect(by("size")).not.toHaveProperty("asks");
    for (const k of ["region", "profile", "hookArg", "server"]) expect([k, by(k)?.asks]).toEqual([k, true]);
    expect(by("theme")).not.toHaveProperty("asks");
    // With the command hook, every plain setting feeds it.
    expect((await make().views("runner")).every((v) => v.asks === true)).toBe(true);
  });
});

describe("signing out from the Plugins page", () => {
  test("with card, a sealed card names the plugin and nothing is deleted until the yes; the terminal signs out at once", async () => {
    const out: string[] = [];
    const auth = { signOut: async (id: string, index: number) => void out.push(`${id}#${index}`) } as never;
    const c = cards();
    const m = pluginAuthMethods(auth, { openCard: c.open as never, nameOf: (id) => (id === "luna" ? "Luna AI" : undefined) });
    expect(await m["plugin.auth.signOut"]!({ id: "luna", index: 0, card: true }, APP)).toEqual({ applied: false, card: "card_1" });
    expect(c.asked[0]!.req).toMatchObject({ kind: "change", change: "plugin-sign-out", fields: { title: { text: "Sign Luna AI out?" } } });
    expect(JSON.stringify(c.asked[0]!.req.fields)).toContain("Its saved sign-in on this computer is deleted.");
    c.asked[0]!.answer(false);
    await flush();
    expect(out).toEqual([]);
    await m["plugin.auth.signOut"]!({ id: "luna", index: 0, card: true }, APP);
    c.asked[1]!.answer(true);
    await flush();
    expect(out).toEqual(["luna#0"]);
    expect(await m["plugin.auth.signOut"]!({ id: "luna", index: 1 }, CLI)).toEqual({ ok: true });
    expect(out).toEqual(["luna#0", "luna#1"]);
    await expect(pluginAuthMethods(auth)["plugin.auth.signOut"]!({ id: "luna", index: 0, card: true }, APP)).rejects.toThrow("needs a sealed card");
  });
});

describe("a plugin's logs", () => {
  test("only its own file, with key-looking runs and a URL's secret parts cut to …", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-logs-")));
    temps.push(home);
    mkdirSync(join(home, "plugins", "tarot"), { recursive: true });
    writeFileSync(join(home, "plugins", "tarot", "clover.json"), JSON.stringify({ manifest: 1, id: "tarot", name: "Tarot", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } }));
    mkdirSync(join(home, "logs", "plugins"), { recursive: true });
    const key = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    writeFileSync(join(home, "logs", "plugins", "tarot.log"), [`calling with Authorization: Bearer ${key}`, "https://api.example.com/v1?api_key=abcdef0123456789abcdef&q=1", "plain line"].join("\n") + "\n");
    writeFileSync(join(home, "logs", "plugins", "nova.log"), "nova's own line\n");
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home });
    try {
      const { lines } = await m["plugin.logs"]!({ id: "tarot" }, APP) as { lines: string[] };
      expect(lines.length).toBe(3);
      expect(lines.join("\n")).not.toContain(key);
      expect(lines.join("\n")).not.toContain("abcdef0123456789abcdef");
      expect(lines.join("\n")).toContain("…");
      expect(lines[2]).toBe("plain line");
      expect(lines.join("\n")).not.toContain("nova");
    } finally {
      opened.close();
    }
  });
});

describe("renewing a development folder from the Plugins page", () => {
  test("with card, the development-folder card first and 24 more hours only on the yes; the terminal renews at once", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-renew-")));
    const devRoot = realpathSync(mkdtempSync(join(tmpdir(), "clover-renew-dev-")));
    temps.push(home, devRoot);
    const dev = join(devRoot, "luna");
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, "clover.json"), JSON.stringify({ manifest: 1, id: "luna", name: "Luna", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } }));
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
    const c = cards();
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home, openCard: c.open as never });
    try {
      await m["plugin.dev.add"]!({ path: dev }, CLI);
      const expiry = () => opened.folders.devFolders().find((d) => d.path === dev)!.expiresAt;
      const first = expiry();
      await Bun.sleep(5);
      expect(await m["plugin.dev.renew"]!({ path: dev, card: true }, APP)).toEqual({ applied: false, card: "card_1" });
      expect(c.asked[0]!.req).toMatchObject({ kind: "change", change: "dev-folder", fields: { title: { text: `Keep loading the plugin you're developing at ${dev} for another 24 hours?` } } });
      c.asked[0]!.answer(false);
      await flush();
      expect(expiry()).toBe(first);
      await m["plugin.dev.renew"]!({ path: dev, card: true }, APP);
      c.asked[1]!.answer(true);
      await flush();
      expect(expiry()).toBeGreaterThan(first);
      await expect(m["plugin.dev.renew"]!({ path: join(devRoot, "other"), card: true }, APP)).rejects.toThrow("isn't a development folder");
      expect(c.asked.length).toBe(2);
      expect(await m["plugin.dev.renew"]!({ path: dev }, CLI)).toMatchObject({ expiresAt: expect.any(Number) });
      expect(c.asked.length).toBe(2);
    } finally {
      opened.close();
    }
  });
});
