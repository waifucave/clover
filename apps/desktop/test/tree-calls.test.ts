import { describe, expect, test } from "bun:test";
import { LAYER_METHODS } from "../src/main/layer-links";
import { NEVER, SEND_ONLY, TREE_CALLS, treeVerdict } from "../src/main/ui/tree-calls";

const verdict = (part: string, method: string) => treeVerdict(part, method);

describe("the bundled tree's calls on the app's connection", () => {
  test("a read is allowed to any part; a method the table doesn't name isn't its business", () => {
    for (const m of ["account.status", "archive.history", "archive.list", "plugin.list", "plugin.get", "plugin.ui", "ui.settings"]) {
      expect(verdict("clover/conversation", m)).toMatchObject({ ok: true });
    }
    expect(verdict("clover/bot-editor", "models.list")).toMatchObject({ ok: true });
    expect(verdict("clover/composer", "models.list")).toMatchObject({ ok: false, owned: true });
    expect(verdict("clover/composer", "plugin.logs")).toMatchObject({ ok: false, owned: true });
    expect(verdict("clover/composer", "nonsense.method")).toMatchObject({ ok: false, owned: false });
  });

  test("settings writes (and a plugin's own settings reads) only from the settings part (and the Plugins page, below)", () => {
    for (const m of ["ui.set", "plugin.setEnabled", "plugin.settings.set", "plugin.settings.get"]) {
      expect(verdict("clover/settings", m)).toMatchObject({ ok: true });
      for (const part of ["clover/conversation", "clover/composer", "clover/shell", "clover/sidebar"]) {
        expect(verdict(part, m)).toMatchObject({ ok: false, owned: true });
      }
    }
  });

  test("the composer's session control is not on the door: it is the composer spot's callbacks", () => {
    for (const m of ["session.setModel", "session.interrupt", "session.stop"]) expect(verdict("clover/composer", m)).toMatchObject({ ok: false, owned: true });
  });

  test("a send is never a bare call, the cards are never answered, trust-changing calls need a card", () => {
    for (const m of SEND_ONLY) expect(verdict("clover/composer", m)).toMatchObject({ ok: false, owned: true });
    for (const m of NEVER) expect(verdict("clover/settings", m)).toMatchObject({ ok: false, owned: true });
    for (const m of ["computer.setLevel", "device.revoke", "main.set"]) {
      expect(verdict("clover/settings", m)).toMatchObject({ ok: false, owned: true });
      expect(verdict("clover/composer", m)).toMatchObject({ ok: false, owned: true });
    }
  });

  test("what the daemon doesn't serve is refused", () => {
    for (const m of ["models.catalog", "session.changes", "session.connectors", "session.context", "session.createPr", "session.diff", "session.outputs"]) {
      expect(verdict("clover/panel", m)).toMatchObject({ ok: false, owned: true });
    }
  });

  test("a non-clover layer's calls are unchanged: the layer door still refuses each of them", () => {
    // The table is reached only for the bundled tree's parts; for any other layer, the layer role's methods stand.
    for (const m of ["session.send", "session.setModel", "session.interrupt", "session.stop", "computer.setLevel", "device.revoke", "main.set", "models.list", "account.status", "card.answer", "card.confirm"]) {
      if (m === "card.confirm") continue; // the layer role's own (the sealed card's)
      expect(LAYER_METHODS.has(m)).toBe(false);
    }
  });

  test("every table entry is a named method", () => {
    for (const m of Object.keys(TREE_CALLS)) expect(m).toMatch(/^[a-z]+(\.[A-Za-z]+)+$/);
  });
});

import { PICK_TOKEN_MS, PickTokens, PLUGINS_PART, routeCall, type KeyTarget, type TreeRoute } from "../src/main/ui/tree-calls";

function route(over: Partial<TreeRoute> & { gesture?: boolean }) {
  const calls: string[] = [];
  const logs: string[] = [];
  const r: TreeRoute = {
    tree: { windowId: 1, pluginId: "clover/composer" },
    method: "session.setModel",
    params: {},
    takeGesture: () => over.gesture ?? false,
    request: async (m) => { calls.push(`app:${m}`); return "app"; },
    layer: async () => { calls.push("layer"); return "layer"; },
    log: (l) => logs.push(l),
    refuse: (why) => new Error(why),
    ...over,
  };
  return { r, calls, logs };
}

