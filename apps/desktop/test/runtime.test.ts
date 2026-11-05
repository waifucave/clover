// The plugin runtime in the main process, without Electron (decision 77, S9's design): mounts inline in the same layer
// and as frames from other layers, single-use tokens bound to the frame and parent that loaded them, props and
// callbacks across a frame's edge, sizes, releases, the crash census and a reload's fresh token, each part themed by its
// tab, and safe mode.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LayerMessage } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { readUiPlugins, type UiPlugin } from "../src/main/ui/model";
import { MOUNT_TOKEN_TTL_MS, UiRuntime, type FrameRef } from "../src/main/ui/runtime";
import { FIXTURES, alphaView, cloverViews, folderView } from "./fake-core/registry";

const WIN = 1;
let pid = 100;
function frame(url: string, parent: FrameRef | null = null, osPid = ++pid): FrameRef {
  return { processId: osPid, routingId: ++pid, url, osPid, parent };
}

function setup(extra: UiPlugin[] = [], opts: { safeMode?: boolean; now?: () => number } = {}) {
  const sent: { to: string; m: LayerMessage }[] = [];
  let n = 0;
  const rt = new UiRuntime({ os: "macos", platform: "darwin", ...(opts.safeMode ? { safeMode: true } : {}), ...(opts.now ? { now: opts.now } : {}), token: () => `t${++n}`, send: (f, m) => sent.push({ to: `${f.processId}:${f.routingId}`, m }) });
  const plugins = [...readUiPlugins([...cloverViews(), alphaView()] as never), ...extra];
  rt.setRegistry(plugins);
  rt.openWindow(WIN, { material: "vibrancy" });
  const rootFrame = frame("clover-core://app/");
  const root = rt.describe(rootFrame, WIN, undefined);
  return { rt, sent, root, rootFrame };
}

/** Mounts the shell's frame under the root, the way the root page and the protocol handler do. */
function mountShell(s: ReturnType<typeof setup>) {
  const view = s.rt.resolve(s.rootFrame, s.root.mount, "app.root");
  const item = view.items[0]!;
  if (item.kind !== "frame") throw new Error("the shell is not a frame");
  const token = new URL(item.url).searchParams.get("mount")!;
  expect(s.rt.serveDocument("clover", token)).toBeDefined();
  const shellFrame = frame(item.url, s.rootFrame);
  const info = s.rt.describe(shellFrame, WIN, token);
  return { item, token, shellFrame, info };
}

const composerFixture = () => readUiPlugins([folderView(join(FIXTURES, "fixture-composer"))] as never);

describe("the root and the shell", () => {
  test("the root mounts app.root: the shell, as a frame from the clover layer", () => {
    const s = setup();
    expect(s.root).toMatchObject({ pluginId: "core", spot: "app.root", context: { material: "vibrancy", os: "macos", safeMode: false } });
    const { item, info } = mountShell(s);
    expect(item).toMatchObject({ kind: "frame", layer: "clover", ref: "clover/shell#app.root" });
    expect(info).toMatchObject({ pluginId: "clover/shell", component: "Window", module: "/_clover/clover.js", css: ["/_clover/clover.css"] });
    expect(info.context.bots).toEqual([{ id: "alpha", name: "Alpha" }]);
  });

  test("everything under clover renders inline in the shell's layer", () => {
    const s = setup();
    const { shellFrame, info } = mountShell(s);
    const sidebar = s.rt.resolve(shellFrame, info.mount, "sidebar");
    expect(sidebar.items).toMatchObject([{ kind: "inline", ref: "clover/sidebar#sidebar", component: "Sidebar" }]);
    const tab = s.rt.resolve(shellFrame, info.mount, "bot.tab", "alpha");
    expect(tab.items).toMatchObject([{ kind: "inline", ref: "clover/shell#bot.tab", component: "BotTab", context: { bot: "alpha" } }]);
    const composer = s.rt.resolve(shellFrame, tab.items[0]!.mount, "composer");
    expect(composer.items).toMatchObject([{ kind: "inline", ref: "clover/composer#composer" }]);
  });

  test("a spot the part doesn't declare waits (its fillers aren't mounted)", () => {
    const s = setup();
    const { shellFrame, info } = mountShell(s);
    expect(s.rt.resolve(shellFrame, info.mount, "composer")).toMatchObject({ items: [], undeclared: true });
  });

  test("resolving the same spot again keeps its mounts (no remount, no reload)", () => {
    const s = setup();
    const { shellFrame, info } = mountShell(s);
    const a = s.rt.resolve(shellFrame, info.mount, "sidebar");
    const b = s.rt.resolve(shellFrame, info.mount, "sidebar");
    expect(b.items[0]!.mount).toBe(a.items[0]!.mount);
  });
});

