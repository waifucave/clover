// The UI API in a layer (`packages/plugin-sdk/src/ui`), with a fake bridge standing in for the main process: an entry
// renders with its props and tokens; `<Spot>` mounts inline parts from the layer's own modules, frames for other
// layers' parts with their props handed across (callbacks as markers the core routes back), nothing for a hidden
// part, and a reload button when a frame's layer stops.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LayerBridge, LayerMessage, MountInfo, SpotView } from "@waifucave/clover-plugin-sdk/ui/bridge";

// Frames never load here: their documents are the main process's (the Electron UI test loads them).
GlobalRegistrator.register({ settings: { navigation: { disableChildFrameNavigation: true } } });
// The tests share one rendered layer, so the library must not unmount it after each.
process.env.RTL_SKIP_AUTO_CLEANUP = "true";
const { act, cleanup, render } = await import("@testing-library/react");
const ui = await import("@waifucave/clover-plugin-sdk/ui");
const { createElement: h } = await import("react");

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

const CTX = { os: "macos" as const, material: "vibrancy" as const, safeMode: false };

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
    release: (mounts) => calls.push({ op: "release", args: [mounts] }),
    reload: async (child) => {
      calls.push({ op: "reload", args: [child] });
      return "clover-plugin://other/?mount=fresh";
    },
    sleep: (child) => calls.push({ op: "sleep", args: [child] }),
    wake: async (child) => {
      calls.push({ op: "wake", args: [child] });
      return "clover-plugin://vn/?mount=woken";
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
    entries: async (mount, spot, key) => {
      calls.push({ op: "entries", args: [mount, spot, key] });
      return [{ ref: "clover/island#usage", id: "usage", pluginId: "clover/island", pluginName: "Island", bundled: true, fields: { title: "Usage" } }, { ref: "vn#tab", id: "tab", pluginId: "vn", pluginName: "VN", bundled: false, fields: { title: "VN" } }];
    },
    api: async (mount, method, params) => {
      calls.push({ op: "api", args: [mount, method, params] });
      return method === "terminal.open" ? { terminalId: "term_1" } : method === "session.get" ? { session: { id: "s", computer: "Laptop" } } : { ok: true };
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
    dragClaim: async (mount, token) => {
      calls.push({ op: "dragClaim", args: [mount, token] });
      return { type: "text/plain", data: "dropped" };
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
const hooks: { api?: ReturnType<typeof ui.usePluginApi>; entries?: () => readonly { ref: string }[]; questions?: () => readonly unknown[]; userSend?: unknown; t?: (key: string, params?: Record<string, string | number>) => string; menu?: () => Promise<string | null>; offer?: () => Promise<string | undefined>; claim?: () => Promise<unknown>; open?: () => Promise<void>; env?: unknown } = {};

describe("the UI API in a layer", () => {
  let fake: ReturnType<typeof fakeBridge>;
  const views: Record<string, SpotView> = {};
  const seen: unknown[] = [];

  beforeAll(() => {
    fake = fakeBridge(Object.assign(views, {
      "m1:sidebar": { spot: "sidebar", shape: "single", hidden: false, conflict: false, items: [{ kind: "inline", mount: "m2", ref: "clover/sidebar#sidebar", pluginId: "clover/sidebar", entryId: "sidebar", component: "Sidebar", context: CTX, tokens: { "color.accent": "#123456" } }] },
      "m1:composer": { spot: "composer", shape: "single", hidden: false, conflict: false, items: [{ kind: "frame", mount: "m3", ref: "vn#composer", pluginId: "vn", entryId: "composer", layer: "vn", url: "clover-plugin://vn/?mount=abc" }] },
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
      const q = ui.useQuestions();
      hooks.questions = () => q.questions;
      hooks.userSend = ui.useUserSend();
      hooks.api = ui.usePluginApi();
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
    ui.configureLayer({ bridge: fake.bridge, modules: { "clover/shell": { Window: Shell }, "clover/sidebar": { Sidebar } }, sleepAfterMs: 30 });
  });

  test("the document's entry renders with its props and tokens; an inline part from the same layer with its own", async () => {
    const info: MountInfo = { mount: "m1", pluginId: "clover/shell", entryId: "app.root", component: "Window", spot: "app.root", props: { title: "Clover" }, tokens: { "color.accent": "#2F6FDF" }, context: CTX, css: [] };
    const { container } = render(h(ui.LayerRoot, { info }));
    await tick();
    expect(container.querySelector("main")?.getAttribute("data-title")).toBe("Clover");
    expect(container.querySelector("main")?.getAttribute("data-accent")).toBe("#2F6FDF");
    const nav = container.querySelector("nav")!;
    expect(nav.getAttribute("data-route")).toBe("alpha");
    expect(nav.getAttribute("data-plugin")).toBe("clover/sidebar");
    // Another tab's (or a dressed part's) tokens: on the part, as custom properties and through the hook.
    expect(nav.getAttribute("data-accent")).toBe("#123456");
    expect((nav.parentElement as HTMLElement).style.getPropertyValue("--clover-color-accent")).toBe("#123456");
    // Tokens reach the document as custom properties.
    expect(document.documentElement.style.getPropertyValue("--clover-color-accent")).toBe("#2F6FDF");
  });

  test("a part from another layer is a frame; its props cross with callbacks as markers the core routes back", async () => {
    const frame = document.querySelector('iframe[data-clover-entry="vn#composer"]') as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("clover-plugin://vn/?mount=abc");
    expect(frame.getAttribute("allow")).toBe("");
    const set = fake.calls.find((c) => c.op === "setProps" && c.args[0] === "m3")!;
    expect(set.args[1]).toEqual({ bot: "alpha", onSend: { "$clover.callback": "1" } });
    await act(async () => fake.emit({ type: "callback", child: "m3", id: "1", args: ["hello"] }));
    expect(seen).toEqual(["hello"]);
    await act(async () => fake.emit({ type: "child-size", child: "m3", height: 64 }));
    expect(frame.style.height).toBe("64px");
  });

  test("a hidden part and an undeclared spot show nothing", () => {
    expect(document.querySelector('[data-clover-spot="status"]')?.getAttribute("data-clover-empty")).toBe("hidden");
    expect(document.querySelector('[data-clover-spot="never-declared"]')?.getAttribute("data-clover-empty")).toBe("waiting");
  });

  test("a frame whose layer stopped shows a reload, which loads a fresh single-use URL", async () => {
    await act(async () => fake.emit({ type: "child-gone", child: "m3", reason: "its layer stopped" }));
    const button = document.querySelector('[data-clover-gone] button') as HTMLButtonElement;
    expect(button.textContent).toBe("Reload");
    await act(async () => button.click());
    await tick();
    expect(fake.calls.some((c) => c.op === "reload" && c.args[0] === "m3")).toBe(true);
    expect(document.querySelector('iframe[data-clover-entry="vn#composer"]')?.getAttribute("src")).toBe("clover-plugin://other/?mount=fresh");
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
    const placeholder = document.querySelector('[data-clover-entry="vn#composer"][data-clover-asleep]') as HTMLElement;
    expect(placeholder).not.toBeNull();
    expect(document.querySelector('iframe[data-clover-entry="vn#composer"]')).toBeNull();
    await act(async () => setNear(true));
    await tick();
    expect(fake.calls.some((c) => c.op === "wake" && c.args[0] === "m3")).toBe(true);
    expect(document.querySelector('iframe[data-clover-entry="vn#composer"]')?.getAttribute("src")).toBe("clover-plugin://vn/?mount=woken");
  });

  test("a registry change resolves every spot again", async () => {
    const before = fake.calls.filter((c) => c.op === "resolve").length;
    await act(async () => fake.emit({ type: "respot" }));
    await tick();
    expect(fake.calls.filter((c) => c.op === "resolve").length).toBeGreaterThanOrEqual(before + 4);
  });

  test("the themes' sheets go in the head in the core's order and follow its changes; each part carries its mark", async () => {
    // The marks a sheet's `@scope` finds: the document's part on its root, an inline part on its wrapper.
    expect(document.documentElement.getAttribute("data-clover-part")).toBe("m1");
    expect(document.querySelector('[data-clover-entry="clover/sidebar#sidebar"]')?.getAttribute("data-clover-part")).toBe("m2");
    const ids = () => Array.from(document.head.querySelectorAll("style[data-clover-sheet]")).map((e) => `${e.getAttribute("data-clover-sheet")}=${e.textContent}`);
    await act(async () => fake.emit({ type: "sheets", sheets: [{ id: "base:clover/base-theme", css: "a{}" }, { id: "bot:luna:m2", css: "b{}" }] }));
    expect(ids()).toEqual(["base:clover/base-theme=a{}", "bot:luna:m2=b{}"]);
    // They come after the part's own stylesheets.
    const link = document.createElement("link");
    document.head.insertBefore(link, document.head.firstChild);
    await act(async () => fake.emit({ type: "sheets", sheets: [{ id: "bot:luna:m2", css: "c{}" }, { id: "user", css: "d{}" }] }));
    expect(ids()).toEqual(["bot:luna:m2=c{}", "user=d{}"]);
    expect(document.head.firstElementChild).toBe(link);
    link.remove();
  });

  test("strings: the core's table, in its language, kept current; a key with no string reads as itself", async () => {
    expect(hooks.t!("clover.sidebar.files", { count: 2 })).toBe("clover.sidebar.files");
    await act(async () => fake.emit({ type: "strings", strings: { lang: "fr", strings: { "clover.sidebar.files": { one: "{count} fichier", other: "{count} fichiers" } } } }));
    expect(hooks.t!("clover.sidebar.files", { count: 1 })).toBe("1 fichier");
    expect(hooks.t!("clover.sidebar.files", { count: 1200 })).toBe("1\u202f200 fichiers");
    expect(document.documentElement.lang).toBe("fr");
  });

  test("a bot's layout draws as its tab's part: rows and columns, images, markdown as elements, spots as the part's own", async () => {
    views["m1:never-declared"] = { spot: "never-declared", shape: "single", hidden: false, conflict: false, items: [{
      kind: "inline", mount: "m20", ref: "luna#layout", pluginId: "luna", entryId: "layout", component: "$layout", context: CTX, tab: "luna",
      layout: { kind: "row", children: [
        { kind: "column", size: "240px", className: "clv-luna__side", children: [
          { kind: "image", src: "/_t/luna/a.png" },
          { kind: "markdown", markdown: "# Luna\nLikes *stars* and [the moon](https://example.com).\n\n- one\n- two" },
          { kind: "text", text: "only when wide", hideBelow: 5000 },
        ] },
        { kind: "column", grow: 1, children: [{ kind: "spot", spot: "conversation" }, { kind: "spacer" }] },
      ] },
    }] };
    views["m20:conversation"] = { spot: "conversation", shape: "single", hidden: false, conflict: false, items: [{ kind: "inline", mount: "m21", ref: "clover/sidebar#sidebar", pluginId: "clover/sidebar", entryId: "sidebar", component: "Sidebar", context: CTX }] };
    await act(async () => fake.emit({ type: "respot" }));
    await tick();
    const part = document.querySelector('[data-clover-part="m20"]')!;
    expect(part.getAttribute("data-clover-tab")).toBe("luna");
    expect(part.querySelector('[data-clover-layout="row"] > [data-clover-layout="column"].clv-luna__side')).not.toBeNull();
    expect(part.querySelector("img")?.getAttribute("src")).toBe("/_t/luna/a.png");
    expect(part.querySelector("h1")?.textContent).toBe("Luna");
    expect(part.querySelector("em")?.textContent).toBe("stars");
    // A link shows as its text: a layout loads and opens nothing.
    expect(part.querySelector("a")).toBeNull();
    expect(part.textContent).toContain("the moon");
    expect(part.querySelectorAll("li").length).toBe(2);
    expect(part.textContent).not.toContain("only when wide");
    // Its spot resolves as the layout part's.
    expect(fake.calls).toContainEqual({ op: "resolve", args: ["m20", "conversation", undefined] });
    expect(part.querySelector('[data-clover-part="m21"] nav')).not.toBeNull();
  });

  test("a spot's entries for its declaring part, and one entry shown by its ref; questions; no user sends outside a surface", async () => {
    await tick();
    expect(hooks.entries!().map((e) => e.ref)).toEqual(["clover/island#usage", "vn#tab"]);
    expect(fake.calls).toContainEqual({ op: "entries", args: ["m2", "island.tab", undefined] });
    // The questions the core sends (to a plugin that may read them), kept current.
    expect(hooks.questions!()).toEqual([]);
    const q = { session: "s_alpha", callId: "c1", at: 1, questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }] };
    await act(async () => fake.emit({ type: "questions", questions: [q] }));
    expect(hooks.questions!()).toEqual([q]);
    // The sidebar isn't a surface's part: it has no way to send as the user.
    expect(hooks.userSend).toBeUndefined();
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
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "terminal_output", terminalId: "term_1", data: "$ " } });
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "terminal_output", terminalId: "term_2", data: "other" } });
      fake.emit({ type: "api-event", pluginId: "someone-else", method: "core.event", params: { type: "terminal_output", terminalId: "term_1", data: "not mine" } });
    });
    off();
    expect(got).toEqual(["$ "]);
    expect(fake.calls).toContainEqual({ op: "api", args: [mount, "events.subscribe", { areas: ["computers"] }] });
    expect((await hooks.api!.conversation!.get!("s")) as unknown).toEqual({ id: "s", computer: "Laptop" });
  });

  test("props across a frame's edge: functions become markers; markers become functions", () => {
    const fns: Function[] = [];
    const encoded = ui.encodeProps({ a: 1, nested: { f: () => 2 }, list: [() => 3, "x"], date: new Date(0) }, (fn) => {
      fns.push(fn);
      return String(fns.length);
    });
    expect(encoded).toEqual({ a: 1, nested: { f: { "$clover.callback": "1" } }, list: [{ "$clover.callback": "2" }, "x"] });
    const called: unknown[] = [];
    const decoded = ui.decodeProps(encoded, (id, args) => called.push([id, args])) as { nested: { f: (x: unknown) => void } };
    decoded.nested.f(() => "a function never crosses");
    expect(called).toEqual([["1", [undefined]]]);
  });
});