describe("routing a part's call", () => {
  test("a part that isn't the bundled tree's goes the layer door, whatever the method", async () => {
    for (const method of ["session.send", "session.setModel", "ui.set", "models.list", "computer.setLevel"]) {
      const { r, calls } = route({ tree: undefined, method, gesture: true });
      expect(await routeCall(r)).toBe("layer");
      expect(calls).toEqual(["layer"]);
    }
  });

  test("a conversation or composer frame is refused every settings write and nothing reaches the core", async () => {
    for (const part of ["clover/conversation", "clover/composer"]) {
      for (const method of ["ui.set", "plugin.setEnabled", "plugin.settings.set"]) {
        const { r, calls, logs } = route({ tree: { windowId: 1, pluginId: part }, method, gesture: true });
        await expect(routeCall(r)).rejects.toThrow("only from clover/settings");
        expect(calls).toEqual([]);
        expect(logs[0]).toContain("refused");
      }
    }
    const { r, calls } = route({ tree: { windowId: 1, pluginId: "clover/settings" }, method: "ui.set" });
    expect(await routeCall(r)).toBe("app");
    expect(calls).toEqual(["app:ui.set"]);
  });

  test("switching a plugin on or off is the settings part's and needs the user's click", async () => {
    const t = { windowId: 1, pluginId: "clover/settings" };
    const none = route({ tree: t, method: "plugin.setEnabled", gesture: false });
    await expect(routeCall(none.r)).rejects.toThrow("only right after the user's own key press or click");
    expect(none.calls).toEqual([]);
    expect(await routeCall(route({ tree: t, method: "plugin.setEnabled", gesture: true }).r)).toBe("app");
    const other = route({ tree: { windowId: 1, pluginId: "clover/composer" }, method: "plugin.setEnabled", gesture: true });
    await expect(routeCall(other.r)).rejects.toThrow("only from clover/settings");
  });

  test("a bare session.send, a card answer and a trust-changing call never reach the core from the tree", async () => {
    for (const method of ["session.send", "card.answer", "card.confirm", "computer.setLevel", "device.revoke", "main.set"]) {
      const { r, calls } = route({ method, gesture: true });
      await expect(routeCall(r)).rejects.toThrow();
      expect(calls).toEqual([]);
    }
  });

  test("a method the table doesn't name falls to the layer door, which keeps its own list", async () => {
    const { r, calls } = route({ method: "plugin.restartEverything" });
    expect(await routeCall(r)).toBe("layer");
    expect(calls).toEqual(["layer"]);
  });

  test("a bot's user layer is the bot editor's, with the user's click; no other part's", async () => {
    const patch = { id: "alpha", patch: { instructions: "x" } };
    const editor = { windowId: 1, pluginId: "clover/bot-editor" };
    expect(await routeCall(route({ tree: editor, method: "bot.setUserLayer", params: patch, gesture: true }).r)).toBe("app");
    const none = route({ tree: editor, method: "bot.setUserLayer", params: patch, gesture: false });
    await expect(routeCall(none.r)).rejects.toThrow("only right after");
    expect(none.calls).toEqual([]);
    for (const part of ["clover/composer", "clover/settings"]) {
      const other = route({ tree: { windowId: 1, pluginId: part }, method: "bot.setUserLayer", params: patch, gesture: true });
      await expect(routeCall(other.r)).rejects.toThrow("only from");
    }
  });

  test("a part's plugin settings are its own: the id on the call must be the calling part's (provider endpoints live in others')", async () => {
    const t = { windowId: 1, pluginId: "clover/settings" };
    for (const method of ["plugin.settings.get", "plugin.settings.set"]) {
      expect(await routeCall(route({ tree: t, method, params: { id: "clover/settings", key: "notifications.sounds", value: true } }).r)).toBe("app");
      for (const id of ["clover/provider-gcp", "clover/model-azure-ai", "clover/relay-cloudflare", undefined]) {
        const other = route({ tree: t, method, params: { id, key: "project", value: "x" } });
        await expect(routeCall(other.r)).rejects.toThrow("its own plugin's settings only");
        expect(other.calls).toEqual([]);
      }
    }
  });
});

