// The plugin runtime in the main process, without Electron (decision 77, S9's design): mounts inline in the same layer
// and as frames from other layers, single-use tokens bound to the frame and parent that loaded them, props and
// callbacks across a frame's edge, sizes, releases, the crash census and a reload's fresh token, each part themed by its
// tab, and safe mode.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LayerMessage } from "@waifucave/moss-plugin-sdk/ui/bridge";
import { readUiEntry, readUiPlugins, type UiPlugin } from "../src/main/ui/model";
import { MOUNT_TOKEN_TTL_MS, UiRuntime, type FrameRef } from "../src/main/ui/runtime";
import { SealedFrames, type SealedCard } from "../src/main/sealed";
import { FIXTURES, alphaView, mossViews, folderView } from "./fake-core/registry";

const WIN = 1;

let pid = 100;
function frame(url: string, parent: FrameRef | null = null, osPid = ++pid): FrameRef {
  return { processId: osPid, routingId: ++pid, url, osPid, parent };
}

function setup(extra: UiPlugin[] = [], opts: { safeMode?: boolean; now?: () => number; log?: (line: string) => void; render?: boolean } = {}) {
  const sent: { to: string; m: LayerMessage }[] = [];
  let n = 0;
  const rt = new UiRuntime({ os: "macos", platform: "darwin", ...(opts.safeMode ? { safeMode: true } : {}), ...(opts.now ? { now: opts.now } : {}), ...(opts.log ? { log: opts.log } : {}), token: () => `t${++n}`, send: (f, m) => sent.push({ to: `${f.processId}:${f.routingId}`, m }) });
  const plugins = [...readUiPlugins([...mossViews(), alphaView()] as never), ...extra];
  rt.setRegistry(plugins);
  rt.openWindow(WIN, { material: "vibrancy", ...(opts.render ? { render: true } : {}) });
  const rootFrame = frame("moss-core://app/");
  const root = rt.describe(rootFrame, WIN, undefined);
  return { rt, sent, root, rootFrame };
}

/** Mounts the shell's frame under the root, the way the root page and the protocol handler do. */
function mountShell(s: ReturnType<typeof setup>) {
  const view = s.rt.resolve(s.rootFrame, s.root.mount, "app.root");
  const item = view.items[0]!;
  if (item.kind !== "frame") throw new Error("the shell is not a frame");
  const token = new URL(item.url).searchParams.get("mount")!;
  expect(s.rt.serveDocument("moss", token)).toBeDefined();
  const shellFrame = frame(item.url, s.rootFrame);
  const info = s.rt.describe(shellFrame, WIN, token);
  return { item, token, shellFrame, info };
}

const composerFixture = () => readUiPlugins([folderView(join(FIXTURES, "fixture-composer"))] as never);

describe("the root and the shell", () => {
  test("the root mounts app.root: the shell, as a frame from the moss layer", () => {
    const s = setup();
    expect(s.root).toMatchObject({ pluginId: "core", spot: "app.root", context: { material: "vibrancy", os: "macos", safeMode: false } });
    const { item, info } = mountShell(s);
    expect(item).toMatchObject({ kind: "frame", layer: "moss", ref: "moss/shell#app.root" });
    expect(info).toMatchObject({ pluginId: "moss/shell", component: "Shell", module: "/_moss/moss.js", css: ["/_moss/moss.css"] });
    expect(info.context.bots).toEqual([{ id: "alpha", name: "Alpha" }]);
  });

  test("everything under moss renders inline in the shell's layer", () => {
    const s = setup();
    const { shellFrame, info } = mountShell(s);
    const sidebar = s.rt.resolve(shellFrame, info.mount, "sidebar");
    expect(sidebar.items).toMatchObject([{ kind: "inline", ref: "moss/sidebar#sidebar", component: "SidebarEntry" }]);
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
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    const view = s.rt.resolve(shell.shellFrame, tab.mount, "composer");
    const item = view.items[0]!;
    if (item.kind !== "frame") throw new Error(`not a frame: ${JSON.stringify(view)}`);
    const token = new URL(item.url).searchParams.get("mount")!;
    return { s, shell, tab, item, token };
  }

  test("the installed composer wins and shows as a frame from its own origin", () => {
    const { item } = withFixture();
    expect(item).toMatchObject({ kind: "frame", layer: "fixture-composer", ref: "fixture-composer#composer" });
    expect(item.url).toMatch(/^moss-plugin:\/\/fixture-composer\/\?mount=t\d+$/);
  });

  test("the document is served once, for its own layer only", () => {
    const { s, token } = withFixture();
    expect(s.rt.serveDocument("moss", token)).toBeUndefined();
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
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    const item = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0]!;
    now += MOUNT_TOKEN_TTL_MS + 1;
    expect(s.rt.serveDocument("fixture-composer", new URL((item as { url: string }).url).searchParams.get("mount"))).toBeUndefined();
  });

  test("it binds only from the frame its URL was loaded in, under the document that placed it", () => {
    const { s, shell, item, token } = withFixture();
    s.rt.serveDocument("fixture-composer", token);
    // Another layer's frame with the token in its URL, or the right URL under the wrong parent: refused.
    expect(() => s.rt.describe(frame(`moss-plugin://other/?mount=${token}`, shell.shellFrame), WIN, token)).toThrow();
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
    s.rt.setProps(shell.shellFrame, item.mount, { bot: { id: "alpha", name: "Alpha" }, onSend: { "$moss.callback": "1" } });
    expect(s.sent).toEqual([{ to: `${child.processId}:${child.routingId}`, m: { type: "props", mount: item.mount, props: { bot: { id: "alpha", name: "Alpha" }, onSend: { "$moss.callback": "1" } } } }]);
    // The same props again, from a parent that drew again: the child is told nothing.
    s.sent.length = 0;
    s.rt.setProps(shell.shellFrame, item.mount, { bot: { id: "alpha", name: "Alpha" }, onSend: { "$moss.callback": "1" } });
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
    const dir = mkdtempSync(join(tmpdir(), "moss-skin-"));
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
    // Bots doesn't offer the sidebar: a theme's old sidebar group loads and reaches no one.
    expect(Object.keys(tokens).filter((k) => k.startsWith("shell.") && k.includes(".sidebar"))).toEqual([]);
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
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    expect(Object.keys((tab as { tokens?: Record<string, unknown> }).tokens ?? {}).some((k) => k.startsWith("shell."))).toBe(false);
  });
});

