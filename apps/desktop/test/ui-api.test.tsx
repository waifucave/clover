// The UI API in a layer (`packages/plugin-sdk/src/ui`), with a fake bridge standing in for the main process: an entry
// renders with its props and tokens; `<Spot>` mounts inline parts from the layer's own modules, frames for other
// layers' parts with their props handed across (callbacks as markers the core routes back), nothing for a hidden
// part, and a reload button when a frame's layer stops.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LayerBridge, LayerMessage, MountInfo, SpotView } from "@waifucave/moss-plugin-sdk/ui/bridge";

// Frames never load here: their documents are the main process's (the Electron UI test loads them).
GlobalRegistrator.register({ settings: { navigation: { disableChildFrameNavigation: true } } });
// The tests share one rendered layer, so the library must not unmount it after each.
process.env.RTL_SKIP_AUTO_CLEANUP = "true";
const { act, cleanup, render } = await import("@testing-library/react");
const ui = await import("@waifucave/moss-plugin-sdk/ui");
const { createElement: h, useState } = await import("react");
// The SDK's example renderer, as a third-party `avatar` entry (its own frame in the app).

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

const CTX = { os: "macos" as const, material: "vibrancy" as const, safeMode: false, window: { narrow: false } };

function fakeBridge(views: Record<string, SpotView>) {
  const listeners = new Set<(m: LayerMessage) => void>();
  const calls: { op: string; args: unknown[] }[] = [];
  const bridge: LayerBridge = {
    token: "t",
    describe: async () => ({}) as MountInfo,
    resolve: async (mount, spot, key) => {
      calls.push({ op: "resolve", args: [mount, spot, key] });
      return views[`${mount}:${spot}${key !== undefined ? `[${key}]` : ""}`] ?? { spot, shape: "single", items: [], hidden: false, conflict: false, undeclared: true };
    },
    setProps: (child, props) => calls.push({ op: "setProps", args: [child, props] }),
    callback: (id, args) => calls.push({ op: "callback", args: [id, args] }),
    reportSize: () => {},
    shell: async (mount, method, args) => {
      calls.push({ op: "shell", args: [mount, method, args] });
      return undefined;
    },
    shellReport: (mount, report) => calls.push({ op: "shellReport", args: [mount, report] }),
    release: (mounts) => calls.push({ op: "release", args: [mounts] }),
    reload: async (child) => {
      calls.push({ op: "reload", args: [child] });
      return "moss-plugin://other/?mount=fresh";
    },
    sleep: (child) => calls.push({ op: "sleep", args: [child] }),
    wake: async (child) => {
      calls.push({ op: "wake", args: [child] });
      return "moss-plugin://vn/?mount=woken";
    },
    rectReply: (id, rect) => calls.push({ op: "rectReply", args: [id, rect] }),
    menu: async (mount, items, x, y) => {
      calls.push({ op: "menu", args: [mount, items, x, y] });
      return "copy";
    },
    surface: (request) => calls.push({ op: "surface", args: [request] }),
    surfaceEnvironment: async () => ({ os: "macos", display: { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 }, notch: null } }),
    open: async (mount, target) => {
      calls.push({ op: "open", args: [mount, target] });
    },
    viewFrame: (mount, name, rect, used) => calls.push({ op: "viewFrame", args: [mount, name, rect, used] }),
    webFrame: (mount, rect) => calls.push({ op: "webFrame", args: [mount, rect] }),
    activeSession: (mount, session) => calls.push({ op: "activeSession", args: [mount, session] }),
    windowDrag: (mount) => { calls.push({ op: "windowDrag", args: [mount] }); },
    composer: async (mount, op, args) => { calls.push({ op: "composer", args: [mount, op, args] }); return undefined; },
    entries: async (mount, spot, key) => {
      calls.push({ op: "entries", args: [mount, spot, key] });
      return [{ ref: "moss/island#usage", id: "usage", pluginId: "moss/island", pluginName: "Island", bundled: true, fields: { title: "Usage" } }, { ref: "vn#tab", id: "tab", pluginId: "vn", pluginName: "VN", bundled: false, fields: { title: "VN" } }];
    },
    api: async (mount, method, params) => {
      calls.push({ op: "api", args: [mount, method, params] });
      return method === "terminal.open" ? { terminalId: "term_1" } : method === "session.get" ? { session: { id: "s", computer: "Laptop" } }
        : method === "card.pending" ? { cards: pendingAtMount.map((id) => ({ id, computers: ["Studio"] })) } : { ok: true };
    },
    terminalInput: async (mount, terminalId, input) => {
      calls.push({ op: "terminalInput", args: [mount, terminalId, input] });
    },
    userSend: async (mount, to, message) => {
      calls.push({ op: "userSend", args: [mount, to, message] });
      return {};
    },
    dragOffer: async (mount, offer) => {
      calls.push({ op: "dragOffer", args: [mount, offer] });
      return { token: "g1" };
    },
    dragClaim: async (mount: string, token: string) => {
      calls.push({ op: "dragClaim", args: [mount, token] });
      return { type: "text/plain", data: "dropped" };
    },
    sealedFrame: async (mount: string, cardId: string, element: string) => {
      calls.push({ op: "sealedFrame", args: [mount, cardId, element] });
      return `moss-sealed://card/${cardId}/${element}?token=x`;
    },
    onMessage: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { bridge, calls, emit: (m: LayerMessage) => listeners.forEach((l) => l(m)) };
}

