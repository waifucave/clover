import { describe, expect, test } from "bun:test";
import { LAYER_METHODS } from "../src/main/layer-links";
import { NEVER, SEND_ONLY, TREE_CALLS, treeVerdict } from "../src/main/ui/tree-calls";

const verdict = (part: string, method: string) => treeVerdict(part, method);

describe("the bundled tree's calls on the app's connection", () => {
  test("a read is allowed to any part; a method the table doesn't name isn't its business", () => {
    for (const m of ["models.list", "account.status", "archive.history", "archive.list", "plugin.list", "plugin.get", "plugin.ui", "ui.settings"]) {
      expect(verdict("clover/conversation", m)).toMatchObject({ ok: true });
    }
    expect(verdict("clover/composer", "plugin.logs")).toMatchObject({ ok: false, owned: false });
    expect(verdict("clover/composer", "nonsense.method")).toMatchObject({ ok: false, owned: false });
  });

  test("settings writes (and a plugin's own settings reads) only from the settings part", () => {
    for (const m of ["ui.set", "plugin.setEnabled", "plugin.settings.set", "plugin.settings.get"]) {
      expect(verdict("clover/settings", m)).toMatchObject({ ok: true });
      for (const part of ["clover/conversation", "clover/composer", "clover/shell", "clover/sidebar", "clover/plugin-index"]) {
        expect(verdict(part, m)).toMatchObject({ ok: false, owned: true });
      }
    }
  });

  test("session control is a gesture call", () => {
    for (const m of ["session.setModel", "session.interrupt", "session.stop"]) expect(verdict("clover/composer", m)).toMatchObject({ ok: true, call: { disposition: "gesture" } });
  });

  test("a send is never a bare call, the cards are never answered, trust-changing calls need a card", () => {
    for (const m of SEND_ONLY) expect(verdict("clover/composer", m)).toMatchObject({ ok: false, owned: true });
    for (const m of NEVER) expect(verdict("clover/settings", m)).toMatchObject({ ok: false, owned: true });
    for (const m of ["computer.setLevel", "device.pair.begin", "device.pair.cancel", "device.pair.confirm", "device.pair.join", "device.revoke", "main.set"]) {
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

import { routeCall, type TreeRoute } from "../src/main/ui/tree-calls";

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

  test("session control without the user's gesture is refused; with one it goes, once", async () => {
    for (const method of ["session.setModel", "session.interrupt", "session.stop"]) {
      const none = route({ method, gesture: false });
      await expect(routeCall(none.r)).rejects.toThrow("only right after the user's own key press or click");
      expect(none.calls).toEqual([]);
      const some = route({ method, gesture: true });
      expect(await routeCall(some.r)).toBe("app");
    }
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
    const { r, calls } = route({ method: "plugin.logs" });
    expect(await routeCall(r)).toBe("layer");
    expect(calls).toEqual(["layer"]);
  });

  test("a bot's user layer is the composer's (model and effort only) or the editor's, with the user's click", async () => {
    const model = { id: "alpha", patch: { model: "a/b", effort: "high" } };
    const some = route({ tree: { windowId: 1, pluginId: "clover/composer" }, method: "bot.setUserLayer", params: model, gesture: true });
    expect(await routeCall(some.r)).toBe("app");
    const none = route({ tree: { windowId: 1, pluginId: "clover/composer" }, method: "bot.setUserLayer", params: model, gesture: false });
    await expect(routeCall(none.r)).rejects.toThrow("only right after");
    const wide = route({ tree: { windowId: 1, pluginId: "clover/composer" }, method: "bot.setUserLayer", params: { id: "alpha", patch: { instructions: "x" } }, gesture: true });
    await expect(routeCall(wide.r)).rejects.toThrow("model and effort only");
    const editor = route({ tree: { windowId: 1, pluginId: "clover/bot-editor" }, method: "bot.setUserLayer", params: { id: "alpha", patch: { instructions: "x" } }, gesture: true });
    expect(await routeCall(editor.r)).toBe("app");
    const other = route({ tree: { windowId: 1, pluginId: "clover/settings" }, method: "bot.setUserLayer", params: model, gesture: true });
    await expect(routeCall(other.r)).rejects.toThrow("only from");
  });
});