describe("a part from another layer: a frame with a single-use token", () => {
  function withFixture() {
    const s = setup(composerFixture());
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    const view = s.rt.resolve(shell.shellFrame, tab.mount, "composer");
    const item = view.items[0]!;
    if (item.kind !== "frame") throw new Error("not a frame");
    const token = new URL(item.url).searchParams.get("mount")!;
    return { s, shell, tab, item, token };
  }

  test("the installed composer wins and shows as a frame from its own origin", () => {
    const { item } = withFixture();
    expect(item).toMatchObject({ kind: "frame", layer: "fixture-composer", ref: "fixture-composer#composer" });
    expect(item.url).toMatch(/^clover-plugin:\/\/fixture-composer\/\?mount=t\d+$/);
  });

  test("the document is served once, for its own layer only", () => {
    const { s, token } = withFixture();
    expect(s.rt.serveDocument("clover", token)).toBeUndefined();
    expect(s.rt.serveDocument("fixture-composer", "never-issued")).toBeUndefined();
    expect(s.rt.serveDocument("fixture-composer", null)).toBeUndefined();
    expect(s.rt.serveDocument("fixture-composer", token)).toBeDefined();
    expect(s.rt.serveDocument("fixture-composer", token)).toBeUndefined();
  });

  test("an unused token expires", () => {
    let now = 1_000;
    const s = setup(composerFixture(), { now: () => now });
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    const item = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0]!;
    now += MOUNT_TOKEN_TTL_MS + 1;
    expect(s.rt.serveDocument("fixture-composer", new URL((item as { url: string }).url).searchParams.get("mount"))).toBeUndefined();
  });

  test("it binds only from the frame its URL was loaded in, under the document that placed it", () => {
    const { s, shell, item, token } = withFixture();
    s.rt.serveDocument("fixture-composer", token);
    // Another layer's frame with the token in its URL, or the right URL under the wrong parent: refused.
    expect(() => s.rt.describe(frame(`clover-plugin://other/?mount=${token}`, shell.shellFrame), WIN, token)).toThrow();
    expect(() => s.rt.describe(frame(item.url, s.rootFrame), WIN, token)).toThrow();
    expect(() => s.rt.describe(frame(item.url, shell.shellFrame), 2, token)).toThrow();
    const info = s.rt.describe(frame(item.url, shell.shellFrame), WIN, token);
    expect(info).toMatchObject({ pluginId: "fixture-composer", component: "FixtureComposer", module: "/_p/fixture-composer/client/index.js", css: ["/_p/fixture-composer/client/styles.css"] });
    // Spent: a second describe with the same token fails.
    expect(() => s.rt.describe(frame(item.url, shell.shellFrame), WIN, token)).toThrow();
  });

  test("props cross the frame's edge through the core; callbacks come back to the parent's document", () => {
    const { s, shell, item, token } = withFixture();
    s.rt.serveDocument("fixture-composer", token);
    const child = frame(item.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    s.sent.length = 0;
    s.rt.setProps(shell.shellFrame, item.mount, { bot: { id: "alpha", name: "Alpha" }, onSend: { "$clover.callback": "1" } });
    expect(s.sent).toEqual([{ to: `${child.processId}:${child.routingId}`, m: { type: "props", mount: item.mount, props: { bot: { id: "alpha", name: "Alpha" }, onSend: { "$clover.callback": "1" } } } }]);
    s.sent.length = 0;
    s.rt.callback(child, "1", ["hello"]);
    s.rt.reportSize(child, 120.4);
    expect(s.sent).toEqual([
      { to: `${shell.shellFrame.processId}:${shell.shellFrame.routingId}`, m: { type: "callback", child: item.mount, id: "1", args: ["hello"] } },
      { to: `${shell.shellFrame.processId}:${shell.shellFrame.routingId}`, m: { type: "child-size", child: item.mount, height: 120 } },
    ]);
    // Only the placing document sets a child's props.
    expect(() => s.rt.setProps(child, item.mount, {})).toThrow();
  });

  test("a frame whose process is gone is found by the census; its reload takes a fresh single-use token", () => {
    const { s, shell, item, token } = withFixture();
    s.rt.serveDocument("fixture-composer", token);
    const child = frame(item.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    s.sent.length = 0;
    expect(s.rt.census((f) => f.processId !== child.processId)).toEqual([item.mount]);
    expect(s.sent).toContainEqual({ to: `${shell.shellFrame.processId}:${shell.shellFrame.routingId}`, m: { type: "child-gone", child: item.mount, reason: "its layer stopped" } });
    const url = s.rt.reload(shell.shellFrame, item.mount)!;
    const fresh = new URL(url).searchParams.get("mount")!;
    expect(fresh).not.toBe(token);
    expect(s.rt.serveDocument("fixture-composer", token)).toBeUndefined();
    expect(s.rt.serveDocument("fixture-composer", fresh)).toBeDefined();
    expect(s.rt.describe(frame(url, shell.shellFrame), WIN, fresh)).toMatchObject({ pluginId: "fixture-composer" });
  });

  test("released parts are dropped with everything under them, and their tokens die", () => {
    const { s, shell, tab, item, token } = withFixture();
    s.rt.release(shell.shellFrame, [tab.mount]);
    expect(s.rt.serveDocument("fixture-composer", token)).toBeUndefined();
    expect(() => s.rt.resolve(shell.shellFrame, tab.mount, "composer")).toThrow();
    void item;
  });
});

describe("each part themed by its tab (decision 77)", () => {
  function botPlugin(id: string, accent: string): UiPlugin {
    const dir = mkdtempSync(join(tmpdir(), "clover-theme-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ theme: 1, name: id, tokens: { "color.accent": accent } }));
    return readUiPlugins([{ pluginId: id, treeHash: "0".repeat(64), layer: id, assetBase: dir, ui: [], themes: [{ id, file: "theme.json" }], locales: [], bots: "all", isBot: true, botTheme: id, name: id }] as never)[0]!;
  }

  test("one plugin's frames in two bots' tabs take each tab's theme", () => {
    const s = setup([...composerFixture(), botPlugin("luna", "#123456"), botPlugin("vega", "#654321")]);
    const shell = mountShell(s);
    const accents: string[] = [];
    for (const bot of ["luna", "vega"]) {
      const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", bot).items[0]!;
      const item = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0]!;
      const token = new URL((item as { url: string }).url).searchParams.get("mount")!;
      s.rt.serveDocument("fixture-composer", token);
      accents.push(String(s.rt.describe(frame((item as { url: string }).url, shell.shellFrame), WIN, token).tokens["color.accent"]));
    }
    expect(accents).toEqual(["#123456", "#654321"]);
  });

  test("an inline part in another tab carries its tab's tokens; the frame variables come from the window", () => {
    const s = setup([botPlugin("luna", "#123456")]);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna").items[0]!;
    expect(tab.kind === "inline" && tab.tokens?.["color.accent"]).toBe("#123456");
    expect(shell.info.tokens["frame.inset.top"]).toBe("45px");
    expect(shell.info.tokens["frame.window.controls"]).toBe("80px");
  });

  test("an appearance or accent change re-themes every document", () => {
    const s = setup();
    const shell = mountShell(s);
    s.sent.length = 0;
    s.rt.setAppearance("dark", "#FF0000");
    const tokens = s.sent.find((x) => x.m.type === "tokens" && x.to === `${shell.shellFrame.processId}:${shell.shellFrame.routingId}`);
    expect(tokens).toBeDefined();
    expect((tokens!.m as { tokens: Record<string, Record<string, unknown>> }).tokens[shell.info.mount]!["color.accent"]).toBe("#FF0000");
  });
});

describe("safe mode and the registry", () => {
  test("in safe mode a third-party part isn't mounted; the bundled one shows", () => {
    const s = setup(composerFixture(), { safeMode: true });
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    expect(s.rt.resolve(shell.shellFrame, tab.mount, "composer").items).toMatchObject([{ kind: "inline", ref: "clover/composer#composer" }]);
  });

  test("a registry change asks every document to resolve its spots again", () => {
    const s = setup();
    const shell = mountShell(s);
    s.sent.length = 0;
    s.rt.setRegistry(s.rt.registry.filter((p) => p.id !== "clover/sidebar"));
    expect(s.sent.filter((x) => x.m.type === "respot").map((x) => x.to).sort()).toEqual([`${s.rootFrame.processId}:${s.rootFrame.routingId}`, `${shell.shellFrame.processId}:${shell.shellFrame.routingId}`].sort());
    expect(s.rt.resolve(shell.shellFrame, shell.info.mount, "sidebar").items).toEqual([]);
  });

  test("the clover layer says what kind of session a part shows, for `when.session`", () => {
    const s = setup();
    // F's code-only panels say so with `when.session` (lane B's catalog), as F-M2's manifests will.
    s.rt.setRegistry(s.rt.registry.map((p) => (p.id !== "clover/panel-diff" ? p : { ...p, entries: p.entries.map((e) => ({ ...e, when: { session: ["coding"] } })) })));
    const shell = mountShell(s);
    const code = s.rt.resolve(shell.shellFrame, shell.info.mount, "panel", "diff", { session: "coding" });
    expect(code.items).toMatchObject([{ ref: "clover/panel-diff#panel" }]);
    expect(s.rt.resolve(shell.shellFrame, shell.info.mount, "panel", "diff", { session: "bot" }).items).toEqual([]);
  });
});
