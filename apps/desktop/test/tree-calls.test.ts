import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYER_METHODS } from "../src/main/layer-links";
import { NEVER, SEND_ONLY, TREE_CALLS, needsOf, treeVerdict, type TreeCaller } from "../src/main/ui/tree-calls";

// F2: the door asks for capabilities, never for an id. A bundled part's are what its manifest lists (the build grants
// them), read here from its folder; any other plugin's are what a test gives it.
const BUNDLED = join(import.meta.dir, "../../../plugins/clover/plugins");
const capsCache = new Map<string, ReadonlySet<string>>();
function capsOf(pluginId: string): ReadonlySet<string> {
  const hit = capsCache.get(pluginId);
  if (hit !== undefined) return hit;
  let caps: ReadonlySet<string> = new Set();
  if (pluginId.startsWith("clover/")) {
    try {
      caps = new Set((JSON.parse(readFileSync(join(BUNDLED, pluginId.slice("clover/".length), "clover.json"), "utf8")) as { capabilities?: string[] }).capabilities ?? []);
    } catch { /* no such bundled part */ }
  }
  capsCache.set(pluginId, caps);
  return caps;
}
const verdict = (part: string, method: string, params?: unknown) => treeVerdict(capsOf(part), method, params);

describe("the door for parts: by capability, never by id (F2)", () => {
  test("a read passes for a part whose plugin holds its capability, whichever plugin; a method the table doesn't name isn't its business", () => {
    for (const m of ["archive.history", "archive.list"]) expect(verdict("clover/conversation", m)).toMatchObject({ ok: true, by: "conversation.read" });
    for (const m of ["plugin.list", "plugin.get", "plugin.ui"]) expect(verdict("clover/bot-editor", m)).toMatchObject({ ok: true, by: "plugins.read" });
    expect(verdict("clover/settings", "ui.settings")).toMatchObject({ ok: true, by: "app.settings" });
    expect(verdict("clover/bot-editor", "ui.settings")).toMatchObject({ ok: true, by: "bots.edit" });
    expect(verdict("clover/shell", "account.status")).toMatchObject({ ok: true, by: "account.read" });
    expect(verdict("clover/bot-editor", "models.list")).toMatchObject({ ok: true, by: "bots.read" });
    // Without the capability: not a door of this table's (models.list, account.status and ui.settings aren't the layer role's).
    expect(verdict("clover/archive", "models.list")).toMatchObject({ ok: false, owned: true, why: "models.list needs the bots.read capability" });
    expect(verdict("clover/conversation", "account.status")).toMatchObject({ ok: false, owned: true, why: "account.status needs the account.read capability" });
    expect(verdict("clover/conversation", "ui.settings")).toMatchObject({ ok: false, owned: true });
    expect(verdict("clover/composer", "nonsense.method")).toMatchObject({ ok: false, owned: false });
    // A third party's part with the capability passes as the bundled one does; the same id with none doesn't.
    expect(treeVerdict(["account.read"], "account.status")).toMatchObject({ ok: true });
    expect(treeVerdict(["plugins.manage"], "plugin.get")).toMatchObject({ ok: true, by: "plugins.read" });
    expect(treeVerdict([], "plugin.get")).toMatchObject({ ok: false, owned: true });
  });

  test("a write without its capability: the layer door for a method the layer role has (the core's own rules and cards), refused for any other", () => {
    for (const m of ["plugin.setEnabled", "plugin.settings.set", "ui.set", "bot.setUserLayer", "plugin.install"]) {
      expect(LAYER_METHODS.has(m)).toBe(true);
      for (const part of ["clover/conversation", "clover/sidebar"]) expect(verdict(part, m, { patch: { appearance: "dark" } })).toMatchObject({ ok: false, owned: false });
    }
    for (const m of ["tool.setPermission", "point.active.set", "plugin.remove", "ui.secret", "ui.pick", "bot.importAvatar"]) {
      expect(LAYER_METHODS.has(m)).toBe(false);
      expect(verdict("clover/conversation", m)).toMatchObject({ ok: false, owned: true });
      expect(verdict("clover/conversation", m).ok === false && (verdict("clover/conversation", m) as { why: string }).why).toContain("capability");
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
    for (const m of ["models.catalog", "session.changes", "session.createPr"]) {
      expect(verdict("clover/panel", m)).toMatchObject({ ok: false, owned: true });
    }
  });

  test("the session panels' reads: conversation.read, no gesture; without it the layer door (the layer role's own)", () => {
    for (const m of ["session.diff", "session.outputs", "session.context", "session.connectors"]) {
      expect(TREE_CALLS[m]).toEqual({ disposition: "read", needs: "conversation.read" });
      expect(verdict("clover/panel", m)).toMatchObject({ ok: true });
      expect(treeVerdict(["conversation.read"], m)).toMatchObject({ ok: true });
      expect(treeVerdict([], m)).toMatchObject({ ok: false, owned: false });
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

import { PART_LOG_LINES_MAX, PICK_TOKEN_MS, PickTokens, pageParams, routeCall, type KeyTarget, type TreeRoute } from "../src/main/ui/tree-calls";

// The bundled parts this file names (their ids only NAME them here; what each may do is its manifest's capabilities).
const PLUGINS_PART = "clover/plugin-index";
const BOT_EDITOR_PART = "clover/bot-editor";
const CONVERSATION_PART = "clover/conversation";
const CHARACTER_PART = "clover/character";
const SHELL_PART = "clover/shell";

/** A test's route: `tree` names the calling part (its capabilities its manifest's, or `caps` for a third party's). */
type Over = Partial<Omit<TreeRoute, "caller">> & { gesture?: boolean; tree?: { windowId: number; pluginId: string } | undefined; caps?: readonly string[] };
function route(over: Over) {
  const calls: string[] = [];
  const logs: string[] = [];
  const { tree, caps, ...rest } = over;
  const who = "tree" in over ? tree : { windowId: 1, pluginId: "clover/composer" };
  const caller: TreeCaller | undefined = who === undefined ? undefined : { ...who, capabilities: caps !== undefined ? new Set(caps) : capsOf(who.pluginId) };
  const r: TreeRoute = {
    caller,
    method: "session.setModel",
    params: {},
    takeGesture: () => over.gesture ?? false,
    request: async (m) => { calls.push(`app:${m}`); return "app"; },
    layer: async () => { calls.push("layer"); return "layer"; },
    log: (l) => logs.push(l),
    refuse: (why) => new Error(why),
    listens: { piece: async () => ({}) },
    ...rest,
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

  test("a conversation or composer frame has no settings capability: its settings writes go the layer door (the core's own rules), never the app's connection", async () => {
    for (const part of ["clover/conversation", "clover/composer"]) {
      for (const method of ["ui.set", "plugin.setEnabled", "plugin.settings.set"]) {
        const { r, calls } = route({ tree: { windowId: 1, pluginId: part }, method, params: { patch: { appearance: "dark" } }, gesture: true });
        expect(await routeCall(r)).toBe("layer");
        expect(calls).toEqual(["layer"]);
      }
      // A write the layer role doesn't have is refused, with the capability it needs.
      const { r, calls, logs } = route({ tree: { windowId: 1, pluginId: part }, method: "tool.setPermission", gesture: true });
      await expect(routeCall(r)).rejects.toThrow("tool.setPermission needs the tools.permissions capability");
      expect(calls).toEqual([]);
      expect(logs[0]).toContain("refused");
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
    expect(await routeCall(other.r)).toBe("layer");
    // A third party's part with plugins.manage passes as Settings does, on the user's press.
    const third = { windowId: 1, pluginId: "my-settings" };
    expect(await routeCall(route({ tree: third, caps: ["plugins.manage"], method: "plugin.setEnabled", gesture: true }).r)).toBe("app");
    await expect(routeCall(route({ tree: third, caps: ["plugins.manage"], method: "plugin.setEnabled", gesture: false }).r)).rejects.toThrow("only right after");
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

  test("a bot's user layer is the bot editor's (and the avatar's two fields the character plugin's), with the user's click; no other part's", async () => {
    const patch = { id: "alpha", patch: { instructions: "x" } };
    const editor = { windowId: 1, pluginId: "clover/bot-editor" };
    expect(await routeCall(route({ tree: editor, method: "bot.setUserLayer", params: patch, gesture: true }).r)).toBe("app");
    const none = route({ tree: editor, method: "bot.setUserLayer", params: patch, gesture: false });
    await expect(routeCall(none.r)).rejects.toThrow("only right after");
    expect(none.calls).toEqual([]);
    // Without bots.edit: the layer door, where the core raises its card for a user-layer change.
    // (The composer holds bots.edit for its model picker on a bot's main conversation.)
    for (const part of ["clover/conversation", "clover/settings"]) {
      const other = route({ tree: { windowId: 1, pluginId: part }, method: "bot.setUserLayer", params: patch, gesture: true });
      expect(await routeCall(other.r)).toBe("layer");
      expect(other.calls).toEqual(["layer"]);
    }
    // A third party's bot editor with bots.edit passes.
    expect(await routeCall(route({ tree: { windowId: 1, pluginId: "my-editor" }, caps: ["bots.edit"], method: "bot.setUserLayer", params: patch, gesture: true }).r)).toBe("app");
  });

  test("another plugin's settings take plugins.read (a read) and plugins.manage (a write, on a press); a part's own go through the plugin API, not this door", async () => {
    // The composer holds neither: a read is refused (not the layer role's), a write goes the layer door.
    const composer = { windowId: 1, pluginId: "clover/composer" };
    const read = route({ tree: composer, method: "plugin.settings.get", params: { id: "clover/provider-gcp" } });
    await expect(routeCall(read.r)).rejects.toThrow("plugin.settings.get needs the plugins.read capability");
    expect(read.calls).toEqual([]);
    expect(await routeCall(route({ tree: composer, method: "plugin.settings.set", params: { id: "clover/provider-gcp", key: "project", value: "x" }, gesture: true }).r)).toBe("layer");
    // A third party with plugins.read reads any plugin's settings view (a secret only as set or not, the core's own).
    const reader = route({ tree: { windowId: 1, pluginId: "my-plugins" }, caps: ["plugins.read"], method: "plugin.settings.get", params: { id: "clover/provider-gcp" } });
    expect(await routeCall(reader.r)).toBe("app");
    expect(reader.calls).toEqual(["app:plugin.settings.get"]);
  });
});

describe("the bot editor's switch for other plugins' layout patches", () => {
  const editor = { windowId: 1, pluginId: "clover/bot-editor" };
  const stored = { picks: [], lists: [{ spot: "status", order: ["a"], hidden: [] }, { spot: "bot.tab", bot: "luna", order: [], hidden: ["old#x"] }, { spot: "bot.tab", bot: "alpha", order: [], hidden: ["m#move"] }] };
  const go = (params: unknown, gesture = true) => {
    const got: [string, unknown][] = [];
    const { r } = route({ tree: editor, method: "ui.set", params, gesture, request: async (m, p) => { got.push([m, p]); return m === "ui.settings" ? stored : "app"; } });
    return { run: routeCall(r), got };
  };
  test("one bot's switched-off patches, merged into the stored lists by main, with the user's click; nothing else", async () => {
    const ok = go({ patch: { lists: [{ spot: "bot.tab", bot: "luna", order: [], hidden: ["mover#move", "mover#move"] }] } });
    expect(await ok.run).toBe("app");
    expect(ok.got).toEqual([["ui.settings", {}], ["ui.set", { patch: { lists: [stored.lists[0], stored.lists[2], { spot: "bot.tab", bot: "luna", order: [], hidden: ["mover#move"] }] } }]]);
    // All back on: Luna's entry goes.
    const on = go({ patch: { lists: [{ spot: "bot.tab", bot: "luna", order: [], hidden: [] }] } });
    await on.run;
    expect(on.got.at(-1)).toEqual(["ui.set", { patch: { lists: [stored.lists[0], stored.lists[2]] } }]);
    for (const patch of [
      { appearance: "dark" },
      { lists: [{ spot: "status", order: [], hidden: ["x"] }] },
      { lists: [{ spot: "bot.tab", order: [], hidden: [] }] },
      { lists: [{ spot: "bot.tab", bot: "luna", order: ["x"], hidden: [] }] },
      { lists: [{ spot: "bot.tab", bot: "luna", order: [], hidden: [], shown: ["x"] }] },
      { lists: [{ spot: "bot.tab", bot: "luna", order: [], hidden: ["Not A Ref"] }] },
      { lists: [{ spot: "bot.tab", bot: "luna", order: [], hidden: [] }, { spot: "bot.tab", bot: "alpha", order: [], hidden: [] }] },
      { lists: [{ spot: "bot.tab", bot: "luna", order: [], hidden: [] }], language: "de" },
    ]) {
      // Refused, or (a look's shape, which takes app.settings the editor lacks) the layer door: never the app's connection.
      const bad = go({ patch });
      expect(["refused", "layer"]).toContain(String(await bad.run.then((v) => v, () => "refused")));
      expect(bad.got).toEqual([]);
    }
    // A plugin's hide switched off in one spot: only that list's `shown`, the user's order and hidden kept.
    const back = go({ patch: { lists: [{ spot: "status", bot: "luna", order: [], hidden: [], shown: ["tidy#no-roll"] }] } });
    await back.run;
    expect(back.got.at(-1)).toEqual(["ui.set", { patch: { lists: [stored.lists[0], stored.lists[1], stored.lists[2], { spot: "status", bot: "luna", order: [], hidden: [], shown: ["tidy#no-roll"] }] } }]);
    const alphaStatus = { picks: [], lists: [{ spot: "status", bot: "alpha", order: ["a"], hidden: ["b"], shown: ["c#d"] }] };
    const keep: [string, unknown][] = [];
    const k = route({ tree: editor, method: "ui.set", params: { patch: { lists: [{ spot: "status", bot: "alpha", order: [], hidden: [], shown: [] }] } }, gesture: true, request: async (m, p) => { keep.push([m, p]); return m === "ui.settings" ? alphaStatus : "app"; } });
    await routeCall(k.r);
    expect(keep.at(-1)).toEqual(["ui.set", { patch: { lists: [{ spot: "status", bot: "alpha", order: ["a"], hidden: ["b"] }] } }]);
    for (const l of [{ spot: "status", bot: "luna", order: ["x"], shown: [] }, { spot: "status", bot: "luna", hidden: ["x"], shown: [] }, { spot: "Not A Spot", bot: "luna", shown: [] }, { spot: "status", bot: "luna", shown: ["Bad Ref"] }]) {
      const bad = go({ patch: { lists: [l] } });
      await expect(bad.run).rejects.toThrow();
      expect(bad.got).toEqual([]);
    }
    const none = go({ patch: { lists: [{ spot: "bot.tab", bot: "luna", order: [], hidden: [] }] } }, false);
    await expect(none.run).rejects.toThrow("only right after the user's own");
    expect(verdict("clover/conversation", "ui.set", { patch: { lists: [] } })).toMatchObject({ ok: false, owned: false, why: "ui.set needs the bots.edit capability" });
    expect(treeVerdict(["bots.edit"], "ui.set", { patch: { lists: [] } })).toMatchObject({ ok: true, by: "bots.edit" });
    // bots.edit sets lists, never the look.
    expect(treeVerdict(["bots.edit"], "ui.set", { patch: { appearance: "dark" } })).toMatchObject({ ok: false, why: "ui.set needs the app.settings capability" });
  });
});

describe("the re-founded Voice makes no call through this door (F1): its own settings are the plugin API's", () => {
  test("voice.stop, voice.speak and voice.played are gone from the door, and its speak-replies switch is its own setting", () => {
    for (const m of ["voice.stop", "voice.speak", "voice.played"]) expect(Object.hasOwn(TREE_CALLS, m)).toBe(false);
    // A patch of `voice` is no shape of ui.set's own: it is the look's, which takes app.settings, and drops what isn't a look key.
    expect(verdict("clover/voice", "ui.set", { patch: { voice: { speakReplies: true } } })).toMatchObject({ ok: false, owned: false, why: "ui.set needs the app.settings capability" });
    expect(verdict("clover/voice", "plugin.settings.get", { id: "clover/voice" })).toMatchObject({ ok: false, owned: true });
  });
});

describe("push-to-talk's voice.listen: the shell's pieces, on a hold the user's press opened", () => {
  const shell = { windowId: 7, pluginId: SHELL_PART };
  test("only a part with audio may make it, it needs no gesture of its own, and the piece goes to the window's hold with nothing else of the page's", async () => {
    const got: [number, unknown][] = [];
    const listens = { piece: async (w: number, p: unknown) => { got.push([w, p]); return { text: "hi" }; } };
    const { r, calls } = route({ tree: shell, method: "voice.listen", params: { audio: "AAAA", final: true, bot: "luna", utterance: "u1", seq: 9 }, gesture: false, listens });
    expect(await routeCall(r)).toEqual({ text: "hi" });
    // The window is main's (partCaller), the params are the page's and are checked by the hold, which names the bot, the utterance and the number itself.
    expect(got).toEqual([[7, { audio: "AAAA", final: true, bot: "luna", utterance: "u1", seq: 9 }]]);
    expect(calls).toEqual([]);
    for (const part of ["clover/sidebar", "clover/settings", PLUGINS_PART]) {
      const other = route({ tree: { windowId: 7, pluginId: part }, method: "voice.listen", params: { audio: "AAAA", final: true }, gesture: true, listens });
      await expect(routeCall(other.r)).rejects.toThrow("voice.listen needs the audio capability");
    }
    expect(got.length).toBe(1);
  });
  test("a piece with no hold open, or an app that can't record, is refused and reaches nothing", async () => {
    const none = route({ tree: shell, method: "voice.listen", params: { audio: "AAAA", final: false }, listens: { piece: () => Promise.reject(new Error("nothing is being recorded")) } });
    await expect(routeCall(none.r)).rejects.toThrow("nothing is being recorded");
    expect(none.calls).toEqual([]);
    const bare = route({ tree: shell, method: "voice.listen", params: {}, listens: undefined });
    await expect(routeCall(bare.r)).rejects.toThrow("can't record");
    // A third-party layer's call never reaches the table: the layer door refuses it.
    const third = route({ tree: undefined, method: "voice.listen", params: { audio: "AAAA", final: true } });
    expect(await routeCall(third.r)).toBe("layer");
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

/** What each table entry needs (F2): the capabilities of which any one lets a part through (none: no capability; the
 *  call holds its own rule), and whether it needs the user's press. Shape-dependent entries are listed with the shape
 *  `paramsFor` sends; their other shapes are tested on their own. */
const EXPECTED: Record<string, { needs: string[]; gesture: boolean }> = {
  "ui.settings": { needs: ["app.settings", "bots.edit"], gesture: false },
  "session.diff": { needs: ["conversation.read"], gesture: false },
  "session.outputs": { needs: ["conversation.read"], gesture: false },
  "session.context": { needs: ["conversation.read"], gesture: false },
  "session.connectors": { needs: ["conversation.read"], gesture: false },
  "ui.set": { needs: ["app.settings"], gesture: true },
  // The pieces of a recording the user holds: no press of its own (the composer's `listenStart` took it; the hold carries the pieces).
  "voice.listen": { needs: ["audio"], gesture: false },
  "ui.secret": { needs: ["plugins.manage", "bots.edit"], gesture: true },
  "plugin.settings.get": { needs: ["plugins.read"], gesture: false },
  "plugin.settings.set": { needs: ["plugins.manage"], gesture: true },
  "bot.setUserLayer": { needs: ["bots.edit"], gesture: true },
  "bot.importAvatar": { needs: ["bots.avatar"], gesture: true },
  "session.resend": { needs: ["user.send"], gesture: true },
  "conversation.messageAction": { needs: [], gesture: true },
  "ui.pick": { needs: ["plugins.manage"], gesture: true },
  "account.status": { needs: ["account.read"], gesture: false },
  "archive.history": { needs: ["conversation.read"], gesture: false },
  "archive.list": { needs: ["conversation.read"], gesture: false },
  "models.list": { needs: ["bots.read"], gesture: false },
  "plugin.logs": { needs: ["logs.read"], gesture: false },
  "tool.permissions": { needs: ["tools.permissions"], gesture: false },
  "tool.setPermission": { needs: ["tools.permissions"], gesture: true },
  "tool.takeBackRule": { needs: ["tools.permissions"], gesture: true },
  "point.active.list": { needs: ["app.settings"], gesture: false },
  "point.active.set": { needs: ["app.settings"], gesture: true },
  "computer.list": { needs: ["computers.read"], gesture: false },
  ...Object.fromEntries(["plugin.list", "plugin.get", "plugin.ui", "plugin.index.list", "plugin.index.search", "plugin.auth.list", "plugin.dev.list", "plugin.grant.list", "command.list", "notify.mutes"].map((m) => [m, { needs: ["plugins.read"], gesture: false }])),
  ...Object.fromEntries(["plugin.install", "plugin.remove", "plugin.update", "plugin.pin", "plugin.restart", "plugin.index.add", "plugin.index.remove", "plugin.auth.signIn", "plugin.auth.signOut", "plugin.dev.add", "plugin.dev.remove", "plugin.grant.remove", "plugin.setScope", "plugin.setComputers", "plugin.confirmAdult", "plugin.dev.renew", "notify.setMuted", "plugin.setEnabled"].map((m) => [m, { needs: ["plugins.manage"], gesture: true }])),
};
/** One active message action, as the part's own spot resolves it. */
const PIN_ENTRY = [{ ref: "alpha#pin", pluginId: "alpha", fields: { title: "Pin", call: "pinReply" } }];
/** A third party's part: its id names nothing the door knows. */
const THIRD = "acme-panel";

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
type Worst = "sealed card" | "main-owned dialog" | "read" | "harmless change" | "starts a model turn" | "held recording" | "user's permission press";
const WORST: Record<string, Worst> = {
  "voice.listen": "held recording", // audio to the bot's own listening voice, only while a hold the user's own press opened is live in that window (listen.ts): main names the bot and numbers the pieces, refuses any with no hold, and the core still asks its provider check; no hold, no call
  "ui.settings": "read", // the app's settings as the parts show them
  "session.diff": "read", // a session's changes in its folder: git read only (no optional locks, no fsmonitor, no external diff or textconv), bounded
  "session.outputs": "read", // the names of the files in a session's outputs folder
  "session.context": "read", // a session's last measured prompt size against its model's window
  "session.connectors": "read", // counts of the plugin MCP servers a session gets and of those waiting for a sign-in
  "ui.set": "harmless change", // appearance and notification choices, the settings part's own, nothing that runs code
  "plugin.settings.get": "read", // a key's value never: only whether one is set
  "plugin.settings.set": "sealed card", // a setting a host, env, args, hook or backend takes from cards; a key is refused (noSecret, and main looks the kind up); the rest are plain
  "bot.importAvatar": "harmless change", // behind an app-owned dialog: a model the user picked in main's dialog, copied into their avatars for an existing bot and made its avatar; only a token of that use, nothing runs
  "conversation.messageAction": "harmless change", // runs one handler of the entry's own plugin's `ui` table, as that plugin (what its own component could call), with the session and the message's seq only
  "session.resend": "starts a model turn", // like the composer's own send: the daemon sends the user's own message that began the latest failed turn again, as a new message from the app, when it checks every condition; a model runs on it
  "bot.setUserLayer": "harmless change", // the user's own words for a bot, from the bot editor (every field but the avatar's) and the character plugin's avatar section (the avatar's two), on their click; no capability moves
  "account.status": "read",
  "archive.history": "read",
  "archive.list": "read",
  "plugin.list": "read",
  "plugin.get": "read",
  "plugin.ui": "read",
  "plugin.index.list": "read",
  "plugin.index.search": "read",
  "models.list": "read",
  "plugin.setEnabled": "sealed card", // turning a found plugin on raises its OK card; turning an OK'd plugin back on (or off) is a gesture (accepted)
  "plugin.logs": "read", // its own file only, key-looking runs cut to "…"
  "tool.permissions": "read", // plugin tools by their own names, each with its value and the bots' saved card rules
  "tool.setPermission": "user's permission press", // always allow, ask or always block: the user's own press in Settings, never another part
  "tool.takeBackRule": "user's permission press", // takes back a card's Always allow for one bot
  "point.active.list": "read", // the one-at-a-time points, their fillers and the one active, for Settings' pickers
  "point.active.set": "user's permission press", // which filler of a one-at-a-time point is used: the user's own press in Settings
  "plugin.auth.list": "read",
  "plugin.dev.list": "read",
  "plugin.grant.list": "read", // the files and folders picked for one plugin: paths only the user chose
  "command.list": "read", // each command's default key and whether it is bound, for the Plugins page's Keys lines
  "computer.list": "read", // the computers' names, to tick which a plugin's server runs on
  "notify.mutes": "read", // which plugins' notifications are muted
  "notify.setMuted": "harmless change", // mutes or unmutes one plugin's notifications to the user; nothing it may do moves
  "ui.pick": "main-owned dialog", // main's own open dialog; the page gets a one-use token and a name
  "ui.secret": "main-owned dialog", // the app's own key dialog; the key never passes the page
  "plugin.install": "sealed card", // every install raises the core's OK card before anything runs
  "plugin.remove": "sealed card", // main sets card: the removal card
  "plugin.update": "sealed card", // main sets card: an update asks (the yes applies that tree only); a new trigger shows its OK card instead
  "plugin.pin": "harmless change", // at worst holds a plugin's fixes back on this computer (it isn't offered updates); unpinning only returns it to the normal update flow
  "plugin.restart": "harmless change", // restarts the plugin's own processes on the code already OK'd
  "plugin.index.add": "harmless change", // runs nothing: each plugin installed from it asks on its own OK card
  "plugin.index.remove": "sealed card", // main sets card: asks when installs came from it
  "plugin.auth.signIn": "main-owned dialog", // a key only in the app's key dialog; a browser sign-in opens the provider's page
  "plugin.auth.signOut": "sealed card", // main sets card: the sign-out card
  "plugin.dev.add": "sealed card", // a picked folder only, and the core's development-folder card
  "plugin.dev.remove": "harmless change", // stops loading a development folder
  "plugin.grant.remove": "harmless change", // takes a picked file or folder back: the plugin no longer reaches it
  "plugin.setScope": "harmless change", // the user's own choice of where a plugin works (bots, agents, both); the manifest's stays the default
  "plugin.setComputers": "harmless change", // ticks the computers a plugin's server runs on; code already OK'd, the core cards anything that moves a host
  "plugin.confirmAdult": "sealed card", // the user's own statement that they are 18 or older, only on the sealed card (main sets card)
  "plugin.dev.renew": "sealed card", // main sets card: another 24 hours of code that reloads asks on the development-folder card
};

/** Params each method can be routed with from a part holding `cap` (the Plugins page's shaped ones included). */
function paramsFor(method: string, part: string, tokens: PickTokens, cap = ""): unknown {
  switch (method) {
    case "ui.set":
      return { patch: { appearance: "dark" } };
    case "ui.settings":
      return {};
    case "plugin.settings.get":
    case "plugin.settings.set":
      return { id: "tarot", key: "k", value: "v" };
    case "voice.listen":
      return { audio: "AAAA", final: false };
    case "bot.setUserLayer":
      return { id: "alpha", patch: cap === "bots.avatar" ? { avatar: null } : { theme: null } };
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
      return { kind: "folder", use: cap === "bots.avatar" ? "bot.importAvatar" : "plugin.install" };
    case "bot.importAvatar":
      return { id: "alpha", path: tokens.issue(part, "/picked/avatar", "bot.importAvatar") };
    case "ui.secret":
      return { id: cap === "bots.edit" ? "alpha" : "tarot", key: "token" };
    case "session.resend":
      return { session: "b_alpha" };
    case "conversation.messageAction":
      return { entry: "alpha#pin", session: "b_alpha", seq: 7 };
    default:
      return {};
  }
}

describe("the door, table by table: what each entry needs, with what press", () => {
  test("every live entry is in the expectation table, and the table matches the door", () => {
    const live = Object.entries(TREE_CALLS).filter(([, c]) => c.disposition !== "card" && c.disposition !== "unserved").map(([m]) => m).sort();
    expect(live).toEqual(Object.keys(EXPECTED).sort());
  });

  test("every live entry's worst single call is classified: sealed card, main-owned dialog, read or harmless change", () => {
    const live = Object.entries(TREE_CALLS).filter(([, c]) => c.disposition !== "card" && c.disposition !== "unserved").map(([m]) => m);
    for (const m of live) expect([m, WORST[m]]).toEqual([m, expect.stringMatching(/^(sealed card|main-owned dialog|read|harmless change|starts a model turn|held recording|user's permission press)$/)]);
    expect(Object.keys(WORST).sort()).toEqual([...live].sort());
    // A read needs no gesture and a change from the Plugins page does; a read is never one that changes a thing.
    for (const [m, w] of Object.entries(WORST)) if (w === "read") expect([m, EXPECTED[m]!.gesture]).toEqual([m, false]);
  });

  test("each entry: a third party's part holding the capability passes (with the press where one is needed); without the press, or with none of the capabilities, nothing reaches the app's connection", async () => {
    for (const [method, want] of Object.entries(EXPECTED)) {
      expect([method, needsOf(TREE_CALLS[method]!, paramsFor(method, THIRD, new PickTokens())).slice().sort()]).toEqual([method, want.needs.slice().sort()]);
      expect([method, TREE_CALLS[method]!.disposition === "gesture"]).toEqual([method, want.gesture]);
      // plugins.manage carries plugins.read (IMPLIED_CAPABILITIES): its holder passes each read too.
      const holders = want.needs.length === 0 ? [""] : want.needs.includes("plugins.read") ? [...want.needs, "plugins.manage"] : want.needs;
      for (const cap of holders) {
        for (const gesture of [true, false]) {
          const tokens = new PickTokens();
          const calls: string[] = [];
          const { r } = route({ tree: { windowId: 1, pluginId: THIRD }, caps: cap === "" ? [] : [cap], method, params: paramsFor(method, THIRD, tokens, cap), gesture, tokens, pick: async () => "/picked/folder", openKey: async () => true, entries: () => PIN_ENTRY, request: async (m) => { calls.push(m); return appConnection(m); } });
          const ok = gesture || !want.gesture;
          const got = await routeCall(r).then(() => "ok", (e: Error) => e.message);
          expect([method, cap, gesture, got]).toEqual([method, cap, gesture, ok ? "ok" : expect.stringContaining("only right after the user's own")]);
          if (!ok) expect([method, cap, calls]).toEqual([method, cap, []]);
        }
      }
      if (want.needs.length === 0) continue;
      // With none: refused with the capability it needs, or (a method the `layer` role has) the layer door's own rules.
      const { r, calls } = route({ tree: { windowId: 1, pluginId: THIRD }, caps: ["files", "notify"], method, params: paramsFor(method, THIRD, new PickTokens()), gesture: true });
      const got = await routeCall(r).then((v) => v, (e: Error) => e.message);
      if (LAYER_METHODS.has(method)) expect([method, got, calls]).toEqual([method, "layer", ["layer"]]);
      else expect([method, got, calls]).toEqual([method, expect.stringContaining("capability"), []]);
      // A mount that acts in no plugin's name never gets the table: the layer door decides.
      const none = route({ tree: undefined, method, params: {}, gesture: true });
      expect(await routeCall(none.r)).toBe("layer");
    }
  });

  test("no test or table names a bundled id to allow a call: the bundled parts pass by the capabilities their manifests list", async () => {
    // Every call each bundled part makes today, from its own manifest's capabilities.
    const makes: Record<string, string[]> = {
      "clover/settings": ["ui.settings", "ui.set", "plugin.setEnabled", "plugin.logs", "plugin.list", "plugin.ui", "account.status", "tool.permissions", "tool.setPermission", "point.active.list", "point.active.set", "computer.list"],
      [PLUGINS_PART]: ["plugin.install", "plugin.remove", "plugin.get", "plugin.settings.get", "plugin.settings.set", "ui.pick", "ui.secret", "plugin.logs", "notify.setMuted", "computer.list", "command.list"],
      [BOT_EDITOR_PART]: ["bot.setUserLayer", "models.list", "plugin.list", "plugin.ui", "ui.secret", "ui.settings"],
      [CHARACTER_PART]: ["bot.importAvatar", "plugin.list"],
      [CONVERSATION_PART]: ["archive.history", "session.resend", "conversation.messageAction"],
      [SHELL_PART]: ["account.status", "voice.listen", "computer.list"],
      "clover/sidebar": ["account.status", "computer.list"],
      "clover/panel": ["session.outputs", "session.context", "session.connectors", "computer.list"],
      "clover/panel-diff": ["session.diff"],
      "clover/archive": ["archive.list", "archive.history"],
    };
    for (const [part, methods] of Object.entries(makes)) for (const m of methods) expect([part, m, verdict(part, m, paramsFor(m, part, new PickTokens(), part === CHARACTER_PART ? "bots.avatar" : part === BOT_EDITOR_PART ? "bots.edit" : "")).ok]).toEqual([part, m, true]);
    const src = readFileSync(join(import.meta.dir, "../src/main/ui/tree-calls.ts"), "utf8");
    expect(src).not.toMatch(/"clover\/[a-z-]+"/);
  });

  test("every bundled part that opens a place in the main window (useOpen) holds shell.control, as any plugin must (mayOpen)", () => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? files(f) : /\.tsx?$/.test(n) ? [f] : []; });
    const openers: string[] = [];
    for (const name of readdirSync(BUNDLED)) {
      let client: string[] = [];
      try { client = files(join(BUNDLED, name, "client")); } catch { continue; }
      if (client.some((f) => !/\/sdk\.tsx?$/.test(f) && /\buseOpen\(\)/.test(readFileSync(f, "utf8")))) openers.push(`clover/${name}`);
    }
    expect(openers.length).toBeGreaterThan(0);
    for (const id of openers) expect([id, capsOf(id).has("shell.control")]).toEqual([id, true]);
  });

  test("plugin.settings: a call naming a bot is its Edit page's (bots.edit, the bot's own plugin); any other plugin's settings are plugins.read's and plugins.manage's", async () => {
    expect(verdict(BOT_EDITOR_PART, "plugin.settings.get", { id: "alpha", bot: "alpha" })).toMatchObject({ ok: true, by: "bots.edit" });
    expect(verdict(BOT_EDITOR_PART, "plugin.settings.set", { id: "tarot", key: "k", value: "v" })).toMatchObject({ ok: false, owned: false });
    // The Plugins page holds plugins.manage, not bots.edit: a bot it names is dropped (pageParams), any plugin's account value.
    expect(verdict(PLUGINS_PART, "plugin.settings.set", { id: "alpha", bot: "alpha", key: "k", value: "v" })).toMatchObject({ ok: true, by: "plugins.manage" });
    expect(treeVerdict(["files"], "plugin.settings.get", { id: "alpha", bot: "alpha" })).toMatchObject({ ok: false, why: "plugin.settings.get needs the bots.edit or plugins.read capability" });
    for (const method of ["plugin.settings.get", "plugin.settings.set"]) {
      const page = route({
        tree: { windowId: 1, pluginId: "clover/settings" }, method, params: { id: "clover/provider-gcp", key: "project", value: "x" }, gesture: true,
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
    const other = route({ tree: { windowId: 1, pluginId: "clover/sidebar" }, method: "ui.secret", params: { id: "tarot", key: "token" }, gesture: true, openKey, request: async (m) => appConnection(m) });
    await expect(routeCall(other.r)).rejects.toThrow("ui.secret needs the plugins.manage or bots.edit capability");
    expect(opened.length).toBe(2);
    // While a key dialog is open, another is refused: the user closes it first.
    const busy = page("ui.secret", { id: "tarot", key: "token" }, { openKey: async () => false });
    await expect(routeCall(busy.r)).rejects.toThrow("key dialog is open already");
  });

  test("a removal, a sign-out, an index's removal, an update and the user's age always go with card; listing is a read", async () => {
    const removal = page("plugin.remove", { id: "tarot", card: false, extra: 1 });
    await routeCall(removal.r);
    expect(removal.sent).toEqual([{ id: "tarot", card: true }]);
    const wipe = page("plugin.remove", { id: "tarot", card: false, deleteData: true, extra: 1 });
    await routeCall(wipe.r);
    expect(wipe.sent).toEqual([{ id: "tarot", card: true, deleteData: true }]);
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
    // The user's age: a sealed card for every holder (one press in a plugin's frame never declares it).
    const adult = page("plugin.confirmAdult", { card: false, extra: 1 });
    await routeCall(adult.r);
    expect(adult.sent).toEqual([{ card: true }]);
    const third = route({ tree: { windowId: 1, pluginId: "acme-plugins" }, caps: ["plugins.manage"], method: "plugin.confirmAdult", params: {}, gesture: true, request: async (_m, p) => p });
    expect(await routeCall(third.r)).toEqual({ card: true });
    const listing = route({ tree: { windowId: 1, pluginId: PLUGINS_PART }, method: "plugin.update", params: { list: true }, gesture: false });
    expect(await routeCall(listing.r)).toBe("app");
  });

  test("plugin.iconSource (a plugin's folder path) is main's alone: the door never makes it for a part, and a layer's own connection can't call it", () => {
    for (const part of [PLUGINS_PART, "clover/settings", "clover/composer"]) expect(verdict(part, "plugin.iconSource").ok).toBe(false);
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
      ["plugin.index.add", { url: "https://plugins.example.com/index.json", ...forged }],
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
    // Any other part's forwarded call the same (a read: the computers).
    const sent: unknown[] = [];
    const own = route({ tree: { windowId: 1, pluginId: "clover/sidebar" }, method: "computer.list", params: { ...forged }, request: async (_m, p) => { sent.push(p); return "app"; } });
    await routeCall(own.r);
    expect(sent).toEqual([{}]);
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

describe("the character plugin's avatar section: a pick of main's, then one import of exactly that pick", () => {
  const editor = (method: string, params: unknown, extra: Partial<TreeRoute> = {}) => {
    const sent: { method: string; params: unknown }[] = [];
    const { r, logs } = route({
      tree: { windowId: 1, pluginId: CHARACTER_PART }, method, params, gesture: true,
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
        tree: { windowId: 1, pluginId: CHARACTER_PART }, method: "ui.pick", params: { kind: "file", use: "bot.importAvatar" }, gesture: true,
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
    expect(tokens.redeem(got.token, CHARACTER_PART, "plugin.install")).toBeUndefined();
    const again = await pickFor(tokens, { kind: "folder", use: "bot.importAvatar" });
    expect(tokens.redeem(again.token, CHARACTER_PART, "plugin.dev.add")).toBeUndefined();
    // And the reverse: a Plugins page token is no avatar's.
    const install = tokens.issue(PLUGINS_PART, "/picked/tarot", "plugin.install");
    expect(tokens.redeem(install, PLUGINS_PART, "bot.importAvatar")).toBeUndefined();
    // Each part asks only for its own uses; no use, or another's, is refused before any dialog.
    for (const [part, use] of [[CHARACTER_PART, "plugin.install"], [CHARACTER_PART, "plugin.dev.add"], [CHARACTER_PART, undefined], [PLUGINS_PART, "bot.importAvatar"], [PLUGINS_PART, undefined]] as const) {
      let opened = 0;
      const { r } = route({ tree: { windowId: 1, pluginId: part }, method: "ui.pick", params: { kind: "folder", use }, gesture: true, tokens, pick: async () => { opened++; return "/x"; } });
      await expect(routeCall(r)).rejects.toThrow(/and says which|capability/);
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
    for (const [part, use] of [[CHARACTER_PART, "plugin.install"], [CHARACTER_PART, "plugin.dev.add"], [PLUGINS_PART, "bot.importAvatar"], ["clover/settings", "bot.importAvatar"]] as const) {
      const r = editor("bot.importAvatar", { id: "alpha", path: tokens.issue(part, "/picked/x", use as never) }, { tokens });
      await expect(routeCall(r.r)).rejects.toThrow("comes from the file picker");
      expect(r.sent).toEqual([]);
    }
    let now = 0;
    const timed = new PickTokens(() => now);
    const late = timed.issue(CHARACTER_PART, "/picked/x", "bot.importAvatar");
    now = PICK_TOKEN_MS + 1;
    const expired = editor("bot.importAvatar", { id: "alpha", path: late }, { tokens: timed });
    await expect(routeCall(expired.r)).rejects.toThrow("comes from the file picker");
    // An id main's own listing doesn't hold (a free string, a plugin that isn't a bot, a path): refused, the token kept.
    const held = tokens.issue(CHARACTER_PART, "/picked/x", "bot.importAvatar");
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
    await expect(routeCall(other.r)).rejects.toThrow("bot.importAvatar needs the bots.avatar capability");
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

  test("the bot editor's part gets neither the pick nor the import: the table refuses it before anything else, and the character part's token stays good for the character part", async () => {
    const tokens = new PickTokens();
    let opened = 0;
    const asEditor = (method: string, params: unknown) =>
      route({ tree: { windowId: 1, pluginId: BOT_EDITOR_PART }, method, params, gesture: true, tokens, pick: async () => { opened++; return "/x"; } });
    await expect(routeCall(asEditor("ui.pick", { kind: "file", use: "bot.importAvatar" }).r)).rejects.toThrow("capability");
    expect(opened).toBe(0);
    const held = tokens.issue(CHARACTER_PART, "/picked/x", "bot.importAvatar");
    const imp = asEditor("bot.importAvatar", { id: "alpha", path: held });
    await expect(routeCall(imp.r)).rejects.toThrow("capability");
    expect(imp.calls).toEqual([]);
    const mine = editor("bot.importAvatar", { id: "alpha", path: held }, { tokens });
    await routeCall(mine.r);
    expect(mine.sent.length).toBe(1);
  });

  test("the result names the renderer's own format id and its name, as plain text", async () => {
    const tokens = new PickTokens();
    const { token } = await pickFor(tokens, { kind: "file", use: "bot.importAvatar" });
    const got = await routeCall(editor("bot.importAvatar", { id: "alpha", path: token }, { tokens, request: async (m) => (m === "bot.list" ? appConnection(m) : { format: "pngtuber", name: "Picture swap\u202e", files: 2, bytes: 8 }) }).r);
    expect(got).toEqual({ format: "pngtuber", name: "Picture swap", files: 2, bytes: 8 });
  });

  test("the avatar's two layer fields are the character plugin's alone: it writes nothing else, and the bot editor writes neither", async () => {
    const as = (part: string, patch: unknown) => route({ tree: { windowId: 1, pluginId: part }, method: "bot.setUserLayer", params: { id: "alpha", patch }, gesture: true });
    for (const patch of [{ avatar: { file: "assets/a.vrm", format: "vrm" } }, { avatar: null }, { avatarCredit: "Free for personal use" }, { avatar: null, avatarCredit: null }]) {
      expect(await routeCall(as(CHARACTER_PART, patch).r)).toBe("app");
      // The editor lacks bots.avatar: the layer door (the core's card for a user-layer change), never the app's connection.
      const refused = as(BOT_EDITOR_PART, patch);
      expect(await routeCall(refused.r)).toBe("layer");
      expect(refused.calls).toEqual(["layer"]);
    }
    for (const patch of [{ model: "x/y" }, { avatar: null, lan: true }, { name: "n" }, {}, undefined, []]) {
      // Never the app's connection: refused (a mixture, nothing), or, for other fields than the avatar's (bots.edit, which
      // the stage lacks), the layer door and its card.
      const wide = as(CHARACTER_PART, patch);
      const got = await routeCall(wide.r).then((v) => v, () => "refused");
      expect([patch, got, wide.calls]).toEqual([patch, got === "layer" ? "layer" : "refused", got === "layer" ? ["layer"] : []]);
      expect(wide.calls).not.toContain("app:bot.setUserLayer");
    }
    expect(await routeCall(as(BOT_EDITOR_PART, { model: "x/y", theme: null }).r)).toBe("app");
    const none = route({ tree: { windowId: 1, pluginId: CHARACTER_PART }, method: "bot.setUserLayer", params: { id: "alpha", patch: { avatar: null } }, gesture: false });
    await expect(routeCall(none.r)).rejects.toThrow("only right after");
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
      await expect(routeCall(t.r)).rejects.toThrow("session.resend needs the user.send capability");
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
  const press = (params: unknown, extra: Over = {}) => {
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
    const cases: [unknown, Over][] = [
      [{ entry: "alpha#gone", session: "b_alpha", seq: 7 }, {}],
      [{ entry: "notes#pin", session: "b_alpha", seq: 7 }, {}],
      [{ entry: "../x", session: "b_alpha", seq: 7 }, {}],
      [{ entry: "alpha#pin", session: "", seq: 7 }, {}],
      [{ entry: "alpha#pin", session: "b_alpha", seq: -1 }, {}],
      [{ entry: "alpha#pin", session: "b_alpha", seq: 1.5 }, {}],
      [{ entry: "alpha#pin", session: "b_alpha", seq: 7 }, { gesture: false }],
      // A part that doesn't declare the spot finds no entry in it (the runtime's `entries` is the declarer's own).
      [{ entry: "alpha#pin", session: "b_alpha", seq: 7 }, { tree: { windowId: 1, pluginId: "clover/composer" }, entries: () => [] }],
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

describe("a setting from the bot's Edit page", () => {
  test("names the bot only when it is the plugin's own bot, and only on the bot editor's path (bots.edit)", () => {
    const set = (part: string, p: Record<string, unknown>, forBot = false) => pageParams("plugin.settings.set", p, part, new PickTokens(), forBot);
    expect(set(BOT_EDITOR_PART, { id: "juniper", key: "loud", value: true, bot: "juniper" }, true)).toEqual({ params: { id: "juniper", key: "loud", value: true, bot: "juniper", noSecret: true } });
    expect(set(BOT_EDITOR_PART, { id: "juniper", key: "loud", value: true, bot: "alpha" }, true)).toEqual({ params: { id: "juniper", key: "loud", value: true, noSecret: true } });
    expect(set(PLUGINS_PART, { id: "juniper", key: "loud", value: true, bot: "juniper" })).toEqual({ params: { id: "juniper", key: "loud", value: true, noSecret: true } });
  });
});

describe("a setting from the bot's Edit page goes through the door", () => {
  // A plugin with a plain text setting, a per-bot number in 1..5, a choice, a switch and a key; its bot is "alpha".
  const field = { k: { type: "string" }, n: { type: "number", min: 1, max: 5, scope: "bot" }, c: { type: "enum", options: ["a", "b"] }, token: { type: "secret" } };
  const edit = (method: string, params: unknown, gesture = true) => {
    const sent: { method: string; params: unknown }[] = [];
    const { r } = route({
      tree: { windowId: 1, pluginId: BOT_EDITOR_PART }, method, params, gesture,
      request: async (m, p) => {
        if (m === "bot.list") return { bots: [{ id: "alpha" }, { id: "luna" }] };
        if (m === "plugin.get") return { plugin: { id: "alpha", manifest: { settings: field } } };
        sent.push({ method: m, params: p });
        return "app";
      },
    });
    return { r, sent };
  };

  test("its own bot's plain setting goes through on a press, and not without one", async () => {
    const ok = edit("plugin.settings.set", { id: "alpha", bot: "alpha", key: "k", value: "x" });
    expect(await routeCall(ok.r)).toBe("app");
    expect(ok.sent).toEqual([{ method: "plugin.settings.set", params: { id: "alpha", key: "k", value: "x", noSecret: true } }]);
    const per = edit("plugin.settings.set", { id: "alpha", bot: "alpha", key: "n", value: 3 });
    await routeCall(per.r);
    expect(per.sent).toEqual([{ method: "plugin.settings.set", params: { id: "alpha", key: "n", value: 3, noSecret: true, bot: "alpha" } }]);
    const none = edit("plugin.settings.set", { id: "alpha", bot: "alpha", key: "k", value: "x" }, false);
    await expect(routeCall(none.r)).rejects.toThrow("only right after the user's own");
    expect(none.sent).toEqual([]);
  });

  test("another plugin's id, an unknown bot, or an id that isn't the edited bot's is refused, read or write", async () => {
    for (const method of ["plugin.settings.get", "plugin.settings.set"]) {
      for (const params of [
        { id: "clover/provider-gcp", bot: "alpha", key: "k", value: "x" },
        { id: "luna", bot: "alpha", key: "k", value: "x" },
        { id: "alpha", bot: "nobody", key: "k", value: "x" },
      ]) {
        const t = edit(method, params);
        await expect(routeCall(t.r)).rejects.toThrow("its own bot's settings only");
        expect(t.sent).toEqual([]);
      }
      // Naming no bot is another plugin's settings: the editor's plugins.read reads their view (a key only as set or
      // not); a write takes plugins.manage, which it lacks: the layer door.
      for (const params of [{ id: "alpha", key: "k", value: "x" }, { id: BOT_EDITOR_PART, key: "k", value: "x" }]) {
        const t = edit(method, params);
        const got = await routeCall(t.r).then((v) => v, () => "refused");
        if (method === "plugin.settings.get") expect(t.sent.map((x) => x.method)).toEqual(["plugin.settings.get"]);
        else expect([got, t.sent]).toEqual(["layer", []]);
      }
    }
  });

  test("a key, a value outside its kind's bounds or choices, and an unknown setting are refused", async () => {
    for (const [key, value, why] of [
      ["token", "sk-1", "Clover's own key dialog"],
      ["n", 9, "at most 5"],
      ["n", "3", "takes a number"],
      ["c", "z", ""],
      ["nope", "x", "isn't one of that plugin's settings"],
    ] as const) {
      const t = edit("plugin.settings.set", { id: "alpha", bot: "alpha", key, value });
      await expect(routeCall(t.r)).rejects.toThrow(why);
      expect(t.sent).toEqual([]);
    }
  });

  test("a read goes with the bot named, and the editor changes no other plugin's settings (no plugins.manage)", async () => {
    const t = edit("plugin.settings.get", { id: "alpha", bot: "alpha" });
    await routeCall(t.r);
    expect(t.sent).toEqual([{ method: "plugin.settings.get", params: { id: "alpha", bot: "alpha" } }]);
    expect(verdict(BOT_EDITOR_PART, "plugin.settings.set", { id: "tarot", key: "k", value: 1 })).toMatchObject({ ok: false, owned: false, why: "plugin.settings.set needs the plugins.manage capability" });
  });
});

describe("a key from the bot's Edit page", () => {
  const key = (params: unknown, gesture = true) => {
    let opened = 0;
    const { r } = route({
      tree: { windowId: 1, pluginId: BOT_EDITOR_PART }, method: "ui.secret", params, gesture, openKey: async () => { opened++; return true; },
      request: async (m) => (m === "bot.list" ? { bots: [{ id: "tarot" }] } : appConnection(m)),
    });
    return { r, opened: () => opened };
  };
  test("opens the app's own key dialog for its own bot's key, on a press", async () => {
    const t = key({ id: "tarot", key: "token" });
    expect(await routeCall(t.r)).toEqual({ opened: true });
    expect(t.opened()).toBe(1);
  });
  test("refuses another plugin's key, a sign-in, a plain setting and a call with no press", async () => {
    for (const [params, gesture] of [[{ id: "other", key: "token" }, true], [{ id: "tarot", index: 0 }, true], [{ id: "tarot", key: "k" }, true], [{ id: "tarot", key: "token" }, false]] as const) {
      const t = key(params, gesture);
      await expect(routeCall(t.r)).rejects.toThrow();
      expect(t.opened()).toBe(0);
    }
  });
});
