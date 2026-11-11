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
const { createElement: h, useState } = await import("react");
// The SDK's example renderer, as a third-party `avatar` entry (its own frame in the app).
const pngtuber = await import("../../../packages/plugin-sdk/examples/example-pngtuber/client/index");

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
    speech: (child, message) => calls.push({ op: "speech", args: [child, message] }),
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
    windowDrag: (mount) => { calls.push({ op: "windowDrag", args: [mount] }); },
    composer: async (mount, op, args) => { calls.push({ op: "composer", args: [mount, op, args] }); return undefined; },
    entries: async (mount, spot, key) => {
      calls.push({ op: "entries", args: [mount, spot, key] });
      return [{ ref: "clover/island#usage", id: "usage", pluginId: "clover/island", pluginName: "Island", bundled: true, fields: { title: "Usage" } }, { ref: "vn#tab", id: "tab", pluginId: "vn", pluginName: "VN", bundled: false, fields: { title: "VN" } }];
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
      return `clover-sealed://card/${cardId}/${element}?token=x`;
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
const hooks: { cards?: () => readonly { id: string }[]; api?: ReturnType<typeof ui.usePluginApi>; entries?: () => readonly { ref: string }[]; questions?: () => readonly unknown[]; userSend?: unknown; t?: (key: string, params?: Record<string, string | number>) => string; menu?: () => Promise<string | null>; offer?: () => Promise<string | undefined>; claim?: () => Promise<unknown>; open?: () => Promise<void>; env?: unknown } = {};

/** The stage's speech, as the app would feed it: frames pushed by the test, on a clock of its own. */
const stageSpeech = (() => {
  const listeners = new Set<(frames: readonly { t: number; rms: number; centroid: number }[]) => void>();
  return {
    feed: { subscribe: (l: (frames: readonly { t: number; rms: number; centroid: number }[]) => void) => { listeners.add(l); return () => void listeners.delete(l); }, now: () => performance.now() / 1000 },
    push: (frames: { t: number; rms: number; centroid: number }[]) => listeners.forEach((l) => l(frames)),
    listeners,
  };
})();
let setStageSpeaking: ((speaking: boolean) => void) | undefined;
/** A bot's stage: the `avatar` spot under the stage's speech (the character part's place for the feed). */
const Stage = () => {
  const [speaking, setSpeaking] = useState(false);
  setStageSpeaking = setSpeaking;
  return h(ui.AvatarSpeechProvider, { feed: stageSpeech.feed, speaking }, h(ui.Spot, { name: "avatar", spotKey: "pngtuber", props: { bot: { id: "pip", name: "Pip" }, file: "https://pngtuber.test/pip.pngtuber.json", format: "pngtuber" } }));
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
    ui.configureLayer({ bridge: fake.bridge, modules: { "clover/shell": { Window: Shell }, "clover/sidebar": { Sidebar }, vn: { VnPage }, "clover/character": { Stage }, "example-pngtuber": { PngtuberAvatar: pngtuber.PngtuberAvatar } }, sleepAfterMs: 30 });
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

  test("a spot's entries for its declaring part, and one entry shown by its ref; questions; the clover tree's parts have useUserSend", async () => {
    await tick();
    expect(hooks.entries!().map((e) => e.ref)).toEqual(["clover/island#usage", "vn#tab"]);
    expect(fake.calls).toContainEqual({ op: "entries", args: ["m2", "island.tab", undefined] });
    // The questions the core sends (to a plugin that may read them), kept current.
    expect(hooks.questions!()).toEqual([]);
    const q = { session: "s_alpha", callId: "c1", at: 1, questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }] };
    await act(async () => fake.emit({ type: "questions", questions: [q] }));
    expect(hooks.questions!()).toEqual([q]);
    // A part of the bundled clover tree has the hook (the main process decides again, and gates the key press or
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
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "terminal_output", terminalId: "term_1", data: "$ " } });
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "terminal_output", terminalId: "term_2", data: "other" } });
      fake.emit({ type: "api-event", pluginId: "someone-else", method: "core.event", params: { type: "terminal_output", terminalId: "term_1", data: "not mine" } });
    });
    off();
    expect(got).toEqual(["$ "]);
    expect(fake.calls).toContainEqual({ op: "api", args: [mount, "events.subscribe", { areas: ["computers"] }] });
    expect((await hooks.api!.conversation!.get!("s")) as unknown).toEqual({ id: "s", computer: "Laptop" });
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
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "plugin_ui_message", pluginId: "clover/sidebar", event: "stage", value: { v: 1, scene: "beach" } } });
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "plugin_ui_message", pluginId: "clover/sidebar", event: "other", value: 2 } });
      fake.emit({ type: "api-event", pluginId: "someone-else", method: "core.event", params: { type: "plugin_ui_message", pluginId: "someone-else", event: "stage", value: "not mine" } });
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "plugin_ui_message", pluginId: "someone-else", event: "stage", value: "not mine either" } });
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "plugin_store_changed", pluginId: "clover/sidebar", key: "stage" } });
      fake.emit({ type: "api-event", pluginId: "someone-else", method: "core.event", params: { type: "plugin_store_changed", pluginId: "someone-else", key: "x" } });
    });
    off();
    offKeys();
    expect(heard).toEqual([{ v: 1, scene: "beach" }]);
    expect(keys).toEqual(["stage"]);
    expect(fake.calls).toContainEqual({ op: "api", args: [mount, "events.subscribe", { areas: ["plugins"] }] });
  });

  test("settings.get and .set: a third-party page reaches its own settings on its own connection (plugin.layer.call, no id, no bot); the bundled tree's parts as before", async () => {
    render(h(ui.LayerRoot, { info: { mount: "m9", pluginId: "vn", entryId: "page", component: "VnPage", spot: "main", props: {}, tokens: {}, context: CTX, css: [] } }));
    await tick();
    const vn = vnApi!;
    fake.calls.length = 0;
    await vn.settings.get("order");
    await vn.settings.set("order", "oldest");
    await vn.settings.set("order", undefined);
    await hooks.api!.settings.get("deck").catch(() => undefined); // the fake core answers no settings list
    await hooks.api!.settings.set("deck", "tarot").catch(() => undefined);
    const got = fake.calls.filter((c) => c.op === "api").map((c) => c.args.slice(1));
    expect(got).toEqual([
      ["plugin.layer.call", { call: "settings.get", args: ["order"] }],
      ["plugin.layer.call", { call: "settings.set", args: ["order", "oldest"] }],
      ["plugin.layer.call", { call: "settings.set", args: ["order", null] }],
      ["plugin.settings.get", { id: "clover/sidebar" }],
      ["plugin.settings.set", { id: "clover/sidebar", key: "deck", value: "tarot" }],
    ]);
    // A page names no bot: a bot's value is its host half's to read or change.
    await expect(vn.settings.get("nick", { bot: "alpha" })).rejects.toThrow("with no bot");
    await expect(vn.settings.set("nick", "Lu", { bot: "alpha" })).rejects.toThrow("with no bot");
  });

  test("settings.watch hears its own plugin's settings changes (the key, never a value); never another plugin's, nor a plugin_changed", async () => {
    const api = hooks.api!;
    const all: string[] = [];
    const deck: string[] = [];
    const offAll = api.settings.watch(null, (k) => all.push(k));
    const offDeck = api.settings.watch("deck", (k) => deck.push(k));
    await act(async () => {
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "plugin_settings_changed", pluginId: "clover/sidebar", key: "deck" } });
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "plugin_settings_changed", pluginId: "clover/sidebar", key: "TAROT_KEY" } });
      fake.emit({ type: "api-event", pluginId: "someone-else", method: "core.event", params: { type: "plugin_settings_changed", pluginId: "someone-else", key: "deck" } });
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "plugin_settings_changed", pluginId: "someone-else", key: "deck" } });
      fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "plugin_changed", id: "clover/sidebar", state: "running", enabled: true } });
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
    await act(async () => fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "card_pending", card: { id: "card_before", computers: ["Studio"] } } }));
    expect(hooks.cards!().filter((c) => c.id === "card_before").length).toBe(1);
    await act(async () => fake.emit({ type: "api-event", pluginId: "clover/sidebar", method: "core.event", params: { type: "card_resolved", id: "card_before", outcome: "approved" } }));
    expect(hooks.cards!().map((c) => c.id)).not.toContain("card_before");
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

  test("an avatar renderer in its own frame gets the stage's speech as batches of numbers, ~every 40 ms while it speaks, nothing while quiet, hidden or gone", async () => {
    views["s1:avatar[pngtuber]"] = { spot: "avatar", key: "pngtuber", shape: "keyed", hidden: false, conflict: false, items: [{ kind: "frame", mount: "s2", ref: "example-pngtuber#avatar", pluginId: "example-pngtuber", entryId: "avatar", layer: "example-pngtuber", url: "clover-plugin://example-pngtuber/?mount=a1" }] };
    const info: MountInfo = { mount: "s1", pluginId: "clover/character", entryId: "bot-stage", component: "Stage", spot: "bot.stage", props: {}, tokens: {}, context: CTX, css: [] };
    const stage = render(h(ui.LayerRoot, { info }));
    await tick();
    const speech = () => fake.calls.filter((c) => c.op === "speech");
    expect(stage.container.querySelector('iframe[data-clover-mount="s2"]')).toBeTruthy();
    // The frame's props carry no feed (functions never cross as data): the speech goes its own way.
    const props = fake.calls.filter((c) => c.op === "setProps" && c.args[0] === "s2").at(-1)?.args[1] as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["bot", "file", "format"]);
    // Quiet: nothing crosses.
    await wait(150);
    expect(speech()).toHaveLength(0);
    // Speaking for ~240 ms, a frame every ~12 ms: a handful of batches, not one per frame, every frame there.
    await act(async () => setStageSpeaking!(true));
    let n = 0;
    const start = performance.now() / 1000;
    for (let i = 0; i < 20; i++) {
      stageSpeech.push([{ t: start + n * 0.0116, rms: 0.3, centroid: 1500 }]);
      n++;
      await new Promise((r) => setTimeout(r, 12));
    }
    await wait(100);
    const sent = speech();
    expect(sent.every((c) => c.args[0] === "s2")).toBe(true);
    const messages = sent.map((c) => c.args[1] as { speaking: boolean; clock: { audio: number; wall: number }; frames: { t: number; rms: number; centroid: number }[] });
    expect(messages.flatMap((m) => m.frames)).toHaveLength(n);
    expect(messages.length).toBeLessThanOrEqual(12);
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages[0]!.speaking).toBe(true);
    // Only numbers: the three per frame, the clock, and the flag.
    for (const m of messages) {
      expect(Object.keys(m).sort()).toEqual(["clock", "frames", "speaking"]);
      for (const f of m.frames) expect(Object.keys(f).sort()).toEqual(["centroid", "rms", "t"]);
    }
    // Quiet again: one message saying so, then nothing.
    await act(async () => setStageSpeaking!(false));
    await wait(200);
    expect(speech().length).toBe(sent.length + 1);
    expect((speech().at(-1)!.args[1] as { speaking: boolean }).speaking).toBe(false);
    // The window hidden: the feed isn't even heard, and nothing is sent.
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(stageSpeech.listeners.size).toBe(0);
    stageSpeech.push([{ t: start + 1, rms: 0.3, centroid: 1500 }]);
    await wait(100);
    expect(speech().length).toBe(sent.length + 1);
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else delete (document as { visibilityState?: unknown }).visibilityState;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(stageSpeech.listeners.size).toBe(1);
    // The frame's layer stops: nothing more goes to it.
    await act(async () => fake.emit({ type: "child-gone", child: "s2", reason: "its layer stopped" }));
    stageSpeech.push([{ t: start + 2, rms: 0.3, centroid: 1500 }]);
    await wait(100);
    expect(speech().length).toBe(sent.length + 1);
    expect(stageSpeech.listeners.size).toBe(0);
    stage.unmount();
  });

  test("the example PNGtuber renderer in its own frame: the talk picture while the bot speaks, the idle one after; batches from elsewhere change nothing", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toBe("https://pngtuber.test/pip.pngtuber.json");
      return new Response(JSON.stringify({ name: "Pip", idle: "idle.png", talk: "talk.png", blink: "blink.png" }));
    }) as typeof fetch;
    try {
      const info: MountInfo = { mount: "p1", pluginId: "example-pngtuber", entryId: "avatar", component: "PngtuberAvatar", spot: "avatar", key: "pngtuber", props: { bot: { id: "pip", name: "Pip" }, file: "https://pngtuber.test/pip.pngtuber.json", format: "pngtuber" }, tokens: {}, context: CTX, css: [] };
      const frame = render(h(ui.LayerRoot, { info }));
      const shown = () => frame.container.querySelector("[data-pngtuber]")?.getAttribute("data-pngtuber");
      const picture = () => frame.container.querySelector("img")?.getAttribute("src") ?? "";
      await wait(30);
      expect(shown()).toBe("idle");
      expect(picture()).toBe("https://pngtuber.test/idle.png");
      const wall = () => performance.timeOrigin + performance.now();
      const frames = (from: number, count: number, rms: number) => Array.from({ length: count }, (_, i) => ({ t: from + i * 0.0116, rms, centroid: 1400 }));
      // A batch for another frame, or one that isn't numbers, is not this renderer's.
      await act(async () => fake.emit({ type: "speech", mount: "p9", speech: { speaking: true, clock: { audio: 50, wall: wall() }, frames: frames(50, 20, 0.5) } }));
      await act(async () => fake.emit({ type: "speech", mount: "p1", speech: { speaking: true, clock: { audio: "50", wall: wall() }, frames: frames(50, 20, 0.5) } as never }));
      await wait(30);
      expect(shown()).toBe("idle");
      // The bot speaks: ~230 ms of loud frames, starting now on the parent's clock.
      const w0 = wall();
      await act(async () => fake.emit({ type: "speech", mount: "p1", speech: { speaking: true, clock: { audio: 50, wall: w0 }, frames: frames(50, 20, 0.3) } }));
      await wait(50);
      expect(shown()).toBe("talk");
      expect(picture()).toBe("https://pngtuber.test/talk.png");
      // After the speech: the idle picture again (and its timer stops: nothing is due).
      await act(async () => fake.emit({ type: "speech", mount: "p1", speech: { speaking: false, clock: { audio: 50 + (wall() - w0) / 1000, wall: wall() }, frames: [] } }));
      await wait(350);
      expect(shown()).toBe("idle");
      frame.unmount();
    } finally {
      globalThis.fetch = realFetch;
    }
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
    const atReload = sessionStorage.getItem("clover.kept:clover:route");
    first.unmount();
    expect(sessionStorage.getItem("clover.kept:clover:route")).toBeNull();
    sessionStorage.setItem("clover.kept:clover:route", atReload!);
    seen.length = 0;
    const second = render(h(Keeper));
    // The very first render already shows the kept place: no flash of the start page.
    expect(seen[0]).toBe("plugins/installed");
    expect(second.container.querySelector("p")?.getAttribute("data-kept")).toBe("plugins/installed");
    // Outside a part it is the clover tree's; another key, or another plugin's, is its own.
    expect(sessionStorage.getItem("clover.kept:clover:route")).toBe(JSON.stringify("plugins/installed"));
    expect(sessionStorage.getItem("clover.kept:clover:other")).toBeNull();
    second.unmount();
    // Left (an unmount, the user going elsewhere): the next mount starts from its initial value.
    seen.length = 0;
    render(h(Keeper));
    expect(seen[0]).toBe("home");
  });
});
