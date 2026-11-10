// The plugin API's core side (B-M2): the router's capability gate, `points.*`, storage, settings, `confirm`, the
// commands and points lists, the caller binding (R7) and the pipe's listener subscriptions.
import { afterAll, describe, expect, test } from "bun:test";
import { catalogPointDecl, SYNCED_STORE_LIMIT_BYTES, type Manifest } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { existsSync, mkdirSync, mkdtempSync as makeTemp, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "../../contracts/common";
import { FakePluginRegistry, type FakePluginInput } from "../../contracts/fakes/plugin-registry";
import type { ApprovalRequest } from "../../contracts/approval-broker";
import type { InvokeRequest } from "../../contracts/plugin-host";
import { commandListMethods, commandOwner, commandsApi, commandViews, pointViews } from "../../commands/views";
import { apiChannel, LISTENER_ARG } from "../api-channel";
import { confirmApi } from "../api/confirm";
import { pointsApi } from "../api/points";
import { defaultAssetUrl } from "../daemon-host";
import { assetPath } from "../paths";
import { createApiRouter, type ApiHandlers } from "../api/router";
import { filePluginSettings, memoryPluginSettings, PluginSettings, pluginSettingsMethods, settingsApi } from "../api/settings";
import { fileSyncedStores, memorySyncedStores, pluginDataFolder, storageApi, SyncedStores } from "../api/storage";
import { InvocationTable } from "../invocations";

// Every temp folder a test makes goes at the end.
const temps: string[] = [];
const mkdtempSync = (prefix: string): string => {
  const d = makeTemp(prefix);
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const API = "^1.0.0";
const manifest = (m: Partial<Manifest> = {}): Manifest => ({ manifest: 1, name: "P", engines: { clover: API }, ...m }) as Manifest;

/** `luna` declares `luna.cards` from its host; `tarot` fills it with two cards and has a command; `quiet` has nothing. */
function plugins(extra: FakePluginInput[] = []): FakePluginInput[] {
  return [
    {
      id: "luna",
      manifest: manifest({
        id: "luna", name: "Luna", capabilities: ["conversation.read", "call:tarot", "network:api.luna.example"],
        host: {
          entry: "host/index.js",
          declares: {
            "luna.cards": {
              shape: "list",
              fields: { type: "object", properties: { id: { type: "string" }, image: { type: "string", format: "path" }, draw: { type: "string", format: "handler" }, title: { type: "string" } } },
            },
          },
        },
        settings: {
          greeting: { type: "string", title: "Greeting", default: "hi" },
          volume: { type: "number", title: "Volume", min: 0, max: 10, default: 5 },
          mode: { type: "enum", title: "Mode", options: ["calm", { value: "loud", title: "Loud" }] },
          tint: { type: "color", title: "Tint", scope: "device" },
          nick: { type: "string", title: "Nickname", scope: "bot" },
          token: { type: "secret", title: "Token" },
        },
      } as Partial<Manifest>),
    },
    {
      id: "tarot",
      manifest: manifest({
        id: "tarot", name: "Tarot", host: { entry: "host/index.js" },
        contributes: {
          "luna.cards": [{ id: "fool", image: "img/fool.png", draw: "drawFool", title: "The Fool" }, { id: "moon", image: "img/moon.png", draw: "drawMoon", title: "The Moon" }],
          commands: [{ name: "shuffle", description: "Shuffle the deck", handler: "shuffle", key: "Mod+Shift+T", args: { type: "object" } }],
        },
      } as Partial<Manifest>),
    },
    { id: "quiet", manifest: manifest({ id: "quiet", name: "Quiet" }) },
    ...extra,
  ];
}

const registry = (extra: FakePluginInput[] = []) => new FakePluginRegistry({ catalog: catalogPointDecl, plugins: plugins(extra) });
const asPlugin = (pluginId: string): Caller => ({ kind: "plugin", pluginId });
const session: Caller = { kind: "session", sessionId: "s_1", sessionKind: "bot" } as Caller;

function hostStub() {
  const calls: InvokeRequest[] = [];
  return { calls, invoke: async (req: InvokeRequest) => (calls.push(req), { ran: req.handler }) as never };
}

function routerWith(reg: FakePluginRegistry, handlers: ApiHandlers[] = []) {
  return createApiRouter({
    registry: reg,
    handlers,
    commandOwner: (name) => commandOwner(reg, name),
    allowNetwork: (caps, host) => caps.includes(`network:${host}`),
  });
}

const call = (router: ReturnType<typeof createApiRouter>, pluginId: string, path: string, args: unknown[] = [], o: { process?: "shared" | "clover" | "own"; caller?: Caller } = {}) =>
  router({ pluginId, process: o.process ?? "shared", path, args, caller: o.caller ?? asPlugin(pluginId) });

const failure = (p: Promise<unknown>): Promise<ContractError> => p.then(() => { throw new Error("it didn't fail"); }, (e: ContractError) => e);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ContractError ? e.code : String(e);
  }
};

