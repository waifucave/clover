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

describe("the UI API in a layer", () => {
  let fake: ReturnType<typeof fakeBridge>;
  const seen: unknown[] = [];

  beforeAll(() => {
    fake = fakeBridge({
      "m1:sidebar": { spot: "sidebar", shape: "single", hidden: false, conflict: false, items: [{ kind: "inline", mount: "m2", ref: "clover/sidebar#sidebar", pluginId: "clover/sidebar", entryId: "sidebar", component: "Sidebar", context: CTX, tokens: { "color.accent": "#123456" } }] },
      "m1:composer": { spot: "composer", shape: "single", hidden: false, conflict: false, items: [{ kind: "frame", mount: "m3", ref: "vn#composer", pluginId: "vn", entryId: "composer", layer: "vn", url: "clover-plugin://vn/?mount=abc" }] },
      "m1:status": { spot: "status", shape: "list", hidden: true, conflict: false, items: [] },
    });
    const Shell = ({ props, tokens }: { props: { title: string }; tokens: Record<string, unknown> }) =>
      h("main", { "data-title": props.title, "data-accent": String(tokens["color.accent"]) },
        h(ui.Spot, { name: "sidebar", props: { route: "alpha" } }),
        h(ui.Spot, { name: "composer", props: { bot: "alpha", onSend: (text: string) => seen.push(text) } }),
        h(ui.Spot, { name: "status" }),
        h(ui.Spot, { name: "never-declared" }));
    const Sidebar = ({ props, entry }: { props: { route: string }; entry: { pluginId: string } }) => {
      const tokens = ui.useTokens();
      return h("nav", { "data-route": props.route, "data-plugin": entry.pluginId, "data-accent": String(tokens["color.accent"]) });
    };
    ui.configureLayer({ bridge: fake.bridge, modules: { "clover/shell": { Window: Shell }, "clover/sidebar": { Sidebar } } });
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

  test("a registry change resolves every spot again", async () => {
    const before = fake.calls.filter((c) => c.op === "resolve").length;
    await act(async () => fake.emit({ type: "respot" }));
    await tick();
    expect(fake.calls.filter((c) => c.op === "resolve").length).toBeGreaterThanOrEqual(before + 4);
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
