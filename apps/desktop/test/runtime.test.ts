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
    return readUiPlugins([{ pluginId: id, treeHash: `sha256:${"0".repeat(64)}`, layer: id, assetBase: dir, ui: [], themes: [{ id, file: "theme.json" }], locales: [], bots: "all", isBot: true, botTheme: id, name: id }] as never)[0]!;
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

describe("the themes' CSS (§5.5's stack, E-M2)", () => {
  function themed(id: string, files: Record<string, string>, view: Record<string, unknown>): UiPlugin {
    const dir = mkdtempSync(join(tmpdir(), "clover-sheet-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return readUiPlugins([{ pluginId: id, treeHash: `sha256:${"1".repeat(64)}`, layer: id, assetBase: dir, ui: [], themes: [], locales: [], bots: "all", ...view }] as never)[0]!;
  }
  const lunaBot = () => themed("luna", {
    "theme.json": JSON.stringify({ theme: 1, name: "Luna", tokens: { "color.accent": "#123456" }, css: "tab.css", fonts: [{ family: "Luna Sans", src: "luna.woff2" }], icons: { "app.send": "send.svg" } }),
    "tab.css": `.bubble { color: red; font-family: "Luna Sans" } @import "x.css";`,
  }, { themes: [{ id: "luna", file: "theme.json" }], isBot: true, botTheme: "luna", name: "Luna" });
  const sheetsSent = (s: ReturnType<typeof setup>, f: FrameRef) => s.sent.filter((x) => x.m.type === "sheets" && x.to === `${f.processId}:${f.routingId}`).map((x) => (x.m as Extract<LayerMessage, { type: "sheets" }>).sheets);

  test("a bot's theme dresses its tab, up to another tab; its fonts and icons are its own, served by the core", () => {
    const s = setup([lunaBot()]);
    const shell = mountShell(s);
    s.sent.length = 0;
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna").items[0]!;
    expect(tab).toMatchObject({ kind: "inline", tab: "luna" });
    const sheets = sheetsSent(s, shell.shellFrame).at(-1)!;
    const sheet = sheets.find((x) => x.id === `bot:luna:${tab.mount}`)!;
    expect(sheet.css).toContain(`@font-face{font-family:"clv-luna__Luna Sans";src:url("/_t/luna/luna.woff2");font-display:swap}`);
    expect(sheet.css).toContain(`@scope ([data-clover-part="${tab.mount}"]) to ([data-clover-tab]:not(:scope)){:scope{--clover-icon-app-send:url("/_t/luna/send.svg")}}`);
    expect(sheet.css).toContain(`@scope ([data-clover-part="${tab.mount}"]) to ([data-clover-tab]:not(:scope)){.bubble{color:red;font-family:"clv-luna__Luna Sans"}}`);
    expect(sheet.css).not.toContain("@import");
    // The tab's font token names the renamed family, as its CSS does.
    expect(s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!.kind).toBe("inline");
  });

  test("a frame in a bot's tab is its own tab root: the theme comes with its document, after the part's own CSS", () => {
    const s = setup([...composerFixture(), lunaBot()]);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna").items[0]!;
    const item = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { url: string; mount: string };
    const token = new URL(item.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const info = s.rt.describe(frame(item.url, shell.shellFrame), WIN, token);
    expect(info.tab).toBe("luna");
    // Clover's base theme over the whole document first, then the tab's.
    expect(info.sheets?.map((x) => x.id)).toEqual(["base:clover/base-theme", `bot:luna:${item.mount}`]);
    expect(info.sheets![0]!.css).toContain(`@scope ([data-clover-part="${item.mount}"]){:scope{color:var(--clover-color-text)`);
    expect(info.sheets![1]!.css).toContain(`@scope ([data-clover-part="${item.mount}"]) to ([data-clover-tab]:not(:scope))`);
  });

  test("a style entry dresses its part, stopping at a part another dresses; the user's own CSS goes last and loads nothing", () => {
    const dresser = themed("dresser", {
      "dress.json": JSON.stringify({ theme: 1, name: "Dress", tokens: {}, css: "dress.css" }),
      "dress.css": `.c { border: 1px solid; background: url(bg.png) }`,
      "bg.png": "",
    }, { ui: [{ spot: "composer", id: "dress", style: "dress.json" }] });
    const s = setup([dresser]);
    s.rt.setChoices({ picks: [], lists: [], overrides: { css: `.x { color: blue; background: url(https://x.example/a.png) }` } } as never);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    s.sent.length = 0;
    const composer = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0]!;
    expect(composer).toMatchObject({ kind: "inline", ref: "clover/composer#composer", styled: true });
    const sheets = sheetsSent(s, shell.shellFrame).at(-1)!;
    const style = sheets.find((x) => x.id === `style:dresser#dress:${composer.mount}`)!;
    expect(style.css).toBe(`@scope ([data-clover-part="${composer.mount}"]) to ([data-clover-styled]:not(:scope)){.c{border:1px solid;background:url("/_t/dresser/bg.png")}}`);
    expect(sheets.at(-1)).toEqual({ id: "user", css: `@scope ([data-clover-part="${shell.info.mount}"]){.x{color:blue}}` });
  });

  test("the core root takes no sheets; a sheet that didn't change isn't sent again", () => {
    const s = setup([lunaBot()]);
    expect(s.root.sheets).toBeUndefined();
    const shell = mountShell(s);
    s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna");
    s.sent.length = 0;
    s.rt.setAppearance("dark", "#FF0000");
    expect(sheetsSent(s, shell.shellFrame)).toEqual([]);
  });
});

describe("each document's strings (§5.5's translations)", () => {
  test("the core root reads the core's own; a layer reads its plugin's keys; a new language reaches every document", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-locale-"));
    writeFileSync(join(dir, "fr.json"), JSON.stringify({ locale: 1, lang: "fr", strings: { "clover.core.root.reload": "Recharger", "fixture-composer.send": "Envoyer" } }));
    writeFileSync(join(dir, "en.json"), JSON.stringify({ locale: 1, lang: "en", strings: { "fixture-composer.send": "Send" } }));
    const fixture = composerFixture().map((p) => ({ ...p, locales: [{ lang: "fr", file: "fr.json" }, { lang: "en", file: "en.json" }], assetBase: dir }));
    const s = setup(fixture);
    expect(s.root.strings).toMatchObject({ lang: "en", strings: { "clover.core.root.reload": "Reload" } });
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    const item = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { url: string };
    const token = new URL(item.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const child = frame(item.url, shell.shellFrame);
    const info = s.rt.describe(child, WIN, token);
    expect(info.strings).toEqual({ lang: "en", strings: { "fixture-composer.send": "Send" } });
    s.sent.length = 0;
    s.rt.setChoices({ picks: [], lists: [], language: "fr" });
    const to = (f: FrameRef) => s.sent.filter((x) => x.m.type === "strings" && x.to === `${f.processId}:${f.routingId}`).map((x) => (x.m as Extract<LayerMessage, { type: "strings" }>).strings);
    expect(to(child)).toEqual([{ lang: "fr", strings: { "fixture-composer.send": "Envoyer" } }]);
    expect(to(s.rootFrame)[0]!.strings["clover.core.root.reload"]).toBe("Recharger");
    // Nothing changed, nothing sent.
    s.sent.length = 0;
    s.rt.setChoices({ picks: [], lists: [], language: "fr" });
    expect(to(child)).toEqual([]);
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

describe("sleeping frames, surfaces, and the brokers' part of the runtime", () => {
  function withFixtureFrame() {
    const s = setup(composerFixture());
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    const item = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { mount: string; url: string };
    const token = new URL(item.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const child = frame(item.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    return { s, shell, tab, item, token, child };
  }

  test("a frame away from the screen sleeps: its document goes, and it wakes with a fresh single-use URL", () => {
    const { s, shell, tab, item, child } = withFixtureFrame();
    expect(s.rt.sleep(shell.shellFrame, item.mount)).toBe(true);
    // The sleeping document can't act any more, and the spot says it sleeps.
    expect(() => s.rt.reportSize(child, 10)).toThrow();
    expect(s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0]).toMatchObject({ kind: "frame", asleep: true, url: "" });
    const url = s.rt.wake(shell.shellFrame, item.mount)!;
    const fresh = new URL(url).searchParams.get("mount")!;
    expect(s.rt.serveDocument("fixture-composer", fresh)).toBeDefined();
    expect(s.rt.describe(frame(url, shell.shellFrame), WIN, fresh)).toMatchObject({ pluginId: "fixture-composer" });
    // Only the document that placed it puts it to sleep.
    expect(() => s.rt.sleep(child, item.mount)).toThrow();
  });

  test("the surfaces to open: app.surface entries with a window; their roots show only their own entry", () => {
    const surface = readUiPlugins([folderView(join(FIXTURES, "fixture-surface"))] as never);
    const s = setup(surface);
    expect(s.rt.surfaceEntries().map((e) => e.id).sort()).toEqual(["fixture", "island", "pill"]);
    s.rt.openWindow(7, { material: "none", surface: { id: "fixture", ref: "fixture-surface#fixture" } });
    const rootFrame = frame("clover-core://app/?surface=fixture");
    const root = s.rt.describe(rootFrame, 7, undefined);
    expect(root).toMatchObject({ spot: "app.surface", context: { surface: "fixture" } });
    const view = s.rt.resolve(rootFrame, root.mount, "app.surface");
    expect(view.items).toMatchObject([{ kind: "frame", ref: "fixture-surface#fixture", layer: "fixture-surface" }]);
    const url = (view.items[0] as { url: string }).url;
    const token = new URL(url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-surface", token);
    const doc = frame(url, rootFrame);
    s.rt.describe(doc, 7, token);
    // That document steers its window; the main window's shell doesn't steer any surface.
    expect(s.rt.surfaceOf(doc)).toBe(7);
    expect(s.rt.surfaceOf(mountShell(s).shellFrame)).toBeUndefined();
    // In safe mode only clover's surfaces open.
    expect(setup(surface, { safeMode: true }).rt.surfaceEntries().map((e) => e.id).sort()).toEqual(["island", "pill"]);
  });

  test("the menu broker learns a frame's place from each document above it", () => {
    const { s, shell, item, child } = withFixtureFrame();
    const place = s.rt.placeOf(child);
    expect(place.windowId).toBe(WIN);
    expect(place.steps.map((x) => x.child)).toEqual([shell.info.mount, item.mount]);
    expect(place.steps[0]!.parent).toEqual({ processId: s.rootFrame.processId, routingId: s.rootFrame.routingId });
    expect(place.steps[1]!.parent).toEqual({ processId: shell.shellFrame.processId, routingId: shell.shellFrame.routingId });
  });

  test("drag grants: offered by a part whose plugin may hand it out, claimed once, by a part whose plugin may hold it", () => {
    const { s, shell, tab, child, item } = withFixtureFrame();
    // The fixture composer has no capabilities: plain text only.
    expect(s.rt.dragOffer(child, item.mount, { type: "application/x-clover-file", data: { path: "a" } })).toHaveProperty("error");
    const text = s.rt.dragOffer(child, item.mount, { type: "text/plain", data: "hello" });
    expect(text).toHaveProperty("token");
    const token = (text as { token: string }).token;
    expect(s.rt.dragClaim(shell.shellFrame, tab.mount, token)).toEqual({ type: "text/plain", data: "hello" });
    expect(s.rt.dragClaim(shell.shellFrame, tab.mount, token)).toHaveProperty("error");
    // A part of another document can't offer for this one.
    expect(() => s.rt.dragOffer(child, tab.mount, { type: "text/plain", data: "x" })).toThrow();
    // The conversation (conversation.read) offers a message; the composer's plugin may not hold one.
    const convo = s.rt.resolve(shell.shellFrame, tab.mount, "conversation").items[0]!;
    const msg = s.rt.dragOffer(shell.shellFrame, convo.mount, { type: "application/x-clover-message", data: { id: "m1" } }) as { token: string };
    expect(s.rt.dragClaim(child, item.mount, msg.token)).toHaveProperty("error");
  });
});

describe("the E-M1 review's fixes", () => {
  test("the layer is the app's own reckoning: a view whose label disagrees, or that isn't a view, is refused", () => {
    const lines: string[] = [];
    const good = folderView(join(FIXTURES, "fixture-composer"));
    const plugins = readUiPlugins([
      good,
      { ...good, pluginId: "evil", layer: "clover" },
      { ...good, pluginId: "kid/part", layer: "kid--part" },
      { pluginId: "broken" },
    ], {}, (l) => lines.push(l));
    expect(plugins.map((p) => [p.id, p.layer])).toEqual([["fixture-composer", "fixture-composer"], ["kid/part", "kid--part"]]);
    expect(lines.join("\n")).toContain("refused evil: its layer is evil, not clover");
    expect(lines.join("\n")).toContain("refused a plugin view that isn't one");
  });

  test("bot.tab: the clover tree's parts may show it; any other part only if it declares it", () => {
    const s = setup(composerFixture());
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    const item = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0]!;
    const token = new URL((item as { url: string }).url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const composerFrame = frame((item as { url: string }).url, shell.shellFrame);
    const info = s.rt.describe(composerFrame, WIN, token);
    expect(s.rt.resolve(composerFrame, info.mount, "bot.tab", "alpha")).toMatchObject({ items: [], undeclared: true });
    expect(s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items.length).toBe(1);
  });

  test("a document names the installed layers it may frame, and loads again to frame one installed after it", () => {
    const s = setup();
    const shell = mountShell(s);
    const mounts = (s.rt as unknown as { mounts: Map<string, Parameters<UiRuntime["mountForDocument"]>[0]> }).mounts;
    expect(s.rt.mountForDocument(mounts.get(shell.info.mount)!).layers).toEqual(["alpha", "clover"]);
    // A composer from a new layer is installed while the shell shows.
    s.rt.setRegistry([...readUiPlugins([...cloverViews(), alphaView()] as never), ...composerFixture()]);
    s.sent.length = 0;
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    s.rt.resolve(shell.shellFrame, tab.mount, "composer");
    const reload = s.sent.find((x) => x.m.type === "child-reload");
    expect(reload?.to).toBe(`${s.rootFrame.processId}:${s.rootFrame.routingId}`);
    const url = (reload!.m as { url: string }).url;
    expect(reload!.m).toMatchObject({ type: "child-reload", child: shell.info.mount });
    expect(url).toMatch(/^clover-plugin:\/\/clover\/\?mount=t\d+$/);
    // Served again, it names the new layer.
    const token = new URL(url).searchParams.get("mount")!;
    const again = s.rt.serveDocument("clover", token);
    expect(s.rt.mountForDocument(again!).layers).toEqual(["alpha", "clover", "fixture-composer"]);
  });
});