describe("the router: the one capability gate", () => {
  test("a path the catalog doesn't have doesn't exist; an unknown plugin isn't installed; a stopped one has no API", async () => {
    const reg = registry();
    const r = routerWith(reg, [{ "conversation.list": () => [] }]);
    expect(await code(call(r, "luna", "process.exit"))).toBe("refused");
    expect(await code(call(r, "luna", "points.__proto__"))).toBe("refused");
    expect(await code(call(r, "ghost", "conversation.list"))).toBe("not_installed");
    reg.setStopped("luna", "crashed 3 times");
    const e = await failure(call(r, "luna", "conversation.list"));
    expect(e.code).toBe("plugin_stopped");
    expect(e.message).toContain("crashed 3 times");
  });

  test("a call needs the capability its OK lists; without it the call doesn't exist for the plugin", async () => {
    const r = routerWith(registry(), [{ "conversation.list": (ctx) => `listed for ${ctx.pluginId}` }]);
    expect(await call(r, "luna", "conversation.list")).toBe("listed for luna");
    const e = await failure(call(r, "quiet", "conversation.list"));
    expect([e.code, e.message]).toEqual(["refused", "conversation.list needs the capability conversation.read, which this plugin's OK doesn't list"]);
  });

  test("where a call exists: secrets.get only in a process of the plugin's own, keys.* only in clover's, host.call only in components", async () => {
    const r = routerWith(registry(), [{ "secrets.get": () => "s", "keys.publicKey": () => "k", "host.call": () => 1 }]);
    expect(await code(call(r, "luna", "secrets.get", ["x"], { process: "shared" }))).toBe("refused");
    expect(await call(r, "luna", "secrets.get", ["x"], { process: "own" })).toBe("s");
    expect(await code(call(r, "luna", "keys.publicKey", ["f"], { process: "shared" }))).toBe("refused");
    expect(await call(r, "luna", "keys.publicKey", ["f"], { process: "clover" })).toBe("k");
    expect(await code(call(r, "luna", "host.call", ["x"]))).toBe("refused");
  });

  test("commands.run needs call:<the command's top-level plugin>; a command nobody installed fails at once", async () => {
    const r = routerWith(registry(), [{ "commands.run": (_c, a) => `ran ${String(a[0])}` }]);
    expect(await call(r, "luna", "commands.run", ["tarot.shuffle"])).toBe("ran tarot.shuffle");
    expect(await code(call(r, "quiet", "commands.run", ["tarot.shuffle"]))).toBe("refused");
    expect(await code(call(r, "luna", "commands.run", ["tarot.nope"]))).toBe("not_installed");
  });

  test("net.fetch reaches only the plugin's network: hosts; a call no area serves yet is refused, never guessed", async () => {
    const r = routerWith(registry(), [{ "net.fetch": (_c, a) => `fetched ${String(a[0])}` }]);
    expect(await call(r, "luna", "net.fetch", ["https://api.luna.example/v1"])).toBe("fetched https://api.luna.example/v1");
    expect(await code(call(r, "luna", "net.fetch", ["https://evil.example/"]))).toBe("refused");
    expect(await code(call(r, "luna", "net.fetch", ["not a url"]))).toBe("invalid");
    const bare = routerWith(registry());
    const e = await failure(call(bare, "luna", "storage.synced.keys"));
    expect([e.code, e.message]).toEqual(["refused", "storage.synced.keys is not served on this computer"]);
  });

  test("handlers get the caller the core bound, never one the call names", async () => {
    let seen: Caller | undefined;
    const r = routerWith(registry(), [{ "storage.synced.keys": (ctx) => ((seen = ctx.caller), []) }]);
    await call(r, "luna", "storage.synced.keys", [{ caller: { kind: "user" } }], { caller: session });
    expect(seen).toEqual(session);
  });
});