// ---- the Plugins page (class 3, the controller's ruling of 2026-11-11) ----

/** What each table entry allows: the parts that may call it, whether it needs the user's gesture (per part), and
 *  whether the id is held to the calling part's own. */
const EXPECTED: Record<string, { parts: string[] | "any"; gesture: string[]; ownId?: string[] }> = {
  "ui.settings": { parts: "any", gesture: [] },
  "ui.set": { parts: ["clover/settings"], gesture: [] },
  "plugin.settings.get": { parts: ["clover/settings", PLUGINS_PART], gesture: [], ownId: ["clover/settings"] },
  "plugin.settings.set": { parts: ["clover/settings", PLUGINS_PART], gesture: [PLUGINS_PART], ownId: ["clover/settings"] },
  "bot.setUserLayer": { parts: ["clover/bot-editor"], gesture: ["clover/bot-editor"] },
  "account.status": { parts: "any", gesture: [] },
  "archive.history": { parts: "any", gesture: [] },
  "archive.list": { parts: "any", gesture: [] },
  "plugin.list": { parts: "any", gesture: [] },
  "plugin.get": { parts: "any", gesture: [] },
  "plugin.ui": { parts: "any", gesture: [] },
  "plugin.index.list": { parts: "any", gesture: [] },
  "plugin.index.search": { parts: "any", gesture: [] },
  "models.list": { parts: ["clover/bot-editor"], gesture: [] },
  "plugin.setEnabled": { parts: ["clover/settings", PLUGINS_PART], gesture: ["clover/settings", PLUGINS_PART] },
  "plugin.logs": { parts: ["clover/settings", PLUGINS_PART], gesture: [] },
  "plugin.auth.list": { parts: [PLUGINS_PART], gesture: [] },
  "plugin.dev.list": { parts: [PLUGINS_PART], gesture: [] },
  ...Object.fromEntries(["ui.pick", "ui.secret", "plugin.install", "plugin.remove", "plugin.update", "plugin.pin", "plugin.restart", "plugin.index.add", "plugin.index.remove", "plugin.auth.signIn", "plugin.auth.signOut", "plugin.dev.add", "plugin.dev.remove", "plugin.dev.renew"].map((m) => [m, { parts: [PLUGINS_PART], gesture: [PLUGINS_PART] }])),
};
const PARTS = ["clover/settings", PLUGINS_PART, "clover/bot-editor", "clover/composer", "clover/conversation", "clover/sidebar"];

/** The app's connection as the door's own look-ups see it: a plugin with one plain setting (`k`, `region`) and one key
 *  (`token`), and one `api-key` sign-in (index 0) and one browser sign-in (index 1). */
async function appConnection(method: string): Promise<unknown> {
  if (method === "plugin.get") return { plugin: { id: "tarot", manifest: { settings: { k: { type: "string" }, region: { type: "string" }, token: { type: "secret" } } } } };
  if (method === "plugin.auth.list") return { auth: [{ index: 0, method: "api-key", state: "signed-out" }, { index: 1, method: "oauth-pkce", state: "signed-out" }] };
  return "app";
}

/** Each live entry's WORST single call from a part, classified (the reviewer's table): a sealed card the core raises, a
 *  dialog main owns, a read, or a harmless change. The test below fails on an entry with none. */
