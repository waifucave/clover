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

  describe("the slash menu's commands", () => {
    // command.list as the core answers it, and the plugins it names: running, off, waiting for its OK, a child of a
    // running plugin, the bot's own (alpha), and one whose top-level plugin stopped.
    const COMMANDS = [
      { name: "tarot.draw", pluginId: "tarot", description: "Draw", args: { type: "object" } },
      { name: "alpha.wave", pluginId: "alpha", description: "Wave" },
      { name: "off.thing", pluginId: "off", description: "Off" },
      { name: "found.thing", pluginId: "found", description: "Not OK'd" },
      { name: "tarot.spread", pluginId: "tarot/spreads", description: "Child" },
      { name: "gone.child", pluginId: "gone/kid", description: "Orphan" },
    ];
    const PLUGINS = [
      { id: "tarot", name: "Tarot", enabled: true, state: "running", scope: "both" },
      { id: "alpha", name: "Alpha", enabled: true, state: "running", scope: "bots" },
      { id: "off", name: "Off", enabled: false, state: "off" },
      { id: "found", name: "Found", enabled: true, state: "found" },
      { id: "tarot/spreads", name: "Spreads", enabled: true, state: "running" },
      { id: "gone", name: "Gone", enabled: true, state: "stopped" },
      { id: "gone/kid", name: "Kid", enabled: true, state: "running" },
    ];
    const lists = (calls: string[]) => async (m: string, p: unknown) => {
      if (m === "command.list") return { commands: COMMANDS };
      if (m === "plugin.list") return { plugins: PLUGINS };
      if (m === "bot.list") return { bots: [] };
      calls.push(`app:${m}:${JSON.stringify(p)}`);
      return { result: "ran" };
    };

    test("commands lists only running, OK'd plugins' commands, the bot's own first, with each plugin's name and scope; a read, no gesture", async () => {
      const calls: string[] = [];
      const { r, logs } = setup({ op: "commands", asApp: lists(calls) });
      const out = (await routeComposer(r)) as { commands: { name: string; pluginName: string; own: boolean; scope?: string }[] };
      expect(out.commands.map((c) => c.name)).toEqual(["alpha.wave", "tarot.draw", "tarot.spread"]);
      expect(out.commands[0]).toMatchObject({ pluginName: "Alpha", own: true, scope: "bots" });
      expect(out.commands[1]).toMatchObject({ pluginName: "Tarot", own: false, args: { type: "object" } });
      expect(calls).toEqual([]);
      expect(logs).toEqual([]);
    });

    test("runCommand runs a listed command on the app's own connection (as the user), with its args, after one gesture", async () => {
      const calls: string[] = [];
      const { r, logs } = setup({ op: "runCommand", args: { name: "tarot.draw", args: { cards: 2 } }, gestures: 1, asApp: lists(calls) });
      expect(await routeComposer(r)).toEqual({ result: "ran" });
      expect(calls).toEqual(['app:command.run:{"name":"tarot.draw","args":{"cards":2}}']);
      // The log names the op, never the command's args.
      expect(logs.join("\n")).toContain("runCommand went through");
      expect(logs.join("\n")).not.toContain("cards");
      await expect(routeComposer(r)).rejects.toThrow("only right after your own key press or click");
      expect(calls.length).toBe(1);
    });

    test("runCommand refuses a command that isn't running here, an off or un-OK'd plugin's, or a bad name, spending no gesture", async () => {
      for (const name of ["off.thing", "found.thing", "gone.child", "nope.nothing", "", 3, "x".repeat(129)]) {
        const calls: string[] = [];
        let spent = 0;
        const { r } = setup({ op: "runCommand", args: { name }, asApp: lists(calls), takeGesture: () => (spent++, true) });
        await expect(routeComposer(r)).rejects.toThrow(/no command|not a command/);
        expect(calls).toEqual([]);
        expect(spent).toBe(0);
      }
    });

    test("args that aren't data, or too many of them, are refused", async () => {
      const calls: string[] = [];
      const loop: Record<string, unknown> = {};
      loop.self = loop;
      for (const [args, why] of [[loop, "are data"], [{ text: "x".repeat(100_001) }, "too much"]] as const) {
        const { r } = setup({ op: "runCommand", args: { name: "tarot.draw", args }, gestures: 1, asApp: lists(calls) });
        await expect(routeComposer(r)).rejects.toThrow(why);
      }
      expect(calls).toEqual([]);
    });

    test("a third party's composer in the spot gets neither: it can't run every plugin's command as the user", async () => {
      const third: ComposerMount = { windowId: 1, pluginId: "vn/composer", session: "alpha:main", bot: "alpha", tree: false };
      for (const op of ["commands", "runCommand"]) {
        const calls: string[] = [];
        const { r } = setup({ composer: third, op, args: { name: "tarot.draw" }, gestures: 1, asApp: lists(calls) });
        await expect(routeComposer(r)).rejects.toThrow("only Clover's own composer");
        expect(calls).toEqual([]);
      }
    });
  });

  describe("push-to-talk: listenStatus, listenStart, listenStop", () => {
    const holds = () => {
      const log: string[] = [];
      return { log, holds: { start: async (w: number, bot: string) => { log.push(`start:${w}:${bot}`); return {}; }, stop: async (w: number) => { log.push(`stop:${w}`); return { text: "heard" }; } } };
    };

    test("the status is a read of the composer's own bot, with no gesture", async () => {
      const calls: string[] = [];
      const { r } = setup({ op: "listenStatus", asApp: async (m, p) => { calls.push(`${m}:${JSON.stringify(p)}`); return { listens: true }; } });
      expect(await routeComposer(r)).toEqual({ listens: true });
      expect(calls).toEqual(['voice.status:{"bot":"alpha"}']);
    });

    test("a start needs the user's own press, takes it last, and names the mount's bot and window, never the page's", async () => {
      const h = holds();
      const none = setup({ op: "listenStart", args: { bot: "someone-else" }, gestures: 0, listens: h.holds });
      await expect(routeComposer(none.r)).rejects.toThrow("only right after your own key press or click");
      expect(h.log).toEqual([]);
      const { r } = setup({ op: "listenStart", args: { bot: "someone-else", session: "x" }, gestures: 1, listens: h.holds });
      expect(await routeComposer(r)).toEqual({});
      expect(h.log).toEqual(["start:1:alpha"]);
      // One press covers one recording.
      await expect(routeComposer(r)).rejects.toThrow("only right after your own");
      expect(h.log).toEqual(["start:1:alpha"]);
    });

    test("a stop is the release: it needs no gesture and answers what was heard", async () => {
      const h = holds();
      const { r, logs } = setup({ op: "listenStop", gestures: 0, listens: h.holds });
      expect(await routeComposer(r)).toEqual({ text: "heard" });
      expect(h.log).toEqual(["stop:1"]);
      expect(logs.some((l) => l.includes("listenStop went through"))).toBe(true);
    });

    test("an app without holds, a conversation with no bot, and a third party's composer are refused all three", async () => {
      const h = holds();
      for (const op of ["listenStatus", "listenStart", "listenStop"]) {
        // No holds (an app that can't record): the status is still a read of the core's; a start and a stop are refused.
        if (op !== "listenStatus") await expect(routeComposer(setup({ op, gestures: 1 }).r)).rejects.toThrow("can't record");
        const agent = setup({ composer: { windowId: 1, pluginId: "clover/composer", session: "agent-1", tree: true }, op, gestures: 1, listens: h.holds });
        await expect(routeComposer(agent.r)).rejects.toThrow("no bot");
        const third: ComposerMount = { windowId: 1, pluginId: "vn/composer", session: "alpha:main", bot: "alpha", tree: false };
        const t = setup({ composer: third, op, gestures: 1, listens: h.holds });
        await expect(routeComposer(t.r)).rejects.toThrow("only Clover's own composer");
      }
      expect(h.log).toEqual([]);
    });
  });
});