describe("points.*", () => {
  const setup = (extra: FakePluginInput[] = []) => {
    const reg = registry(extra);
    const host = hostStub();
    const r = routerWith(reg, [pointsApi({ registry: reg, host, assetUrl: (id, p) => `clover-asset://${id}/${p}` })]);
    return { reg, host, r };
  };

  test("the declarer reads its point's active entries, paths as asset URLs", async () => {
    const { r } = setup();
    expect(await call(r, "luna", "points.entries", ["luna.cards"])).toEqual([
      { pluginId: "tarot", entryId: "fool", value: { id: "fool", image: "clover-asset://tarot/img/fool.png", draw: "drawFool", title: "The Fool" } },
      { pluginId: "tarot", entryId: "moon", value: { id: "moon", image: "clover-asset://tarot/img/moon.png", draw: "drawMoon", title: "The Moon" } },
    ]);
  });

  test("a path field that could leave its plugin's folder is null; the rest is percent-encoded (#332's review)", async () => {
    const bad = ["../../etc/passwd", "img/../../x", "img\\fool.png", "https://evil.example/x.png", "//evil.example/x", "/abs.png", "img//x.png", "./x.png", "a\u0000b"];
    const sly: FakePluginInput = {
      id: "sly",
      manifest: manifest({ id: "sly", name: "Sly", contributes: { "luna.cards": [...bad, "art/the fool #1.png"].map((image, i) => ({ id: `c${i}`, image, draw: "d", title: "t" })) } } as Partial<Manifest>),
    };
    const reg = registry([sly]);
    const r = routerWith(reg, [pointsApi({ registry: reg, host: hostStub(), assetUrl: defaultAssetUrl })]);
    const images = ((await call(r, "luna", "points.entries", ["luna.cards"])) as { pluginId: string; value: { image: unknown } }[]).filter((e) => e.pluginId === "sly").map((e) => e.value.image);
    expect(images).toEqual([...bad.map(() => null), "clover-plugin://sly/art/the%20fool%20%231.png"]);
    for (const p of bad) {
      expect(assetPath(p)).toBeUndefined();
      expect(() => defaultAssetUrl("sly", p)).toThrow("isn't a path inside sly's folder");
    }
    expect(defaultAssetUrl("luna/tarot", "img/moon.png")).toBe("clover-plugin://luna/tarot/img/moon.png");
  });

  test("only the declarer's tree reads a point; a core point is the core's; an undeclared one has no entries", async () => {
    const { r } = setup();
    expect(await code(call(r, "tarot", "points.entries", ["luna.cards"]))).toBe("refused");
    expect(await code(call(r, "luna", "points.entries", ["models"]))).toBe("not_found");
    expect(await code(call(r, "luna", "points.entries", ["luna.nothing"]))).toBe("not_found");
  });

  test("points.watch hears a change in its entries, and only that", async () => {
    const { reg, r } = setup();
    const heard: unknown[][] = [];
    const stop = (await call(r, "luna", "points.watch", ["luna.cards", (e: unknown[]) => heard.push(e)])) as () => void;
    reg.put({ id: "quiet", manifest: manifest({ id: "quiet", name: "Quiet again" }) });
    expect(heard).toEqual([]);
    reg.put({ id: "tarot", manifest: manifest({ id: "tarot", name: "Tarot", host: { entry: "host/index.js" }, contributes: { "luna.cards": [{ id: "sun", image: "img/sun.png", draw: "drawSun" }] } } as Partial<Manifest>), change: "applies" });
    expect(heard.length).toBe(1);
    expect((heard[0] as { entryId: string }[]).map((e) => e.entryId)).toEqual(["sun"]);
    stop();
    reg.remove("tarot");
    expect(heard.length).toBe(1);
  });

  test("points.call runs the handler an entry names in a handler field, as the declarer's caller", async () => {
    const { host, r } = setup();
    expect(await call(r, "luna", "points.call", ["luna.cards", { pluginId: "tarot", entryId: "moon" }, "draw", { n: 1 }, { method: "go", timeoutMs: 2000 }], { caller: session })).toEqual({ ran: "drawMoon" });
    expect(host.calls).toEqual([{ pluginId: "tarot", handler: "drawMoon", method: "go", args: { n: 1 }, caller: session, session: "s_1", timeoutMs: 2000 }]);
    expect(await code(call(r, "luna", "points.call", ["luna.cards", { pluginId: "tarot", entryId: "moon" }, "title"]))).toBe("refused");
    expect(await code(call(r, "luna", "points.call", ["luna.cards", { pluginId: "tarot", entryId: "star" }, "draw"]))).toBe("not_installed");
    expect(await code(call(r, "tarot", "points.call", ["luna.cards", { pluginId: "tarot", entryId: "moon" }, "draw"]))).toBe("refused");
  });
});