const tick = () => act(async () => {
  await new Promise((r) => setTimeout(r, 10));
});

// IntersectionObserver as the frames see it: the test says whether each observed element is near the screen.
const observers = new Set<{ cb: (e: { isIntersecting: boolean }[]) => void; els: Set<Element> }>();
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  private o: { cb: (e: { isIntersecting: boolean }[]) => void; els: Set<Element> };
  constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
    this.o = { cb, els: new Set() };
    observers.add(this.o);
  }
  observe(el: Element) {
    this.o.els.add(el);
  }
  disconnect() {
    observers.delete(this.o);
  }
};
function setNear(near: boolean) {
  for (const o of observers) if (o.els.size > 0) o.cb([{ isIntersecting: near }]);
}
/** The cards `card.pending` answers with (what was pending before a part mounted). */
const pendingAtMount: string[] = ["card_before"];

let vnApi: ReturnType<typeof ui.usePluginApi> | undefined;
/** A third-party plugin's page, in its own layer. */
const VnPage = () => {
  vnApi = ui.usePluginApi();
  return h("p", null, "vn");
};
const hooks: { cards?: () => readonly { id: string }[]; api?: ReturnType<typeof ui.usePluginApi>; entries?: () => readonly { ref: string }[]; loaded?: () => boolean; questions?: () => readonly unknown[]; userSend?: unknown; t?: (key: string, params?: Record<string, string | number>) => string; menu?: () => Promise<string | null>; offer?: () => Promise<string | undefined>; claim?: () => Promise<unknown>; open?: () => Promise<void>; env?: unknown } = {};

/** A window's columns: its `main` and `panel` spots, and the `sidebar` for a frame that is not a fill spot. */
const Columns = () => h("div", null, h(ui.Spot, { name: "main", spotKey: "editor" }), h(ui.Spot, { name: "panel", spotKey: "side" }), h(ui.Spot, { name: "bar" }));
const NarrowProbe = () => {
  const ctx = ui.useMountContext();
  return h("p", { "data-narrow-probe": String(ctx.window.narrow) });
};
const wait = (ms: number) => act(async () => {
  await new Promise((r) => setTimeout(r, ms));
});

