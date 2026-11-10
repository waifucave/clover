import { describe, expect, test } from "bun:test";
import { routeComposer, type ComposerMount, type ComposerRoute } from "../src/main/ui/composer-calls";

function setup(over: Partial<ComposerRoute> & { gestures?: number } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  let gestures = over.gestures ?? 0;
  const mount: ComposerMount = { windowId: 1, pluginId: "clover/composer", session: "alpha:main", bot: "alpha", tree: true };
  const r: ComposerRoute = {
    composer: mount,
    op: "models",
    args: undefined,
    takeGesture: () => (gestures > 0 ? (gestures--, true) : false),
    asApp: async (m, p) => {
      if (m === "bot.list") return { bots: [{ id: "alpha", mainSession: "alpha:main" }] };
      calls.push(`app:${m}:${JSON.stringify(p)}`);
      return "app";
    },
    asLayer: async (id, m, p) => { calls.push(`layer:${id}:${m}:${JSON.stringify(p)}`); return "layer"; },
    log: (l) => logs.push(l),
    refuse: (why) => new Error(why),
    ...over,
  };
  return { r, calls, logs, mount };
}

describe("the composer spot's callbacks", () => {
  test("a frame that isn't a mounted composer entry is refused every callback", async () => {
    for (const op of ["models", "setModel", "interrupt", "stop"]) {
      const { r, calls } = setup({ composer: undefined, op, args: { model: "a/b" }, gestures: 5 });
      await expect(routeComposer(r)).rejects.toThrow("isn't the entry the core mounted");
      expect(calls).toEqual([]);
    }
  });

  test("an op the spot doesn't offer is refused", async () => {
    const { r, calls } = setup({ op: "session.send", gestures: 1 });
    await expect(routeComposer(r)).rejects.toThrow("not something");
    expect(calls).toEqual([]);
  });

  test("an acting callback without the user's key press or click is refused and logged", async () => {
    for (const op of ["setModel", "interrupt", "stop"]) {
      const { r, calls, logs } = setup({ op, args: { model: "a/b" }, gestures: 0 });
      await expect(routeComposer(r)).rejects.toThrow("only right after the user's own key press or click");
      expect(calls).toEqual([]);
      expect(logs[0]).toContain("refused");
    }
  });

  test("models is a read and needs no gesture", async () => {
    const { r, calls } = setup({ op: "models" });
    expect(await routeComposer(r)).toBe("app");
    expect(calls).toEqual(['app:models.list:{"session":"alpha:main"}']);
  });

  test("one gesture covers one acting call", async () => {
    const { r, calls } = setup({ op: "interrupt", gestures: 1 });
    expect(await routeComposer(r)).toBe("app");
    await expect(routeComposer(r)).rejects.toThrow("only right after");
    expect(calls).toEqual(['app:session.interrupt:{"id":"alpha:main"}']);
  });

  test("stop and interrupt go to the composer's own session only", async () => {
    const { r, calls } = setup({ op: "stop", args: { id: "someone-else" }, gestures: 1 });
    await routeComposer(r);
    expect(calls).toEqual(['app:session.stop:{"id":"alpha:main"}']);
  });

  test("the bundled entry's model switch on a bot's main conversation changes its user layer on the app connection", async () => {
    const { r, calls } = setup({ op: "setModel", args: { model: "a/b", effort: "high" }, gestures: 1 });
    await routeComposer(r);
    expect(calls).toEqual(['app:bot.setUserLayer:{"id":"alpha","patch":{"model":"a/b","effort":"high"}}']);
  });

  test("a third-party entry in the composer spot sends with a gesture, and its bot model switch goes its own layer connection (the card)", async () => {
    const third: ComposerMount = { windowId: 1, pluginId: "vn/composer", session: "alpha:main", bot: "alpha", tree: false };
    const { r, calls } = setup({ composer: third, op: "setModel", args: { model: "a/b" }, gestures: 2 });
    expect(await routeComposer(r)).toBe("layer");
    expect(calls).toEqual(['layer:vn/composer:bot.setUserLayer:{"id":"alpha","patch":{"model":"a/b"}}']);
    const stop = setup({ composer: third, op: "stop", gestures: 1 });
    await routeComposer(stop.r);
    expect(stop.calls).toEqual(['app:session.stop:{"id":"alpha:main"}']);
  });

  test("another session's model switch is session.setModel; a malformed model is refused", async () => {
    const other: ComposerMount = { windowId: 1, pluginId: "clover/composer", session: "s_1", tree: true };
    const { r, calls } = setup({ composer: other, op: "setModel", args: { model: "a/b" }, gestures: 2 });
    await routeComposer(r);
    expect(calls).toEqual(['app:session.setModel:{"id":"s_1","model":"a/b"}']);
    for (const args of [{}, { model: "" }, { model: "x".repeat(201) }, { model: "a/b", effort: 3 }]) {
      const bad = setup({ composer: other, op: "setModel", args, gestures: 1 });
      await expect(routeComposer(bad.r)).rejects.toThrow("not a model");
      expect(bad.calls).toEqual([]);
    }
  });
});