describe("storage", () => {
  test("each plugin has its own synced store of JSON, up to 1 MB, and hears its changes", async () => {
    const stores = new SyncedStores(memorySyncedStores());
    const r = routerWith(registry(), [storageApi(stores)]);
    const heard: string[] = [];
    await call(r, "luna", "storage.synced.watch", [(k: string) => heard.push(k)]);
    await call(r, "luna", "storage.synced.set", ["b", { n: [1, "x", null] }]);
    await call(r, "luna", "storage.synced.set", ["a", true]);
    expect(await call(r, "luna", "storage.synced.get", ["b"])).toEqual({ n: [1, "x", null] });
    expect(await call(r, "luna", "storage.synced.keys")).toEqual(["a", "b"]);
    expect(await call(r, "tarot", "storage.synced.keys")).toEqual([]);
    expect(await call(r, "tarot", "storage.synced.get", ["b"])).toBeUndefined();
    await call(r, "luna", "storage.synced.delete", ["a"]);
    expect(heard).toEqual(["b", "a", "a"]);
    for (const bad of [new Uint8Array(2), new Date(0), new Map(), undefined, Number.NaN, 1n]) expect(await code(call(r, "luna", "storage.synced.set", ["c", bad]))).toBe("invalid");
    expect(await code(call(r, "luna", "storage.synced.set", ["big", "x".repeat(SYNCED_STORE_LIMIT_BYTES)]))).toBe("refused");
    expect(await call(r, "luna", "storage.synced.keys")).toEqual(["b"]);
  });

  test("on disk: the store in the fenced settings folder, the data folder under plugin-data, owner-only", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-home-"));
    const stores = new SyncedStores(fileSyncedStores(home));
    stores.set("clover/web", "k", 1);
    expect(JSON.parse(readFileSync(join(home, "settings", "plugin-stores", "clover", "web.json"), "utf8"))).toEqual({ k: 1 });
    expect(new SyncedStores(fileSyncedStores(home)).get("clover/web", "k")).toBe(1);
    const data = pluginDataFolder(home, "clover/web");
    expect(data).toBe(join(home, "plugin-data", "clover", "web"));
    if (process.platform !== "win32") expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(() => pluginDataFolder(home, "../etc")).toThrow("isn't a plugin id");
    expect(existsSync(join(home, "etc"))).toBe(false);
  });
});