describe("the UI API in a layer", () => {
  let fake: ReturnType<typeof fakeBridge>;
  const views: Record<string, SpotView> = {};
  const seen: unknown[] = [];

  beforeAll(() => {
    fake = fakeBridge(Object.assign(views, {
      "m1:sidebar": { spot: "sidebar", shape: "single", hidden: false, conflict: false, items: [{ kind: "inline", mount: "m2", ref: "moss/sidebar#sidebar", pluginId: "moss/sidebar", entryId: "sidebar", component: "Sidebar", context: CTX, tokens: { "color.accent": "#123456" } }] },
      "m1:composer": { spot: "composer", shape: "single", hidden: false, conflict: false, items: [{ kind: "frame", mount: "m3", ref: "vn#composer", pluginId: "vn", entryId: "composer", layer: "vn", url: "moss-plugin://vn/?mount=abc" }] },
      "m1:status": { spot: "status", shape: "list", hidden: true, conflict: false, items: [] },
    }));
    const Shell = ({ props, tokens }: { props: { title: string }; tokens: Record<string, unknown> }) =>
      h("main", { "data-title": props.title, "data-accent": String(tokens["color.accent"]) },
        h(ui.Spot, { name: "sidebar", props: { route: "alpha" } }),
        h(ui.Spot, { name: "composer", props: { bot: "alpha", onSend: (text: string) => seen.push(text) } }),
        h(ui.Spot, { name: "status" }),
        h(ui.Spot, { name: "never-declared" }));
    const Sidebar = ({ props, entry }: { props: { route: string }; entry: { pluginId: string } }) => {
      const tokens = ui.useTokens();
      hooks.t = ui.useT();
      const list = ui.useSpotEntries("island.tab");
      hooks.entries = () => list.entries;
      hooks.loaded = () => list.loaded;
      const q = ui.useQuestions();
      hooks.questions = () => q.questions;
      hooks.userSend = ui.useUserSend();
      hooks.api = ui.usePluginApi();
      const approvals = ui.useApprovals();
      hooks.cards = () => approvals.cards;
      const menu = ui.useMenu();
      const drag = ui.useDrag();
      const open = ui.useOpen();
      hooks.env = ui.useSurfaceEnvironment();
      hooks.open = () => open({ kind: "settings", section: "devices", item: "laptop" });
      const viewRef = ui.useViewFrame("browser");
      hooks.menu = () => menu([{ id: "copy", label: "Copy" }], { x: 3, y: 4 });
      hooks.offer = () => drag.offer({ type: "text/plain", data: "a row" });
      hooks.claim = () => drag.claim("g1");
      return h("nav", { "data-route": props.route, "data-plugin": entry.pluginId, "data-accent": String(tokens["color.accent"]) }, h("div", { ref: viewRef, "data-live-view": "" }));
    };
    ui.configureLayer({ bridge: fake.bridge, modules: { "moss/shell": { Window: Shell }, "moss/sidebar": { Sidebar }, vn: { VnPage }, "test/fill": { Columns, NarrowProbe } }, sleepAfterMs: 30 });
  });

  test("the document's entry renders with its props and tokens; an inline part from the same layer with its own", async () => {
    const info: MountInfo = { mount: "m1", pluginId: "moss/shell", entryId: "app.root", component: "Window", spot: "app.root", props: { title: "MOSS" }, tokens: { "color.accent": "#2F6FDF" }, context: CTX, css: [] };
    const { container } = render(h(ui.LayerRoot, { info }));
    await tick();
    expect(container.querySelector("main")?.getAttribute("data-title")).toBe("MOSS");
    expect(container.querySelector("main")?.getAttribute("data-accent")).toBe("#2F6FDF");
    const nav = container.querySelector("nav")!;
    expect(nav.getAttribute("data-route")).toBe("alpha");
    expect(nav.getAttribute("data-plugin")).toBe("moss/sidebar");
    // Another tab's (or a dressed part's) tokens: on the part, as custom properties and through the hook.
    expect(nav.getAttribute("data-accent")).toBe("#123456");
    expect((nav.parentElement as HTMLElement).style.getPropertyValue("--moss-color-accent")).toBe("#123456");
    // Tokens reach the document as custom properties.
    expect(document.documentElement.style.getPropertyValue("--moss-color-accent")).toBe("#2F6FDF");
    // Light to dark: one message updates the document's and the part's; the part keeps its new ones (the parent's
    // change never puts back the tokens it was resolved with).
    await act(async () => fake.emit({ type: "tokens", tokens: { m1: { "color.accent": "#0A0A0A" }, m2: { "color.accent": "#FEDCBA" } } }));
    await tick();
    expect(container.querySelector("nav")!.getAttribute("data-accent")).toBe("#FEDCBA");
    expect((container.querySelector("nav")!.parentElement as HTMLElement).style.getPropertyValue("--moss-color-accent")).toBe("#FEDCBA");
    await act(async () => fake.emit({ type: "tokens", tokens: { m1: { "color.accent": "#2F6FDF" }, m2: { "color.accent": "#123456" } } }));
    await tick();
    expect(container.querySelector("nav")!.getAttribute("data-accent")).toBe("#123456");
  });

  test("a part from another layer is a frame; its props cross with callbacks as markers the core routes back", async () => {
    const frame = document.querySelector('iframe[data-moss-entry="vn#composer"]') as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("moss-plugin://vn/?mount=abc");
    expect(frame.getAttribute("allow")).toBe("");
    const set = fake.calls.find((c) => c.op === "setProps" && c.args[0] === "m3")!;
    expect(set.args[1]).toEqual({ bot: "alpha", onSend: { "$moss.callback": "1" } });
    await act(async () => fake.emit({ type: "callback", child: "m3", id: "1", args: ["hello"] }));
    expect(seen).toEqual(["hello"]);
    await act(async () => fake.emit({ type: "child-size", child: "m3", height: 64 }));
    expect(frame.style.height).toBe("64px");
  });

  test("a frame's props cross when they changed, not at every draw of the part that holds it (an equal object each draw is no message)", async () => {
    const sets = () => fake.calls.filter((c) => c.op === "setProps" && c.args[0] === "m3").length;
    expect(sets()).toBe(1);
    // The shell draws again (a token change redraws it, and its spot's props are a new object each draw): nothing goes.
    await act(async () => fake.emit({ type: "tokens", tokens: { m1: { "color.accent": "#111111" } } }));
    await tick();
    await act(async () => fake.emit({ type: "tokens", tokens: { m1: { "color.accent": "#2F6FDF" } } }));
    await tick();
    expect(sets()).toBe(1);
  });

  test("a hidden part and an undeclared spot show nothing", () => {
    expect(document.querySelector('[data-moss-spot="status"]')?.getAttribute("data-moss-empty")).toBe("hidden");
    expect(document.querySelector('[data-moss-spot="never-declared"]')?.getAttribute("data-moss-empty")).toBe("waiting");
  });

  test("a frame whose layer stopped shows a reload, which loads a fresh single-use URL", async () => {
    await act(async () => fake.emit({ type: "child-gone", child: "m3", reason: "its layer stopped" }));
    const button = document.querySelector('[data-moss-gone] button') as HTMLButtonElement;
    expect(button.textContent).toBe("Reload");
    await act(async () => button.click());
    await tick();
    expect(fake.calls.some((c) => c.op === "reload" && c.args[0] === "m3")).toBe(true);
    expect(document.querySelector('iframe[data-moss-entry="vn#composer"]')?.getAttribute("src")).toBe("moss-plugin://other/?mount=fresh");
  });

  test("the core asks where a child frame is (the menu broker); a part's menu and drags go through the core", async () => {
    await act(async () => fake.emit({ type: "rect-query", id: "q1", child: "m3" }));
    const reply = fake.calls.find((c) => c.op === "rectReply")!;
    expect(reply.args[0]).toBe("q1");
    expect(reply.args[1]).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
    await act(async () => fake.emit({ type: "rect-query", id: "q2", child: "nobody" }));
    expect(fake.calls.find((c) => c.op === "rectReply" && c.args[0] === "q2")!.args[1]).toBeNull();
    expect(await hooks.menu!()).toBe("copy");
    expect(fake.calls.find((c) => c.op === "menu")!.args).toEqual(["m2", [{ id: "copy", label: "Copy" }], 3, 4]);
    expect(await hooks.offer!()).toBe("g1");
    expect(await hooks.claim!()).toEqual({ type: "text/plain", data: "dropped" });
    expect(fake.calls.find((c) => c.op === "dragOffer")!.args).toEqual(["m2", { type: "text/plain", data: "a row" }]);
  });

  test("a part opens Settings at a section and an item; a surface's part reads its environment, kept current", async () => {
    await hooks.open!();
    expect(fake.calls.find((c) => c.op === "open")!.args).toEqual(["m2", { kind: "settings", section: "devices", item: "laptop" }]);
    expect(hooks.env).toMatchObject({ os: "macos", display: { workArea: { y: 37 }, notch: null } });
    await act(async () => fake.emit({ type: "surface-environment", environment: { os: "linux", session: "wayland", display: { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 }, notch: null } } }));
    expect(hooks.env).toMatchObject({ os: "linux", session: "wayland" });
  });

  test("a native view's frame: placed (as used), moved, used, and gone with its part", async () => {
    const el = document.querySelector("[data-live-view]") as HTMLElement;
    let box = { x: 10, y: 20, width: 300, height: 200 };
    el.getBoundingClientRect = () => ({ ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box }) as DOMRect;
    const frames = () => fake.calls.filter((c) => c.op === "viewFrame");
    // happy-dom lays nothing out: the first report saw no size, so it said "no place"; a measure finds the box.
    await act(async () => {
      await new Promise((r) => setTimeout(r, ui.VIEW_FRAME_POLL_MS + 20));
    });
    expect(frames().at(-1)!.args).toEqual(["m2", "browser", { x: 10, y: 20, width: 300, height: 200 }, undefined]);
    box = { ...box, y: 40 };
    await act(async () => {
      await new Promise((r) => setTimeout(r, ui.VIEW_FRAME_POLL_MS + 20));
    });
    expect(frames().at(-1)!.args[2]).toMatchObject({ y: 40 });
    el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(frames().at(-1)!.args).toEqual(["m2", "browser", { x: 10, y: 40, width: 300, height: 200 }, true]);
  });

  test("a frame away from the screen a while sleeps, keeping its place, and wakes with a fresh URL when it comes near", async () => {
    await act(async () => setNear(false));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(fake.calls.some((c) => c.op === "sleep" && c.args[0] === "m3")).toBe(true);
    const placeholder = document.querySelector('[data-moss-entry="vn#composer"][data-moss-asleep]') as HTMLElement;
    expect(placeholder).not.toBeNull();
    expect(document.querySelector('iframe[data-moss-entry="vn#composer"]')).toBeNull();
    await act(async () => setNear(true));
    await tick();
    expect(fake.calls.some((c) => c.op === "wake" && c.args[0] === "m3")).toBe(true);
    expect(document.querySelector('iframe[data-moss-entry="vn#composer"]')?.getAttribute("src")).toBe("moss-plugin://vn/?mount=woken");
  });

  test("a registry change resolves every spot again", async () => {
    const before = fake.calls.filter((c) => c.op === "resolve").length;
    await act(async () => fake.emit({ type: "respot" }));
    await tick();
    expect(fake.calls.filter((c) => c.op === "resolve").length).toBeGreaterThanOrEqual(before + 4);
  });

  test("the themes' sheets go in the head in the core's order and follow its changes; each part carries its mark", async () => {
    // The marks a sheet's `@scope` finds: the document's part on its root, an inline part on its wrapper.
    expect(document.documentElement.getAttribute("data-moss-part")).toBe("m1");
    expect(document.querySelector('[data-moss-entry="moss/sidebar#sidebar"]')?.getAttribute("data-moss-part")).toBe("m2");
    const ids = () => Array.from(document.head.querySelectorAll("style[data-moss-sheet]")).map((e) => `${e.getAttribute("data-moss-sheet")}=${e.textContent}`);
    await act(async () => fake.emit({ type: "sheets", sheets: [{ id: "base:moss/base-theme", css: "a{}" }, { id: "bot:luna:m2", css: "b{}" }] }));
    expect(ids()).toEqual(["base:moss/base-theme=a{}", "bot:luna:m2=b{}"]);
    // They come after the part's own stylesheets.
    const link = document.createElement("link");
    document.head.insertBefore(link, document.head.firstChild);
    await act(async () => fake.emit({ type: "sheets", sheets: [{ id: "bot:luna:m2", css: "c{}" }, { id: "user", css: "d{}" }] }));
    expect(ids()).toEqual(["bot:luna:m2=c{}", "user=d{}"]);
    expect(document.head.firstElementChild).toBe(link);
    link.remove();
  });

  test("strings: the core's table, in its language, kept current; a key with no string reads as itself", async () => {
    expect(hooks.t!("moss.sidebar.files", { count: 2 })).toBe("moss.sidebar.files");
    await act(async () => fake.emit({ type: "strings", strings: { lang: "fr", strings: { "moss.sidebar.files": { one: "{count} fichier", other: "{count} fichiers" } } } }));
    expect(hooks.t!("moss.sidebar.files", { count: 1 })).toBe("1 fichier");
    expect(hooks.t!("moss.sidebar.files", { count: 1200 })).toBe("1\u202f200 fichiers");
    expect(document.documentElement.lang).toBe("fr");
  });

  test("a bot's tab layout is retired with the bot tab (G8): an item that still carries one draws only the retirement words, no layout and no spot", async () => {
    views["m1:never-declared"] = { spot: "never-declared", shape: "single", hidden: false, conflict: false, items: [{
      kind: "inline", mount: "m20", ref: "luna#layout", pluginId: "luna", entryId: "layout", component: "$layout", context: CTX, tab: "luna",
      layout: { kind: "row", children: [{ kind: "column", children: [{ kind: "text", text: "a layout's own words" }, { kind: "spot", spot: "conversation" }] }] },
    }] };
    await act(async () => fake.emit({ type: "respot" }));
    await tick();
    const part = document.querySelector('[data-moss-part="m20"]')!;
    expect(part.textContent).toBe("A bot's tab layout is retired with the bot tab: nothing draws it.");
    expect(part.querySelector("[data-moss-layout]")).toBeNull();
    expect(part.textContent).not.toContain("a layout's own words");
    expect(fake.calls).not.toContainEqual({ op: "resolve", args: ["m20", "conversation", undefined] });
  });

  test("a spot's entries for its declaring part, and one entry shown by its ref; questions; the moss tree's parts have useUserSend", async () => {
    await tick();
    expect(hooks.entries!().map((e) => e.ref)).toEqual(["moss/island#usage", "vn#tab"]);
    // Answered: a list that is empty before the first answer says so (`loaded` false), so a host does not read it as the spot being unfilled.
    expect(hooks.loaded!()).toBe(true);
    expect(fake.calls).toContainEqual({ op: "entries", args: ["m2", "island.tab", undefined] });
    // The questions the core sends (to a plugin that may read them), kept current.
    expect(hooks.questions!()).toEqual([]);
    const q = { session: "s_alpha", callId: "c1", at: 1, questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }] };
    await act(async () => fake.emit({ type: "questions", questions: [q] }));
    expect(hooks.questions!()).toEqual([q]);
    // A part of the bundled moss tree has the hook (the main process decides again, and gates the key press or
    // click); the runtime test covers a part of any other layer being refused there.
    expect(hooks.userSend).toBeDefined();
  });

  test("the plugin API in a layer: the terminal on the part's own connection, written only from trusted input", async () => {
    const term = hooks.api!.terminal!;
    expect(await term.open({ computer: "Laptop", cols: 80, rows: 24 })).toEqual({ terminalId: "term_1" });
    // (The sidebar's last-drawn copy is the one whose hooks the test holds: the calls name its mount.)
    const opened = fake.calls.find((c) => c.op === "api" && c.args[1] === "terminal.open")!;
    const mount = opened.args[0];
    expect(opened.args).toEqual([mount, "terminal.open", { computer: "Laptop", cols: 80, rows: 24 }]);
    // A made-up event sends nothing; the user's own key press goes to the core, which derives its bytes itself.
    await expect(term.input("term_1", { type: "keydown", isTrusted: false } as never)).rejects.toThrow("only the user's own");
    await term.input("term_1", { type: "keydown", isTrusted: true, key: "l" } as never);
    await term.input("term_1", { type: "paste", isTrusted: true } as never);
    expect(fake.calls.filter((c) => c.op === "terminalInput").map((c) => c.args)).toEqual([[mount, "term_1", { kind: "key", key: "l" }], [mount, "term_1", { kind: "paste" }]]);
    // Output, from the plugin's own connection's events: subscribed once, for this terminal only.
    const got: string[] = [];
    const off = term.onData("term_1", (d) => got.push(d));
    await act(async () => {
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "terminal_output", terminalId: "term_1", data: "$ " } });
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "terminal_output", terminalId: "term_2", data: "other" } });
      fake.emit({ type: "api-event", pluginId: "someone-else", method: "core.event", params: { type: "terminal_output", terminalId: "term_1", data: "not mine" } });
    });
    off();
    expect(got).toEqual(["$ "]);
    expect(fake.calls).toContainEqual({ op: "api", args: [mount, "events.subscribe", { areas: ["computers"] }] });
    expect((await hooks.api!.conversation!.get!("s")) as unknown).toEqual({ id: "s", computer: "Laptop" });
  });

  test("the plugin API in a layer: bots.watch hears a changed bot, and, when asked, a removed one's id", async () => {
    const changed: string[] = [];
    const removed: string[] = [];
    const off = hooks.api!.bots!.watch((b) => changed.push(b.id), (id) => removed.push(id));
    await act(async () => {
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "bot_changed", bot: { id: "luna" } } });
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "bot_removed", id: "luna" } });
      fake.emit({ type: "api-event", pluginId: "someone-else", method: "core.event", params: { type: "bot_removed", id: "not-mine" } });
    });
    off();
    expect([changed, removed]).toEqual([["luna"], ["luna"]]);
    // With no `onRemoved`, nothing more is subscribed and a removal is not heard.
    const only: string[] = [];
    const offOnly = hooks.api!.bots!.watch((b) => only.push(b.id));
    await act(async () => fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "bot_removed", id: "luna" } }));
    offOnly();
    expect(only).toEqual([]);
  });

  test("the plugin API in a layer: its own plugin's host half and store, on its own connection; its messages only", async () => {
    const api = hooks.api!;
    fake.calls.length = 0;
    await api.host.call("draw", { card: "The Star" });
    await api.storage.synced.get("stage");
    await api.storage.synced.keys();
    const mine = fake.calls.filter((c) => c.op === "api");
    const mount = mine[0]!.args[0];
    expect(mine.map((c) => c.args)).toEqual([
      [mount, "plugin.layer.call", { call: "host.call", args: ["draw", { card: "The Star" }] }],
      [mount, "plugin.layer.call", { call: "storage.synced.get", args: ["stage"] }],
      [mount, "plugin.layer.call", { call: "storage.synced.keys", args: [] }],
    ]);
    // A component never writes its store (its host half does) and has no ui.send.
    await expect(api.storage.synced.set("stage", 1)).rejects.toThrow("its host half does");
    await expect(api.storage.synced.delete("stage")).rejects.toThrow("its host half does");
    expect(() => api.ui.send("x", 1)).toThrow("host.call");
    // Its host half's messages and its store's changes: its own plugin's only, by topic.
    const heard: unknown[] = [];
    const keys: string[] = [];
    const off = api.host.on("stage", (v) => heard.push(v));
    const offKeys = api.storage.synced.watch((k) => keys.push(k));
    await act(async () => {
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "plugin_ui_message", pluginId: "moss/sidebar", event: "stage", value: { v: 1, scene: "beach" } } });
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "plugin_ui_message", pluginId: "moss/sidebar", event: "other", value: 2 } });
      fake.emit({ type: "api-event", pluginId: "someone-else", method: "core.event", params: { type: "plugin_ui_message", pluginId: "someone-else", event: "stage", value: "not mine" } });
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "plugin_ui_message", pluginId: "someone-else", event: "stage", value: "not mine either" } });
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "plugin_store_changed", pluginId: "moss/sidebar", key: "stage" } });
      fake.emit({ type: "api-event", pluginId: "someone-else", method: "core.event", params: { type: "plugin_store_changed", pluginId: "someone-else", key: "x" } });
    });
    off();
    offKeys();
    expect(heard).toEqual([{ v: 1, scene: "beach" }]);
    expect(keys).toEqual(["stage"]);
    expect(fake.calls).toContainEqual({ op: "api", args: [mount, "events.subscribe", { areas: ["plugins"] }] });
  });

  test("settings.get and .set: every part reaches its own settings on its own connection (plugin.layer.call, no id), the bundled tree's too, and a bot's value for the bot it names (F2)", async () => {
    render(h(ui.LayerRoot, { info: { mount: "m9", pluginId: "vn", entryId: "page", component: "VnPage", spot: "main", props: {}, tokens: {}, context: CTX, css: [] } }));
    await tick();
    const vn = vnApi!;
    fake.calls.length = 0;
    await vn.settings.get("order");
    await vn.settings.set("order", "oldest");
    await vn.settings.set("order", undefined);
    await hooks.api!.settings.get("deck").catch(() => undefined); // the fake core answers no settings list
    await hooks.api!.settings.set("deck", "tarot").catch(() => undefined);
    await vn.settings.get("nick", { bot: "alpha" }).catch(() => undefined);
    await vn.settings.set("nick", "Lu", { bot: "alpha" }).catch(() => undefined);
    const got = fake.calls.filter((c) => c.op === "api").map((c) => c.args.slice(1));
    expect(got).toEqual([
      ["plugin.layer.call", { call: "settings.get", args: ["order"] }],
      ["plugin.layer.call", { call: "settings.set", args: ["order", "oldest"] }],
      ["plugin.layer.call", { call: "settings.set", args: ["order", null] }],
      // The bundled tree's part the same way: its own plugin's, never through the app's door by its id.
      ["plugin.layer.call", { call: "settings.get", args: ["deck"] }],
      ["plugin.layer.call", { call: "settings.set", args: ["deck", "tarot"] }],
      // A bot's value names its bot, as the host half's does.
      ["plugin.layer.call", { call: "settings.get", args: ["nick", { bot: "alpha" }] }],
      ["plugin.layer.call", { call: "settings.set", args: ["nick", "Lu", { bot: "alpha" }] }],
    ]);
  });

  test("settings.watch hears its own plugin's settings changes (the key, never a value); never another plugin's, nor a plugin_changed", async () => {
    const api = hooks.api!;
    const all: string[] = [];
    const deck: string[] = [];
    const offAll = api.settings.watch(null, (k) => all.push(k));
    const offDeck = api.settings.watch("deck", (k) => deck.push(k));
    await act(async () => {
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "plugin_settings_changed", pluginId: "moss/sidebar", key: "deck" } });
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "plugin_settings_changed", pluginId: "moss/sidebar", key: "TAROT_KEY" } });
      fake.emit({ type: "api-event", pluginId: "someone-else", method: "core.event", params: { type: "plugin_settings_changed", pluginId: "someone-else", key: "deck" } });
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "plugin_settings_changed", pluginId: "someone-else", key: "deck" } });
      fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "plugin_changed", id: "moss/sidebar", state: "running", enabled: true } });
    });
    offAll();
    offDeck();
    expect(all).toEqual(["deck", "TAROT_KEY"]);
    expect(deck).toEqual(["deck"]);
  });

  test("useApprovals has the cards already pending when the part mounts (card.pending), and a card answered meanwhile doesn't come back", async () => {
    await tick();
    expect(hooks.cards!().map((c) => c.id)).toContain("card_before");
    // The same card heard again (its event, after the read) is still one card: shown once, never twice.
    await act(async () => fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "card_pending", card: { id: "card_before", computers: ["Studio"] } } }));
    expect(hooks.cards!().filter((c) => c.id === "card_before").length).toBe(1);
    await act(async () => fake.emit({ type: "api-event", pluginId: "moss/sidebar", method: "core.event", params: { type: "card_resolved", id: "card_before", outcome: "approved" } }));
    expect(hooks.cards!().map((c) => c.id)).not.toContain("card_before");
  });

  test("props across a frame's edge: functions become markers; markers become functions", () => {
    const fns: Function[] = [];
    const encoded = ui.encodeProps({ a: 1, nested: { f: () => 2 }, list: [() => 3, "x"], date: new Date(0) }, (fn) => {
      fns.push(fn);
      return String(fns.length);
    });
    expect(encoded).toEqual({ a: 1, nested: { f: { "$moss.callback": "1" } }, list: [{ "$moss.callback": "2" }, "x"] });
    const called: unknown[] = [];
    const decoded = ui.decodeProps(encoded, (id, args) => called.push([id, args])) as { nested: { f: (x: unknown) => void } };
    decoded.nested.f(() => "a function never crosses");
    expect(called).toEqual([["1", [undefined]]]);
  });

  test("a frame in the main or panel spot fills the room it is given and ignores the height its page reports; in another spot it takes the page's height", async () => {
    const frameItem = (mount: string, spot: string) => ({ kind: "frame" as const, mount, ref: `vn#${spot}`, pluginId: "vn", entryId: spot, layer: "vn", url: `moss-plugin://vn/?mount=${mount}` });
    views["w1:main[editor]"] = { spot: "main", key: "editor", shape: "keyed", hidden: false, conflict: false, items: [frameItem("w2", "main")] };
    views["w1:panel[side]"] = { spot: "panel", key: "side", shape: "keyed", hidden: false, conflict: false, items: [frameItem("w3", "panel")] };
    views["w1:bar"] = { spot: "bar", shape: "single", hidden: false, conflict: false, items: [frameItem("w4", "bar")] };
    const info: MountInfo = { mount: "w1", pluginId: "test/fill", entryId: "columns", component: "Columns", spot: "app.root", props: {}, tokens: {}, context: CTX, css: [] };
    const win = render(h(ui.LayerRoot, { info }));
    await tick();
    const frame = (mount: string) => win.container.querySelector(`iframe[data-moss-mount="${mount}"]`) as HTMLIFrameElement;
    await act(async () => { for (const m of ["w2", "w3", "w4"]) fake.emit({ type: "child-size", child: m, height: 64 }); });
    for (const m of ["w2", "w3"]) {
      expect(frame(m).getAttribute("data-moss-fill")).toBe("");
      expect(frame(m).style.height).toBe("100%");
      expect(frame(m).style.flex).toBe("1 1 0px");
      expect(["0", "0px"]).toContain(frame(m).style.minHeight);
    }
    expect(frame("w4").getAttribute("data-moss-fill")).toBeNull();
    expect(frame("w4").style.height).toBe("64px");
    win.unmount();
  });

  test("a document in the main or panel spot tells the base sheet so (it scrolls in itself there)", async () => {
    const info: MountInfo = { mount: "w9", pluginId: "vn", entryId: "main", component: "VnPage", spot: "main", props: {}, tokens: {}, context: CTX, css: [] };
    const page = render(h(ui.LayerRoot, { info }));
    await tick();
    expect(document.documentElement.getAttribute("data-moss-spot")).toBe("main");
    page.unmount();
  });

  test("useMountContext's window.narrow starts as the core said and follows its updates", async () => {
    const info: MountInfo = { mount: "w10", pluginId: "test/fill", entryId: "probe", component: "NarrowProbe", spot: "main", props: {}, tokens: {}, context: { ...CTX, window: { narrow: true } }, css: [] };
    const probe = render(h(ui.LayerRoot, { info }));
    await tick();
    const read = () => probe.container.querySelector("[data-narrow-probe]")?.getAttribute("data-narrow-probe");
    expect(read()).toBe("true");
    await act(async () => fake.emit({ type: "window", narrow: false }));
    expect(read()).toBe("false");
    await act(async () => fake.emit({ type: "window", narrow: true }));
    expect(read()).toBe("true");
    probe.unmount();
  });
});

