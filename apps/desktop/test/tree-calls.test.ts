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

import { PICK_TOKEN_MS, PickTokens, PLUGINS_PART, routeCall, type TreeRoute } from "../src/main/ui/tree-calls";

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
  ...Object.fromEntries(["ui.pick", "plugin.install", "plugin.remove", "plugin.update", "plugin.pin", "plugin.restart", "plugin.index.add", "plugin.index.remove", "plugin.auth.signIn", "plugin.auth.signOut", "plugin.dev.add", "plugin.dev.remove", "plugin.dev.renew"].map((m) => [m, { parts: [PLUGINS_PART], gesture: [PLUGINS_PART] }])),
};
const PARTS = ["clover/settings", PLUGINS_PART, "clover/bot-editor", "clover/composer", "clover/conversation", "clover/sidebar"];

/** Params each method can be routed with from the part (the Plugins page's shaped ones included). */
function paramsFor(method: string, part: string, tokens: PickTokens): unknown {
  switch (method) {
    case "plugin.settings.get":
    case "plugin.settings.set":
      return { id: part, key: "k", value: "v" };
    case "plugin.install":
      return { source: { from: "folder", path: tokens.issue(part, "/picked/tarot") } };
    case "plugin.remove":
    case "plugin.update":
    case "plugin.pin":
      return { id: "tarot", pinned: true };
    case "ui.pick":
      return { kind: "folder" };
    default:
      return {};
  }
}

describe("the door, table by table: who may call each entry, with what gesture, and whose id", () => {
  test("every live entry is in the expectation table, and the table matches the door", () => {
    const live = Object.entries(TREE_CALLS).filter(([, c]) => c.disposition !== "card" && c.disposition !== "unserved").map(([m]) => m).sort();
    expect(live).toEqual(Object.keys(EXPECTED).sort());
  });

  test("each entry: its parts with the gesture it needs pass; without the gesture, another part, and a non-bundled layer are refused", async () => {
    for (const [method, want] of Object.entries(EXPECTED)) {
      for (const part of PARTS) {
        const allowed = want.parts === "any" || want.parts.includes(part);
        const needs = want.gesture.includes(part);
        for (const gesture of [true, false]) {
          const tokens = new PickTokens();
          const { r, calls } = route({ tree: { windowId: 1, pluginId: part }, method, params: paramsFor(method, part, tokens), gesture, tokens, pick: async () => "/picked/folder" });
          const ok = allowed && (gesture || !needs);
          const got = await routeCall(r).then(() => "ok", (e: Error) => e.message);
          expect([method, part, gesture, got === "ok"]).toEqual([method, part, gesture, ok]);
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
    const { r, logs } = route({ tree: { windowId: 1, pluginId: PLUGINS_PART }, method, params, gesture: true, request: async (_m, p) => { sent.push(p); return "app"; }, ...extra });
    return { r, sent, logs };
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

  test("a removal always asks on a sealed card; an update is applied by id only, and listing is a read", async () => {
    const removal = page("plugin.remove", { id: "tarot", card: false, extra: 1 });
    await routeCall(removal.r);
    expect(removal.sent).toEqual([{ id: "tarot", card: true }]);
    const all = page("plugin.update", {});
    await expect(routeCall(all.r)).rejects.toThrow("one plugin at a time");
    const one = page("plugin.update", { id: "tarot" });
    await routeCall(one.r);
    expect(one.sent).toEqual([{ id: "tarot" }]);
    const listing = route({ tree: { windowId: 1, pluginId: PLUGINS_PART }, method: "plugin.update", params: { list: true }, gesture: false });
    expect(await routeCall(listing.r)).toBe("app");
  });
});