describe("settings", () => {
  const setup = () => {
    const reg = registry();
    const secrets: { ref: { name: string }; value: string }[] = [];
    const settings = new PluginSettings({
      registry: reg, backend: memoryPluginSettings(),
      secrets: {
        set: async (ref, value) => (secrets.push({ ref, value: String(value) }), { ref, generation: 1, updatedAt: 0, synced: true }),
        delete: async () => true,
        list: async () => secrets.map((s) => ({ ref: { owner: { kind: "plugin" as const, pluginId: "luna" }, name: s.ref.name }, generation: 1, updatedAt: 0, synced: true })),
      },
    });
    return { reg, settings, secrets, r: routerWith(reg, [settingsApi(settings)]) };
  };

  test("a plugin reads its own values, defaults first, and sets them within the field's rules", async () => {
    const { r } = setup();
    expect(await call(r, "luna", "settings.get", ["greeting"])).toBe("hi");
    await call(r, "luna", "settings.set", ["greeting", "hello"]);
    expect(await call(r, "luna", "settings.get", ["greeting"])).toBe("hello");
    await call(r, "luna", "settings.set", ["greeting", null]);
    expect(await call(r, "luna", "settings.get", ["greeting"])).toBe("hi");
    await call(r, "luna", "settings.set", ["mode", "loud"]);
    await call(r, "luna", "settings.set", ["tint", "#ff00aa"]);
    for (const [k, v] of [["volume", 11], ["volume", "5"], ["mode", "wild"], ["tint", "red"], ["greeting", 3]] as const) expect([k, await code(call(r, "luna", "settings.set", [k, v]))]).toEqual([k, "invalid"]);
    expect(await code(call(r, "luna", "settings.get", ["nope"]))).toBe("not_found");
    expect(await code(call(r, "tarot", "settings.get", ["greeting"]))).toBe("not_found");
  });

  test("a bot value names its bot; a secret never passes through the plugin API", async () => {
    const { r } = setup();
    expect(await code(call(r, "luna", "settings.set", ["nick", "Lu"]))).toBe("invalid");
    await call(r, "luna", "settings.set", ["nick", "Lu", { bot: "alpha" }]);
    expect(await call(r, "luna", "settings.get", ["nick", { bot: "alpha" }])).toBe("Lu");
    expect(await call(r, "luna", "settings.get", ["nick", { bot: "beta" }])).toBeUndefined();
    expect(await code(call(r, "luna", "settings.get", ["token"]))).toBe("refused");
    expect(await code(call(r, "luna", "settings.set", ["token", "t"]))).toBe("refused");
  });

  test("settings.watch hears its own plugin's keys only", async () => {
    const { r, settings } = setup();
    const heard: string[] = [];
    await call(r, "luna", "settings.watch", [null, (k: string) => heard.push(k)]);
    await call(r, "luna", "settings.set", ["greeting", "yo"]);
    settings.set("luna", "volume", 1);
    expect(heard).toEqual(["greeting", "volume"]);
    expect(await code(call(r, "luna", "settings.watch", ["nope", () => {}]))).toBe("not_found");
  });

  test("the user's plugin.settings.*: a secret goes to the credential store and only whether it is set comes back", async () => {
    const { settings, secrets } = setup();
    const m = pluginSettingsMethods(settings);
    const user = { caller: { kind: "user", client: "app" } as Caller };
    expect(await m["plugin.settings.set"]!({ id: "luna", key: "token", value: "sekrit" }, user)).toEqual({ applied: true });
    expect(secrets).toEqual([{ ref: { owner: { kind: "plugin", pluginId: "luna" }, name: "token" } as never, value: "sekrit" }]);
    const views = ((await m["plugin.settings.get"]!({ id: "luna" }, user)) as { settings: Record<string, unknown>[] }).settings;
    expect(views.find((v) => v.key === "token")).toEqual({ key: "token", type: "secret", title: "Token", scope: "account", required: false, set: true });
    expect(views.find((v) => v.key === "greeting")).toEqual({ key: "greeting", type: "string", title: "Greeting", scope: "account", required: false, value: "hi", set: false });
    expect(JSON.stringify(views)).not.toContain("sekrit");
    await expect(m["plugin.settings.set"]!({ id: "luna", key: "greeting", value: "x" }, { caller: session })).rejects.toThrow("only the user");
  });

  test("a file that doesn't parse is kept aside and the read fails loudly; a __proto__ key is refused; a plain value of a field that became a secret moves to the store (#332's review)", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-home-"));
    mkdirSync(join(home, "settings", "plugins"), { recursive: true });
    writeFileSync(join(home, "settings", "plugins", "luna.json"), "{not json");
    const settings = new PluginSettings({ registry: registry(), backend: filePluginSettings(home) });
    expect(() => settings.get("luna", "greeting")).toThrow("couldn't be read; it's kept at");
    expect(readdirSync(join(home, "settings", "plugins")).some((f) => f.startsWith("luna.json.corrupt-"))).toBe(true);
    expect(settings.get("luna", "greeting")).toBe("hi");
    mkdirSync(join(home, "settings", "plugin-stores"), { recursive: true });
    writeFileSync(join(home, "settings", "plugin-stores", "luna.json"), "[1,2]");
    const stores = new SyncedStores(fileSyncedStores(home));
    expect(() => stores.get("luna", "k")).toThrow("couldn't be read");
    for (const bad of ["__proto__", "constructor", "prototype"]) expect(() => stores.set("luna", bad, 1)).toThrow("isn't a store key");
    stores.set("luna", "k", 1);
    expect(Object.getPrototypeOf(JSON.parse(readFileSync(join(home, "settings", "plugin-stores", "luna.json"), "utf8")))).toBe(Object.prototype);
    // `token` is a secret now; an older version kept it as a plain string.
    writeFileSync(join(home, "settings", "plugins", "luna.json"), JSON.stringify({ account: { token: "plain-old", greeting: "yo" }, device: {}, bot: {} }));
    const moved: { name: string; value: string }[] = [];
    const withStore = new PluginSettings({
      registry: registry(), backend: filePluginSettings(home),
      secrets: { set: async (ref, value) => (moved.push({ name: ref.name, value: String(value) }), { ref, generation: 1, updatedAt: 0, synced: true }), delete: async () => true, list: async () => [] },
    });
    const views = await withStore.views("luna");
    expect(moved).toEqual([{ name: "token", value: "plain-old" }]);
    expect(readFileSync(join(home, "settings", "plugins", "luna.json"), "utf8")).not.toContain("plain-old");
    expect(views.find((v) => v.key === "greeting")).toMatchObject({ value: "yo" });
  });

  test("on disk, under the fenced settings folder", () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b2-home-"));
    const settings = new PluginSettings({ registry: registry(), backend: filePluginSettings(home) });
    settings.set("luna", "tint", "#000000");
    settings.set("luna", "nick", "Lu", "alpha");
    expect(JSON.parse(readFileSync(join(home, "settings", "plugins", "luna.json"), "utf8"))).toEqual({ account: {}, device: { tint: "#000000" }, bot: { alpha: { nick: "Lu" } } });
  });
});