describe("the title area's drag region", () => {
  test("a press counts on the nearest element that says drag; a button in the bar says no-drag", () => {
    const bar = document.createElement("div");
    const title = document.createElement("span");
    const button = document.createElement("button");
    const icon = document.createElement("i");
    bar.dataset.region = "drag";
    button.dataset.region = "no-drag";
    button.append(icon);
    bar.append(title, button);
    const style = (el: Element) => (el as HTMLElement).dataset.region ?? "none";
    expect(ui.onDragRegion(title, style)).toBe(true);
    expect(ui.onDragRegion(bar, style)).toBe(true);
    expect(ui.onDragRegion(button, style)).toBe(false);
    expect(ui.onDragRegion(icon, style)).toBe(false);
    expect(ui.onDragRegion(document.createElement("p"), style)).toBe(false);
    expect(ui.onDragRegion(null, style)).toBe(false);
  });

});

describe("a document loaded again keeps the user's place", () => {
  test("useKept: a value set before the document goes is there from the first render of the one loaded again (the window's session storage), per plugin and key; an unmount drops it", async () => {
    const seen: unknown[] = [];
    let set: ((v: string) => void) | undefined;
    const Keeper = () => {
      const [v, setV] = ui.useKept<string>("route", () => "home");
      set = setV;
      seen.push(v);
      return h("p", { "data-kept": v });
    };
    const first = render(h(Keeper));
    expect(seen[0]).toBe("home");
    await act(async () => set!("plugins/installed"));
    // The document goes with no unmount (a reload runs no cleanup): the storage as it was, under a fresh tree.
    const atReload = sessionStorage.getItem("moss.kept:moss:route");
    first.unmount();
    expect(sessionStorage.getItem("moss.kept:moss:route")).toBeNull();
    sessionStorage.setItem("moss.kept:moss:route", atReload!);
    seen.length = 0;
    const second = render(h(Keeper));
    // The very first render already shows the kept place: no flash of the start page.
    expect(seen[0]).toBe("plugins/installed");
    expect(second.container.querySelector("p")?.getAttribute("data-kept")).toBe("plugins/installed");
    // Outside a part it is the moss tree's; another key, or another plugin's, is its own.
    expect(sessionStorage.getItem("moss.kept:moss:route")).toBe(JSON.stringify("plugins/installed"));
    expect(sessionStorage.getItem("moss.kept:moss:other")).toBeNull();
    second.unmount();
    // Left (an unmount, the user going elsewhere): the next mount starts from its initial value.
    seen.length = 0;
    render(h(Keeper));
    expect(seen[0]).toBe("home");
  });
});

