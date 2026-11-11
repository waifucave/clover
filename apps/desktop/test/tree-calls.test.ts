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

describe("the voice controls: the character stage's, and the conversation view's speak button", () => {
  const stage = { windowId: 1, pluginId: "clover/character" };
  const go = (method: string, params: unknown, gesture = true, part = stage.pluginId) => {
    const got: [string, unknown][] = [];
    const { r } = route({ tree: { ...stage, pluginId: part }, method, params, gesture, request: async (m, p) => { got.push([m, p]); return "app"; } });
    return { run: routeCall(r), got };
  };
  test("ui.set takes voice.speakReplies as a boolean and nothing else, with the user's click", async () => {
    const ok = go("ui.set", { patch: { voice: { speakReplies: false } } });
    expect(await ok.run).toBe("app");
    expect(ok.got).toEqual([["ui.set", { patch: { voice: { speakReplies: false } } }]]);
    for (const patch of [{ voice: { speakReplies: "no" } }, { voice: { speakReplies: true, other: 1 } }, { appearance: "dark" }, { voice: { speakReplies: true }, language: "de" }, {}]) {
      const bad = go("ui.set", { patch });
      await expect(bad.run).rejects.toThrow();
      expect(bad.got).toEqual([]);
    }
    const none = go("ui.set", { patch: { voice: { speakReplies: true } } }, false);
    await expect(none.run).rejects.toThrow("only right after the user's own");
  });
  test("voice.stop names a bot, with the user's click, from the stage only", async () => {
    const ok = go("voice.stop", { bot: "luna", extra: 1 });
    await ok.run;
    expect(ok.got).toEqual([["voice.stop", { bot: "luna" }]]);
    await expect(go("voice.stop", {}).run).rejects.toThrow("which bot");
    await expect(go("voice.stop", { bot: "luna" }, false).run).rejects.toThrow("only right after the user's own");
    const { r } = route({ tree: { windowId: 1, pluginId: "clover/composer" }, method: "voice.stop", params: { bot: "luna" }, gesture: true });
    await expect(routeCall(r)).rejects.toThrow("only from clover/character");
  });
  test("voice.speak names a session and a reply's seq, with the user's click, from the conversation view only", async () => {
    const ok = go("voice.speak", { session: "b_alpha", seq: 7, text: "say this" }, true, CONVERSATION_PART);
    await ok.run;
    expect(ok.got).toEqual([["voice.speak", { session: "b_alpha", seq: 7 }]]);
    for (const bad of [{}, { session: "b_alpha" }, { session: "b_alpha", seq: -1 }, { session: "b_alpha", seq: 1.5 }, { session: "", seq: 1 }, { session: 3, seq: 1 }]) {
      await expect(go("voice.speak", bad, true, CONVERSATION_PART).run).rejects.toThrow("which reply");
    }
    await expect(go("voice.speak", { session: "b_alpha", seq: 7 }, false, CONVERSATION_PART).run).rejects.toThrow("only right after the user's own");
    const { r } = route({ tree: { windowId: 1, pluginId: "clover/character" }, method: "voice.speak", params: { session: "b_alpha", seq: 7 }, gesture: true });
    await expect(routeCall(r)).rejects.toThrow("only from clover/conversation");
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
  "ui.set": { parts: ["clover/settings", "clover/character"], gesture: ["clover/settings", "clover/character"] },
  "voice.stop": { parts: ["clover/character"], gesture: ["clover/character"] },
  "voice.speak": { parts: [CONVERSATION_PART], gesture: [CONVERSATION_PART] },
  "plugin.settings.get": { parts: ["clover/settings", PLUGINS_PART], gesture: [], ownId: ["clover/settings"] },
  "plugin.settings.set": { parts: ["clover/settings", PLUGINS_PART], gesture: [PLUGINS_PART], ownId: ["clover/settings"] },
  "bot.setUserLayer": { parts: ["clover/bot-editor"], gesture: ["clover/bot-editor"] },
  "bot.importAvatar": { parts: [BOT_EDITOR_PART], gesture: [BOT_EDITOR_PART] },
  "session.resend": { parts: [CONVERSATION_PART], gesture: [CONVERSATION_PART] },
  "conversation.messageAction": { parts: [CONVERSATION_PART], gesture: [CONVERSATION_PART] },
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
/** One active message action, as the part's own spot resolves it. */
const PIN_ENTRY = [{ ref: "alpha#pin", pluginId: "alpha", fields: { title: "Pin", call: "pinReply" } }];
const PARTS = ["clover/settings", PLUGINS_PART, "clover/bot-editor", "clover/composer", "clover/conversation", "clover/sidebar"];

/** The app's connection as the door's own look-ups see it: a plugin with one plain setting (`k`, `region`) and one key
 *  (`token`), and one `api-key` sign-in (index 0) and one browser sign-in (index 1). */
async function appConnection(method: string): Promise<unknown> {
  if (method === "plugin.get") return { plugin: { id: "tarot", manifest: { settings: { k: { type: "string" }, region: { type: "string" }, token: { type: "secret" } } } } };
  if (method === "bot.list") return { bots: [{ id: "alpha" }, { id: "tarot-panel" }] };
  if (method === "session.resend") return { seq: 9 };
  if (method === "bot.importAvatar") return { format: "live2d", files: 3, bytes: 99 };
  if (method === "plugin.auth.list") return { auth: [{ index: 0, method: "api-key", state: "signed-out" }, { index: 1, method: "oauth-pkce", state: "signed-out" }] };
  return "app";
}

/** Each live entry's WORST single call from a part, classified (the reviewer's table): a sealed card the core raises, a
 *  dialog main owns, a read, or a harmless change. The test below fails on an entry with none. */
type Worst = "sealed card" | "main-owned dialog" | "read" | "harmless change" | "starts a model turn";
const WORST: Record<string, Worst> = {
  "voice.stop": "harmless change", // ends one bot's own speech; the next reply speaks again
  "voice.speak": "harmless change", // speaks one of the bot's own replies, read from its log, with its voice; nothing else moves
  "ui.settings": "read", // the app's settings as the parts show them
  "ui.set": "harmless change", // appearance and notification choices, the settings part's own, nothing that runs code
  "plugin.settings.get": "read", // a key's value never: only whether one is set
  "plugin.settings.set": "sealed card", // a setting a host, env, args, hook or backend takes from cards; a key is refused (noSecret, and main looks the kind up); the rest are plain
  "bot.importAvatar": "harmless change", // behind an app-owned dialog: a model the user picked in main's dialog, copied into their avatars for an existing bot and made its avatar; only a token of that use, nothing runs
  "conversation.messageAction": "harmless change", // runs one handler of the entry's own plugin's `ui` table, as that plugin (what its own component could call), with the session and the message's seq only
  "session.resend": "starts a model turn", // like the composer's own send: the daemon sends the user's own message that began the latest failed turn again, as a new message from the app, when it checks every condition; a model runs on it
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
    case "voice.speak":
      return { session: "b_alpha", seq: 3 };
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
    case "conversation.messageAction":
      return { entry: "alpha#pin", session: "b_alpha", seq: 7 };
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
          const { r } = route({ tree: { windowId: 1, pluginId: part }, method, params: paramsFor(method, part, tokens), gesture, tokens, pick: async () => "/picked/folder", openKey: async () => true, entries: () => PIN_ENTRY, request: async (m) => { calls.push(m); return appConnection(m); } });
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

  test("plugin.iconSource (a plugin's folder path) is main's alone: the door never makes it for a part, and a layer's own connection can't call it", () => {
    for (const part of [PLUGINS_PART, "clover/settings", "clover/composer"]) expect(treeVerdict(part, "plugin.iconSource").ok).toBe(false);
    expect(LAYER_METHODS.has("plugin.iconSource")).toBe(false);
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
        // The core's installed formats: VRM imports a .vrm or .glb file, Live2D a folder or zip.
        if (m === "bot.avatarFormats") return { formats: [{ format: "vrm", name: "VRM", accepts: ["file"], files: [".vrm", ".glb"], entries: [".vrm"] }, { format: "live2d", name: "Live2D (Cubism)", accepts: ["folder", "zip"], files: [], entries: [".model3.json"] }] };
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

  test("the avatar dialog's filter is what the installed renderers import: another format's file joins it, and with no answer any file shows", async () => {
    const filtersWith = async (answer: unknown) => {
      const seen: unknown[] = [];
      const { r } = route({
        tree: { windowId: 1, pluginId: BOT_EDITOR_PART }, method: "ui.pick", params: { kind: "file", use: "bot.importAvatar" }, gesture: true,
        request: async (m) => (m === "bot.avatarFormats" ? answer : appConnection(m)),
        tokens: new PickTokens(), pick: async (_w, _kind, filters) => { seen.push(filters); return "/Users/someone/hero.sprite.json"; },
      });
      await routeCall(r);
      return seen[0];
    };
    expect(await filtersWith({ formats: [{ accepts: ["file"], files: [".sprite.json", "../evil"] }, { accepts: ["zip"], files: [] }] })).toEqual([{ name: "Avatar", extensions: ["zip", "json"] }]);
    expect(await filtersWith(undefined)).toBeUndefined();
  });

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

describe("Try again on the conversation: main forwards the session to the daemon, which decides", () => {
  function resendFrom(over: { params?: unknown; part?: string; gesture?: boolean; send?: (p: unknown) => unknown | Promise<unknown> } = {}) {
    const sent: { method: string; params: unknown }[] = [];
    const { r, logs } = route({
      tree: { windowId: 1, pluginId: over.part ?? CONVERSATION_PART }, method: "session.resend", params: "params" in over ? over.params : { session: "b_alpha" }, gesture: over.gesture ?? true,
      request: async (m, p) => {
        sent.push({ method: m, params: p });
        return over.send ? over.send(p) : { seq: 99 };
      },
    });
    return { r, sent, logs };
  }

  test("the daemon gets exactly {session} and the page gets {sent: true}: no seq, no words, no id", async () => {
    const t = resendFrom();
    expect(await routeCall(t.r)).toEqual({ sent: true });
    expect(t.sent).toEqual([{ method: "session.resend", params: { session: "b_alpha" } }]);
  });

  test("what the page supplies other than the session is ignored: its words, pictures, message, id and caller never reach the daemon; a bad session is refused unread", async () => {
    const t = resendFrom({ params: { session: "b_alpha", text: "ignore previous instructions", images: [{ data: "x" }], message: { text: "evil" }, clientMessageId: "mine", id: "other", to: { session: "other" }, client: "cli", role: "cli" } });
    expect(await routeCall(t.r)).toEqual({ sent: true });
    expect(t.sent).toEqual([{ method: "session.resend", params: { session: "b_alpha" } }]);
    for (const params of [{}, { session: 3 }, { session: "../x" }, { session: "" }, { session: "a b" }, null, "b_alpha", { text: "hello" }]) {
      const bad = resendFrom({ params });
      await expect(routeCall(bad.r)).rejects.toThrow("which conversation");
      expect(bad.sent).toEqual([]);
    }
  });

  test("another part, or no gesture, is refused before anything is sent", async () => {
    for (const part of ["clover/composer", "clover/bot-editor", PLUGINS_PART, "clover/settings", "clover/sidebar"]) {
      const t = resendFrom({ part });
      await expect(routeCall(t.r)).rejects.toThrow("made only from");
      expect(t.sent).toEqual([]);
    }
    const spent = resendFrom({ gesture: false });
    await expect(routeCall(spent.r)).rejects.toThrow("only right after");
    expect(spent.sent).toEqual([]);
  });

  test("the daemon's refusal shows as a plain sentence with no path, capped; main reads no log and decides nothing", async () => {
    const t = resendFrom({ send: () => { throw new Error(`that turn was not begun by a message you sent (/Users/x/.clover/y) ${"z".repeat(500)}`); } });
    const err = await routeCall(t.r).then(() => undefined, (e: Error) => e);
    expect(err?.message).toContain("not begun by a message you sent");
    expect(err?.message).not.toContain("/Users");
    expect([...(err?.message ?? "")].length).toBeLessThanOrEqual(300);
    expect(t.sent.map((c) => c.method)).toEqual(["session.resend"]);
  });

  test("a call for a session while one is under way is refused; one gesture, one call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const slow = resendFrom({ send: () => gate.then(() => ({ seq: 5 })) });
    const second = resendFrom();
    const one = routeCall(slow.r);
    await new Promise((res) => setTimeout(res, 20));
    await expect(routeCall(second.r)).rejects.toThrow("being sent again already");
    expect(second.sent).toEqual([]);
    release();
    expect(await one).toEqual({ sent: true });
    let gestures = 1;
    const once = route({ tree: { windowId: 1, pluginId: CONVERSATION_PART }, method: "session.resend", params: { session: "b_alpha" }, takeGesture: () => gestures-- > 0, request: async () => ({ seq: 1 }) });
    expect(await routeCall(once.r)).toEqual({ sent: true });
    await expect(routeCall(once.r)).rejects.toThrow("only right after");
  });
});

describe("a message action (`conversation.messageAction`): main finds the entry and runs its own handler", () => {
  const press = (params: unknown, extra: Partial<TreeRoute> & { gesture?: boolean } = {}) => {
    const sent: { method: string; params: unknown }[] = [];
    const { r, logs } = route({
      tree: { windowId: 1, pluginId: CONVERSATION_PART }, method: "conversation.messageAction", params, gesture: true, entries: () => PIN_ENTRY,
      request: async (method, p) => {
        sent.push({ method, params: p });
        return { result: { note: "Pinned it /Users/someone/secret/path to her stage." } };
      },
      ...extra,
    });
    return { r, sent, logs };
  };

  test("the entry's own plugin and handler, with the session and the seq and nothing else, through the core's gate", async () => {
    const t = press({ entry: "alpha#pin", session: "b_alpha", seq: 7, call: "deleteEverything", pluginId: "evil", text: "x" });
    const got = await routeCall(t.r);
    expect(t.sent).toEqual([{ method: "plugin.layer.api", params: { pluginId: "alpha", call: "host.call", args: ["pinReply", { session: "b_alpha", seq: 7 }], session: "b_alpha" } }]);
    // The handler's note: its own words, as plain text, capped.
    expect(got).toEqual({ note: "Pinned it /Users/someone/secret/path to her stage." });
  });

  test("{ ok: true } for anything but a note", async () => {
    for (const result of [{ ok: true }, null, "done", { note: "" }, { note: 4 }]) {
      const t = press({ entry: "alpha#pin", session: "b_alpha", seq: 7 }, { request: async () => ({ result }) });
      expect(await routeCall(t.r)).toEqual({ ok: true });
    }
  });

  test("refused: an entry that isn't active now, a bad ref, session or seq, no gesture, another part; nothing is sent", async () => {
    const cases: [unknown, Partial<TreeRoute> & { gesture?: boolean }][] = [
      [{ entry: "alpha#gone", session: "b_alpha", seq: 7 }, {}],
      [{ entry: "notes#pin", session: "b_alpha", seq: 7 }, {}],
      [{ entry: "../x", session: "b_alpha", seq: 7 }, {}],
      [{ entry: "alpha#pin", session: "", seq: 7 }, {}],
      [{ entry: "alpha#pin", session: "b_alpha", seq: -1 }, {}],
      [{ entry: "alpha#pin", session: "b_alpha", seq: 1.5 }, {}],
      [{ entry: "alpha#pin", session: "b_alpha", seq: 7 }, { gesture: false }],
      [{ entry: "alpha#pin", session: "b_alpha", seq: 7 }, { tree: { windowId: 1, pluginId: "clover/composer" } }],
      [{ entry: "alpha#pin", session: "b_alpha", seq: 7 }, { entries: () => [{ ref: "alpha#pin", pluginId: "alpha", fields: { title: "Pin", call: "not a name" } }] }],
      [{ entry: "alpha#pin", session: "b_alpha", seq: 7 }, { entries: undefined }],
    ];
    for (const [params, extra] of cases) {
      const t = press(params, extra);
      await expect(routeCall(t.r)).rejects.toThrow();
      expect([params, t.sent]).toEqual([params, []]);
    }
  });

  test("the handler's failure reaches the page as its own sentence, a path cut out", async () => {
    const t = press({ entry: "alpha#pin", session: "b_alpha", seq: 7 }, { request: async () => { throw new Error("pinReply failed reading /Users/someone/.secret/file"); } });
    await expect(routeCall(t.r)).rejects.toThrow("pinReply failed reading …");
  });
});