describe("confirm", () => {
  test("a sealed confirm card says it is the plugin's, carries its text only in `what`, and returns only the answer", async () => {
    const asked: ApprovalRequest[] = [];
    const broker = { request: async (req: ApprovalRequest) => (asked.push(req), { allowed: true, by: "card" as const, cardId: "card_000001" }) };
    const r = routerWith(registry(), [confirmApi(broker)]);
    expect(await call(r, "tarot", "confirm", ["Shuffle the whole deck?"], { caller: session })).toBe(true);
    expect(await call(r, "tarot", "confirmCard", ["Again?"])).toEqual({ allowed: true, card: "card_000001" });
    expect(asked[0]).toEqual({
      kind: "confirm", origin: "plugin", computers: [], effect: "other", pluginId: "tarot", session: "s_1",
      fields: {
        title: { type: "text", text: "A plugin asks" }, what: { type: "text", text: "Shuffle the whole deck?" },
        source: { type: "rows", rows: [{ label: "Plugin", value: "Tarot" }, { label: "Id", value: "tarot" }, { label: "Source", value: "local" }] },
      },
    });
    for (const bad of ["", "   ", "x".repeat(2001), "\uD800", 3, "\u202e\u200f"]) expect(await code(call(r, "tarot", "confirm", [bad]))).toBe("invalid");
  });

  test("control and bidirectional characters are dropped from the text; a plugin has at most 3 cards open, and 10 a minute (#332's review)", async () => {
    const asked: ApprovalRequest[] = [];
    const answers: ((v: { allowed: boolean; by: "card"; cardId: string }) => void)[] = [];
    const broker = { request: (req: ApprovalRequest) => new Promise<{ allowed: boolean; by: "card"; cardId: string }>((resolve) => { asked.push(req); answers.push(resolve); }) };
    let t = 1_000_000;
    const r = routerWith(registry(), [confirmApi(broker, { now: () => t })]);
    const first = call(r, "tarot", "confirm", ["Pay \u202eevil\u202c now?\u0007\nReally?"]);
    await Bun.sleep(1);
    expect((asked[0]!.fields.what as { text: string }).text).toBe("Pay evil now?\nReally?");
    const more = [call(r, "tarot", "confirm", ["2?"]), call(r, "tarot", "confirm", ["3?"])];
    expect(await code(call(r, "tarot", "confirm", ["4?"]))).toBe("refused");
    // Another plugin's cards count on their own.
    const luna = call(r, "luna", "confirm", ["Luna's own?"]);
    await Bun.sleep(1);
    expect(asked.length).toBe(4);
    for (const a of answers.splice(0)) a({ allowed: true, by: "card", cardId: "c" });
    await Promise.all([first, ...more, luna]);
    // Answered, they free their places; the rate still counts them.
    for (let i = 0; i < 7; i++) {
      const p = call(r, "tarot", "confirm", [`more ${i}?`]);
      await Bun.sleep(1);
      for (const a of answers.splice(0)) a({ allowed: false, by: "card", cardId: "c" });
      await p;
    }
    expect(await code(call(r, "tarot", "confirm", ["eleventh?"]))).toBe("refused");
    t += 60_000;
    const later = call(r, "tarot", "confirm", ["a minute on?"]);
    await Bun.sleep(1);
    for (const a of answers.splice(0)) a({ allowed: true, by: "card", cardId: "c" });
    expect(await later).toBe(true);
  });
});

