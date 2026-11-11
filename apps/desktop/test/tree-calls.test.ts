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

import { failedTurn, type LogEvent } from "../src/main/ui/resend";
import { BOT_EDITOR_PART, CONVERSATION_PART, PART_LOG_LINES_MAX, PICK_TOKEN_MS, PickTokens, PLUGINS_PART, routeCall, type KeyTarget, type TreeRoute } from "../src/main/ui/tree-calls";

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
    const { r, calls } = route({ tree: { windowId: 1, pluginId: "clover/settings" }, method: "ui.set", params: { patch: { appearance: "dark" } }, gesture: true });
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

describe("the Settings page's ui.set", () => {
  const settings = { windowId: 1, pluginId: "clover/settings" };
  const sent = async (params: unknown, gesture = true) => {
    const got: unknown[] = [];
    const { r } = route({ tree: settings, method: "ui.set", params, gesture, request: async (_m, p) => { got.push(p); return "app"; } });
    return { run: routeCall(r), got };
  };
  test("only the user's own click or key press, one call per gesture", async () => {
    let taken = 0;
    const { r } = route({ tree: settings, method: "ui.set", params: { patch: { appearance: "dark" } }, takeGesture: () => taken++ === 0 });
    expect(await routeCall(r)).toBe("app");
    await expect(routeCall(r)).rejects.toThrow("only right after the user's own");
    const none = await sent({ patch: { appearance: "dark" } }, false);
    await expect(none.run).rejects.toThrow("only right after the user's own");
    expect(none.got).toEqual([]);
  });
  test("the keys its controls write pass with their values checked", async () => {
    for (const patch of [{ appearance: "light" }, { appearance: "system" }, { globalTheme: "midnight#night" }, { globalTheme: "clover/base-theme#base" }, { language: "pt-BR" }, { language: "de" }]) {
      const c = await sent({ patch });
      await c.run;
      expect(c.got).toEqual([{ patch }]);
    }
  });
  test("a key no Settings control writes is dropped, and a call with nothing left is refused", async () => {
    const c = await sent({ patch: { appearance: "dark", overrides: { css: "@import url(//x)" }, picks: [], lists: [], textSize: "large", packs: {}, baseTheme: "x#y" }, other: 1 });
    await c.run;
    expect(c.got).toEqual([{ patch: { appearance: "dark" } }]);
    const none = await sent({ patch: { overrides: { css: "a{}" } } });
    await expect(none.run).rejects.toThrow("nothing here is a choice");
    expect(none.got).toEqual([]);
  });
  test("a bad value is refused whole", async () => {
    for (const patch of [{ appearance: "Dark" }, { appearance: 1 }, { globalTheme: "no-hash" }, { globalTheme: "../x#y" }, { language: "en_US" }, { language: "x".repeat(40) }, { language: { a: 1 } }]) {
      const c = await sent({ patch: { language: "de", ...patch } });
      await expect(c.run).rejects.toThrow("isn't a value");
      expect(c.got).toEqual([]);
    }
    for (const bad of [undefined, null, [], { patch: null }, { patch: [] }, { patch: "x" }]) {
      const c = await sent(bad);
      await expect(c.run).rejects.toThrow("what should change");
    }
  });
});

// ---- the Plugins page (class 3, the controller's ruling of 2026-11-11) ----

/** What each table entry allows: the parts that may call it, whether it needs the user's gesture (per part), and
 *  whether the id is held to the calling part's own. */
const EXPECTED: Record<string, { parts: string[] | "any"; gesture: string[]; ownId?: string[] }> = {
  "ui.settings": { parts: "any", gesture: [] },
  "ui.set": { parts: ["clover/settings"], gesture: ["clover/settings"] },
  "plugin.settings.get": { parts: ["clover/settings", PLUGINS_PART], gesture: [], ownId: ["clover/settings"] },
  "plugin.settings.set": { parts: ["clover/settings", PLUGINS_PART], gesture: [PLUGINS_PART], ownId: ["clover/settings"] },
  "bot.setUserLayer": { parts: ["clover/bot-editor"], gesture: ["clover/bot-editor"] },
  "bot.importAvatar": { parts: [BOT_EDITOR_PART], gesture: [BOT_EDITOR_PART] },
  "session.resend": { parts: [CONVERSATION_PART], gesture: [CONVERSATION_PART] },
  "ui.pick": { parts: [PLUGINS_PART, BOT_EDITOR_PART], gesture: [PLUGINS_PART, BOT_EDITOR_PART] },
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
  "notify.mutes": { parts: [PLUGINS_PART], gesture: [] },
  ...Object.fromEntries(["ui.secret", "plugin.install", "plugin.remove", "plugin.update", "plugin.pin", "plugin.restart", "plugin.index.add", "plugin.index.remove", "plugin.auth.signIn", "plugin.auth.signOut", "plugin.dev.add", "plugin.dev.remove", "plugin.dev.renew", "notify.setMuted"].map((m) => [m, { parts: [PLUGINS_PART], gesture: [PLUGINS_PART] }])),
};
const PARTS = ["clover/settings", PLUGINS_PART, "clover/bot-editor", "clover/composer", "clover/conversation", "clover/sidebar"];