describe("the example PNGtuber renderer's framing", async () => {
  const pngtuber = await import("../../../packages/plugin-sdk/examples/example-pngtuber/client/index");
  const host = { width: 600, height: 800 };
  const natural = { width: 400, height: 800 };

  test("without framing the picture is left to fit its box; with a crop it shows that much of the height from the top, headroom above", () => {
    expect(pngtuber.framePicture(undefined, natural, host)).toBeUndefined();
    expect(pngtuber.framePicture({}, natural, host)).toBeUndefined();
    expect(pngtuber.framePicture({ crop: 0.5 }, { width: 0, height: 0 }, host)).toBeUndefined();
    // Half the figure from 3% headroom: the box shows 0.53 of the height, so the picture is 800 / (800 * 0.53) = 1.887 times its size, 755 px wide: wider than
    // the box's 98%, so the width limits it (the top stays where it was asked for).
    const waist = pngtuber.framePicture({ crop: 0.56, headroom: 0.12 }, natural, host)!;
    expect(waist.width).toBeCloseTo(588, 0);
    expect(waist.left).toBeCloseTo(6, 0);
    expect(waist.top).toBeCloseTo(0.12 * waist.height, 5);
    const wide = pngtuber.framePicture({ crop: 0.3, headroom: 0.04 }, { width: 400, height: 800 }, { width: 1000, height: 400 })!;
    // Height-limited here: 400 / (800 * 0.34) = 1.47.
    expect(wide.height).toBeCloseTo(1176, 0);
    expect(wide.top).toBeCloseTo(0.04 * 1176, 0);
    expect(wide.left).toBeCloseTo((1000 - wide.width) / 2, 5);
    // A preset with no numbers: the whole figure, with a little room above.
    const full = pngtuber.framePicture({ mode: "full" }, natural, host)!;
    expect(full.height).toBeCloseTo(800 / 1.03, 0);
  });
});