describe("commands and points, listed", () => {
  test("command.list and commands.list: the active commands as the palette shows them", async () => {
    const reg = registry();
    expect(commandViews(reg)).toEqual([{ name: "tarot.shuffle", pluginId: "tarot", description: "Shuffle the deck", args: { type: "object" }, key: "Mod+Shift+T" }]);
    const r = routerWith(reg, [commandsApi(reg)]);
    expect(await call(r, "quiet", "commands.list")).toEqual(commandViews(reg));
    expect(await commandListMethods(reg)["command.list"]!({}, { caller: { kind: "user", client: "app" } as Caller })).toEqual({ commands: commandViews(reg) });
  });

  test("point.list: the core's points and the declared ones, with occupants", () => {
    const views = pointViews(registry());
    expect(views.find((p) => p.name === "models")).toMatchObject({ declaredBy: "core", occupants: [], waiting: [] });
    expect(views.find((p) => p.name === "luna.cards")).toMatchObject({
      declaredBy: { pluginId: "luna", entry: "host" }, spot: false, shape: "list",
      occupants: [{ pluginId: "tarot", entry: "luna.cards/0" }, { pluginId: "tarot", entry: "luna.cards/1" }],
      replacesShipped: false, private: false,
    });
    expect(views.find((p) => p.name === "commands")?.occupants).toEqual([{ pluginId: "tarot", entry: "commands/0" }]);
  });
});

