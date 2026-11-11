// The core's own pages (spec §5.8): the welcome guide's providers, terms and sign-ins, and safe mode's plugin manager,
// through the main process's checked calls. A key the user pastes reaches the daemon's sign-in and nothing else.
import { describe, expect, test } from "bun:test";
import { anyReady, listManaged, listProviders, pageCall, PAGE_CALLS, type PageClient, type PageDeps } from "../src/main/core-pages";

const SUMMARY = { version: "1.0.0", source: "index", class: "code", namespace: "x", scope: "everywhere", adult: false, children: [], dev: false };

function client(overrides: Record<string, (params: Record<string, unknown>) => unknown> = {}): PageClient & { calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  const answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    "point.list": () => ({ points: [{ name: "models", shape: "list", declaredBy: "core", spot: false, occupants: [{ pluginId: "luna-models", entry: "models" }, { pluginId: "clover/openai", entry: "models" }, { pluginId: "luna-models", entry: "models" }], waiting: [], replacesShipped: false, private: false }] }),
    "plugin.get": (p) => ({ plugin: { name: p.id, manifest: { contributes: { models: p.id === "luna-models"
      ? [{ provider: "luna", name: { en: "Luna AI", fr: "Luna IA" }, terms: "https://luna.example/terms", auth: [{ method: "api-key", help: "Make a key in Luna's console." }, { method: "oauth-pkce" }] }]
      : [{ provider: "openai", name: "OpenAI", terms: "Be nice.", auth: [{ method: "api-key" }] }] } } } }),
    "plugin.auth.list": (p) => ({ auth: p.id === "luna-models" ? [{ index: 0, method: "api-key", state: "signed-out" }, { index: 1, method: "oauth-pkce", state: "signed-out" }] : [{ index: 0, method: "api-key", state: "signed-in", account: "me@example.com" }] }),
    "plugin.list": () => ({ plugins: [
      { id: "clover", name: "Clover", state: "enabled", enabled: true, ...SUMMARY, source: "bundled" },
      { id: "clover/shell", parent: "clover", name: "Shell", state: "enabled", enabled: true, ...SUMMARY, source: "bundled" },
      { id: "alpha", name: "Alpha", state: "enabled", enabled: true, ...SUMMARY, source: "bundled" },
      { id: "vn-shell", name: { en: "VN shell" }, state: "enabled", enabled: true, ...SUMMARY },
      { id: "vn-shell/extra", parent: "vn-shell", name: "Extra", state: "disabled", enabled: false, ...SUMMARY },
      { id: "found-one", name: "Found", state: "found", enabled: false, ...SUMMARY, reason: "waiting for your OK" },
    ] }),
    ...overrides,
  };
  return {
    calls,
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      const answer = answers[method];
      if (answer === undefined) throw new Error(`no ${method}`);
      return (await answer((params ?? {}) as Record<string, unknown>)) as T;
    },
  };
}

function deps(c: PageClient | undefined, more: Partial<PageDeps> = {}): PageDeps & { opened: string[]; done: number; closed: number } {
  const d = {
    opened: [] as string[],
    done: 0,
    closed: 0,
    client: () => c,
    lang: () => "fr",
    openExternal: async (url: string) => void d.opened.push(url),
    welcomeDone: () => void d.done++,
    page: () => "welcome" as const,
    closePage: () => void d.closed++,
    registryReady: () => true,
    ...more,
  };
  return d;
}

describe("the registry's state", () => {
  test("registry.state says whether the daemon has the registry open, and is a call the root may make", async () => {
    expect(PAGE_CALLS).toContain("registry.state");
    expect(await pageCall("registry.state", {}, deps(undefined, { registryReady: () => false }))).toEqual({ ready: false });
    expect(await pageCall("registry.state", {}, deps(undefined))).toEqual({ ready: true });
  });
});