describe("each part themed by its tab (decision 77)", () => {
  function botPlugin(id: string, accent: string): UiPlugin {
    const dir = mkdtempSync(join(tmpdir(), "moss-theme-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ theme: 1, name: id, tokens: { "color.accent": accent } }));
    return readUiPlugins([{ pluginId: id, treeHash: `sha256:${"0".repeat(64)}`, layer: id, assetBase: dir, ui: [], themes: [{ id, file: "theme.json" }], locales: [], bots: "all", isBot: true, botTheme: id, name: id }] as never)[0]!;
  }

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
    const dir = mkdtempSync(join(tmpdir(), "moss-sheet-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return readUiPlugins([{ pluginId: id, name: id, treeHash: `sha256:${"1".repeat(64)}`, layer: id, assetBase: dir, ui: [], themes: [], locales: [], bots: "all", ...view }] as never)[0]!;
  }
  const lunaBot = () => themed("luna", {
    "theme.json": JSON.stringify({ theme: 1, name: "Luna", tokens: { "color.accent": "#123456" }, css: "tab.css", fonts: [{ family: "Luna Sans", src: "luna.woff2" }], icons: { "app.send": "send.svg" } }),
    "tab.css": `.bubble { color: red; font-family: "Luna Sans" } @import "x.css";`,
  }, { themes: [{ id: "luna", file: "theme.json" }], isBot: true, botTheme: "luna", name: "Luna" });
  const sheetsSent = (s: ReturnType<typeof setup>, f: FrameRef) => s.sent.filter((x) => x.m.type === "sheets" && x.to === `${f.processId}:${f.routingId}`).map((x) => (x.m as Extract<LayerMessage, { type: "sheets" }>).sheets);

  test("a style entry dresses its part, stopping at a part another dresses; the user's own CSS goes last and loads nothing", () => {
    const dresser = themed("dresser", {
      "dress.json": JSON.stringify({ theme: 1, name: "Dress", tokens: {}, css: "dress.css" }),
      "dress.css": `.c { border: 1px solid; background: url(bg.png) }`,
      "bg.png": "",
    }, { ui: [{ spot: "composer", id: "dress", style: "dress.json" }] });
    const s = setup([dresser]);
    s.rt.setChoices({ picks: [], lists: [], overrides: { css: `.x { color: blue; background: url(https://x.example/a.png) }` } } as never);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    s.sent.length = 0;
    const composer = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0]!;
    expect(composer).toMatchObject({ kind: "inline", ref: "moss/composer#composer", styled: true });
    const sheets = sheetsSent(s, shell.shellFrame).at(-1)!;
    const style = sheets.find((x) => x.id === `style:dresser#dress:${composer.mount}`)!;
    expect(style.css).toBe(`@scope ([data-moss-part="${composer.mount}"]) to ([data-moss-styled]:not(:scope)){.c{border:1px solid;background:url("/_t/dresser/bg.png")}}`);
    expect(sheets.at(-1)).toEqual({ id: "user", css: `@scope ([data-moss-part="${shell.info.mount}"]){.x{color:blue}}` });
  });

  test("the core root takes no sheets; a sheet that didn't change isn't sent again", () => {
    const s = setup([lunaBot()]);
    expect(s.root.sheets).toBeUndefined();
    const shell = mountShell(s);
    s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent");
    s.sent.length = 0;
    s.rt.setAppearance("dark", "#FF0000");
    expect(sheetsSent(s, shell.shellFrame)).toEqual([]);
  });
});

describe("each document's strings (§5.5's translations)", () => {
  test("the core root reads the core's own; a layer reads its plugin's keys; a new language reaches every document", () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-locale-"));
    writeFileSync(join(dir, "fr.json"), JSON.stringify({ locale: 1, lang: "fr", strings: { "moss.core.root.reload": "Recharger", "fixture-composer.send": "Envoyer" } }));
    writeFileSync(join(dir, "en.json"), JSON.stringify({ locale: 1, lang: "en", strings: { "fixture-composer.send": "Send" } }));
    const fixture = composerFixture().map((p) => ({ ...p, locales: [{ lang: "fr", file: "fr.json" }, { lang: "en", file: "en.json" }], assetBase: dir }));
    const s = setup(fixture);
    expect(s.root.strings).toMatchObject({ lang: "en", strings: { "moss.core.root.reload": "Reload" } });
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
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
    expect(to(s.rootFrame)[0]!.strings["moss.core.root.reload"]).toBe("Recharger");
    // Nothing changed, nothing sent.
    s.sent.length = 0;
    s.rt.setChoices({ picks: [], lists: [], language: "fr" });
    expect(to(child)).toEqual([]);
  });
});

describe("a message to the main window's shell", () => {
  test("the window's acts and what it provides go to the part that fills app.root, whichever plugin's (F2b: never by layer or id)", () => {
    const s = setup(readUiPlugins([folderView(join(FIXTURES, "fixture-root"), 2000)] as never));
    const view = s.rt.resolve(s.rootFrame, s.root.mount, "app.root");
    const item = view.items[0]!;
    if (item.kind !== "frame") throw new Error("the root part is not a frame");
    expect(item).toMatchObject({ ref: "fixture-root#app.root" });
    const token = new URL(item.url).searchParams.get("mount")!;
    expect(s.rt.serveDocument(item.layer, token)).toBeDefined();
    const rootFrame = frame(item.url, s.rootFrame);
    s.rt.describe(rootFrame, WIN, token);
    const m = { type: "shell-act" as const, act: { kind: "sidebar" as const } };
    s.sent.length = 0;
    s.rt.rootPartMessage(WIN, m as never);
    expect(s.sent).toEqual([{ to: `${rootFrame.processId}:${rootFrame.routingId}`, m }]);
    s.sent.length = 0;
    s.rt.rootPartMessage(WIN + 1, m as never);
    expect(s.sent).toEqual([]);
  });

  test("a shell message goes to the window's moss shell document only (not the core root, not another window's)", () => {
    const s = setup([]);
    const shell = mountShell(s);
    const m = { type: "shell-provides" as const, sidebar: true, drag: false };
    s.sent.length = 0;
    s.rt.shellMessage(WIN, m);
    expect(s.sent).toEqual([{ to: `${shell.shellFrame.processId}:${shell.shellFrame.routingId}`, m }]);
    s.sent.length = 0;
    s.rt.shellMessage(WIN + 1, m);
    expect(s.sent).toEqual([]);
  });

  test("the frames main gives an activation to (the player's autoplay start) are the moss shell's own document alone, never the core root or another window's", () => {
    const s = setup([]);
    const shell = mountShell(s);
    expect(s.rt.shellFrames(WIN).map((f) => f.frame)).toEqual([{ processId: shell.shellFrame.processId, routingId: shell.shellFrame.routingId }]);
    expect(s.rt.shellFrames(WIN + 1)).toEqual([]);
  });
});

describe("lane B's #179 hooks in the runtime", () => {
  function tabbed(id: string, title: string, enabledAt: number, extra: Record<string, unknown> = {}): UiPlugin {
    return readUiPlugins([{ pluginId: id, name: id, treeHash: `sha256:${"3".repeat(64)}`, layer: id.replace(/\//g, "--"), assetBase: tmpdir(), clientEntry: "c.js", ui: [{ spot: "bot.header.action", id: "act", component: "Act", title, order: enabledAt }], themes: [], locales: [], bots: "all", ...extra }] as never, { [id]: { enabledAt, source: "installed" } })[0]!;
  }

  test("a spot's entries for the part that declares it, in the spot's order, with their fields; one shown by its ref", () => {
    const s = setup([tabbed("vn", "Visual novel", 2), tabbed("timer", "Timer", 1)]);
    // The tab's part declares bot.header.action (the shell's main[agent] tab declares the tab's spots).
    s.rt.setRegistry(s.rt.registry.map((p) => (p.id !== "moss/shell" ? p : { ...p, entries: p.entries.map((e) => ((e.spot !== "main" || e.key !== "agent") ? e : { ...e, declares: { ...e.declares, "bot.header.action": { shape: "list" } } })) })));
    const shell = mountShell(s);
    const fresh = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
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

  test("a panel a plugin adds: listed for the shell by plugin#key, mounted by its ref in its own key's cell", () => {
    const office = readUiPlugins([{ pluginId: "office", name: "Office", treeHash: `sha256:${"5".repeat(64)}`, layer: "office", assetBase: tmpdir(), clientEntry: "c.js", ui: [{ spot: "panel", id: "sheets", key: "sheets", component: "Sheets", title: "Sheets" }], themes: [], locales: [], bots: "all" }] as never, { office: { enabledAt: 3, source: "installed" } });
    const s = setup(office);
    const shell = mountShell(s);
    // The bundled parts' own panels (the avatar plugin's figure) are listed too; the plugin's is by its own ref.
    const own = s.rt.entries(shell.shellFrame, shell.info.mount, "panel", "*", "alpha", "bot").filter((e) => e.pluginId === "office");
    expect(own.map((e) => [e.ref, e.pluginId, e.key, e.fields.title])).toEqual([["office#sheets", "office", "sheets", "Sheets"]]);
    const view = s.rt.resolve(shell.shellFrame, shell.info.mount, "panel", "sheets", { entry: "office#sheets", session: "bot", bot: "alpha" });
    expect(view.undeclared).toBeUndefined();
    expect(view.items.map((i) => i.ref)).toEqual(["office#sheets"]);
  });

  test("a message action is data: the declaring part lists it, and nothing is ever mounted for it (no frame per message)", () => {
    const pin = readUiPlugins([{ pluginId: "pinner", name: "Pinner", treeHash: `sha256:${"5".repeat(64)}`, layer: "pinner", assetBase: tmpdir(), clientEntry: "c.js", ui: [{ spot: "conversation.message.action", id: "pin", title: "Pin", icon: "assets/pin.png", call: "pinReply" }], themes: [], locales: [], bots: "all" }] as never, { pinner: { enabledAt: 3, source: "installed" } })[0]!;
    const s = setup([pin]);
    s.rt.setRegistry(s.rt.registry.map((p) => (p.id !== "moss/shell" ? p : { ...p, entries: p.entries.map((e) => ((e.spot !== "main" || e.key !== "agent") ? e : { ...e, declares: { ...e.declares, "conversation.message.action": { shape: "list" } } })) })));
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    // MOSS Voice's speak button is the bundled tree's own entry beside it.
    expect(s.rt.entries(shell.shellFrame, tab.mount, "conversation.message.action").map((e) => [e.ref, e.fields.call, e.fields.title])).toEqual([["moss/voice#speak", "speak", "Speak"], ["pinner#pin", "pinReply", "Pin"]]);
    expect(s.rt.resolve(shell.shellFrame, tab.mount, "conversation.message.action").items).toEqual([]);
  });

  test("a pill target is data too: its entry (title and handler, no component) is read as data and never mounted", () => {
    const lights = readUiPlugins([{ pluginId: "lights", name: "Lights", treeHash: `sha256:${"6".repeat(64)}`, layer: "lights", assetBase: tmpdir(), clientEntry: "c.js", ui: [{ spot: "pill.target", id: "lights-target", title: "Lights", handler: "target" }], themes: [], locales: [], bots: "all" }] as never, { lights: { enabledAt: 3, source: "installed" } })[0]!;
    const e = lights.entries.find((x) => x.spot === "pill.target")!;
    expect([e.kind, e.fields.title, e.fields.handler]).toEqual(["data", "Lights", "target"]);
  });

  test("the questions go only to a document whose plugin may read conversations", () => {
    const reader = tabbed("reader", "Reader", 3, { capabilities: ["conversation.read"] });
    const s = setup([...composerFixture(), reader]);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    const composer = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { url: string; mount: string };
    const token = new URL(composer.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const child = frame(composer.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    s.sent.length = 0;
    const q = { session: "s_alpha", callId: "c1", at: 1, questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] };
    s.rt.setQuestions([q]);
    const to = s.sent.filter((x) => x.m.type === "questions").map((x) => x.to);
    // The moss layer (its conversation reads them) does; the fixture composer, with no capability, doesn't.
    expect(to).toContain(`${shell.shellFrame.processId}:${shell.shellFrame.routingId}`);
    expect(to).not.toContain(`${child.processId}:${child.routingId}`);
  });

  test("only a part whose plugin holds user.send sends the user's words (no plugin's id decides it), and the door names each part by its plugin and capabilities", () => {
    const s = setup(composerFixture());
    const shell = mountShell(s);
    expect(s.rt.partCaller(shell.shellFrame, shell.info.mount)).toMatchObject({ pluginId: "moss/shell" });
    // The bundled shell without the capability sends nothing: the tree's name is no key.
    expect(() => s.rt.userSender(shell.shellFrame, shell.info.mount)).toThrow("user.send capability");
    // With `user.send` in its manifest (what the build grants the pill), it does.
    const granted = setup(composerFixture());
    granted.rt.setRegistry(granted.rt.registry.map((p) => (p.id !== "moss/shell" ? p : { ...p, capabilities: new Set([...p.capabilities, "user.send"]) })));
    const shell2 = mountShell(granted);
    expect(granted.rt.userSender(shell2.shellFrame, shell2.info.mount)).toMatchObject({ pluginId: "moss/shell" });
    // A third-party part in its own layer's document is not a tree part, and sends only if it holds the capability too.
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    const composer = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { url: string; mount: string };
    const token = new URL(composer.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const child = frame(composer.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    // The door asks its capabilities, never whether it is the tree's (F2): the fixture composer holds none of the door's.
    expect([...s.rt.partCaller(child, composer.mount)!.capabilities].filter((c) => ["app.settings", "plugins.manage", "bots.edit"].includes(c))).toEqual([]);
    // It is a composer-spot entry, so it sends to its own session only (never anywhere else).
    s.rt.setProps(shell.shellFrame, composer.mount, { bot: { id: "alpha", name: "Alpha" }, session: "alpha:main" });
    expect(s.rt.userSender(child, composer.mount)).toMatchObject({ pluginId: "fixture-composer", only: { session: "alpha:main" } });
  });
});

describe("a held key binding's documents (§5.4 `hold`)", () => {
  test("the owner's own documents in that window get its release's allowance, only while the owner holds user.send", () => {
    const id = (f: FrameRef) => `${f.processId}:${f.routingId}`;
    const open = (granted: string[]) => {
      const s = setup(composerFixture());
      s.rt.setRegistry(s.rt.registry.map((p) => (!granted.includes(p.id) ? p : { ...p, capabilities: new Set([...p.capabilities, "user.send"]) })));
      const shell = mountShell(s);
      const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
      const composer = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { url: string; mount: string };
      const token = new URL(composer.url).searchParams.get("mount")!;
      s.rt.serveDocument("fixture-composer", token);
      const child = frame(composer.url, shell.shellFrame);
      s.rt.describe(child, WIN, token);
      return { s, shell: shell.shellFrame, child };
    };
    // A plugin without user.send gets none, whatever it holds in the window.
    const none = open([]);
    expect(none.s.rt.heldKeyFrames(WIN, "fixture-composer")).toEqual([]);
    expect(none.s.rt.heldKeyFrames(WIN, "moss/shell")).toEqual([]);
    // With it: its own document, never another plugin's, and nothing in another window.
    const one = open(["fixture-composer"]);
    expect(one.s.rt.heldKeyFrames(WIN, "fixture-composer")).toEqual([id(one.child)]);
    expect(one.s.rt.heldKeyFrames(WIN + 1, "fixture-composer")).toEqual([]);
    expect(one.s.rt.heldKeyFrames(WIN, "moss/shell")).toEqual([]);
    const both = open(["fixture-composer", "moss/shell"]);
    expect(both.s.rt.heldKeyFrames(WIN, "moss/shell")).toEqual([id(both.shell)]);
  });
});

describe("the composer spot's mount record", () => {
  test("composerOf knows only an entry the core mounted in the composer spot, for the session the declaring document gave", () => {
    const s = setup(composerFixture());
    const shell = mountShell(s);
    expect(s.rt.composerOf(shell.shellFrame, shell.info.mount)).toBeUndefined();
    expect(s.rt.mainShell(shell.shellFrame, shell.info.mount)).toMatchObject({ windowId: WIN });
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    const comp = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { url: string; mount: string };
    const token = new URL(comp.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const child = frame(comp.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    // A third party's composer entry in its own layer is a composer-spot entry too, for the session its declaring document says.
    expect(s.rt.composerOf(child, comp.mount)).toBeUndefined();
    s.rt.setProps(shell.shellFrame, comp.mount, { bot: { id: "alpha", name: "Alpha" }, session: "alpha:main" });
    expect(s.rt.composerOf(child, comp.mount)).toMatchObject({ pluginId: "fixture-composer", session: "alpha:main", bot: "alpha", windowId: WIN });
    s.rt.setProps(shell.shellFrame, comp.mount, { session: "../etc" });
    expect(s.rt.composerOf(child, comp.mount)).toBeUndefined();
    // The window's shell is only the part in `app.root` (what the window shows, where it is, its drag): never a composer, a
    // tab or any other part, whatever capabilities its plugin holds (F2's fix round).
    expect(s.rt.mainShell(child, comp.mount)).toBeUndefined();
    expect(s.rt.mainShell(shell.shellFrame, tab.mount)).toBeUndefined();
  });
});

describe("safe mode and the registry", () => {
  test("in safe mode a third-party part isn't mounted; the bundled one shows", () => {
    const s = setup(composerFixture(), { safeMode: true });
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    expect(s.rt.resolve(shell.shellFrame, tab.mount, "composer").items).toMatchObject([{ kind: "inline", ref: "moss/composer#composer" }]);
  });

  test("a registry change asks every document to resolve its spots again", () => {
    const s = setup();
    const shell = mountShell(s);
    s.sent.length = 0;
    s.rt.setRegistry(s.rt.registry.filter((p) => p.id !== "moss/sidebar"));
    expect(s.sent.filter((x) => x.m.type === "respot").map((x) => x.to).sort()).toEqual([`${s.rootFrame.processId}:${s.rootFrame.routingId}`, `${shell.shellFrame.processId}:${shell.shellFrame.routingId}`].sort());
    expect(s.rt.resolve(shell.shellFrame, shell.info.mount, "sidebar").items).toEqual([]);
  });

  test("the moss layer says what kind of session a part shows, for `when.session`", () => {
    const s = setup();
    // F's code-only panels say so with `when.session` (lane B's catalog).
    const shell = mountShell(s);
    const code = s.rt.resolve(shell.shellFrame, shell.info.mount, "panel", "diff", { session: "coding" });
    expect(code.items).toMatchObject([{ ref: "moss/panel-diff#diff" }]);
    expect(s.rt.resolve(shell.shellFrame, shell.info.mount, "panel", "diff", { session: "bot" }).items).toEqual([]);
  });
});

describe("what a conversation's inner spots need is the data's own kind (spec revision 19, §3.6)", () => {
  /** A third-party plugin with one entry in `spot` and the capabilities it holds. */
  function filler(id: string, caps: string[], spot: string): UiPlugin {
    return {
      id, topId: id, layer: id, treeHash: "0".repeat(64), assetBase: `/plugins/${id}`, css: [], source: "installed", enabledAt: 1000, capabilities: new Set(caps),
      bots: "all", isBot: false, themes: [], locales: [], dataFiles: [], entries: [readUiEntry(id, { spot, component: "Extra" })!],
    } as UiPlugin;
  }
  const bots = filler("bots-only", ["conversation.read"], "conversation.message.extra");
  const code = filler("code-only", ["sessions.read"], "conversation.message.extra");

  /** The conversation part's own document (the moss layer), as the session's tab places it. */
  function conversationPart() {
    const s = setup([bots, code]);
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    const conv = s.rt.resolve(shell.shellFrame, tab.mount, "conversation").items[0]!;
    return { s, shell, conv };
  }
  const refs = (v: { items: readonly object[] }) => v.items.map((i) => (i as { ref?: string }).ref?.split("#")[0]).sort();

  test("the conversation part (the moss layer) says the session's kind: a code session's add-ons come from sessions.read plugins only, a bot's from conversation.read ones only, an archived one's from neither", () => {
    const { s, shell, conv } = conversationPart();
    const ask = (session: string | undefined) => refs(s.rt.resolve(shell.shellFrame, conv.mount, "conversation.message.extra", undefined, session === undefined ? {} : { session }));
    for (const session of ["coding", "agent"]) expect([session, ask(session)]).toEqual([session, ["code-only"]]);
    for (const session of ["bot", "side-thread"]) expect([session, ask(session)]).toEqual([session, ["bots-only"]]);
    // A cell whose kind isn't told: both reads, so neither single-kind plugin.
    expect(ask(undefined)).toEqual([]);
    expect(ask("archived")).toEqual([]);
  });
});

describe("sleeping frames, surfaces, and the brokers' part of the runtime", () => {
  function withFixtureFrame() {
    const s = setup(composerFixture());
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    const item = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { mount: string; url: string };
    const token = new URL(item.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const child = frame(item.url, shell.shellFrame);
    s.rt.describe(child, WIN, token);
    return { s, shell, tab, item, token, child };
  }

  test("the window's width class is in the mount context and told to every frame of the window when it flips (the shell's 900px rule)", () => {
    const { s, shell, child, item } = withFixtureFrame();
    const to = (f: { processId: number; routingId: number }) => `${f.processId}:${f.routingId}`;
    s.sent.length = 0;
    s.rt.setWindowWidth(WIN, 1200);
    expect(s.sent).toEqual([]);
    s.rt.setWindowWidth(WIN, 899);
    expect(s.sent).toContainEqual({ to: to(child), m: { type: "window", narrow: true } });
    expect(s.sent).toContainEqual({ to: to(shell.shellFrame), m: { type: "window", narrow: true } });
    // The same class again is nothing; 900 is wide.
    s.sent.length = 0;
    s.rt.setWindowWidth(WIN, 500);
    expect(s.sent).toEqual([]);
    s.rt.setWindowWidth(WIN, 900);
    expect(s.sent).toContainEqual({ to: to(child), m: { type: "window", narrow: false } });
    // A document that mounts while the window is narrow learns it from its context.
    s.rt.setWindowWidth(WIN, 600);
    const url = s.rt.reload(shell.shellFrame, item.mount)!;
    const again = new URL(url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", again);
    expect(s.rt.describe(frame(url, shell.shellFrame), WIN, again).context.window).toEqual({ narrow: true });
  });

  test("a frame that loads its spent address again (made again, moved, or late) gets a fresh one from its parent; nothing else can use it (window-3 step 33's \"forbidden\")", () => {
    let t = 1_000_000;
    const s = setup(composerFixture(), { now: () => t });
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    const item = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0] as { mount: string; url: string };
    const token = new URL(item.url).searchParams.get("mount")!;
    const reloads = () => s.sent.filter((x) => x.m.type === "child-reload").map((x) => x.m as { child: string; url: string });
    // 1. The first load is served and binds.
    expect(s.rt.serveDocument("fixture-composer", token)).toBeDefined();
    s.rt.describe(frame(item.url, shell.shellFrame), WIN, token);
    // 2. The same address loads again (the parent made the frame again with the same src): refused, and the parent is sent a
    //    fresh address for that mount, which serves once.
    s.sent.length = 0;
    expect(s.rt.serveDocument("fixture-composer", token)).toBeUndefined();
    expect(reloads()).toHaveLength(1);
    expect(reloads()[0]!.child).toBe(item.mount);
    const fresh = new URL(reloads()[0]!.url).searchParams.get("mount")!;
    expect(fresh).not.toBe(token);
    // Sent to the parent document only (the shell's frame), never to whatever loaded the old address.
    expect(s.sent.find((x) => x.m.type === "child-reload")!.to).toBe(`${shell.shellFrame.processId}:${shell.shellFrame.routingId}`);
    // 3. The old address once more within the second: no second fresh one (no loop); another layer's load of it: nothing.
    s.sent.length = 0;
    expect(s.rt.serveDocument("fixture-composer", token)).toBeUndefined();
    expect(s.rt.serveDocument("acceptance-other", token)).toBeUndefined();
    expect(reloads()).toEqual([]);
    // 4. The parent never took the fresh address and its frame loads the old one a second later: the unspent fresh one is sent again.
    t += 1_500;
    expect(s.rt.serveDocument("fixture-composer", token)).toBeUndefined();
    expect(reloads().map((r) => new URL(r.url).searchParams.get("mount"))).toEqual([fresh]);
    // 5. The fresh address serves once and binds; the old one is now an address the mount moved on from: refused, nothing sent.
    expect(s.rt.serveDocument("fixture-composer", fresh)).toBeDefined();
    s.rt.describe(frame(`moss-plugin://fixture-composer/?mount=${fresh}`, shell.shellFrame), WIN, fresh);
    s.sent.length = 0;
    t += 1_500;
    expect(s.rt.serveDocument("fixture-composer", token)).toBeUndefined();
    expect(reloads()).toEqual([]);
    // 6. A part drawn more than a minute after its address was issued: refused as expired, and a fresh address goes to its parent.
    const late = s.rt.reload(shell.shellFrame, item.mount)!;
    const lateToken = new URL(late).searchParams.get("mount")!;
    s.sent.length = 0;
    t += 61_000;
    expect(s.rt.serveDocument("fixture-composer", lateToken)).toBeUndefined();
    expect(reloads()).toHaveLength(1);
    expect(s.rt.serveDocument("fixture-composer", new URL(reloads()[0]!.url).searchParams.get("mount"))).toBeDefined();
  });

  test("a frame's document loads again when its plugin's module changes (a client the core built at load landing later)", () => {
    const { s, item } = withFixtureFrame();
    s.sent.length = 0;
    // The same plugins: nothing loads again.
    s.rt.setRegistry([...readUiPlugins([...mossViews(), alphaView()] as never), ...composerFixture()]);
    expect(s.sent.filter((x) => x.m.type === "child-reload")).toEqual([]);
    // Its client is now the core's build: the frame's document is served again, for the module it has now.
    const built = composerFixture().map((p) => ({ ...p, clientEntry: undefined, clientBuild: { base: "/x", file: "index.js", sha256: "cd".repeat(32) } }));
    s.rt.setRegistry([...readUiPlugins([...mossViews(), alphaView()] as never), ...built]);
    const reload = s.sent.find((x) => x.m.type === "child-reload");
    expect(reload?.m).toMatchObject({ type: "child-reload", child: item.mount });
    const token = new URL((reload!.m as { url: string }).url).searchParams.get("mount")!;
    const again = s.rt.serveDocument("fixture-composer", token);
    expect(s.rt.mountForDocument(again!).assets.module).toBe(`/_b/fixture-composer/${"cd".repeat(8)}/index.js`);
  });

  test("the microphone follows the capability for a frame already open: the plugin stays listed, its live frame loads again with the new policy (withdrawn and given)", () => {
    const { s, item, shell } = withFixtureFrame();
    const base = readUiPlugins([...mossViews(), alphaView()] as never);
    const withMic = (on: boolean) => composerFixture().map((p) => ({ ...p, capabilities: new Set(on ? [...p.capabilities, "microphone"] : [...p.capabilities].filter((c) => c !== "microphone")) }));
    // Given while the frame is open: it loads again (its document's policy was fixed when it was served), the layer now holds it.
    s.sent.length = 0;
    s.rt.setRegistry([...base, ...withMic(true)]);
    expect(s.rt.layerHolds("fixture-composer", "microphone")).toBe(true);
    const gain = s.sent.filter((x) => x.m.type === "child-reload");
    expect(gain.length).toBe(1);
    // The reload carries the frame's flags (a parent that builds the frame again, the core root, gives it the same `allow`).
    expect(gain[0]!.m).toMatchObject({ child: item.mount, microphone: true });
    const token = new URL((gain[0]!.m as { url: string }).url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    s.rt.describe(frame((gain[0]!.m as { url: string }).url, shell.shellFrame), WIN, token);
    // The same registry again is nothing.
    s.sent.length = 0;
    s.rt.setRegistry([...base, ...withMic(true)]);
    expect(s.sent.filter((x) => x.m.type === "child-reload")).toEqual([]);
    // Withdrawn while it stays listed and open: loads again, and the layer no longer holds it (a new request is refused too).
    s.rt.setRegistry([...base, ...withMic(false)]);
    const lose = s.sent.filter((x) => x.m.type === "child-reload");
    expect(lose.length).toBe(1);
    expect((lose[0]!.m as { microphone?: true }).microphone).toBeUndefined();
    expect(s.rt.layerHolds("fixture-composer", "microphone")).toBe(false);
  });

  test("ten changes of a plugin's module while its frame loads again: one reload, and the document served has the last module", () => {
    const { s, item } = withFixtureFrame();
    s.sent.length = 0;
    const builtAs = (n: number) => composerFixture().map((p) => ({ ...p, clientEntry: undefined, clientBuild: { base: "/x", file: "index.js", sha256: n.toString(16).repeat(64).slice(0, 64) } }));
    for (let n = 1; n <= 10; n++) s.rt.setRegistry([...readUiPlugins([...mossViews(), alphaView()] as never), ...builtAs(n)]);
    const reloads = s.sent.filter((x) => x.m.type === "child-reload");
    // The first change reloads it; the frame is loading again (its token issued, not yet served) for the other nine.
    expect(reloads.length).toBe(1);
    const token = new URL((reloads[0]!.m as { url: string }).url).searchParams.get("mount")!;
    const again = s.rt.serveDocument("fixture-composer", token);
    expect(s.rt.mountForDocument(again!).assets.module).toBe(`/_b/fixture-composer/${"a".repeat(16)}/index.js`);
    // Served with the last module: the same registry again reloads nothing.
    s.sent.length = 0;
    s.rt.setRegistry([...readUiPlugins([...mossViews(), alphaView()] as never), ...builtAs(10)]);
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
    expect(s.rt.surfaceEntries().map((e) => e.id).sort()).toEqual(["fixture", "island", "on-screen", "pill"]);
    s.rt.openWindow(7, { material: "none", surface: { id: "fixture", ref: "fixture-surface#fixture" } });
    const rootFrame = frame("moss-core://app/?surface=fixture");
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
    // In safe mode only moss's surfaces open.
    expect(setup(surface, { safeMode: true }).rt.surfaceEntries().map((e) => e.id).sort()).toEqual(["island", "on-screen", "pill"]);
  });

  test("background parts: app.background components that may run, each in a window of its own whose root shows only it; audio only for a plugin holding it", () => {
    const bg = readUiPlugins([folderView(join(FIXTURES, "fixture-background"))] as never);
    const s = setup(bg);
    // MOSS Voice's player is the bundled tree's own background part.
    // MOSS Voice holds `microphone` for its hold-to-talk button; a capability is the plugin's, so its player's window carries it too.
    const VOICE = { ref: "moss/voice#player", pluginId: "moss/voice", audio: true, microphone: true };
    expect(s.rt.backgroundEntries()).toEqual([VOICE, { ref: "fixture-background#ticker", pluginId: "fixture-background", audio: true, microphone: false }]);
    // The surface list doesn't take it, and in safe mode only moss's would run.
    expect(s.rt.surfaceEntries().map((e) => e.id)).not.toContain("ticker");
    expect(setup(bg, { safeMode: true }).rt.backgroundEntries().filter((e) => e.pluginId !== VOICE.pluginId)).toEqual([]);
    // A plugin without `audio`.
    const quiet = readUiPlugins([{ ...folderView(join(FIXTURES, "fixture-background")), capabilities: [] }] as never);
    expect(setup(quiet).rt.backgroundEntries()).toEqual([VOICE, { ref: "fixture-background#ticker", pluginId: "fixture-background", audio: false, microphone: false }]);
    // Its window's root declares `app.background` and places just that entry; the frame may autoplay (the plugin holds `audio`), and the
    // other plugin's would not.
    s.rt.openWindow(8, { material: "none", surface: { id: "fixture-background#ticker", ref: "fixture-background#ticker", spot: "app.background" } });
    const rootFrame = frame("moss-core://app/?surface=fixture-background%23ticker");
    const root = s.rt.describe(rootFrame, 8, undefined);
    expect(root).toMatchObject({ spot: "app.background" });
    const view = s.rt.resolve(rootFrame, root.mount, "app.background");
    expect(view.items).toMatchObject([{ kind: "frame", ref: "fixture-background#ticker", layer: "fixture-background", autoplay: true }]);
    const q = setup(quiet);
    q.rt.openWindow(9, { material: "none", surface: { id: "fixture-background#ticker", ref: "fixture-background#ticker", spot: "app.background" } });
    const quietRoot = frame("moss-core://app/?surface=fixture-background%23ticker");
    const quietView = q.rt.resolve(quietRoot, q.rt.describe(quietRoot, 9, undefined).mount, "app.background");
    expect((quietView.items[0] as { autoplay?: true }).autoplay).toBeUndefined();
    // Closing its window drops the mount.
    s.rt.closeWindow(8);
    expect(() => s.rt.describe(rootFrame, 8, undefined)).toThrow();
  });
  test("a surface's powers are its plugin's capabilities and its manifest's fields, never its id; tray lines are the plugin's own", () => {
    const view = (id: string, capabilities: string[], extra: Record<string, unknown> = {}) => readUiPlugins([{
      pluginId: id, name: `Name of ${id}`, treeHash: `sha256:${"7".repeat(64)}`, layer: id, assetBase: tmpdir(), clientEntry: "c.js", capabilities, themes: [], locales: [], bots: "all",
      ui: [
        { spot: "app.surface", id: "island", component: "Island", window: { type: "overlay", alwaysOnTop: true, front: "steps-aside", cards: true, summon: ["tap"] } },
        { spot: "app.tray", id: "put-away", title: "Hide me", toggles: "island" },
        { spot: "app.tray", id: "run", title: "Run it", command: "mine.run" },
        { spot: "app.tray", id: "stray", title: "Hide another", toggles: "not-mine" },
        ...(extra.more as object[] | undefined ?? []),
      ],
    }] as never, { [id]: { enabledAt: 5, source: "installed" } })[0]!;
    const full = view("copy-island", ["approvals", "approvals.all", "overlay", "tray"]);
    const bare = view("plain-island", ["approvals"]);
    const s = setup([full, bare]);
    const mine = (id: string) => s.rt.surfaceEntries().find((e) => e.pluginId === id)!;
    // The same manifest fields; what each may do is its capabilities (the copy under another id has what the bundled island has).
    expect(mine("copy-island")).toMatchObject({ floats: true, cards: true, stepsAside: true, tap: true });
    expect(mine("plain-island")).toMatchObject({ floats: false, cards: false, stepsAside: true, tap: true });
    // Tray lines need `tray`; a toggle names the plugin's own surface that is there; each plugin has a few lines.
    expect(s.rt.trayEntries().filter((t) => t.pluginId !== "moss/pill").map((t) => [t.pluginId, t.title, t.surface ?? t.command])).toEqual([
      ["copy-island", "Hide me", "copy-island#island"], ["copy-island", "Run it", "mine.run"],
    ]);
    // The bundled pill's own line is read the same way (its manifest says so: a toggle of its own surface).
    expect(s.rt.trayEntries().find((t) => t.pluginId === "moss/pill")).toMatchObject({ title: "Dispatch Pill", surface: "moss/pill#pill" });
    const many = view("loud", ["tray"], { more: [1, 2, 3, 4].map((n) => ({ spot: "app.tray", id: `c${n}`, title: `C${n}`, command: `loud.c${n}` })) });
    expect(setup([many]).rt.trayEntries().filter((t) => t.pluginId === "loud")).toHaveLength(3);
  });

  test("a plugin holding `microphone`: its frames carry the flag and the runtime says its layer holds it; no other plugin's does", () => {
    const view = (capabilities: string[]) => readUiPlugins([{ ...folderView(join(FIXTURES, "fixture-surface")), capabilities }] as never);
    const hold = setup(view(["microphone"]));
    expect(hold.rt.layerHolds("fixture-surface", "microphone")).toBe(true);
    expect(hold.rt.layerHolds("fixture-surface", "audio")).toBe(false);
    // The moss layer holds it through MOSS Voice (its hold-to-talk button), one of its plugins.
    expect(hold.rt.layerHolds("moss", "microphone")).toBe(true);
    expect(hold.rt.layerHolds("fixture-other", "microphone")).toBe(false);
    expect(hold.rt.layerHolds("someone-else", "microphone")).toBe(false);
    const itemOf = (s: ReturnType<typeof setup>) => {
      s.rt.openWindow(7, { material: "none", surface: { id: "fixture", ref: "fixture-surface#fixture" } });
      const rootFrame = frame("moss-core://app/?surface=fixture");
      const root = s.rt.describe(rootFrame, 7, undefined);
      return s.rt.resolve(rootFrame, root.mount, "app.surface").items[0] as { microphone?: true };
    };
    expect(itemOf(hold).microphone).toBe(true);
    const none = setup(view([]));
    expect(none.rt.layerHolds("fixture-surface", "microphone")).toBe(false);
    expect(itemOf(none).microphone).toBeUndefined();
  });

  test("a background part is a client part like any other: its host half's ui.send reaches its document, and its own calls act as its plugin", () => {
    const bg = readUiPlugins([folderView(join(FIXTURES, "fixture-background"))] as never);
    const s = setup(bg);
    s.rt.openWindow(8, { material: "none", surface: { id: "fixture-background#ticker", ref: "fixture-background#ticker", spot: "app.background" } });
    const rootFrame = frame("moss-core://app/?surface=fixture-background%23ticker");
    const root = s.rt.describe(rootFrame, 8, undefined);
    const item = s.rt.resolve(rootFrame, root.mount, "app.background").items[0] as { mount: string; url: string };
    const token = new URL(item.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-background", token);
    const child = frame(item.url, rootFrame);
    s.rt.describe(child, 8, token);
    // The host half's `ui.send` (a plugin_ui_message on the plugin's own connection) goes to the background document.
    s.sent.length = 0;
    const message = { type: "api-event", pluginId: "fixture-background", method: "core.event", params: { type: "plugin_ui_message", pluginId: "fixture-background", event: "holds", value: { utterances: ["u1"] } } };
    s.rt.pluginMessage("fixture-background", message as never);
    expect(s.sent).toEqual([{ to: `${child.processId}:${child.routingId}`, m: message as never }]);
    // Another plugin's message doesn't reach it.
    s.sent.length = 0;
    s.rt.pluginMessage("moss/voice", { ...message, pluginId: "moss/voice" } as never);
    expect(s.sent.filter((x) => x.to === `${child.processId}:${child.routingId}`)).toEqual([]);
    // browser-press: the MOSS Browser's events (`visibleOnly`) never reach a background document, and the part is known
    // as one in the background.
    s.sent.length = 0;
    s.rt.pluginMessage("fixture-background", { ...message, params: { type: "tab_changed", tab: { id: "t" } } } as never, { visibleOnly: true });
    expect(s.sent).toEqual([]);
    expect(s.rt.inBackground(child, item.mount)).toBe(true);
    // The other way: its part's calls (`host.call` to its host half among them) go as its own plugin, with its capabilities.
    expect(s.rt.partOf(child, item.mount)).toBe("fixture-background");
    expect([...s.rt.capabilitiesOf(child, item.mount)]).toContain("audio");
  });

  test("browser-press: the MOSS Browser's events (visibleOnly) reach a visible part's document in the main window", () => {
    const { s, child, item } = withFixtureFrame();
    s.sent.length = 0;
    const m = { type: "api-event", pluginId: "fixture-composer", method: "core.event", params: { type: "tab_changed", tab: { id: "t" } } };
    s.rt.pluginMessage("fixture-composer", m as never, { visibleOnly: true });
    expect(s.sent).toEqual([{ to: `${child.processId}:${child.routingId}`, m: m as never }]);
    expect(s.rt.inBackground(child, item.mount)).toBe(false);
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
    expect(s.rt.dragOffer(child, item.mount, { type: "application/x-moss-file", data: { path: "home/Laptop/a.txt" } })).toHaveProperty("error");
    const text = s.rt.dragOffer(child, item.mount, { type: "text/plain", data: "hello" });
    expect(text).toHaveProperty("token");
    const token = (text as { token: string }).token;
    expect(s.rt.dragClaim(shell.shellFrame, tab.mount, token)).toEqual({ type: "text/plain", data: "hello" });
    expect(s.rt.dragClaim(shell.shellFrame, tab.mount, token)).toHaveProperty("error");
    // A part of another document can't offer for this one.
    expect(() => s.rt.dragOffer(child, tab.mount, { type: "text/plain", data: "x" })).toThrow();
    // The conversation (conversation.read) offers a message; the composer's plugin may not hold one.
    const convo = s.rt.resolve(shell.shellFrame, tab.mount, "conversation").items[0]!;
    const msg = s.rt.dragOffer(shell.shellFrame, convo.mount, { type: "application/x-moss-message", data: { session: "s_1", seq: 3 } }) as { token: string };
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
      { ...good, pluginId: "evil", layer: "moss" },
      { ...good, pluginId: "kid/part", layer: "kid--part" },
      { pluginId: "broken" },
    ], {}, (l) => lines.push(l));
    expect(plugins.map((p) => [p.id, p.layer])).toEqual([["fixture-composer", "fixture-composer"], ["kid/part", "kid--part"]]);
    expect(lines.join("\n")).toContain("refused evil: its layer is evil, not moss");
    expect(lines.join("\n")).toContain("refused a plugin view that isn't one");
  });

  test("main[agent]: the shell, which declares it, shows it; any other part only if it declares it", () => {
    const s = setup(composerFixture());
    const shell = mountShell(s);
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    const item = s.rt.resolve(shell.shellFrame, tab.mount, "composer").items[0]!;
    const token = new URL((item as { url: string }).url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-composer", token);
    const composerFrame = frame((item as { url: string }).url, shell.shellFrame);
    const info = s.rt.describe(composerFrame, WIN, token);
    expect(s.rt.resolve(composerFrame, info.mount, "main", "agent")).toMatchObject({ items: [], undeclared: true });
    expect(s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items.length).toBe(1);
  });

  test("a document names the installed layers it may frame, and loads again to frame one installed after it", () => {
    const s = setup();
    const shell = mountShell(s);
    const mounts = (s.rt as unknown as { mounts: Map<string, Parameters<UiRuntime["mountForDocument"]>[0]> }).mounts;
    expect(s.rt.mountForDocument(mounts.get(shell.info.mount)!).layers).toEqual(["alpha", "moss"]);
    // A composer from a new layer is installed while the shell shows.
    s.rt.setRegistry([...readUiPlugins([...mossViews(), alphaView()] as never), ...composerFixture()]);
    s.sent.length = 0;
    const tab = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    s.rt.resolve(shell.shellFrame, tab.mount, "composer");
    const reload = s.sent.find((x) => x.m.type === "child-reload");
    expect(reload?.to).toBe(`${s.rootFrame.processId}:${s.rootFrame.routingId}`);
    const url = (reload!.m as { url: string }).url;
    expect(reload!.m).toMatchObject({ type: "child-reload", child: shell.info.mount });
    expect(url).toMatch(/^moss-plugin:\/\/moss\/\?mount=t\d+$/);
    // Served again, it names the new layer.
    const token = new URL(url).searchParams.get("mount")!;
    const again = s.rt.serveDocument("moss", token);
    expect(s.rt.mountForDocument(again!).layers).toEqual(["alpha", "fixture-composer", "moss"]);
  });
});

describe("a plugin's sealed frames: its own cards only (the core's `ownedBy`: its own tools' calls, its moved bot's), bound to the document that placed them", () => {
  const card = (id: string, bot?: string, ownedBy?: string[]): SealedCard => ({
    id, kind: "tool", computer: null, ...(bot === undefined ? {} : { bot }), ...(ownedBy === undefined ? {} : { ownedBy }), origin: "user", issuedAt: 1, expiresAt: null, hash: "b".repeat(64),
    fields: { title: { type: "text", text: "Run?" } }, options: [{ id: "allow_once", kind: "approve", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" }],
  });
  function placed(render = false, all = false) {
    const plugins = readUiPlugins([folderView(join(FIXTURES, "fixture-card"))] as never).map((p) => (all ? { ...p, capabilities: new Set([...p.capabilities, "approvals.all"]) } : p));
    const s = setup(plugins, { render });
    const shell = mountShell(s);
    const item = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    if (item.kind !== "frame") throw new Error("not a frame");
    const token = new URL(item.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-card", token);
    const docFrame = frame(item.url, shell.shellFrame);
    const info = s.rt.describe(docFrame, WIN, token);
    const store = new SealedFrames();
    s.rt.sealed = store;
    // Its own: a call to its tool in a code session (no bot), and a bot's call to its tool. Not its own: another plugin's
    // tool's card, a card of no plugin's tool, and a bot named like it that the core did not mark as its own (no id decides it).
    for (const c of [card("card_own", undefined, ["fixture-card"]), card("card_ownbot", "alpha", ["fixture-card"]), card("card_other", "alpha", ["other-plugin"]), card("card_none"), card("card_named", "fixture-card/bot")]) store.fromCore(c);
    return { s, store, docFrame, mount: info.mount };
  }

  test("its own card gets a frame (its tool's call, in a code session or a bot's turn), bound to the frame of the document that placed it", () => {
    const { s, store, docFrame, mount } = placed();
    expect(s.rt.sealedFrameOf(docFrame, mount, "card_ownbot", "button:allow_once")).toMatch(/^moss-sealed:\/\/card\/card_ownbot\//);
    const url = s.rt.sealedFrameOf(docFrame, mount, "card_own", "button:allow_once")!;
    expect(url).toMatch(/^moss-sealed:\/\/card\/card_own\/button%3Aallow_once\?token=/);
    const token = new URL(url).searchParams.get("token")!;
    // The channel answers only for a sealed frame whose parent is that document's frame (the plugin's own iframe).
    expect(store.boundOf(token)).toBe(`p:${docFrame.processId}:${docFrame.routingId}`);
  });

  test("another plugin's card, a card of no plugin's tool, and a bot's card named like it but not its own, are refused, whatever the part holds", () => {
    const { s, docFrame, mount } = placed();
    for (const id of ["card_other", "card_none", "card_named"]) {
      expect(() => s.rt.sealedFrameOf(docFrame, mount, id, "button:allow_once")).toThrow("takes a card of this plugin's own tools");
    }
  });

  test("with approvals.all a plugin places any card, another bot's and a card of no bot too, whoever it is (no id decides it)", () => {
    const { s, docFrame, mount } = placed(false, true);
    for (const id of ["card_own", "card_other", "card_none", "card_named"]) expect(s.rt.sealedFrameOf(docFrame, mount, id, "button:allow_once")).toMatch(/^moss-sealed:\/\/card\//);
  });

  test("approvals.all without approvals places nothing, and with both it places any card", () => {
    const plugins = readUiPlugins([folderView(join(FIXTURES, "fixture-card"))] as never).map((p) => ({ ...p, capabilities: new Set(["approvals.all"]) }));
    const s = setup(plugins);
    const shell = mountShell(s);
    const item = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    if (item.kind !== "frame") throw new Error("not a frame");
    const token = new URL(item.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-card", token);
    const docFrame = frame(item.url, shell.shellFrame);
    const info = s.rt.describe(docFrame, WIN, token);
    const store = new SealedFrames();
    s.rt.sealed = store;
    store.fromCore(card("card_none"));
    expect(() => s.rt.sealedFrameOf(docFrame, info.mount, "card_none", "button:allow_once")).toThrow("approvals capability");
  });

  test("each ask says what came of it, with the window of the part that asked (the app's timing lines)", () => {
    const { s, docFrame, mount } = placed();
    const heard: [string, number | undefined, string][] = [];
    s.rt.onSealedAsk = (cardId, windowId, outcome) => heard.push([cardId, windowId, outcome]);
    expect(s.rt.sealedFrameOf(docFrame, mount, "card_later", "button:allow_once")).toBeUndefined();
    expect(s.rt.sealedFrameOf(docFrame, mount, "card_own", "field:nothing")).toBe("");
    expect(s.rt.sealedFrameOf(docFrame, mount, "card_own", "button:allow_once")).toMatch(/^moss-sealed:/);
    expect(() => s.rt.sealedFrameOf(docFrame, mount, "card_other", "button:allow_once")).toThrow();
    expect(heard).toEqual([["card_later", WIN, "not yet"], ["card_own", WIN, "absent"], ["card_own", WIN, "made"], ["card_other", WIN, "refused"]]);
  });

  // The render window's rule (AppScreenshot): where a pending card's sealed element would be, a plain placeholder of the
  // same layout; never a minted frame, no step of the card's timing, nothing that answers.
  test("in a render window a pending card's elements are placeholders: no mint, no ask heard, no answer bridge, served once", () => {
    const { s, store, docFrame, mount } = placed(true);
    const minted: string[] = [];
    const mint = store.mint.bind(store);
    store.mint = (...a: Parameters<SealedFrames["mint"]>) => { minted.push(a[1]); return mint(...a); };
    store.onMinted = (cardId) => minted.push(`onMinted ${cardId}`);
    const heard: string[] = [];
    s.rt.onSealedAsk = (cardId, _w, outcome) => heard.push(`${cardId} ${outcome}`);
    expect(s.rt.isRenderWindow(WIN)).toBe(true);
    const button = s.rt.sealedFrameOf(docFrame, mount, "card_own", "button:allow_once")!;
    const field = s.rt.sealedFrameOf(docFrame, mount, "card_own", "field:title")!;
    expect(button).toMatch(/^moss-sealed:\/\/placeholder\/[0-9a-f]{24}$/);
    expect(field).toMatch(/^moss-sealed:\/\/placeholder\/[0-9a-f]{24}$/);
    // The same rules as a frame: a field the card lacks is nothing, a card not yet here is asked again, another bot's is refused.
    expect(s.rt.sealedFrameOf(docFrame, mount, "card_own", "field:nothing")).toBe("");
    expect(s.rt.sealedFrameOf(docFrame, mount, "card_later", "button:allow_once")).toBeUndefined();
    expect(() => s.rt.sealedFrameOf(docFrame, mount, "card_other", "button:allow_once")).toThrow("takes a card of this plugin's own tools");
    expect({ minted, heard }).toEqual({ minted: [], heard: [] });
    const page = s.rt.servePlaceholder(new URL(button).pathname.slice(1))!;
    expect(page.html).toContain('<div class="seal-placeholder" aria-hidden="true">approval button</div>');
    expect(page.html).toContain("visibility: hidden !important");
    expect(page.html).toContain("mossSealedSize");
    expect(page.html).not.toContain("mossSealed.");
    expect(page.html).not.toContain("window.mossSealed");
    expect(page.html).toContain('class="seal-button'); // the real layout, hidden, so it takes the same room
    expect(page.headers["Content-Security-Policy"]).toContain("connect-src 'none'");
    expect(s.rt.servePlaceholder(new URL(button).pathname.slice(1))).toBeUndefined();
    expect(s.rt.servePlaceholder(new URL(field).pathname.slice(1))!.html).toContain(">card field</div>");
    // A placeholder's page gets no answer bridge: the preload gives `mossSealed` to the card host alone.
    expect(readFileSync(join(import.meta.dir, "../src/main/preload.ts"), "utf8")).toContain('where === "moss-sealed:" && location.host === "card"');
    // The window going drops what it hadn't served.
    const left = s.rt.sealedFrameOf(docFrame, mount, "card_own", "button:deny")!;
    s.rt.closeWindow(WIN);
    expect(s.rt.servePlaceholder(new URL(left).pathname.slice(1))).toBeUndefined();
  });

  test("an ordinary window still gets the live frame (the placeholder is the render window's alone)", () => {
    const { s, docFrame, mount } = placed();
    expect(s.rt.isRenderWindow(WIN)).toBe(false);
    expect(s.rt.sealedFrameOf(docFrame, mount, "card_own", "button:allow_once")).toMatch(/^moss-sealed:\/\/card\//);
  });
});

describe("a part's Review on a plugin's card: the app's own page for it, by the same placing rule", () => {
  test("a plugin's OK card that is its own (its moved bot's) opens; another's is refused; a tool card or an unknown one doesn't open", async () => {
    const s = setup([...readUiPlugins([folderView(join(FIXTURES, "fixture-card"))] as never)]);
    const shell = mountShell(s);
    const item = s.rt.resolve(shell.shellFrame, shell.info.mount, "main", "agent").items[0]!;
    if (item.kind !== "frame") throw new Error("not a frame");
    const token = new URL(item.url).searchParams.get("mount")!;
    s.rt.serveDocument("fixture-card", token);
    const docFrame = frame(item.url, shell.shellFrame);
    const info = s.rt.describe(docFrame, WIN, token);
    const store = new SealedFrames();
    s.rt.sealed = store;
    const base = { computer: null, origin: "user", issuedAt: 1, expiresAt: null, hash: "b".repeat(64), fields: {}, options: [{ id: "approve", kind: "approve", label: "Approve" }] } as const;
    store.fromCore({ ...base, id: "card_okown", kind: "plugin-ok", bot: "fixture-card/bot", ownedBy: ["fixture-card"] });
    store.fromCore({ ...base, id: "card_okother", kind: "plugin-ok", bot: "alpha", ownedBy: ["alpha"] });
    store.fromCore({ ...base, id: "card_toolown", kind: "tool", ownedBy: ["fixture-card"] });
    const opened: string[] = [];
    s.rt.onCardPage = async (id) => { opened.push(id); return true; };
    expect(await s.rt.cardPageOf(docFrame, info.mount, "card_okown")).toBe(true);
    await expect(s.rt.cardPageOf(docFrame, info.mount, "card_okother")).rejects.toThrow("takes a card of this plugin's own tools");
    expect(await s.rt.cardPageOf(docFrame, info.mount, "card_toolown")).toBe(false);
    expect(await s.rt.cardPageOf(docFrame, info.mount, "card_unknown")).toBe(false);
    expect(opened).toEqual(["card_okown"]);
  });
});

describe("the row diagnosis log lines (ids only, once per pair, no change of what a call does)", () => {
  test("a part asked of a document that isn't its own is refused as before and named once; an unbound frame is named once, without its address", () => {
    const lines: string[] = [];
    const s = setup([], { log: (l) => lines.push(l) });
    expect(() => s.rt.resolve(s.rootFrame, "nope", "main")).toThrow("that part isn't in this document");
    expect(() => s.rt.resolve(s.rootFrame, "nope", "main")).toThrow("that part isn't in this document");
    expect(lines.filter((l) => l.includes("asked of document"))).toHaveLength(1);
    expect(lines.find((l) => l.includes("asked of document"))).toContain("no such mount");
    const stray = frame("moss-plugin://moss/?mount=secrettoken");
    expect(() => s.rt.resolve(stray, "nope", "main")).toThrow("this document isn't bound to a mount");
    expect(() => s.rt.resolve(stray, "nope", "main")).toThrow("this document isn't bound to a mount");
    const unbound = lines.filter((l) => l.includes("bound to no mount"));
    expect(unbound).toHaveLength(1);
    expect(unbound[0]).not.toContain("secrettoken");
  });
});