type Worst = "sealed card" | "main-owned dialog" | "read" | "harmless change";
const WORST: Record<string, Worst> = {
  "ui.settings": "read", // the app's settings as the parts show them
  "ui.set": "harmless change", // appearance and notification choices, the settings part's own, nothing that runs code
  "plugin.settings.get": "read", // a key's value never: only whether one is set
  "plugin.settings.set": "sealed card", // a setting a host, env, args, hook or backend takes from cards; a key is refused (noSecret, and main looks the kind up); the rest are plain
  "bot.setUserLayer": "harmless change", // the user's own words for a bot, from the bot editor, on their click; no capability moves
  "account.status": "read",
  "archive.history": "read",
  "archive.list": "read",
  "plugin.list": "read",
  "plugin.get": "read",
  "plugin.ui": "read",
  "plugin.index.list": "read",
  "plugin.index.search": "read",
  "models.list": "read",
  "plugin.setEnabled": "sealed card", // turning a revoked plugin back on is the override's warning card; else an OK'd plugin on or off
  "plugin.logs": "read", // its own file only, key-looking runs cut to "…"
  "plugin.auth.list": "read",
  "plugin.dev.list": "read",
  "ui.pick": "main-owned dialog", // main's own open dialog; the page gets a one-use token and a name
  "ui.secret": "main-owned dialog", // the app's own key dialog; the key never passes the page
  "plugin.install": "sealed card", // every install raises the core's OK card before anything runs
  "plugin.remove": "sealed card", // main sets card: the removal card
  "plugin.update": "sealed card", // main sets card: a non-official update asks; a new trigger shows its OK card instead
  "plugin.pin": "harmless change", // holds a plugin's updates back on this computer; it never lets new code in
  "plugin.restart": "harmless change", // restarts the plugin's own processes on the code already OK'd
  "plugin.index.add": "sealed card", // the core's warning card with the key's fingerprint
  "plugin.index.remove": "sealed card", // main sets card: asks when installs came from it; blocks it held stay
  "plugin.auth.signIn": "main-owned dialog", // a key only in the app's key dialog; a browser sign-in opens the provider's page
  "plugin.auth.signOut": "sealed card", // main sets card: the sign-out card
  "plugin.dev.add": "sealed card", // a picked folder only, and the core's development-folder card
  "plugin.dev.remove": "harmless change", // stops loading a development folder
  "plugin.dev.renew": "harmless change", // another 24 hours for a development folder the user already added on a card
};

/** Params each method can be routed with from the part (the Plugins page's shaped ones included). */
function paramsFor(method: string, part: string, tokens: PickTokens): unknown {
  switch (method) {
    case "plugin.settings.get":
    case "plugin.settings.set":
      return { id: part, key: "k", value: "v" };
    case "plugin.install":
      return { source: { from: "folder", path: tokens.issue(part, "/picked/tarot") } };
    case "plugin.dev.add":
      return { path: tokens.issue(part, "/picked/dev") };
    case "plugin.remove":
    case "plugin.update":
    case "plugin.pin":
      return { id: "tarot", pinned: true };
    case "plugin.auth.signIn":
    case "plugin.auth.signOut":
      return { id: "tarot", index: 0 };
    case "plugin.index.remove":
      return { url: "https://plugins.example.com/index.json" };
    case "ui.pick":
      return { kind: "folder" };
    case "ui.secret":
      return { id: "tarot", key: "token" };
    default:
      return {};
  }
}

describe("the door, table by table: who may call each entry, with what gesture, and whose id", () => {
  test("every live entry is in the expectation table, and the table matches the door", () => {
    const live = Object.entries(TREE_CALLS).filter(([, c]) => c.disposition !== "card" && c.disposition !== "unserved").map(([m]) => m).sort();
    expect(live).toEqual(Object.keys(EXPECTED).sort());
  });

  test("every live entry's worst single call is classified: sealed card, main-owned dialog, read or harmless change", () => {
    const live = Object.entries(TREE_CALLS).filter(([, c]) => c.disposition !== "card" && c.disposition !== "unserved").map(([m]) => m);
    for (const m of live) expect([m, WORST[m]]).toEqual([m, expect.stringMatching(/^(sealed card|main-owned dialog|read|harmless change)$/)]);
    expect(Object.keys(WORST).sort()).toEqual([...live].sort());
    // A read needs no gesture and a change from the Plugins page does; a read is never one that changes a thing.
    for (const [m, w] of Object.entries(WORST)) if (w === "read") expect([m, EXPECTED[m]!.gesture]).toEqual([m, []]);
  });

  test("each entry: its parts with the gesture it needs pass; without the gesture, another part, and a non-bundled layer are refused", async () => {
    for (const [method, want] of Object.entries(EXPECTED)) {
      for (const part of PARTS) {
        const allowed = want.parts === "any" || want.parts.includes(part);
        const needs = want.gesture.includes(part);
        for (const gesture of [true, false]) {
          const tokens = new PickTokens();
          const calls: string[] = [];
          const { r } = route({ tree: { windowId: 1, pluginId: part }, method, params: paramsFor(method, part, tokens), gesture, tokens, pick: async () => "/picked/folder", openKey: async () => undefined, request: async (m) => { calls.push(m); return appConnection(m); } });
          const ok = allowed && (gesture || !needs);
          const got = await routeCall(r).then(() => "ok", (e: Error) => e.message);
          expect([method, part, gesture, got]).toEqual([method, part, gesture, ok ? "ok" : expect.any(String)]);
          if (!ok) expect([method, part, calls]).toEqual([method, part, []]);
        }
      }
      // A non-bundled plugin's layer never gets the table: the layer door decides.
      const { r, calls } = route({ tree: undefined, method, params: {}, gesture: true });
      expect(await routeCall(r)).toBe("layer");
      expect(calls).toEqual(["layer"]);
    }
  });

  test("ids: the settings part is held to its own plugin's settings; the Plugins page may name any plugin's", async () => {
    for (const method of ["plugin.settings.get", "plugin.settings.set"]) {
      const own = route({ tree: { windowId: 1, pluginId: "clover/settings" }, method, params: { id: "clover/provider-gcp", key: "project", value: "x" }, gesture: true });
      await expect(routeCall(own.r)).rejects.toThrow("its own plugin's settings only");
      const page = route({ tree: { windowId: 1, pluginId: PLUGINS_PART }, method, params: { id: "clover/provider-gcp", key: "project", value: "x" }, gesture: true });
      expect(await routeCall(page.r)).toBe("app");
    }
  });
});