describe("the welcome guide", () => {
  test("lists each model provider once, in the user's language, with its terms and its sign-ins", async () => {
    const providers = await listProviders(client(), "fr");
    expect(providers).toEqual([
      { id: "luna-models", name: "Luna IA", terms: { url: "https://luna.example/terms" }, auth: [{ index: 0, method: "api-key", state: "signed-out", help: "Make a key in Luna's console." }, { index: 1, method: "oauth-pkce", state: "signed-out" }] },
      { id: "clover/openai", name: "OpenAI", terms: { text: "Be nice." }, auth: [{ index: 0, method: "api-key", state: "signed-in", account: "me@example.com" }] },
    ]);
    expect(anyReady(providers)).toBe(true);
    expect(anyReady(providers.slice(0, 1))).toBe(false);
  });

  test("a key goes to the daemon's sign-in and nowhere else; an error never carries it", async () => {
    const key = "sk-test-not-a-real-key-0001";
    const c = client({ "plugin.auth.signIn": (p) => {
      if (p.index === 0) throw new Error(`the provider refused ${String(p.key)}`);
      return { state: "signed-in" };
    } });
    const d = deps(c);
    const err = await pageCall("welcome.signIn", { id: "luna-models", index: 0, key }, d).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("the provider refused …");
    expect(c.calls.find((x) => x.method === "plugin.auth.signIn")?.params).toEqual({ id: "luna-models", index: 0, key });
    // Nothing else saw it.
    expect(JSON.stringify(c.calls.filter((x) => x.method !== "plugin.auth.signIn"))).not.toContain(key);
  });

  test("a browser sign-in opens the provider's own page in the user's browser, an https one only", async () => {
    let url = "https://luna.example/authorize?x=1";
    const c = client({ "plugin.auth.signIn": () => ({ state: "signed-out", authorizeUrl: url }) });
    const d = deps(c);
    expect(await pageCall("welcome.signIn", { id: "luna-models", index: 1 }, d)).toEqual({ state: "signed-out", opened: true });
    expect(d.opened).toEqual(["https://luna.example/authorize?x=1"]);
    url = "javascript:alert(1)";
    expect(await pageCall("welcome.signIn", { id: "luna-models", index: 1 }, d)).toEqual({ state: "signed-out", opened: false });
    expect(d.opened).toHaveLength(1);
  });

  test("the terms open only when they are a link; done closes the guide for good", async () => {
    const d = deps(client());
    await pageCall("welcome.openTerms", { id: "luna-models" }, d);
    expect(d.opened).toEqual(["https://luna.example/terms"]);
    await expect(pageCall("welcome.openTerms", { id: "clover/openai" }, d)).rejects.toThrow("no terms to open");
    await pageCall("welcome.done", {}, d);
    expect([d.done, d.closed]).toEqual([1, 1]);
  });
});

describe("safe mode's plugin manager", () => {
  test("lists every plugin but the app's own, and turns one off or removes it", async () => {
    const c = client({ "plugin.setEnabled": () => ({ applied: true }), "plugin.remove": () => ({ ok: true }) });
    expect((await listManaged(c, "en")).map((p) => [p.id, p.state, p.enabled, p.child])).toEqual([
      ["found-one", "found", false, false],
      ["vn-shell", "enabled", true, false],
      ["vn-shell/extra", "disabled", false, true],
    ]);
    const d = deps(c);
    await pageCall("plugins.turnOff", { id: "vn-shell" }, d);
    await pageCall("plugins.remove", { id: "vn-shell" }, d);
    expect(c.calls.filter((x) => x.method === "plugin.setEnabled" || x.method === "plugin.remove").map((x) => [x.method, x.params])).toEqual([
      ["plugin.setEnabled", { id: "vn-shell", enabled: false }],
      ["plugin.remove", { id: "vn-shell" }],
    ]);
  });

  test("never the app's own, never a child on its own, never another call", async () => {
    const d = deps(client());
    await expect(pageCall("plugins.turnOff", { id: "clover/shell" }, d)).rejects.toThrow();
    await expect(pageCall("plugins.remove", { id: "alpha" }, d)).rejects.toThrow();
    await expect(pageCall("plugins.remove", { id: "vn-shell/extra" }, d)).rejects.toThrow();
    await expect(pageCall("plugin.setEnabled", { id: "vn-shell", enabled: true }, d)).rejects.toThrow("not a call");
    await expect(pageCall("plugins.list", {}, deps(undefined))).rejects.toThrow("isn't running");
    expect(PAGE_CALLS).not.toContain("plugins.turnOn" as never);
  });
});