/** A bot's conversation whose last turn failed: the user's words, the turn, an assistant line, the failure. */
const FAILED: LogEvent[] = [
  { type: "user_message", seq: 4, text: "  Please keep my spacing, and the \u00e9!  " },
  { type: "turn_started", seq: 5 },
  { type: "assistant_message", seq: 6, text: "partial" },
  { type: "turn_completed", seq: 7, stopReason: "error" },
];

/** The app's connection as the door's own look-ups see it: a plugin with one plain setting (`k`, `region`) and one key
 *  (`token`), and one `api-key` sign-in (index 0) and one browser sign-in (index 1). */
async function appConnection(method: string): Promise<unknown> {
  if (method === "plugin.get") return { plugin: { id: "tarot", manifest: { settings: { k: { type: "string" }, region: { type: "string" }, token: { type: "secret" } } } } };
  if (method === "bot.list") return { bots: [{ id: "alpha", mainSession: "b_alpha" }, { id: "tarot-panel", mainSession: "b_tarot" }] };
  if (method === "session.get") return { session: { id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" } };
  if (method === "computer.list") return { computers: [{ name: "Studio", aliases: ["Mac"], link: "self" }, { name: "Laptop", aliases: [], link: "lan" }] };
  if (method === "session.history") return { events: FAILED, hasMore: false };
  if (method === "pill.send") return { seq: 9 };
  if (method === "bot.importAvatar") return { format: "live2d", files: 3, bytes: 99 };
  if (method === "plugin.auth.list") return { auth: [{ index: 0, method: "api-key", state: "signed-out" }, { index: 1, method: "oauth-pkce", state: "signed-out" }] };
  return "app";
}

/** Each live entry's WORST single call from a part, classified (the reviewer's table): a sealed card the core raises, a
 *  dialog main owns, a read, or a harmless change. The test below fails on an entry with none. */
type Worst = "sealed card" | "main-owned dialog" | "read" | "harmless change" | "starts a model turn";
const WORST: Record<string, Worst> = {
  "ui.settings": "read", // the app's settings as the parts show them
  "ui.set": "harmless change", // appearance and notification choices, the settings part's own, nothing that runs code
  "plugin.settings.get": "read", // a key's value never: only whether one is set
  "plugin.settings.set": "sealed card", // a setting a host, env, args, hook or backend takes from cards; a key is refused (noSecret, and main looks the kind up); the rest are plain
  "bot.importAvatar": "harmless change", // behind an app-owned dialog: a model the user picked in main's dialog, copied into their avatars for an existing bot and made its avatar; only a token of that use, nothing runs
  "session.resend": "starts a model turn", // the composer's own send (`pill.send`): the user's own message that began the latest failed turn, again, to a conversation the part shows; a model runs on it
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
  "plugin.setEnabled": "sealed card", // turning a revoked plugin back on is the override's warning card; turning an OK'd plugin back on (or off) is a gesture (accepted)
  "plugin.logs": "read", // its own file only, key-looking runs cut to "…"
  "plugin.auth.list": "read",
  "plugin.dev.list": "read",
  "notify.mutes": "read", // which plugins' notifications are muted
  "notify.setMuted": "harmless change", // mutes or unmutes one plugin's notifications to the user; nothing it may do moves
  "ui.pick": "main-owned dialog", // main's own open dialog; the page gets a one-use token and a name
  "ui.secret": "main-owned dialog", // the app's own key dialog; the key never passes the page
  "plugin.install": "sealed card", // every install raises the core's OK card before anything runs
  "plugin.remove": "sealed card", // main sets card: the removal card
  "plugin.update": "sealed card", // main sets card: a non-official update asks (the yes applies that tree only); a new trigger shows its OK card instead; the official index's applies as its automatic check would
  "plugin.pin": "harmless change", // at worst holds a plugin's fixes back on this computer (revocations still apply); unpinning only returns it to the normal update flow
  "plugin.restart": "harmless change", // restarts the plugin's own processes on the code already OK'd
  "plugin.index.add": "sealed card", // the core's warning card with the key's fingerprint
  "plugin.index.remove": "sealed card", // main sets card: asks when installs came from it; blocks it held stay
  "plugin.auth.signIn": "main-owned dialog", // a key only in the app's key dialog; a browser sign-in opens the provider's page
  "plugin.auth.signOut": "sealed card", // main sets card: the sign-out card
  "plugin.dev.add": "sealed card", // a picked folder only, and the core's development-folder card
  "plugin.dev.remove": "harmless change", // stops loading a development folder
  "plugin.dev.renew": "sealed card", // main sets card: another 24 hours of code that reloads asks on the development-folder card
};

/** Params each method can be routed with from the part (the Plugins page's shaped ones included). */
function paramsFor(method: string, part: string, tokens: PickTokens): unknown {
  switch (method) {
    case "ui.set":
      return { patch: { appearance: "dark" } };
    case "plugin.settings.get":
    case "plugin.settings.set":
      return { id: part, key: "k", value: "v" };
    case "plugin.install":
      return { source: { from: "folder", path: tokens.issue(part, "/picked/tarot", "plugin.install") } };
    case "plugin.dev.add":
      return { path: tokens.issue(part, "/picked/dev", "plugin.dev.add") };
    case "plugin.remove":
    case "plugin.update":
    case "plugin.pin":
      return { id: "tarot", pinned: true };
    case "plugin.auth.signIn":
    case "plugin.auth.signOut":
      return { id: "tarot", index: 0 };
    case "plugin.index.remove":
      return { url: "https://plugins.example.com/index.json" };
    case "plugin.dev.renew":
    case "plugin.dev.remove":
      return { path: "/picked/dev" };
    case "notify.setMuted":
      return { pluginId: "tarot", muted: true };
    case "ui.pick":
      return { kind: "folder", use: part === BOT_EDITOR_PART ? "bot.importAvatar" : "plugin.install" };
    case "bot.importAvatar":
      return { id: "alpha", path: tokens.issue(part, "/picked/avatar", "bot.importAvatar") };
    case "ui.secret":
      return { id: "tarot", key: "token" };
    case "session.resend":
      return { session: "b_alpha" };
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
    for (const m of live) expect([m, WORST[m]]).toEqual([m, expect.stringMatching(/^(sealed card|main-owned dialog|read|harmless change|starts a model turn)$/)]);
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
          const { r } = route({ tree: { windowId: 1, pluginId: part }, method, params: paramsFor(method, part, tokens), gesture, tokens, pick: async () => "/picked/folder", openKey: async () => true, request: async (m) => { calls.push(m); return appConnection(m); } });
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
      const page = route({
        tree: { windowId: 1, pluginId: PLUGINS_PART }, method, params: { id: "clover/provider-gcp", key: "project", value: "x" }, gesture: true,
        request: async (m) => (m === "plugin.get" ? { plugin: { id: "clover/provider-gcp", manifest: { settings: { project: { type: "string" } } } } } : "app"),
      });
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
    const token = tokens.issue(PLUGINS_PART, "/picked/tarot", "plugin.install");
    const ok = page("plugin.install", { source: { from: "folder", path: token } }, { tokens });
    await routeCall(ok.r);
    expect(ok.sent).toEqual([{ source: { from: "folder", path: "/picked/tarot" } }]);
    // Once only.
    const again = page("plugin.install", { source: { from: "folder", path: token } }, { tokens });
    await expect(routeCall(again.r)).rejects.toThrow("comes from the folder picker");
    // Another part's token, an expired one: refused.
    expect(tokens.redeem(tokens.issue("clover/settings", "/x", "plugin.install"), PLUGINS_PART, "plugin.install")).toBeUndefined();
    let now = 0;
    const timed = new PickTokens(() => now);
    const t = timed.issue(PLUGINS_PART, "/x", "plugin.install");
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
    const picked = page("ui.pick", { kind: "folder", use: "plugin.install" }, { tokens, pick: async () => "/Users/someone/Plugins/tarot" });
    const got = (await routeCall(picked.r)) as { token: string; name: string };
    expect(got.name).toBe("tarot");
    expect(JSON.stringify(got)).not.toContain("/Users");
    expect(tokens.redeem(got.token, PLUGINS_PART, "plugin.install")).toBe("/Users/someone/Plugins/tarot");
    const cancelled = page("ui.pick", { kind: "folder", use: "plugin.install" }, { tokens, pick: async () => undefined });
    expect(await routeCall(cancelled.r)).toEqual({ cancelled: true });
    const noGesture = route({ tree: { windowId: 1, pluginId: PLUGINS_PART }, method: "ui.pick", params: { kind: "folder", use: "plugin.install" }, gesture: false, tokens, pick: async () => "/x" });
    await expect(routeCall(noGesture.r)).rejects.toThrow("only right after");
  });

  test("a development folder only from a pick token (the core's card stays)", async () => {
    const tokens = new PickTokens();
    const raw = page("plugin.dev.add", { path: "/Users/someone/dev" }, { tokens });
    await expect(routeCall(raw.r)).rejects.toThrow("comes from the folder picker");
    const ok = page("plugin.dev.add", { path: tokens.issue(PLUGINS_PART, "/picked/dev", "plugin.dev.add") }, { tokens });
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

  test("a setting from the page is id, key and value only, and the value fits the field's kind (main reads the kind; the page's word for it is ignored)", async () => {
    const fields: Record<string, Record<string, unknown>> = {
      region: { type: "string" }, size: { type: "number", min: 1, max: 9 }, on: { type: "boolean" },
      order: { type: "enum", options: ["newest", { value: "oldest", title: "Oldest" }] }, tint: { type: "color" }, mood: { type: "string", scope: "bot" },
    };
    const set = (params: Record<string, unknown>) => page("plugin.settings.set", { id: "tarot", ...params }, {
      request: async (m, p) => (m === "plugin.get" ? { plugin: { id: "tarot", manifest: { settings: fields } } } : (sent.push(p), "app")),
    });
    const sent: unknown[] = [];
    // Fits: each kind, and null (back to its default). Extra keys (a bot, a card, the page's own `type`) are dropped.
    for (const [key, value] of [["region", "us"], ["size", 9], ["on", false], ["order", "oldest"], ["tint", "#A1B2C3"], ["region", null]] as const) {
      await routeCall(set({ key, value, bot: "alpha", card: false, type: "secret", noSecret: false }).r);
    }
    expect(sent).toEqual([
      { id: "tarot", key: "region", value: "us", noSecret: true }, { id: "tarot", key: "size", value: 9, noSecret: true },
      { id: "tarot", key: "on", value: false, noSecret: true }, { id: "tarot", key: "order", value: "oldest", noSecret: true },
      { id: "tarot", key: "tint", value: "#A1B2C3", noSecret: true }, { id: "tarot", key: "region", value: null, noSecret: true },
    ]);
    sent.length = 0;
    // Doesn't fit: refused by main, nothing reaches the core.
    const bad: [string, unknown, string][] = [
      ["region", 3, "takes text"], ["region", "x".repeat(8193), "takes text"], ["size", "5", "takes a number"], ["size", 0, "at least 1"], ["size", 10, "at most 9"],
      ["size", Number.NaN, "takes a number"], ["on", "true", "on or off"], ["order", "sideways", "one of its choices"], ["tint", "red", "a color"],
      ["mood", "calm", "one value per bot"], ["nope", "x", "isn't one of that plugin's settings"], ["__proto__", "x", "isn't one of that plugin's settings"],
    ];
    for (const [key, value, why] of bad) await expect(routeCall(set({ key, value }).r)).rejects.toThrow(why);
    await expect(routeCall(set({ key: "region" }).r)).rejects.toThrow("set it to what?");
    await expect(routeCall(set({ value: "x" }).r)).rejects.toThrow("which setting?");
    expect(sent).toEqual([]);
  });

  test("ui.secret opens the app's own key dialog for a real key of the plugin's, and nothing else", async () => {
    const opened: KeyTarget[] = [];
    const openKey = async (t: KeyTarget) => { opened.push(t); return true; };
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
    // While a key dialog is open, another is refused: the user closes it first.
    const busy = page("ui.secret", { id: "tarot", key: "token" }, { openKey: async () => false });
    await expect(routeCall(busy.r)).rejects.toThrow("key dialog is open already");
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

  test("notify.setMuted: a top-level plugin, a bundled bot's like any (alpha), never Clover's own tree or a part of it; a boolean; nothing else", async () => {
    const ok = page("notify.setMuted", { pluginId: "tarot-panel", muted: true, extra: 1, client: "cli" });
    await routeCall(ok.r);
    expect(ok.sent).toEqual([{ pluginId: "tarot-panel", muted: true }]);
    const alpha = page("notify.setMuted", { pluginId: "alpha", muted: true });
    await routeCall(alpha.r);
    expect(alpha.sent).toEqual([{ pluginId: "alpha", muted: true }]);
    for (const params of [{ pluginId: "clover", muted: true }, { pluginId: "clover/shell", muted: true }, { pluginId: "tarot-panel/part", muted: true }, { pluginId: "tarot-panel", muted: "yes" }, { muted: true }, { pluginId: "../x", muted: false }, { pluginId: "1tarot", muted: true }, { pluginId: "tarot--x", muted: true }, { pluginId: "x".repeat(41), muted: true }]) {
      const r = page("notify.setMuted", params);
      await expect(routeCall(r.r)).rejects.toThrow();
      expect(r.sent).toEqual([]);
    }
  });

  test("a forwarded call never names its caller: client, caller, role, origin and by are dropped (the connection is main's app one)", async () => {
    const tokens = new PickTokens();
    const forged = { client: "cli", caller: "cli", role: "cli", origin: "user-terminal", by: "user-terminal" };
    const cases: [string, Record<string, unknown>][] = [
      ["plugin.dev.add", { path: tokens.issue(PLUGINS_PART, "/picked/dev", "plugin.dev.add"), ...forged }],
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
    const own = route({ tree: { windowId: 1, pluginId: "clover/settings" }, method: "plugin.settings.set", params: { id: "clover/settings", key: "k", value: 1, ...forged }, request: async (_m, p) => { sent.push(p); return "app"; } });
    await routeCall(own.r);
    expect(sent).toEqual([{ id: "clover/settings", key: "k", value: 1 }]);
  });

  test("a development folder's renewal from the page asks on a card; a log read is capped at PART_LOG_LINES_MAX lines", async () => {
    const renew = page("plugin.dev.renew", { path: "/picked/dev", card: false });
    await routeCall(renew.r);
    expect(renew.sent).toEqual([{ path: "/picked/dev", card: true }]);
    for (const [lines, want] of [[1_000_000, PART_LOG_LINES_MAX], [50, 50], [-3, 1], ["x", 200]] as const) {
      for (const part of [PLUGINS_PART, "clover/settings"]) {
        const sent: unknown[] = [];
        const logs = route({ tree: { windowId: 1, pluginId: part }, method: "plugin.logs", params: { id: "tarot", lines }, request: async (_m, p) => { sent.push(p); return "app"; } });
        await routeCall(logs.r);
        expect([part, lines, sent]).toEqual([part, lines, [{ id: "tarot", lines: want }]]);
      }
    }
  });
});

describe("the bot editor's avatar: a pick of main's, then one import of exactly that pick", () => {
  const editor = (method: string, params: unknown, extra: Partial<TreeRoute> = {}) => {
    const sent: { method: string; params: unknown }[] = [];
    const { r, logs } = route({
      tree: { windowId: 1, pluginId: BOT_EDITOR_PART }, method, params, gesture: true,
      request: async (m, p) => {
        if (m === "bot.list") return appConnection(m);
        sent.push({ method: m, params: p });
        return appConnection(m);
      },
      ...extra,
    });
    return { r, sent, logs };
  };
  const pickFor = async (tokens: PickTokens, params: unknown, path = "/Users/someone/Models/Mochi‮.zip") => {
    const got = (await routeCall(editor("ui.pick", params, { tokens, pick: async () => path }).r)) as { token: string; name: string };
    return got;
  };

  test("the pick is for one use: the page names it, main issues the token for it alone and sets the dialog's filter, and the page gets a neutralised name", async () => {
    const tokens = new PickTokens();
    const seen: { kind: string; filters?: unknown }[] = [];
    const got = (await routeCall(editor("ui.pick", { kind: "file", use: "bot.importAvatar", filters: [{ name: "Anything", extensions: ["exe"] }] }, { tokens, pick: async (_w, kind, filters) => { seen.push({ kind, filters }); return "/Users/someone/Models/Mochi‮.zip"; } }).r)) as { token: string; name: string };
    expect(seen).toEqual([{ kind: "file", filters: [{ name: "Avatar", extensions: ["zip", "vrm", "glb"] }] }]);
    expect(got.name).toBe("Mochi.zip");
    expect(JSON.stringify(got)).not.toContain("/Users");
    // Only bot.importAvatar redeems it, never an install or a development folder.
    expect(tokens.redeem(got.token, BOT_EDITOR_PART, "plugin.install")).toBeUndefined();
    const again = await pickFor(tokens, { kind: "folder", use: "bot.importAvatar" });
    expect(tokens.redeem(again.token, BOT_EDITOR_PART, "plugin.dev.add")).toBeUndefined();
    // And the reverse: a Plugins page token is no avatar's.
    const install = tokens.issue(PLUGINS_PART, "/picked/tarot", "plugin.install");
    expect(tokens.redeem(install, PLUGINS_PART, "bot.importAvatar")).toBeUndefined();
    // Each part asks only for its own uses; no use, or another's, is refused before any dialog.
    for (const [part, use] of [[BOT_EDITOR_PART, "plugin.install"], [BOT_EDITOR_PART, "plugin.dev.add"], [BOT_EDITOR_PART, undefined], [PLUGINS_PART, "bot.importAvatar"], [PLUGINS_PART, undefined]] as const) {
      let opened = 0;
      const { r } = route({ tree: { windowId: 1, pluginId: part }, method: "ui.pick", params: { kind: "folder", use }, gesture: true, tokens, pick: async () => { opened++; return "/x"; } });
      await expect(routeCall(r)).rejects.toThrow("and says which");
      expect(opened).toBe(0);
    }
  });

  test("a valid token imports once: only {id, path} goes to the core, with the real path; the page gets format, files and bytes", async () => {
    const tokens = new PickTokens();
    const { token } = await pickFor(tokens, { kind: "file", use: "bot.importAvatar" });
    const ok = editor("bot.importAvatar", { id: "alpha", path: token, client: "cli", role: "cli", extra: 1 }, { tokens });
    expect(await routeCall(ok.r)).toEqual({ format: "live2d", files: 3, bytes: 99 });
    expect(ok.sent).toEqual([{ method: "bot.importAvatar", params: { id: "alpha", path: "/Users/someone/Models/Mochi‮.zip" } }]);
    // Replay.
    const replay = editor("bot.importAvatar", { id: "alpha", path: token }, { tokens });
    await expect(routeCall(replay.r)).rejects.toThrow("comes from the file picker");
    expect(replay.sent).toEqual([]);
  });

  test("refused: a page-supplied real path, another use's token, another part's token, an expired one, an unknown bot id", async () => {
    const tokens = new PickTokens();
    for (const path of ["/Users/someone/Models/Mochi.zip", "pick-guess", "", 5, undefined]) {
      const r = editor("bot.importAvatar", { id: "alpha", path }, { tokens });
      await expect(routeCall(r.r)).rejects.toThrow("comes from the file picker");
      expect(r.sent).toEqual([]);
    }
    for (const [part, use] of [[BOT_EDITOR_PART, "plugin.install"], [BOT_EDITOR_PART, "plugin.dev.add"], [PLUGINS_PART, "bot.importAvatar"], ["clover/settings", "bot.importAvatar"]] as const) {
      const r = editor("bot.importAvatar", { id: "alpha", path: tokens.issue(part, "/picked/x", use as never) }, { tokens });
      await expect(routeCall(r.r)).rejects.toThrow("comes from the file picker");
      expect(r.sent).toEqual([]);
    }
    let now = 0;
    const timed = new PickTokens(() => now);
    const late = timed.issue(BOT_EDITOR_PART, "/picked/x", "bot.importAvatar");
    now = PICK_TOKEN_MS + 1;
    const expired = editor("bot.importAvatar", { id: "alpha", path: late }, { tokens: timed });
    await expect(routeCall(expired.r)).rejects.toThrow("comes from the file picker");
    // An id main's own listing doesn't hold (a free string, a plugin that isn't a bot, a path): refused, the token kept.
    const held = tokens.issue(BOT_EDITOR_PART, "/picked/x", "bot.importAvatar");
    for (const id of ["nobody", "clover/composer", "../alpha", "", 7, undefined]) {
      const r = editor("bot.importAvatar", { id, path: held }, { tokens });
      await expect(routeCall(r.r)).rejects.toThrow("which bot?");
      expect(r.sent).toEqual([]);
    }
    const still = editor("bot.importAvatar", { id: "tarot-panel", path: held }, { tokens });
    await routeCall(still.r);
    expect(still.sent.length).toBe(1);
    // Another part, no click: the table refuses before anything else.
    const other = route({ tree: { windowId: 1, pluginId: PLUGINS_PART }, method: "bot.importAvatar", params: { id: "alpha", path: held }, gesture: true, tokens });
    await expect(routeCall(other.r)).rejects.toThrow("only from");
    const none = editor("bot.importAvatar", { id: "alpha", path: held }, { tokens, takeGesture: () => false });
    await expect(routeCall(none.r)).rejects.toThrow("only right after");
  });

  test("a refusal from the core shows its plain reason with no path in it, capped", async () => {
    const tokens = new PickTokens();
    const { token } = await pickFor(tokens, { kind: "folder", use: "bot.importAvatar" }, "/Users/someone/Models/Mochi");
    const bad = editor("bot.importAvatar", { id: "alpha", path: token }, {
      tokens,
      request: async (m) => {
        if (m === "bot.list") return appConnection(m);
        throw new Error(`nothing at /Users/someone/Models/Mochi, and /private/tmp/x/y is no model ${"x".repeat(400)}`);
      },
    });
    const err = await routeCall(bad.r).then(() => undefined, (e: Error) => e);
    expect(err?.message).not.toContain("/Users");
    expect(err?.message).not.toContain("/private");
    expect(err?.message).toContain("nothing at Mochi");
    expect([...(err?.message ?? "")].length).toBeLessThanOrEqual(300);
  });

  test("the model's own note comes back as plain text, 300 characters at most; none, none", async () => {
    const tokens = new PickTokens();
    const { token } = await pickFor(tokens, { kind: "file", use: "bot.importAvatar" });
    const noted = editor("bot.importAvatar", { id: "alpha", path: token }, {
      tokens,
      request: async (m) => (m === "bot.list" ? appConnection(m) : { format: "vrm", files: 1, bytes: 5, credit: `Free \u202efor personal use\n${"z".repeat(400)}` }),
    });
    const got = (await routeCall(noted.r)) as { credit?: string; format: string };
    expect(got.format).toBe("vrm");
    expect(got.credit?.startsWith("Free for personal use zz")).toBe(true);
    expect([...got.credit!].length).toBe(300);
    expect(got.credit).not.toContain("\u202e");
    const second = await pickFor(tokens, { kind: "file", use: "bot.importAvatar" });
    expect(await routeCall(editor("bot.importAvatar", { id: "alpha", path: second.token }, { tokens }).r)).toEqual({ format: "live2d", files: 3, bytes: 99 });
  });
});

describe("Try again on the conversation: main reads the log and sends the user's own words again", () => {
  const ev = (type: string, seq: number, more: Record<string, unknown> = {}): LogEvent => ({ type, seq, ...more });
  const turn = (seq: number, text = "hello there", stop = "error", more: Record<string, unknown> = {}): LogEvent[] => [ev("user_message", seq, { text, ...more }), ev("turn_started", seq + 1), ev("turn_completed", seq + 2, { stopReason: stop })];

  /** `log`: what `session.history` answers, as a list of reads (the last repeats). */
  function resendFrom(log: LogEvent[] | LogEvent[][], over: { params?: unknown; session?: Record<string, unknown>; computers?: unknown; bots?: unknown; part?: string; gesture?: boolean; send?: (p: unknown) => unknown; hasMore?: boolean } = {}) {
    const reads = Array.isArray(log[0]) || log.length === 0 ? (log as LogEvent[][]) : [log as LogEvent[]];
    let n = 0;
    const sent: { method: string; params: unknown }[] = [];
    const { r, logs } = route({
      tree: { windowId: 1, pluginId: over.part ?? CONVERSATION_PART }, method: "session.resend", params: "params" in over ? over.params : { session: "b_alpha" }, gesture: over.gesture ?? true,
      request: async (m, p) => {
        sent.push({ method: m, params: p });
        if (m === "session.history") return { events: reads[Math.min(n++, reads.length - 1)] ?? [], hasMore: over.hasMore ?? false };
        if (m === "session.get") return { session: { id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio", ...over.session } };
        if (m === "computer.list") return over.computers ?? { computers: [{ name: "Studio", aliases: ["Mac"], link: "self" }] };
        if (m === "bot.list") return over.bots ?? { bots: [{ id: "alpha", mainSession: "b_alpha" }] };
        if (m === "pill.send") return over.send ? over.send(p) : { seq: 99 };
        throw new Error(`unexpected ${m}`);
      },
    });
    return { r, sent, logs, sends: () => sent.filter((c) => c.method === "pill.send") };
  }

  test("a failed turn that began from the user's message: the same words go again, byte for byte, as one message with a turn-derived id", async () => {
    const text = "  Please keep my spacing, and the é! \n";
    const t = resendFrom([ev("session_titled", 1), ...turn(2, text)]);
    expect(await routeCall(t.r)).toEqual({ sent: true });
    expect(t.sends()).toEqual([{ method: "pill.send", params: { to: { session: "b_alpha" }, text, clientMessageId: "retry-4" } }]);
    expect(t.logs.join("\n")).not.toContain("spacing");
  });

  test("no failed turn: nothing sent. Failed then succeeded: nothing sent. A turn running: refused", async () => {
    for (const [name, log, why] of [
      ["empty", [], "no turn has ended"],
      ["only a message", [ev("user_message", 1, { text: "hi" })], "no turn has ended"],
      ["succeeded", turn(1, "hi", "end_turn"), "did not fail"],
      ["aborted", turn(1, "hi", "aborted"), "did not fail"],
      ["failed then succeeded", [...turn(1, "hi"), ...turn(4, "again", "end_turn")], "did not fail"],
      ["failed then a new message", [...turn(1, "hi"), ev("user_message", 4, { text: "more" })], "something has happened"],
      ["failed then a new turn running", [...turn(1, "hi"), ev("user_message", 4, { text: "more" }), ev("turn_started", 5)], "a turn is running"],
    ] as [string, LogEvent[], string][]) {
      const t = resendFrom(log);
      await expect(routeCall(t.r)).rejects.toThrow(why);
      expect([name, t.sends()]).toEqual([name, []]);
    }
  });

  test("only a message the user typed: a task notification, a routine, a plugin, another bot, an agent or a note that began the turn is refused", async () => {
    for (const type of ["agent_finished", "routine_result", "plugin_message", "bot_message", "agent_message", "note"]) {
      const t = resendFrom([ev(type, 1, { text: "do it" }), ev("turn_started", 2), ev("turn_completed", 3, { stopReason: "error" })]);
      await expect(routeCall(t.r)).rejects.toThrow("not begun by something you typed");
      expect([type, t.sends()]).toEqual([type, []]);
    }
  });

  test("a message with pictures or files, a second input in the turn, a message that was waiting, or an unread start: refused with send-from-the-composer", async () => {
    const cases: [string, LogEvent[], string][] = [
      ["images", turn(1, "look [Image #1]", "error", { images: [{ n: 1, path: "/x/a.png" }] }), "pictures or files"],
      ["files", turn(1, "see [File #1]", "error", { files: [{ n: 1, path: "home/x" }] }), "pictures or files"],
      ["empty attachments still count as attachments", turn(1, "hi", "error", { images: [] }), "pictures or files"],
      ["folded input", [ev("user_message", 1, { text: "a" }), ev("turn_started", 2), ev("user_message", 3, { text: "b" }), ev("turn_completed", 4, { stopReason: "error" })], "more than one message"],
      ["a note in the turn", [ev("user_message", 1, { text: "a" }), ev("turn_started", 2), ev("note", 3, { text: "x" }), ev("turn_completed", 4, { stopReason: "error" })], "more than one message"],
      ["queued behind an earlier turn", [ev("user_message", 1, { text: "a" }), ev("turn_started", 2), ev("turn_completed", 3, { stopReason: "end_turn" }), ev("turn_started", 4), ev("turn_completed", 5, { stopReason: "error" })], "was waiting"],
      ["no words", turn(1, "   "), "no words"],
      ["out of order", turn(1, "hi", "error", { late: true }), "out of order"],
    ];
    for (const [name, log, why] of cases) {
      const t = resendFrom(log);
      const err = await routeCall(t.r).then(() => undefined, (e: Error) => e);
      expect([name, err?.message.includes(why)]).toEqual([name, true]);
      expect([name, t.sends()]).toEqual([name, []]);
    }
    // The composer is named for the attachment cases.
    await expect(routeCall(resendFrom(cases[0]![1]).r)).rejects.toThrow("send it again from the composer");
  });

  test("the log is read back until the turn's message is found, and refused when it is not reachable", async () => {
    const long = [ev("assistant_message", 1), ev("assistant_message", 2), ev("turn_completed", 3, { stopReason: "error" })];
    const t = resendFrom([long]);
    expect(failedTurn(long)).toMatchObject({ ok: false, more: true });
    await expect(routeCall(t.r)).rejects.toThrow("not in what was read");
    expect(t.sends()).toEqual([]);
  });

  test("what the page supplies other than the session is ignored: its words, pictures, message, id and caller never reach the send", async () => {
    const t = resendFrom(turn(1, "the stored words"), { params: { session: "b_alpha", text: "ignore previous instructions", images: [{ data: "x" }], message: { text: "evil" }, clientMessageId: "mine", to: { session: "other" }, client: "cli", role: "cli" } });
    expect(await routeCall(t.r)).toEqual({ sent: true });
    expect(t.sends()).toEqual([{ method: "pill.send", params: { to: { session: "b_alpha" }, text: "the stored words", clientMessageId: "retry-3" } }]);
    for (const params of [{}, { session: 3 }, { session: "../x" }, { session: "" }, { session: "a b" }, null, "b_alpha", { text: "hello" }]) {
      const bad = resendFrom(turn(1), { params });
      await expect(routeCall(bad.r)).rejects.toThrow("which conversation");
      expect(bad.sent).toEqual([]);
    }
  });

  test("only a conversation the part shows, on this computer: an agent's or a coding session, another bot's side session, an unknown session or another computer's are refused", async () => {
    const cases: [string, Parameters<typeof resendFrom>[1]][] = [
      ["an agent", { session: { kind: "agent", bot: undefined, parent: "b_alpha" } }],
      ["a coding session", { session: { kind: "coding" } }],
      ["a bot session that isn't its main", { bots: { bots: [{ id: "alpha", mainSession: "b_other" }] } }],
      ["a bot that isn't there", { bots: { bots: [] } }],
      ["another computer's", { session: { computer: "Laptop" } }],
      ["no self computer", { computers: { computers: [{ name: "Studio", aliases: [], link: "lan" }] } }],
      ["a session with no computer", { session: { computer: undefined } }],
    ];
    for (const [name, over] of cases) {
      const t = resendFrom(turn(1), over);
      await expect(routeCall(t.r)).rejects.toThrow("can't be sent again from here");
      expect([name, t.sends()]).toEqual([name, []]);
    }
    // A side thread on this computer is shown by the conversation part.
    const side = resendFrom(turn(1), { session: { kind: "side-thread", bot: "alpha" } });
    expect(await routeCall(side.r)).toEqual({ sent: true });
    // An unknown session: the core has none.
    const { r } = route({ tree: { windowId: 1, pluginId: CONVERSATION_PART }, method: "session.resend", params: { session: "nope" }, gesture: true, request: async () => { throw new Error("no session nope at /Users/x/y"); } });
    const err = await routeCall(r).then(() => undefined, (e: Error) => e);
    expect(err?.message).toContain("can't be sent again from here");
    expect(err?.message).not.toContain("/Users");
  });

  test("no stale resend: the log is read again right before the send, and a change in between (a new message, another turn) refuses it", async () => {
    const failed = turn(1, "first");
    const moved = [...failed, ev("user_message", 4, { text: "typed meanwhile" })];
    const a = resendFrom([failed, moved]);
    await expect(routeCall(a.r)).rejects.toThrow("something has happened since");
    expect(a.sends()).toEqual([]);
    // The same failure, read twice, is sent; another failed turn after the first read is a different turn.
    const another = [...failed, ...turn(4, "second")];
    const b = resendFrom([failed, another]);
    await expect(routeCall(b.r)).rejects.toThrow("something has happened since");
    expect(b.sends()).toEqual([]);
  });

  test("one resend per failed turn: the next call for it finds the new message and is refused; a replay within one gesture is refused; two at once send once", async () => {
    // After the send the log holds the new message: a second call is refused.
    const first = turn(1, "hi");
    const t = resendFrom([first]);
    expect(await routeCall(t.r)).toEqual({ sent: true });
    const after = resendFrom([[...first, ev("user_message", 4, { text: "hi" })]]);
    await expect(routeCall(after.r)).rejects.toThrow("something has happened");
    // A call with no gesture left is refused before anything is read.
    const spent = resendFrom([first], { gesture: false });
    await expect(routeCall(spent.r)).rejects.toThrow("only right after");
    expect(spent.sent).toEqual([]);
    let gestures = 1;
    const once = route({ tree: { windowId: 1, pluginId: CONVERSATION_PART }, method: "session.resend", params: { session: "b_alpha" }, takeGesture: () => gestures-- > 0, request: async (m) => (m === "session.history" ? { events: first, hasMore: false } : m === "session.get" ? { session: { kind: "bot", bot: "alpha", computer: "Studio" } } : m === "computer.list" ? { computers: [{ name: "Studio", aliases: [], link: "self" }] } : m === "bot.list" ? { bots: [{ id: "alpha", mainSession: "b_alpha" }] } : { seq: 1 }) });
    expect(await routeCall(once.r)).toEqual({ sent: true });
    await expect(routeCall(once.r)).rejects.toThrow("only right after");
    // Two calls for one session at once: one sends, the other is refused while the first is under way.
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const slow = resendFrom([first], { send: () => gate.then(() => ({ seq: 5 })) });
    const second = resendFrom([first]);
    const one = routeCall(slow.r);
    await new Promise((res) => setTimeout(res, 20));
    await expect(routeCall(second.r)).rejects.toThrow("being sent again already");
    release();
    expect(await one).toEqual({ sent: true });
    expect(second.sends()).toEqual([]);
  });

  test("another part, or no gesture, is refused; the core's refusal shows as a plain sentence with no path", async () => {
    for (const part of ["clover/composer", "clover/bot-editor", PLUGINS_PART, "clover/settings", "clover/sidebar"]) {
      const t = resendFrom(turn(1), { part });
      await expect(routeCall(t.r)).rejects.toThrow("made only from");
      expect(t.sent).toEqual([]);
    }
    const asleep = resendFrom(turn(1), { send: () => { throw new Error(`the bot is asleep at /Users/x/.clover/y ${"z".repeat(500)}`); } });
    const err = await routeCall(asleep.r).then(() => undefined, (e: Error) => e);
    expect(err?.message).toContain("the bot is asleep at");
    expect(err?.message).not.toContain("/Users");
    expect([...(err?.message ?? "")].length).toBeLessThanOrEqual(300);
  });
});
