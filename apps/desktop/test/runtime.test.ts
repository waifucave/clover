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
import { SealedFrames, type SealedCard } from "../src/main/sealed";
import { FIXTURES, alphaView, cloverViews, folderView } from "./fake-core/registry";

const WIN = 1;
let pid = 100;
function frame(url: string, parent: FrameRef | null = null, osPid = ++pid): FrameRef {
  return { processId: osPid, routingId: ++pid, url, osPid, parent };
}

function setup(extra: UiPlugin[] = [], opts: { safeMode?: boolean; now?: () => number; log?: (line: string) => void } = {}) {
  const sent: { to: string; m: LayerMessage }[] = [];
  let n = 0;
  const rt = new UiRuntime({ os: "macos", platform: "darwin", ...(opts.safeMode ? { safeMode: true } : {}), ...(opts.now ? { now: opts.now } : {}), ...(opts.log ? { log: opts.log } : {}), token: () => `t${++n}`, send: (f, m) => sent.push({ to: `${f.processId}:${f.routingId}`, m }) });
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
    expect(info).toMatchObject({ pluginId: "clover/shell", component: "Shell", module: "/_clover/clover.js", css: ["/_clover/clover.css"] });
    expect(info.context.bots).toEqual([{ id: "alpha", name: "Alpha" }]);
  });

  test("everything under clover renders inline in the shell's layer", () => {
    const s = setup();
    const { shellFrame, info } = mountShell(s);
    const sidebar = s.rt.resolve(shellFrame, info.mount, "sidebar");
    expect(sidebar.items).toMatchObject([{ kind: "inline", ref: "clover/sidebar#sidebar", component: "SidebarEntry" }]);
    const tab = s.rt.resolve(shellFrame, info.mount, "bot.tab", "alpha");
    expect(tab.items).toMatchObject([{ kind: "inline", ref: "clover/shell#bot-tab", component: "DefaultBotTab", context: { bot: "alpha" } }]);
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
    if (item.kind !== "frame") throw new Error(`not a frame: ${JSON.stringify(view)}`);
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

  test("a client the core built at load is the module its mounts load: /_b/ by its hash, on its own layer's origin", () => {
    const { s } = withFixture();
    const sha256 = "ab".repeat(32);
    const plugin = { id: "tarot", topId: "tarot", css: [], clientBuild: { base: "/x", file: "index.js", sha256 } };
    expect(s.rt.assets({ plugin } as never)).toEqual({ module: `/_b/tarot/${sha256.slice(0, 16)}/index.js`, css: [] });
    // A shipped JavaScript entry is still its own file; a TypeScript entry with no build yet loads nothing.
    expect(s.rt.assets({ plugin: { ...plugin, clientBuild: undefined, clientEntry: "client/index.js" } } as never).module).toBe("/_p/tarot/client/index.js");
    expect(s.rt.assets({ plugin: { ...plugin, clientBuild: undefined, clientEntry: "client/index.tsx" } } as never).module).toBeUndefined();
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
    // The same props again, from a parent that drew again: the child is told nothing.
    s.sent.length = 0;
    s.rt.setProps(shell.shellFrame, item.mount, { bot: { id: "alpha", name: "Alpha" }, onSend: { "$clover.callback": "1" } });
    expect(s.sent).toEqual([]);
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

describe("a bot's shell skin reaches the window while its tab shows", () => {
  const skinned = (id: string, shell: unknown): UiPlugin => {
    const dir = mkdtempSync(join(tmpdir(), "clover-skin-"));
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ theme: 1, name: id, tokens: { "color.surface": "#FFFFFF" }, dark: { tokens: { "color.surface": "#1A1A1A" } }, shell }));
    return readUiPlugins([{ pluginId: id, treeHash: `sha256:${"0".repeat(64)}`, layer: id, assetBase: dir, ui: [], themes: [{ id, file: "theme.json" }], locales: [], bots: "all", isBot: true, botTheme: id, name: id }] as never)[0]!;
  };
  const meadow = { tokens: { bar: "#F6F2FF", "bar.text": "#2A2140", "bar.rule": "#D3C6F0", sidebar: "linear-gradient(180deg, #F7F3FF, #F4FAF7)", "sidebar.text": "#2A2140", "sidebar.muted": "#5C5278", "sidebar.selected": "#F6F0FF", "sidebar.hover": "#F8F4FF" } };
  const ember = { tokens: { bar: "#FBEFE8", "bar.text": "#3A1A10", "bar.rule": "#E8CFC2", accent: "#B34A1B" }, dark: { tokens: { bar: "#1A0C09", "bar.text": "#FFE9DD", "bar.rule": "#5A2F22", accent: "#FF9F70" } } };

  test("each bot's skin is told to the shell by name; a bot with none has none; a group that misses its contrast is dropped", () => {
    const unreadable = { tokens: { bar: "#FFFFFF", "bar.text": "#F5F5F5", "bar.rule": "#EEEEEE" } };
    const s = setup([...composerFixture(), skinned("luna", meadow), skinned("vega", ember), skinned("dim", unreadable), skinned("plain", undefined)]);
    const shell = mountShell(s);
    const tokens = shell.info.tokens as Record<string, string>;
    expect(tokens["shell.luna.bar.text"]).toBe("#2A2140");
    expect(tokens["shell.luna.sidebar"]).toContain("linear-gradient");
    expect(tokens["shell.vega.bar"]).toBe("#FBEFE8");
    expect(tokens["shell.vega.accent"]).toBe("#B34A1B");
    expect(tokens["shell.luna.bar"]).not.toBe(tokens["shell.vega.bar"]);
    expect(Object.keys(tokens).filter((k) => k.startsWith("shell.plain.") || k.startsWith("shell.dim."))).toEqual([]);
  });

  test("the appearance picks the bot's dark values, and the skin changes with it", () => {
    const s = setup([...composerFixture(), skinned("vega", ember)]);
    const shell = mountShell(s);
    const before = (shell.info.tokens as Record<string, string>)["shell.vega.bar"];
    s.sent.length = 0;
    s.rt.setAppearance("dark", undefined);
    const msg = s.sent.find((x) => x.m.type === "tokens" && x.to === `${shell.shellFrame.processId}:${shell.shellFrame.routingId}`);
    const after = (msg!.m as { tokens: Record<string, Record<string, string>> }).tokens[shell.info.mount]!["shell.vega.bar"];
    expect([before, after]).toEqual(["#FBEFE8", "#1A0C09"]);
  });

  test("a bot's own tab never carries the shell's names (the chrome is the shell's to dress)", () => {
    const s = setup([...composerFixture(), skinned("luna", meadow)]);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna").items[0]!;
    expect(Object.keys((tab as { tokens?: Record<string, unknown> }).tokens ?? {}).some((k) => k.startsWith("shell."))).toBe(false);
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
    return readUiPlugins([{ pluginId: id, name: id, treeHash: `sha256:${"1".repeat(64)}`, layer: id, assetBase: dir, ui: [], themes: [], locales: [], bots: "all", ...view }] as never)[0]!;
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

describe("a bot's layout (§5.5)", () => {
  function layoutBot(layout: unknown, files: Record<string, string> = {}, extra: Record<string, unknown> = {}): UiPlugin {
    const dir = mkdtempSync(join(tmpdir(), "clover-layout-"));
    writeFileSync(join(dir, "layout.json"), JSON.stringify(layout));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return readUiPlugins([{ pluginId: "luna", name: "Luna", treeHash: `sha256:${"2".repeat(64)}`, layer: "luna", assetBase: dir, ui: [], themes: [], locales: [], bots: "all", ...extra }] as never, { luna: { isBot: true, name: "Luna", botLayout: "layout.json" } })[0]!;
  }
  const LAYOUT = {
    layout: 1,
    css: "layout.css",
    background: "bg.png",
    root: { row: [
      { column: [{ image: "art/luna.png", size: 120 }, { text: { en: "Hello", fr: "Bonjour" } }, { markdown: "about.md" }], size: "240px", hideBelow: 700, class: "side" },
      { column: [{ spot: "conversation", grow: 1 }, { spot: "composer", prefer: ["clover/composer"] }], grow: 1 },
    ] },
  };
  const FILES = { "layout.css": ".side { padding: 8px } .side img { border-radius: 50% }", "about.md": "# Luna\nLikes *stars*." };

  test("a data-only bot's tab is its layout, drawn inline by the runtime as data: sizes, classes, images, text and markdown resolved", () => {
    const s = setup([...composerFixture(), layoutBot(LAYOUT, FILES)]);
    s.rt.setChoices({ picks: [], lists: [], language: "fr" });
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna").items[0]!;
    expect(tab).toMatchObject({ kind: "inline", ref: "luna#layout", component: "$layout", tab: "luna" });
    const layout = (tab as { layout: unknown }).layout;
    expect(layout).toEqual({ kind: "row", children: [
      { kind: "column", size: "240px", hideBelow: 700, className: "clv-luna__side", children: [
        { kind: "image", src: "/_t/luna/art/luna.png", size: "120px" },
        { kind: "text", text: "Bonjour" },
        { kind: "markdown", markdown: "# Luna\nLikes *stars*." },
      ] },
      { kind: "column", grow: 1, children: [{ kind: "spot", spot: "conversation", grow: 1 }, { kind: "spot", spot: "composer" }] },
    ] });
  });

  test("its spots are the tab's; its `prefer` is rule 3 there (the bundled composer over an installed one)", () => {
    const s = setup([...composerFixture(), layoutBot(LAYOUT, FILES)]);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna").items[0]!;
    expect(s.rt.resolve(shell.shellFrame, tab.mount, "composer").items).toMatchObject([{ kind: "inline", ref: "clover/composer#composer" }]);
    // Without the layout's preference the installed composer wins (rule 5), as in Alpha's tab.
    const alpha = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    expect(s.rt.resolve(shell.shellFrame, alpha.mount, "composer").items).toMatchObject([{ kind: "frame", ref: "fixture-composer#composer" }]);
    // The composer in a layout is the declaring (bundled, shell) document's own: its session counts through the layout part.
    const inLayout = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { mount: string };
    s.rt.setProps(shell.shellFrame, inLayout.mount, { bot: { id: "luna", name: "Luna" }, session: "luna:main" });
    expect(s.rt.composerOf(shell.shellFrame, inLayout.mount)).toMatchObject({ session: "luna:main", bot: "luna", windowId: WIN });
    // A spot the tab doesn't declare waits.
    expect(s.rt.resolve(shell.shellFrame, tab.mount, "sidebar")).toMatchObject({ undeclared: true });
  });

  test("its CSS is cleaned with its classes prefixed, scoped to the tab and stopping at the parts inside it", () => {
    const s = setup([layoutBot(LAYOUT, FILES)]);
    const shell = mountShell(s);
    s.sent.length = 0;
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna").items[0]!;
    const sheets = s.sent.filter((x) => x.m.type === "sheets").map((x) => (x.m as Extract<LayerMessage, { type: "sheets" }>).sheets).at(-1)!;
    const sheet = sheets.find((x) => x.id === `layout:luna:${tab.mount}`)!;
    const scope = `@scope ([data-clover-part="${tab.mount}"]) to ([data-clover-part]:not(:scope))`;
    expect(sheet.css).toBe(`${scope}{:scope{background-image:url("/_t/luna/bg.png");background-size:cover;background-position:center}}\n${scope}{.clv-luna__side{padding:8px}.clv-luna__side img{border-radius:50%}}`);
  });

  test("a patch on the stock tab (the owner's example): the stage to the left of the transcript, wider; its classes the bot's own; a change with no node said once and skipped", () => {
    const patch = { layout: 1, extends: "default", css: "layout.css", changes: [{ set: ".tab", as: "row" }, { set: "bot.stage", size: "42%", min: 280 }, { remove: "bot.header" }] };
    const lines: string[] = [];
    const s = setup([...composerFixture(), layoutBot(patch, { "layout.css": ".stage { border-right: 1px solid }" })], { log: (l) => lines.push(l) });
    const shell = mountShell(s);
    s.sent.length = 0;
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna").items[0]!;
    expect(tab).toMatchObject({ kind: "inline", ref: "luna#layout", component: "$layout" });
    expect((tab as { layout: unknown }).layout).toEqual({ kind: "row", grow: 1, className: "clv-luna__tab", children: [
      { kind: "spot", spot: "bot.stage", size: "42%", min: "280px", className: "clv-luna__stage" },
      { kind: "column", grow: 1, className: "clv-luna__talk", children: [{ kind: "spot", spot: "conversation", grow: 1 }, { kind: "spot", spot: "composer" }] },
    ] });
    // The patch's own CSS styles the stock tab's boxes by their names, prefixed as the bot's.
    const sheets = s.sent.filter((x) => x.m.type === "sheets").map((x) => (x.m as Extract<LayerMessage, { type: "sheets" }>).sheets).at(-1)!;
    expect(sheets.find((x) => x.id === `layout:luna:${tab.mount}`)!.css).toContain(".clv-luna__stage{border-right:1px solid}");
    // Its spots are the tab's, as a whole layout's are.
    expect(s.rt.resolve(shell.shellFrame, tab.mount, "bot.stage").undeclared).not.toBe(true);
    s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna");
    expect(lines.filter((l) => l.includes("change 3 (remove bot.header): no such node; skipped"))).toEqual(["layout: luna/layout.json: change 3 (remove bot.header): no such node; skipped"]);
  });

  // Another plugin's patch to a bot's tab, and the user's own layout (the owner's "move a button" question).
  function mover(id: string, patch: unknown, files: Record<string, string> = {}, entry: Record<string, unknown> = {}): UiPlugin {
    const dir = mkdtempSync(join(tmpdir(), "clover-mover-"));
    writeFileSync(join(dir, "move.json"), JSON.stringify(patch));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return readUiPlugins([{ pluginId: id, name: id, treeHash: `sha256:${"3".repeat(64)}`, layer: id, assetBase: dir, ui: [{ spot: "bot.tab", id: "move", layout: "move.json", when: { bot: "luna" }, ...entry }], themes: [], locales: [], bots: "all" }] as never)[0]!;
  }
  const HEADED = { layout: 1, extends: "default", css: "layout.css", changes: [{ add: { spot: "bot.header" }, into: ".talk", at: "start" }] };
  const MOVE = { layout: 1, css: "move.css", changes: [{ move: "bot.header", before: "composer" }, { wrap: "bot.header", in: "row", class: "nudge" }] };
  const layoutOf = (s: ReturnType<typeof setup>, shell: ReturnType<typeof mountShell>) => (s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna").items[0] as { layout?: unknown; ref: string });

  test("another plugin's patch moves a part of a bot's tab and nudges it with its own CSS, after the bot's layout; never a cell of the tab", () => {
    const s = setup([...composerFixture(), layoutBot(HEADED, { "layout.css": ".talk { gap: 4px }" }), mover("mover", MOVE, { "move.css": ".nudge { transform: translateY(-6px); margin: 0 12px } .talk { color: red }" })]);
    const shell = mountShell(s);
    s.sent.length = 0;
    const tab = layoutOf(s, shell);
    expect(tab.ref).toBe("luna#layout");
    expect(tab.layout).toEqual({ kind: "column", grow: 1, className: "clv-luna__tab", children: [
      { kind: "spot", spot: "bot.stage", className: "clv-luna__stage" },
      { kind: "column", grow: 1, className: "clv-luna__talk", children: [
        { kind: "spot", spot: "conversation", grow: 1 },
        { kind: "row", className: "clv-mover__nudge", children: [{ kind: "spot", spot: "bot.header" }] },
        { kind: "spot", spot: "composer" },
      ] },
    ] });
    // Each plugin's CSS is its own sheet's: the mover's classes are its own, so its `.talk` reaches no box of the bot's.
    const sheets = s.sent.filter((x) => x.m.type === "sheets").map((x) => (x.m as Extract<LayerMessage, { type: "sheets" }>).sheets).at(-1)!;
    const css = sheets.find((x) => x.id === `layout:luna:${(tab as unknown as { mount: string }).mount}`)!.css;
    expect(css).toContain(".clv-luna__talk{gap:4px}");
    expect(css).toContain(".clv-mover__nudge{transform:translateY(-6px);margin:0 12px}");
    expect(css).toContain(".clv-mover__talk{color:red}");
    // A tab patch is no entry anything ranks.
    expect(s.rt.registry.find((p) => p.id === "mover")!.entries).toEqual([]);
  });

  test("a bot with no layout of its own: the patch makes its tab the stock one, changed; switched off by the user, or its plugin off, the tab is as before", () => {
    const lines: string[] = [];
    const plain = readUiPlugins([{ pluginId: "luna", name: "Luna", treeHash: `sha256:${"2".repeat(64)}`, layer: "luna", assetBase: tmpdir(), ui: [], themes: [], locales: [], bots: "all" }] as never, { luna: { isBot: true, name: "Luna" } })[0]!;
    const before = setup([...composerFixture(), plain]);
    const stock = layoutOf(before, mountShell(before)).ref;
    expect(stock).not.toBe("luna#layout");
    const swap = mover("mover", { layout: 1, changes: [{ move: "composer", before: "conversation" }, { set: ".tab", gap: 8 }] });
    const s = setup([...composerFixture(), plain, swap], { log: (l) => lines.push(l) });
    const shell = mountShell(s);
    const talk = (l: unknown) => ((l as { children: { children?: { spot?: string }[] }[] }).children[1]!.children ?? []).map((c) => c.spot);
    const tab = layoutOf(s, shell);
    expect(tab.ref).toBe("luna#layout");
    expect(talk(tab.layout)).toEqual(["composer", "conversation"]);
    expect((tab.layout as { gap?: string }).gap).toBe("8px");
    // The user switches it off for Luna: the next resolve (the respot the change sends) draws the stock tab.
    s.sent.length = 0;
    s.rt.setChoices({ picks: [], lists: [{ spot: "bot.tab", bot: "luna", order: [], hidden: ["mover#move"] }] });
    expect(s.sent.some((x) => x.m.type === "respot")).toBe(true);
    expect(talk(layoutOf(s, shell).layout)).toEqual(["conversation", "composer"]);
    s.rt.setChoices({ picks: [], lists: [] });
    expect(talk(layoutOf(s, shell).layout)).toEqual(["composer", "conversation"]);
    // Its plugin off (gone from the registry): the bot's tab is what it was before any patch.
    s.sent.length = 0;
    s.rt.setRegistry(s.rt.registry.filter((p) => p.id !== "mover").map((p) => (p.id === "luna" ? plain : p)));
    expect(s.sent.some((x) => x.m.type === "respot")).toBe(true);
    expect(layoutOf(s, shell).ref).toBe(stock);
  });

  test("the owner's example: another plugin moves ONE top-bar button (the editor's, `chrome.action` keyed edit) to just above the composer of a bot with no layout of its own", () => {
    const plain = readUiPlugins([{ pluginId: "luna", name: "Luna", treeHash: `sha256:${"2".repeat(64)}`, layer: "luna", assetBase: tmpdir(), ui: [], themes: [], locales: [], bots: "all" }] as never, { luna: { isBot: true, name: "Luna" } })[0]!;
    const move = mover("mover", { layout: 1, css: "move.css", changes: [{ add: { spot: "chrome.action", key: "edit" }, before: "composer" }, { wrap: { spot: "chrome.action", key: "edit" }, in: "row", class: "nudge" }] }, { "move.css": ".nudge { transform: translateY(-6px) }" });
    const s = setup([...composerFixture(), plain, move]);
    const shell = mountShell(s);
    const tab = layoutOf(s, shell) as unknown as { mount: string; ref: string; layout: { children: { children?: { kind: string; className?: string; children?: { spot?: string; key?: string }[] }[] }[] } };
    expect(tab.ref).toBe("luna#layout");
    const talk = tab.layout.children[1]!.children!;
    expect(talk.map((c) => c.className ?? c.kind)).toEqual(["spot", "clv-mover__nudge", "spot"]);
    expect(talk[1]!.children as unknown).toEqual([{ kind: "spot", spot: "chrome.action", key: "edit" }]);
    // The tab declares the cell, and the shell's own Edit button fills it there (the bar leaves out what the tab places).
    expect(s.rt.resolve(shell.shellFrame, tab.mount, "chrome.action", "edit").items).toMatchObject([{ kind: "inline", ref: "clover/shell#chrome-edit" }]);
  });

  test("patches go in turn (order, then plugin id); a change that reaches too far skips its patch, said once", () => {
    const lines: string[] = [];
    const a = mover("zeta", { layout: 1, changes: [{ add: { spot: "bot.side" }, into: ".talk", at: "start" }] }, {}, { order: 10 });
    const b = mover("alpha-mover", { layout: 1, changes: [{ add: { spacer: true }, into: ".talk", at: "start" }] }, {}, { order: 20 });
    const far = mover("far", { layout: 1, changes: [{ set: ".talk", class: "mine" }] });
    const s = setup([...composerFixture(), layoutBot(HEADED, { "layout.css": "" }), a, b, far], { log: (l) => lines.push(l) });
    const shell = mountShell(s);
    const talk = (layoutOf(s, shell).layout as { children: { children: { kind: string; spot?: string }[] }[] }).children[1]!.children;
    expect(talk.map((c) => c.spot ?? c.kind)).toEqual(["spacer", "bot.side", "bot.header", "conversation", "composer"]);
    layoutOf(s, shell);
    expect(lines.filter((l) => l.includes("far#move"))).toEqual(["layout: luna's tab: far#move (move.json): change 1: `set` gives a class to a node it didn't add; wrap the node in a box with its own class instead; skipped"]);
  });

  test("another plugin's own component for the tab keeps it: the patches wait (the tab ranks as without them)", () => {
    const plain = readUiPlugins([{ pluginId: "luna", name: "Luna", treeHash: `sha256:${"2".repeat(64)}`, layer: "luna", assetBase: tmpdir(), ui: [], themes: [], locales: [], bots: "all" }] as never, { luna: { isBot: true, name: "Luna" } })[0]!;
    const tabber = readUiPlugins([{ pluginId: "acme-tab", name: "Acme", treeHash: `sha256:${"4".repeat(64)}`, layer: "acme-tab", assetBase: tmpdir(), clientEntry: "c.js", ui: [{ spot: "bot.tab", component: "AcmeTab", when: { bot: "luna" } }], themes: [], locales: [], bots: "all" }] as never)[0]!;
    const without = setup([...composerFixture(), plain, tabber]);
    const winner = layoutOf(without, mountShell(without)).ref;
    const s = setup([...composerFixture(), plain, tabber, mover("mover", MOVE)]);
    expect(layoutOf(s, mountShell(s)).ref).toBe(winner);
    expect(s.rt.registry.find((p) => p.id === "luna")!.entries).toEqual([]);
  });

  test("the user's own layout comes last: a patch on the tab as made so far, or on the stock tab; a whole one replaces it", () => {
    const userLayout = JSON.stringify({ layout: 1, extends: "bot", changes: [{ move: "bot.stage", after: ".talk" }] });
    const s = setup([...composerFixture(), layoutBot(HEADED, { "layout.css": "" }, { bot: { name: "Luna", userLayout } }), mover("mover", MOVE, { "move.css": "" })]);
    const shell = mountShell(s);
    const kids = (l: unknown) => (l as { children: { className?: string }[] }).children.map((c) => c.className);
    const tab = layoutOf(s, shell);
    expect(kids(tab.layout)).toEqual(["clv-luna__talk", "clv-luna__stage"]);
    const talk = (tab.layout as { children: { children: { className?: string; spot?: string }[] }[] }).children[0]!.children;
    expect(talk.map((c) => c.className ?? c.spot)).toEqual(["conversation", "clv-mover__nudge", "composer"]);
    // On the stock tab: the bot's and the mover's changes are not in it.
    const onStock = JSON.stringify({ layout: 1, extends: "default", changes: [{ set: ".tab", as: "row" }] });
    const t = setup([...composerFixture(), layoutBot(HEADED, { "layout.css": "" }, { bot: { name: "Luna", userLayout: onStock } }), mover("mover", MOVE, { "move.css": "" })]);
    const tsh = mountShell(t);
    const made = layoutOf(t, tsh).layout as { kind: string; children: { children?: { spot?: string }[] }[] };
    expect(made.kind).toBe("row");
    expect(made.children[1]!.children!.map((c) => c.spot)).toEqual(["conversation", "composer"]);
    // The user changes their layout while the tab shows: the mounted tab draws the new one at its next resolve.
    const mountedBefore = layoutOf(t, tsh) as unknown as { mount: string };
    const again = JSON.stringify({ layout: 1, extends: "default", changes: [] });
    t.rt.setRegistry(t.rt.registry.map((p) => (p.id === "luna" ? { ...p, userLayout: again } : p)));
    const after = layoutOf(t, tsh) as unknown as { mount: string; layout: { kind: string } };
    expect(after.mount).toBe(mountedBefore.mount);
    expect(after.layout.kind).toBe("column");
    // A user layout on a bot with none of its own makes one on the stock tab.
    const own = readUiPlugins([{ pluginId: "luna", name: "Luna", treeHash: `sha256:${"2".repeat(64)}`, layer: "luna", assetBase: tmpdir(), ui: [], themes: [], locales: [], bots: "all", bot: { name: "Luna", userLayout: onStock } }] as never)[0]!;
    expect(own.entries.map((e) => [e.id, e.layout])).toEqual([["layout", ""]]);
  });

  test("the acceptance fixtures: the mover's row holds the bot's header, and the header's buttons are the mover's Wave alone (the bot hides Pin)", () => {
    const ACC = join(import.meta.dir, "..", "..", "..", "scripts", "acceptance", "fixtures");
    const botView = { ...folderView(join(ACC, "acceptance-layout-patch")), bot: { name: "Acceptance Layout Patch", layout: "tab/layout.json" } };
    const s = setup([...readUiPlugins([botView, folderView(join(ACC, "acceptance-layout-mover"))] as never)]);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "acceptance-layout-patch").items[0] as { mount: string; layout: { children: { children?: { className?: string; children?: { spot?: string }[] }[] }[] } };
    const row = tab.layout.children[1]!.children![1]!;
    expect(row.className).toBe("clv-acceptance-layout-mover__nudge");
    expect(row.children!.map((c) => c.spot)).toEqual(["bot.header"]);
    const header = s.rt.resolve(shell.shellFrame, tab.mount, "bot.header").items[0]!;
    expect(header).toMatchObject({ kind: "inline", ref: "clover/shell#bot-header" });
    expect(s.rt.resolve(shell.shellFrame, header.mount, "bot.header.action").items.map((i) => i.ref)).toEqual(["acceptance-layout-mover#wave"]);
  });

  test("a bot whose own component fills its tab keeps it; a broken layout shows nothing", () => {
    const own = layoutBot(LAYOUT, FILES, { clientEntry: "client/index.js", ui: [{ spot: "bot.tab", component: "LunaTab" }] });
    expect(own.entries.map((e) => e.id)).toEqual(["bot.tab"]);
    const s = setup([layoutBot({ layout: 1, root: { row: [{ script: "x" }] } })]);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna").items[0]!;
    expect((tab as { layout: unknown }).layout).toEqual({ kind: "text", text: "" });
  });

  test("a layout part acts in no plugin's name in another plugin's document: its api, its open and its terminal hand-over ask refused, and its plugin's events reach only the documents of its own layer (the review's S1)", () => {
    const s = setup([composerFixture()[0]!, layoutBot(LAYOUT, FILES)]);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "luna").items[0]!;
    expect(tab).toMatchObject({ kind: "inline", ref: "luna#layout" });
    expect(() => s.rt.partOf(shell.shellFrame, tab.mount)).toThrow("a layout part acts only in its own layer's document");
    // The layout's plugin's events go only to documents of that plugin's own layer: one inline part in the shell's
    // layer's document hears nothing (the sheet and token messages the mount built before are the rest of `sent`).
    s.sent.length = 0;
    s.rt.pluginMessage("luna", { type: "api-event", pluginId: "luna", method: "core.event", params: {} } as never);
    expect(s.sent).toEqual([]);
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

describe("a bot's speech to the main window's shell", () => {
  test("a voice piece goes to the window's clover shell document only (not the core root, not another window's)", () => {
    const s = setup([]);
    const shell = mountShell(s);
    const piece = { bot: "luna", utterance: "u1", seq: 0, audio: "AAAA", format: "pcm16-24k" as const, final: false };
    s.sent.length = 0;
    s.rt.shellMessage(WIN, { type: "voice", piece });
    expect(s.sent).toEqual([{ to: `${shell.shellFrame.processId}:${shell.shellFrame.routingId}`, m: { type: "voice", piece } }]);
    s.sent.length = 0;
    s.rt.shellMessage(WIN + 1, { type: "voice", piece });
    expect(s.sent).toEqual([]);
  });
});

describe("lane B's #179 hooks in the runtime", () => {
  function tabbed(id: string, title: string, enabledAt: number, extra: Record<string, unknown> = {}): UiPlugin {
    return readUiPlugins([{ pluginId: id, name: id, treeHash: `sha256:${"3".repeat(64)}`, layer: id.replace(/\//g, "--"), assetBase: tmpdir(), clientEntry: "c.js", ui: [{ spot: "bot.header.action", id: "act", component: "Act", title, order: enabledAt }], themes: [], locales: [], bots: "all", ...extra }] as never, { [id]: { enabledAt, source: "installed" } })[0]!;
  }

  test("an avatar frame's speech: only from the document that placed it, only to an `avatar` frame, only once it is loaded", () => {
    const pip = readUiPlugins([{ pluginId: "pip", name: "Pip", treeHash: `sha256:${"4".repeat(64)}`, layer: "pip", assetBase: tmpdir(), clientEntry: "c.js", ui: [{ spot: "avatar", key: "pngtuber", id: "avatar", component: "PngtuberAvatar" }], themes: [], locales: [], bots: "all" }] as never, { pip: { enabledAt: 3, source: "installed" } })[0]!;
    const s = setup([pip, tabbed("vn", "Visual novel", 2)]);
    s.rt.setRegistry(s.rt.registry.map((p) => (p.id !== "clover/shell" ? p : { ...p, entries: p.entries.map((e) => (e.spot !== "bot.tab" ? e : { ...e, declares: { ...e.declares, avatar: { shape: "keyed" }, "bot.header.action": { shape: "list" } } })) })));
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    const avatar = s.rt.resolve(shell.shellFrame, tab.mount, "avatar", "pngtuber").items[0] as { kind: string; mount: string; url: string };
    const action = s.rt.resolve(shell.shellFrame, tab.mount, "bot.header.action").items[0] as { kind: string; mount: string; url: string };
    expect([avatar.kind, action.kind]).toEqual(["frame", "frame"]);
    const batch = { speaking: true, clock: { audio: 3, wall: 1000 }, frames: [{ t: 3, rms: 0.2, centroid: 900 }] };
    // Not loaded yet: nothing to hear it.
    s.sent.length = 0;
    s.rt.speech(shell.shellFrame, avatar.mount, batch);
    expect(s.sent).toEqual([]);
    const token = new URL(avatar.url).searchParams.get("mount")!;
    s.rt.serveDocument("pip", token);
    const child = frame(avatar.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    s.sent.length = 0;
    s.rt.speech(shell.shellFrame, avatar.mount, batch);
    expect(s.sent).toEqual([{ to: `${child.processId}:${child.routingId}`, m: { type: "speech", mount: avatar.mount, speech: batch } }]);
    // Any other frame (not an avatar) gets none; and only the placing document sends it.
    s.sent.length = 0;
    s.rt.speech(shell.shellFrame, action.mount, batch);
    expect(s.sent).toEqual([]);
    expect(() => s.rt.speech(child, avatar.mount, batch)).toThrow();
    expect(() => s.rt.speech(s.rootFrame, avatar.mount, batch)).toThrow();
  });

  test("an avatar frame's cues and state: a cue only from the document that placed it, to an `avatar` frame; its state only to its parent", () => {
    const pip = readUiPlugins([{ pluginId: "pip", name: "Pip", treeHash: `sha256:${"4".repeat(64)}`, layer: "pip", assetBase: tmpdir(), clientEntry: "c.js", ui: [{ spot: "avatar", key: "pngtuber", id: "avatar", component: "PngtuberAvatar" }], themes: [], locales: [], bots: "all" }] as never, { pip: { enabledAt: 3, source: "installed" } })[0]!;
    const s = setup([pip, tabbed("vn", "Visual novel", 2)]);
    s.rt.setRegistry(s.rt.registry.map((p) => (p.id !== "clover/shell" ? p : { ...p, entries: p.entries.map((e) => (e.spot !== "bot.tab" ? e : { ...e, declares: { ...e.declares, avatar: { shape: "keyed" }, "bot.header.action": { shape: "list" } } })) })));
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    const avatar = s.rt.resolve(shell.shellFrame, tab.mount, "avatar", "pngtuber").items[0] as { kind: string; mount: string; url: string };
    const action = s.rt.resolve(shell.shellFrame, tab.mount, "bot.header.action").items[0] as { kind: string; mount: string; url: string };
    const cue = { kind: "cue" as const, cue: { type: "expression" as const, name: "happy" } };
    s.sent.length = 0;
    s.rt.avatarDown(shell.shellFrame, avatar.mount, cue);
    expect(s.sent).toEqual([]);
    const token = new URL(avatar.url).searchParams.get("mount")!;
    s.rt.serveDocument("pip", token);
    const child = frame(avatar.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    s.sent.length = 0;
    s.rt.avatarDown(shell.shellFrame, avatar.mount, cue);
    expect(s.sent).toEqual([{ to: `${child.processId}:${child.routingId}`, m: { type: "avatar", mount: avatar.mount, message: cue } }]);
    s.sent.length = 0;
    s.rt.avatarDown(shell.shellFrame, action.mount, cue);
    expect(s.sent).toEqual([]);
    expect(() => s.rt.avatarDown(child, avatar.mount, cue)).toThrow();
    // Its state goes up to the document that placed it, and says which child it is.
    const state = { kind: "state" as const, names: { expressions: ["happy"], motions: [], outfits: [] }, box: null };
    s.sent.length = 0;
    s.rt.avatarUp(child, state);
    expect(s.sent).toEqual([{ to: `${shell.shellFrame.processId}:${shell.shellFrame.routingId}`, m: { type: "avatar-up", child: avatar.mount, message: state } }]);
  });

  test("a spot's entries for the part that declares it, in the spot's order, with their fields; one shown by its ref", () => {
    const s = setup([tabbed("vn", "Visual novel", 2), tabbed("timer", "Timer", 1)]);
    // The tab's part declares bot.header.action (the fake shell's bot.tab declares the tab's spots).
    s.rt.setRegistry(s.rt.registry.map((p) => (p.id !== "clover/shell" ? p : { ...p, entries: p.entries.map((e) => (e.spot !== "bot.tab" ? e : { ...e, declares: { ...e.declares, "bot.header.action": { shape: "list" } } })) })));
    const shell = mountShell(s);
    const fresh = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    const entries = s.rt.entries(shell.shellFrame, fresh.mount, "bot.header.action");
    expect(entries.map((e) => [e.ref, e.pluginName, e.bundled, e.fields.title])).toEqual([["timer#act", "timer", false, "Timer"], ["vn#act", "vn", false, "Visual novel"]]);
    const one = s.rt.resolve(shell.shellFrame, fresh.mount, "bot.header.action", undefined, { entry: "vn#act" });
    expect(one.items.map((i) => i.ref)).toEqual(["vn#act"]);
    // Two of them side by side (a badge per sidebar app button): each keeps its own mount when the other resolves.
    const other = s.rt.resolve(shell.shellFrame, fresh.mount, "bot.header.action", undefined, { entry: "timer#act" });
    expect(other.items.map((i) => i.ref)).toEqual(["timer#act"]);
    expect(s.rt.resolve(shell.shellFrame, fresh.mount, "bot.header.action", undefined, { entry: "vn#act" }).items[0]!.mount).toBe(one.items[0]!.mount);
    expect(s.rt.resolve(shell.shellFrame, fresh.mount, "bot.header.action", undefined, { entry: "timer#act" }).items[0]!.mount).toBe(other.items[0]!.mount);
    // A part that doesn't declare the spot lists nothing.
    expect(s.rt.entries(shell.shellFrame, shell.info.mount, "bot.header.action")).toEqual([]);
  });

  test("a message action is data: the declaring part lists it, and nothing is ever mounted for it (no frame per message)", () => {
    const pin = readUiPlugins([{ pluginId: "pinner", name: "Pinner", treeHash: `sha256:${"5".repeat(64)}`, layer: "pinner", assetBase: tmpdir(), clientEntry: "c.js", ui: [{ spot: "conversation.message.action", id: "pin", title: "Pin", icon: "assets/pin.png", call: "pinReply" }], themes: [], locales: [], bots: "all" }] as never, { pinner: { enabledAt: 3, source: "installed" } })[0]!;
    const s = setup([pin]);
    s.rt.setRegistry(s.rt.registry.map((p) => (p.id !== "clover/shell" ? p : { ...p, entries: p.entries.map((e) => (e.spot !== "bot.tab" ? e : { ...e, declares: { ...e.declares, "conversation.message.action": { shape: "list" } } })) })));
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    expect(s.rt.entries(shell.shellFrame, tab.mount, "conversation.message.action").map((e) => [e.ref, e.fields.call, e.fields.title])).toEqual([["pinner#pin", "pinReply", "Pin"]]);
    expect(s.rt.resolve(shell.shellFrame, tab.mount, "conversation.message.action").items).toEqual([]);
  });

  test("the questions go only to a document whose plugin may read conversations", () => {
    const reader = tabbed("reader", "Reader", 3, { capabilities: ["conversation.read"] });
    const s = setup([...composerFixture(), reader]);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    const composer = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { url: string; mount: string };
    const token = new URL(composer.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const child = frame(composer.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    s.sent.length = 0;
    const q = { session: "s_alpha", callId: "c1", at: 1, questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] };
    s.rt.setQuestions([q]);
    const to = s.sent.filter((x) => x.m.type === "questions").map((x) => x.to);
    // The clover layer (its conversation reads them) does; the fixture composer, with no capability, doesn't.
    expect(to).toContain(`${shell.shellFrame.processId}:${shell.shellFrame.routingId}`);
    expect(to).not.toContain(`${child.processId}:${child.routingId}`);
  });

  test("only a part of the bundled clover tree sends the user's words, and is a tree part", () => {
    const s = setup(composerFixture());
    const shell = mountShell(s);
    expect(s.rt.treePart(shell.shellFrame, shell.info.mount)).toMatchObject({ pluginId: "clover/shell" });
    expect(s.rt.userSender(shell.shellFrame, shell.info.mount)).toMatchObject({ pluginId: "clover/shell" });
    // A third-party part in its own layer's document is neither.
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    const composer = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { url: string; mount: string };
    const token = new URL(composer.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const child = frame(composer.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    expect(s.rt.treePart(child, composer.mount)).toBeUndefined();
    expect(() => s.rt.userSender(child, composer.mount)).toThrow("only the composer's entry and the app's own parts");
  });
});

describe("the composer spot's mount record", () => {
  test("composerOf knows only an entry the core mounted in the composer spot, for the session the declaring document gave", () => {
    const s = setup(composerFixture());
    const shell = mountShell(s);
    expect(s.rt.composerOf(shell.shellFrame, shell.info.mount)).toBeUndefined();
    expect(s.rt.mainShell(shell.shellFrame, shell.info.mount)).toMatchObject({ windowId: WIN });
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    const comp = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { url: string; mount: string };
    const token = new URL(comp.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const child = frame(comp.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    // A third party's composer entry in its own layer is a composer-spot entry too, for the session its declaring document says.
    expect(s.rt.composerOf(child, comp.mount)).toBeUndefined();
    s.rt.setProps(shell.shellFrame, comp.mount, { bot: { id: "alpha", name: "Alpha" }, session: "alpha:main" });
    expect(s.rt.composerOf(child, comp.mount)).toMatchObject({ pluginId: "fixture-composer", session: "alpha:main", bot: "alpha", windowId: WIN, tree: false });
    s.rt.setProps(shell.shellFrame, comp.mount, { session: "../etc" });
    expect(s.rt.composerOf(child, comp.mount)).toBeUndefined();
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
    // F's code-only panels say so with `when.session` (lane B's catalog).
    const shell = mountShell(s);
    const code = s.rt.resolve(shell.shellFrame, shell.info.mount, "panel", "diff", { session: "coding" });
    expect(code.items).toMatchObject([{ ref: "clover/panel-diff#diff" }]);
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

  test("a frame's document loads again when its plugin's module changes (a client the core built at load landing later)", () => {
    const { s, item } = withFixtureFrame();
    s.sent.length = 0;
    // The same plugins: nothing loads again.
    s.rt.setRegistry([...readUiPlugins([...cloverViews(), alphaView()] as never), ...composerFixture()]);
    expect(s.sent.filter((x) => x.m.type === "child-reload")).toEqual([]);
    // Its client is now the core's build: the frame's document is served again, for the module it has now.
    const built = composerFixture().map((p) => ({ ...p, clientEntry: undefined, clientBuild: { base: "/x", file: "index.js", sha256: "cd".repeat(32) } }));
    s.rt.setRegistry([...readUiPlugins([...cloverViews(), alphaView()] as never), ...built]);
    const reload = s.sent.find((x) => x.m.type === "child-reload");
    expect(reload?.m).toMatchObject({ type: "child-reload", child: item.mount });
    const token = new URL((reload!.m as { url: string }).url).searchParams.get("mount")!;
    const again = s.rt.serveDocument("fixture-composer", token);
    expect(s.rt.mountForDocument(again!).assets.module).toBe(`/_b/fixture-composer/${"cd".repeat(8)}/index.js`);
  });

  test("ten changes of a plugin's module while its frame loads again: one reload, and the document served has the last module", () => {
    const { s, item } = withFixtureFrame();
    s.sent.length = 0;
    const builtAs = (n: number) => composerFixture().map((p) => ({ ...p, clientEntry: undefined, clientBuild: { base: "/x", file: "index.js", sha256: n.toString(16).repeat(64).slice(0, 64) } }));
    for (let n = 1; n <= 10; n++) s.rt.setRegistry([...readUiPlugins([...cloverViews(), alphaView()] as never), ...builtAs(n)]);
    const reloads = s.sent.filter((x) => x.m.type === "child-reload");
    // The first change reloads it; the frame is loading again (its token issued, not yet served) for the other nine.
    expect(reloads.length).toBe(1);
    const token = new URL((reloads[0]!.m as { url: string }).url).searchParams.get("mount")!;
    const again = s.rt.serveDocument("fixture-composer", token);
    expect(s.rt.mountForDocument(again!).assets.module).toBe(`/_b/fixture-composer/${"a".repeat(16)}/index.js`);
    // Served with the last module: the same registry again reloads nothing.
    s.sent.length = 0;
    s.rt.setRegistry([...readUiPlugins([...cloverViews(), alphaView()] as never), ...builtAs(10)]);
    expect(s.sent.filter((x) => x.m.type === "child-reload")).toEqual([]);
    expect(item.mount).toBe((reloads[0]!.m as { child: string }).child);
  });

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
    expect(s.rt.dragOffer(child, item.mount, { type: "application/x-clover-file", data: { path: "home/Laptop/a.txt" } })).toHaveProperty("error");
    const text = s.rt.dragOffer(child, item.mount, { type: "text/plain", data: "hello" });
    expect(text).toHaveProperty("token");
    const token = (text as { token: string }).token;
    expect(s.rt.dragClaim(shell.shellFrame, tab.mount, token)).toEqual({ type: "text/plain", data: "hello" });
    expect(s.rt.dragClaim(shell.shellFrame, tab.mount, token)).toHaveProperty("error");
    // A part of another document can't offer for this one.
    expect(() => s.rt.dragOffer(child, tab.mount, { type: "text/plain", data: "x" })).toThrow();
    // The conversation (conversation.read) offers a message; the composer's plugin may not hold one.
    const convo = s.rt.resolve(shell.shellFrame, tab.mount, "conversation").items[0]!;
    const msg = s.rt.dragOffer(shell.shellFrame, convo.mount, { type: "application/x-clover-message", data: { session: "s_1", seq: 3 } }) as { token: string };
    expect(msg).toHaveProperty("token");
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

describe("a plugin's sealed frames: its own bot's cards only, bound to the document that placed them", () => {
  const card = (id: string, bot?: string): SealedCard => ({
    id, kind: "tool", computer: null, ...(bot === undefined ? {} : { bot }), origin: "user", issuedAt: 1, expiresAt: null, hash: "b".repeat(64),
    fields: { title: { type: "text", text: "Run?" } }, options: [{ id: "allow_once", kind: "approve", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" }],
  });
  function placed() {
    const s = setup([...readUiPlugins([folderView(join(FIXTURES, "fixture-card"))] as never)]);
    const shell = mountShell(s);
    const item = s.rt.resolve(shell.shellFrame, shell.info.mount, "bot.tab", "alpha").items[0]!;
    if (item.kind !== "frame") throw new Error("not a frame");
    const token = new URL(item.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-card", token);
    const docFrame = frame(item.url, shell.shellFrame);
    const info = s.rt.describe(docFrame, WIN, token);
    const store = new SealedFrames();
    s.rt.sealed = store;
    for (const c of [card("card_own", "fixture-card/bot"), card("card_other", "alpha"), card("card_none")]) store.fromCore(c);
    return { s, store, docFrame, mount: info.mount };
  }

  test("its own bot's card gets a frame, bound to the frame of the document that placed it", () => {
    const { s, store, docFrame, mount } = placed();
    const url = s.rt.sealedFrameOf(docFrame, mount, "card_own", "button:allow_once")!;
    expect(url).toMatch(/^clover-sealed:\/\/card\/card_own\/button%3Aallow_once\?token=/);
    const token = new URL(url).searchParams.get("token")!;
    // The channel answers only for a sealed frame whose parent is that document's frame (the plugin's own iframe).
    expect(store.boundOf(token)).toBe(`p:${docFrame.processId}:${docFrame.routingId}`);
  });

  test("another bot's card, and a card of no bot, are refused, whatever the part holds", () => {
    const { s, docFrame, mount } = placed();
    for (const id of ["card_other", "card_none"]) {
      expect(() => s.rt.sealedFrameOf(docFrame, mount, id, "button:allow_once")).toThrow("takes a card of this plugin's own bot");
    }
  });

  test("each ask says what came of it, with the window of the part that asked (the app's timing lines)", () => {
    const { s, docFrame, mount } = placed();
    const heard: [string, number | undefined, string][] = [];
    s.rt.onSealedAsk = (cardId, windowId, outcome) => heard.push([cardId, windowId, outcome]);
    expect(s.rt.sealedFrameOf(docFrame, mount, "card_later", "button:allow_once")).toBeUndefined();
    expect(s.rt.sealedFrameOf(docFrame, mount, "card_own", "field:nothing")).toBe("");
    expect(s.rt.sealedFrameOf(docFrame, mount, "card_own", "button:allow_once")).toMatch(/^clover-sealed:/);
    expect(() => s.rt.sealedFrameOf(docFrame, mount, "card_other", "button:allow_once")).toThrow();
    expect(heard).toEqual([["card_later", WIN, "not yet"], ["card_own", WIN, "absent"], ["card_own", WIN, "made"], ["card_other", WIN, "refused"]]);
  });
});

describe("the row diagnosis log lines (ids only, once per pair, no change of what a call does)", () => {
  test("a part asked of a document that isn't its own is refused as before and named once; an unbound frame is named once, without its address", () => {
    const lines: string[] = [];
    const s = setup([], { log: (l) => lines.push(l) });
    expect(() => s.rt.resolve(s.rootFrame, "nope", "bot.tab")).toThrow("that part isn't in this document");
    expect(() => s.rt.resolve(s.rootFrame, "nope", "bot.tab")).toThrow("that part isn't in this document");
    expect(lines.filter((l) => l.includes("asked of document"))).toHaveLength(1);
    expect(lines.find((l) => l.includes("asked of document"))).toContain("no such mount");
    const stray = frame("clover-plugin://clover/?mount=secrettoken");
    expect(() => s.rt.resolve(stray, "nope", "bot.tab")).toThrow("this document isn't bound to a mount");
    expect(() => s.rt.resolve(stray, "nope", "bot.tab")).toThrow("this document isn't bound to a mount");
    const unbound = lines.filter((l) => l.includes("bound to no mount"));
    expect(unbound).toHaveLength(1);
    expect(unbound[0]).not.toContain("secrettoken");
  });
});