describe("the app's own key dialog (the Plugins page's ui.secret)", () => {
  const keyed = () => {
    const stored = new Map<string, unknown>();
    const c = client({
      "plugin.get": (p) => ({ plugin: { name: { en: "Tarot", fr: "Tarot FR" }, manifest: { settings: { token: { type: "secret", title: { en: "Deck key", fr: "Clé du jeu" } }, region: { type: "string" } } } } }),
      "plugin.settings.get": () => ({ settings: [{ key: "token", set: stored.has("token") }, { key: "region", value: "eu" }] }),
      "plugin.settings.set": (p) => {
        if (p.value === "bad") throw new Error(`refused: bad is not a key`);
        if (p.value === null) stored.delete(p.key as string);
        else stored.set(p.key as string, p.value);
        return { applied: true };
      },
      "plugin.auth.list": () => ({ auth: [{ index: 0, method: "api-key", state: stored.has("auth0") ? "signed-in" : "signed-out" }, { index: 1, method: "oauth-pkce", state: "signed-out" }] }),
      "plugin.auth.signIn": (p) => { stored.set(`auth${p.index}`, p.key); return { state: "signed-in" }; },
      "plugin.auth.signOut": (p) => { stored.delete(`auth${p.index}`); return { ok: true }; },
    });
    return { c, stored };
  };

  test("names the plugin and field from the registry, enters, replaces and removes a setting's key; the value never comes back", async () => {
    const { c, stored } = keyed();
    const d = deps(c, { page: () => "key", keyTarget: () => ({ target: { id: "tarot", key: "token" }, session: "s1" }) });
    expect(await pageCall("key.view", {}, d)).toEqual({ session: "s1", plugin: "Tarot FR", label: "Clé du jeu", set: false });
    // A save or removal from another opening of the dialog (a stale session, or none) is refused.
    for (const session of [undefined, "s0"]) await expect(pageCall("key.save", { value: "sk-x", session }, d)).rejects.toThrow("out of date");
    await expect(pageCall("key.remove", { session: "s0" }, d)).rejects.toThrow("out of date");
    expect(stored.size).toBe(0);
    // The page's id or key is never used: main's target is.
    const saved = await pageCall("key.save", { value: " sk-one ", id: "other", key: "region", session: "s1" }, d);
    expect(saved).toEqual({ session: "s1", plugin: "Tarot FR", label: "Clé du jeu", set: true });
    expect(JSON.stringify(saved)).not.toContain("sk-one");
    expect(stored.get("token")).toBe("sk-one");
    expect(c.calls.filter((x) => x.method === "plugin.settings.set").map((x) => x.params)).toEqual([{ id: "tarot", key: "token", value: "sk-one" }]);
    await pageCall("key.save", { value: "sk-two", session: "s1" }, d);
    expect(stored.get("token")).toBe("sk-two");
    expect(await pageCall("key.remove", { session: "s1" }, d)).toEqual({ session: "s1", plugin: "Tarot FR", label: "Clé du jeu", set: false });
    expect(stored.has("token")).toBe(false);
    // An error never carries the key; an empty one isn't sent.
    const err = await pageCall("key.save", { value: "bad", session: "s1" }, d).catch((e: Error) => e.message);
    expect(err).not.toContain("bad");
    await expect(pageCall("key.save", { value: "  ", session: "s1" }, d)).rejects.toThrow("type or paste");
  });

  test("an api-key sign-in the same way; a browser sign-in, a plain setting, no target or another page: refused", async () => {
    const { c, stored } = keyed();
    const at = (target: unknown) => ({ target: target as never, session: "s" });
    const d = deps(c, { page: () => "key", keyTarget: () => at({ id: "tarot", index: 0 }) });
    await pageCall("key.save", { value: "sk-auth", session: "s" }, d);
    expect(stored.get("auth0")).toBe("sk-auth");
    expect(await pageCall("key.view", {}, d)).toMatchObject({ set: true });
    await pageCall("key.remove", { session: "s" }, d);
    expect(stored.has("auth0")).toBe(false);
    await expect(pageCall("key.view", {}, deps(c, { page: () => "key", keyTarget: () => at({ id: "tarot", index: 1 }) }))).rejects.toThrow("doesn't take a key");
    await expect(pageCall("key.save", { value: "x", session: "s" }, deps(c, { page: () => "key", keyTarget: () => at({ id: "tarot", key: "region" }) }))).rejects.toThrow("isn't one of the plugin's keys");
    await expect(pageCall("key.save", { value: "x", session: "s" }, deps(c, { page: () => "key" }))).rejects.toThrow("no key is being entered");
    await expect(pageCall("key.save", { value: "x", session: "s" }, deps(c, { page: () => "plugins" as never, keyTarget: () => at({ id: "tarot", key: "token" }) }))).rejects.toThrow("no key is being entered");
    expect(stored.size).toBe(0);
  });
});