describe("the Plugins page's calls as main sends them", () => {
  const page = (method: string, params: unknown, extra: Partial<TreeRoute> = {}) => {
    const sent: unknown[] = [];
    const looked: string[] = [];
    const { r, logs } = route({
      tree: { windowId: 1, pluginId: PLUGINS_PART }, method, params, gesture: true,
      request: async (m, p) => {
        if (m === "plugin.get" || m === "plugin.auth.list") { looked.push(m); return appConnection(m); }
        sent.push(p);
        return "app";
      },
      ...extra,
    });
    return { r, sent, logs, looked };
  };

  test("a folder is never a path from the page: only a token from main's picker, once, for this part", async () => {
    const tokens = new PickTokens();
    const raw = page("plugin.install", { source: { from: "folder", path: "/Users/someone/evil" } }, { tokens });
    await expect(routeCall(raw.r)).rejects.toThrow("comes from the folder picker");
    expect(raw.sent).toEqual([]);
    const token = tokens.issue(PLUGINS_PART, "/picked/tarot");
    const ok = page("plugin.install", { source: { from: "folder", path: token } }, { tokens });
    await routeCall(ok.r);
    expect(ok.sent).toEqual([{ source: { from: "folder", path: "/picked/tarot" } }]);
    // Once only.
    const again = page("plugin.install", { source: { from: "folder", path: token } }, { tokens });
    await expect(routeCall(again.r)).rejects.toThrow("comes from the folder picker");
    // Another part's token, an expired one: refused.
    expect(tokens.redeem(tokens.issue("clover/settings", "/x"), PLUGINS_PART, "plugin.install")).toBeUndefined();
    let now = 0;
    const timed = new PickTokens(() => now);
    const t = timed.issue(PLUGINS_PART, "/x");
    now = PICK_TOKEN_MS + 1;
    expect(timed.redeem(t, PLUGINS_PART, "plugin.install")).toBeUndefined();
    // A wrapped folder the same; pasted config text and an npm name pass as written (what the card then shows).
    const wrapped = page("plugin.install", { source: { from: "wrap", kind: "claude-plugin", value: "/Users/someone/evil" } }, { tokens });
    await expect(routeCall(wrapped.r)).rejects.toThrow("comes from the folder picker");
    const pasted = page("plugin.install", { source: { from: "wrap", kind: "mcp-config", value: "{\"mcpServers\":{}}" } }, { tokens });
    await routeCall(pasted.r);
    expect(pasted.sent).toEqual([{ source: { from: "wrap", kind: "mcp-config", value: "{\"mcpServers\":{}}" } }]);
    const npm = page("plugin.install", { source: { from: "npm", name: "clover-tarot", version: "1.0.0" } }, { tokens });
    await routeCall(npm.r);
    expect(npm.sent).toEqual([{ source: { from: "npm", name: "clover-tarot", version: "1.0.0" } }]);
  });

  test("ui.pick: main's dialog, a token and the name back, never the path; cancelled says so", async () => {
    const tokens = new PickTokens();
    const picked = page("ui.pick", { kind: "folder" }, { tokens, pick: async () => "/Users/someone/Plugins/tarot" });
    const got = (await routeCall(picked.r)) as { token: string; name: string };
    expect(got.name).toBe("tarot");
    expect(JSON.stringify(got)).not.toContain("/Users");
    expect(tokens.redeem(got.token, PLUGINS_PART, "plugin.install")).toBe("/Users/someone/Plugins/tarot");
    const cancelled = page("ui.pick", { kind: "folder" }, { tokens, pick: async () => undefined });
    expect(await routeCall(cancelled.r)).toEqual({ cancelled: true });
    const noGesture = route({ tree: { windowId: 1, pluginId: PLUGINS_PART }, method: "ui.pick", params: { kind: "folder" }, gesture: false, tokens, pick: async () => "/x" });
    await expect(routeCall(noGesture.r)).rejects.toThrow("only right after");
  });

  test("a development folder only from a pick token (the core's card stays)", async () => {
    const tokens = new PickTokens();
    const raw = page("plugin.dev.add", { path: "/Users/someone/dev" }, { tokens });
    await expect(routeCall(raw.r)).rejects.toThrow("comes from the folder picker");
    const ok = page("plugin.dev.add", { path: tokens.issue(PLUGINS_PART, "/picked/dev") }, { tokens });
    await routeCall(ok.r);
    expect(ok.sent).toEqual([{ path: "/picked/dev" }]);
  });

  test("a key never passes the page: a secret setting is refused by main (the kind from the registry) and carries noSecret; a sign-in's key too", async () => {
    // A plain setting goes with noSecret (the core refuses a key again, and cards a templated one); the page's own
    // card or noSecret is replaced.
    const plain = page("plugin.settings.set", { id: "tarot", key: "region", value: "us", noSecret: false, card: false });
    await routeCall(plain.r);
    expect(plain.sent).toEqual([{ id: "tarot", key: "region", value: "us", noSecret: true }]);
    expect(plain.looked).toEqual(["plugin.get"]);
    // The key: refused before the core sees a value, whatever the page says the field is.
    for (const value of ["sk-new", null, ""]) {
      const key = page("plugin.settings.set", { id: "tarot", key: "token", value, type: "string" });
      await expect(routeCall(key.r)).rejects.toThrow("only in Clover's own key dialog");
      expect(key.sent).toEqual([]);
    }
    // A sign-in from the page takes no key; a browser sign-in passes as id and index.
    const withKey = page("plugin.auth.signIn", { id: "tarot", index: 0, key: "sk-new" });
    await expect(routeCall(withKey.r)).rejects.toThrow("only in Clover's own key dialog");
    expect(withKey.sent).toEqual([]);
    const browser = page("plugin.auth.signIn", { id: "tarot", index: 1, extra: true });
    await routeCall(browser.r);
    expect(browser.sent).toEqual([{ id: "tarot", index: 1 }]);
  });

  test("ui.secret opens the app's own key dialog for a real key of the plugin's, and nothing else", async () => {
    const opened: KeyTarget[] = [];
    const openKey = async (t: KeyTarget) => { opened.push(t); };
    expect(await routeCall(page("ui.secret", { id: "tarot", key: "token", value: "sk-x" }, { openKey }).r)).toEqual({ opened: true });
    expect(await routeCall(page("ui.secret", { id: "tarot", index: 0 }, { openKey }).r)).toEqual({ opened: true });
    expect(opened).toEqual([{ id: "tarot", key: "token" }, { id: "tarot", index: 0 }]);
    // A plain setting, a browser sign-in, an unknown key, a bad id, both at once: refused, no dialog.
    for (const params of [{ id: "tarot", key: "region" }, { id: "tarot", key: "nope" }, { id: "tarot", index: 1 }, { id: "tarot", index: 5 }, { id: "../x", key: "token" }, { id: "tarot", key: "token", index: 0 }, {}]) {
      await expect(routeCall(page("ui.secret", params, { openKey }).r)).rejects.toThrow();
    }
    expect(opened.length).toBe(2);
    // No gesture, no dialog; another part, no dialog.
    const none = route({ tree: { windowId: 1, pluginId: PLUGINS_PART }, method: "ui.secret", params: { id: "tarot", key: "token" }, gesture: false, openKey, request: async (m) => appConnection(m) });
    await expect(routeCall(none.r)).rejects.toThrow("only right after");
    const other = route({ tree: { windowId: 1, pluginId: "clover/settings" }, method: "ui.secret", params: { id: "tarot", key: "token" }, gesture: true, openKey, request: async (m) => appConnection(m) });
    await expect(routeCall(other.r)).rejects.toThrow("only from");
    expect(opened.length).toBe(2);
  });

  test("a removal, a sign-out, an index's removal and an update always go with card; listing is a read", async () => {
    const removal = page("plugin.remove", { id: "tarot", card: false, extra: 1 });
    await routeCall(removal.r);
    expect(removal.sent).toEqual([{ id: "tarot", card: true }]);
    const all = page("plugin.update", {});
    await expect(routeCall(all.r)).rejects.toThrow("one plugin at a time");
    const one = page("plugin.update", { id: "tarot", card: false });
    await routeCall(one.r);
    expect(one.sent).toEqual([{ id: "tarot", card: true }]);
    const signOut = page("plugin.auth.signOut", { id: "tarot", index: 0 });
    await routeCall(signOut.r);
    expect(signOut.sent).toEqual([{ id: "tarot", index: 0, card: true }]);
    const index = page("plugin.index.remove", { url: "https://plugins.example.com/index.json" });
    await routeCall(index.r);
    expect(index.sent).toEqual([{ url: "https://plugins.example.com/index.json", card: true }]);
    const listing = route({ tree: { windowId: 1, pluginId: PLUGINS_PART }, method: "plugin.update", params: { list: true }, gesture: false });
    expect(await routeCall(listing.r)).toBe("app");
  });

  test("a forwarded call never names its caller: client, caller, role, origin and by are dropped (the connection is main's app one)", async () => {
    const tokens = new PickTokens();
    const forged = { client: "cli", caller: "cli", role: "cli", origin: "user-terminal", by: "user-terminal" };
    const cases: [string, Record<string, unknown>][] = [
      ["plugin.dev.add", { path: tokens.issue(PLUGINS_PART, "/picked/dev"), ...forged }],
      ["plugin.install", { source: { from: "npm", name: "clover-tarot" }, ...forged }],
      ["plugin.remove", { id: "tarot", ...forged }],
      ["plugin.update", { id: "tarot", ...forged }],
      ["plugin.pin", { id: "tarot", pinned: true, ...forged }],
      ["plugin.restart", { id: "tarot", ...forged }],
      ["plugin.index.add", { url: "https://plugins.example.com/index.json", keys: ["k"], ...forged }],
      ["plugin.index.remove", { url: "https://plugins.example.com/index.json", ...forged }],
      ["plugin.auth.signIn", { id: "tarot", index: 1, ...forged }],
      ["plugin.auth.signOut", { id: "tarot", index: 0, ...forged }],
      ["plugin.dev.remove", { path: "/picked/dev", ...forged }],
      ["plugin.dev.renew", { path: "/picked/dev", ...forged }],
      ["plugin.settings.set", { id: "tarot", key: "region", value: "us", ...forged }],
      ["plugin.setEnabled", { id: "tarot", enabled: true, ...forged }],
    ];
    for (const [method, params] of cases) {
      const c = page(method, params, { tokens });
      await routeCall(c.r);
      expect([method, c.sent.length]).toEqual([method, 1]);
      for (const k of Object.keys(forged)) expect([method, k, Object.hasOwn(c.sent[0] as object, k)]).toEqual([method, k, false]);
      expect(JSON.stringify(c.sent[0])).not.toContain("cli");
    }
    // The settings part's own calls the same.
    const sent: unknown[] = [];
    const own = route({ tree: { windowId: 1, pluginId: "clover/settings" }, method: "plugin.settings.set", params: { id: "clover/settings", key: "k", value: 1, client: "cli", caller: "cli" }, request: async (_m, p) => { sent.push(p); return "app"; } });
    await routeCall(own.r);
    expect(sent).toEqual([{ id: "clover/settings", key: "k", value: 1 }]);
  });
});