describe("the caller (R7) and the pipe", () => {
  test("an API call inside an open call acts as its caller; outside any, as the plugin; an ended or foreign one is refused", () => {
    const t = new InvocationTable();
    const end = t.open("call_1", { pluginId: "tarot", caller: session, session: "s_1" });
    expect(t.callerFor("tarot", "call_1")).toEqual(session);
    expect(t.callerFor("tarot")).toEqual({ kind: "plugin", pluginId: "tarot" });
    expect(() => t.callerFor("luna", "call_1")).toThrow(ContractError);
    expect(() => t.open("call_1", { pluginId: "tarot", caller: session })).toThrow("already open");
    end();
    expect(() => t.callerFor("tarot", "call_1")).toThrow("has ended");
    expect(() => t.callerFor("tarot", "made-up")).toThrow(ContractError);
  });

  test("pluginHost.api binds the caller from the core's record and turns a listener into a subscription", async () => {
    const reg = registry();
    const stores = new SyncedStores(memorySyncedStores());
    const seen: Caller[] = [];
    const invocations = new InvocationTable();
    const delivered: [string, string, unknown][] = [];
    const ch = apiChannel({
      process: "shared",
      router: routerWith(reg, [storageApi(stores), { "storage.synced.keys": (ctx) => (seen.push(ctx.caller), []) }]),
      invocations,
      deliver: (p, s, v) => delivered.push([p, s, v]),
    });
    const api = ch.methods["pluginHost.api"]!;
    const ctx = { caller: { kind: "core" } as Caller };
    invocations.open("call_9", { pluginId: "tarot", caller: session });
    await api({ pluginId: "tarot", callId: "a1", call: "storage.synced.keys", args: [], invocation: "call_9" }, ctx);
    await api({ pluginId: "tarot", callId: "a2", call: "storage.synced.keys", args: [] }, ctx);
    expect(seen).toEqual([session, { kind: "plugin", pluginId: "tarot" }]);
    await expect(api({ pluginId: "tarot", callId: "a3", call: "storage.synced.keys", args: [], invocation: "call_x" }, ctx)).rejects.toThrow();

    const { result } = (await api({ pluginId: "tarot", callId: "a4", call: "storage.synced.watch", args: [{ [LISTENER_ARG]: true }] }, ctx)) as { result: { subscription: string } };
    expect(result.subscription).toMatch(/^sub_/);
    stores.set("tarot", "x", 1);
    expect(delivered).toEqual([["tarot", result.subscription, "x"]]);
    expect(ch.watches).toBe(1);
    await ch.methods["pluginHost.unwatch"]!({ pluginId: "luna", subscription: result.subscription }, ctx);
    expect(ch.watches).toBe(1); // another plugin can't end it
    await ch.methods["pluginHost.unwatch"]!({ pluginId: "tarot", subscription: result.subscription }, ctx);
    stores.set("tarot", "y", 1);
    expect(delivered.length).toBe(1);
    await api({ pluginId: "tarot", callId: "a5", call: "storage.synced.watch", args: [{ [LISTENER_ARG]: true }] }, ctx);
    ch.closeAll();
    expect(ch.watches).toBe(0);
  });
});

describe("the process check in front of the gate (S4)", () => {
  test("a third-party worker presenting a clover id is refused before the gate; clover's own process passes", async () => {
    const { pluginApiRouter } = await import("../index");
    const reg = registry([{ id: "clover", source: "bundled", manifest: manifest({ id: "clover", name: "Clover", host: { entry: "host/index.js" } } as Partial<Manifest>) }]);
    const r = pluginApiRouter({
      registry: reg,
      handlers: [{ "storage.synced.keys": () => ["k"] }],
      recordOf: (id) => {
        const rec = reg.get(id);
        return rec === undefined ? undefined : { id, source: rec.source };
      },
    });
    expect(await call(r, "clover", "storage.synced.keys", [], { process: "clover" })).toEqual(["k"]);
    expect(await code(call(r, "clover", "storage.synced.keys", [], { process: "shared" }))).toBe("refused");
    expect(await code(call(r, "luna", "storage.synced.keys", [], { process: "clover" }))).toBe("refused");
    expect(await call(r, "luna", "storage.synced.keys", [], { process: "shared" })).toEqual(["k"]);
  });
});
