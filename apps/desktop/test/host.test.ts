// The host's pure parts: the headers and documents on the app's schemes, the windows' options per OS, reading a
// plugin's files, the tray's menu, and the guard that keeps Bun out of the main process and Node out of pages.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_BARE_IMPORTS } from "@waifucave/clover-plugin-sdk";
import { CORE_CSP, IMPORT_MAP, connectionAllowlist, layerCsp, layerDocument, layerHeaders } from "../src/main/ui/documents";
import { appShortcut, fallbackMayShow, fallbackOnVisibility, sealedInputAllowed } from "../src/main/shortcuts";
import { islandCards } from "../src/layer/clover/cards";
import type { CardMeta } from "@waifucave/clover-protocol";
import { builtClientFile, builtClientUrl, mediaType, pluginFile } from "../src/main/ui/files";
import { trayMenu } from "../src/main/tray-menu";
import { linuxSession, mainWindowPlan, surfaceWindowPlan, webPreferences, windowsHasAcrylic } from "../src/main/window";

describe("documents and headers (S9, decision 94)", () => {
  test("a layer document: its import map is the one script CSP allows inline, by hash", () => {
    const html = layerDocument({ css: ["/_p/x/a.css"], title: "x" });
    const map = /<script type="importmap">(.*?)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(map)).toEqual(IMPORT_MAP);
    const hash = `'sha256-${createHash("sha256").update(map).digest("base64")}'`;
    expect(layerCsp()).toContain(`script-src 'self' ${hash}`);
    expect(html).toContain('<link rel="stylesheet" href="/_p/x/a.css">');
    expect(html).toContain('<script type="module" src="/_clover/boot.js"></script>');
  });

  test("a plugin can't add an import map of its own: the document carries exactly the core's, and CSP runs no other inline script", () => {
    // A title (a plugin's id) that tries to bring its own map in is text.
    const html = layerDocument({ css: [], title: '"><script type="importmap">{"imports":{"react":"https://evil.example/r.js"}}</script>' });
    expect(html.match(/<script type="importmap">/g)?.length).toBe(1);
    expect(html.match(/<script\b/g)?.length).toBe(2);
    const map = /<script type="importmap">(.*?)<\/script>/.exec(html)![1]!;
    expect(JSON.parse(map)).toEqual(IMPORT_MAP);
    // script-src is exactly the layer's own files and that one map's hash, whatever hosts the plugin declares: an inline
    // map a part adds later (its text has another hash) never applies, and no host serves a script.
    const hash = `'sha256-${createHash("sha256").update(map).digest("base64")}'`;
    for (const hosts of [[], ["https://api.example.com"]]) {
      const directive = layerCsp(hosts).split(";").map((d) => d.trim()).filter((d) => d.startsWith("script-src"));
      expect(directive).toEqual([`script-src 'self' ${hash}`]);
    }
  });

  test("the import map serves exactly CLIENT_BARE_IMPORTS: what a client's build keeps and the loader check exempts", () => {
    expect(new Set(Object.keys(IMPORT_MAP.imports))).toEqual(new Set(CLIENT_BARE_IMPORTS));
    for (const n of ["react/jsx-runtime", "react/jsx-dev-runtime", "@waifucave/clover-plugin-sdk/ui"]) expect(Object.keys(IMPORT_MAP.imports)).toContain(n);
    // No prefix entry (a key ending in "/" would serve every subpath under it).
    expect(Object.keys(IMPORT_MAP.imports).filter((k) => k.endsWith("/"))).toEqual([]);
    // The layer's own builds keep the same list external (scripts/build.ts).
    const build = readFileSync(join(import.meta.dir, "..", "scripts", "build.ts"), "utf8");
    expect(build).toContain("const LAYER_EXTERNALS: string[] = [...CLIENT_BARE_IMPORTS];");
  });

  test("layers reach only their own origin until hosts are declared; frames only from layer origins", () => {
    const csp = layerCsp();
    for (const d of ["default-src 'none'", "connect-src 'self'", "frame-src clover-plugin:", "form-action 'none'", "object-src 'none'", "base-uri 'none'"]) expect(csp).toContain(d);
    expect(connectionAllowlist()).toBe('("clover-sealed://card/*" response-origin)');
    expect(connectionAllowlist(["https://api.example.com"])).toBe('("https://api.example.com/*" "clover-sealed://card/*" response-origin)');
    // A document names each installed layer by its label, never a `*` host: Chromium matches its DNS lookups against
    // the list by host alone (the E-M1 review's B1). The sealed frames' origin rides along always (E-M3).
    expect(connectionAllowlist([], ["clover", "fixture-composer"])).toBe('("clover-plugin://clover/*" "clover-plugin://fixture-composer/*" "clover-sealed://card/*" response-origin)');
    expect(connectionAllowlist([], ["*", "a/b", "x.example", "ok"])).toBe('("clover-plugin://ok/*" "clover-sealed://card/*" response-origin)');
    const doc = layerHeaders("text/html; charset=utf-8", [], ["clover", "alpha"]);
    expect(doc).toMatchObject({ "Connection-Allowlist": '("clover-plugin://clover/*" "clover-plugin://alpha/*" "clover-sealed://card/*" response-origin)', "X-Content-Type-Options": "nosniff", "X-DNS-Prefetch-Control": "off" });
    expect(doc["Connection-Allowlist"]).not.toContain("://*");
    expect(layerHeaders("text/html; charset=utf-8")["Connection-Allowlist"]).toBe('("clover-sealed://card/*" response-origin)');
    expect(layerHeaders("text/javascript; charset=utf-8", [], ["clover"])["Connection-Allowlist"]).toBe('("clover-sealed://card/*" response-origin)');
    expect(layerHeaders("image/png")["Connection-Allowlist"]).toBeUndefined();
    expect(CORE_CSP).toContain("connect-src 'none'");
    expect(CORE_CSP).toContain("frame-ancestors 'none'");
  });
});

describe("a plugin's own files", () => {
  test("only inside its folder, symlinks included; only known media types", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-files-"));
    const plugin = join(dir, "p");
    mkdirSync(join(plugin, "client"), { recursive: true });
    writeFileSync(join(plugin, "client", "index.js"), "export {}");
    writeFileSync(join(dir, "secret.txt"), "no");
    let linked = true;
    try {
      symlinkSync(join(dir, "secret.txt"), join(plugin, "client", "link.js"));
    } catch {
      // Windows without the symlink privilege: the link case can't be made here.
      linked = false;
    }
    expect(readFileSync(pluginFile({ assetBase: plugin }, "client/index.js"), "utf8")).toBe("export {}");
    for (const bad of ["../secret.txt", "client/../../secret.txt", "/etc/passwd", "C:/Windows/win.ini", "client//index.js", ...(linked ? ["client/link.js"] : []), "missing.js"]) {
      expect(() => pluginFile({ assetBase: plugin }, bad)).toThrow();
    }
    expect(mediaType("a.js")).toStartWith("text/javascript");
    expect(mediaType("a.html")).toBeUndefined();
  });

  test("a client the core built at load: served at /_b/ by its hash, only while the file is the one built, never through a link", () => {
    const dir = mkdtempSync(join(tmpdir(), "clover-built-"));
    const text = "export const Page = () => null;\n";
    writeFileSync(join(dir, "index.js"), text);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const plugin = { clientBuild: { base: dir, file: "index.js", sha256 } };
    expect(builtClientUrl("pack/eyes", plugin.clientBuild)).toBe(`/_b/pack%2Feyes/${sha256.slice(0, 16)}/index.js`);
    expect(new TextDecoder().decode(builtClientFile(plugin, sha256.slice(0, 16), "index.js"))).toBe(text);
    // Another key, another file, a path, no build at all: nothing.
    for (const [key, file] of [["0000000000000000", "index.js"], [sha256.slice(0, 16), "other.js"], [sha256.slice(0, 16), "../index.js"]]) expect(builtClientFile(plugin, key!, file!)).toBeUndefined();
    expect(builtClientFile({}, sha256.slice(0, 16), "index.js")).toBeUndefined();
    // Changed on disk after the build: not served.
    writeFileSync(join(dir, "index.js"), "export const evil = 1;\n");
    expect(builtClientFile(plugin, sha256.slice(0, 16), "index.js")).toBeUndefined();
    // A link in its place: not followed.
    const other = mkdtempSync(join(tmpdir(), "clover-built-"));
    writeFileSync(join(other, "real.js"), text);
    rmSync(join(dir, "index.js"));
    try {
      symlinkSync(join(other, "real.js"), join(dir, "index.js"));
      expect(builtClientFile(plugin, sha256.slice(0, 16), "index.js")).toBeUndefined();
    } catch {
      // Windows without the symlink privilege.
    }
  });
});

describe("the windows (decision 86)", () => {
  const prefs = webPreferences({ preload: "/p.cjs", partition: "clover-ui", headless: true, offscreen: false });

  test("every page is sandboxed and isolated, with no Node and no webview; the preload reaches subframes", () => {
    expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: true, webSecurity: true, webviewTag: false, spellcheck: false, backgroundThrottling: false });
  });

  test("macOS: an inset title bar over the sidebar material", () => {
    const p = mainWindowPlan({ platform: "darwin", acrylic: false, title: "Clover", dark: false, solid: "#F5F5F5", symbol: "#1F1F1F", webPreferences: prefs });
    expect(p.material).toBe("vibrancy");
    expect(p.options).toMatchObject({ titleBarStyle: "hiddenInset", vibrancy: "sidebar", backgroundColor: "#00000000", show: false });
  });

  test("Windows 11: acrylic under a hidden title bar with the system's controls; older Windows: solid", () => {
    const p = mainWindowPlan({ platform: "win32", acrylic: true, title: "Clover", dark: true, solid: "#202020", symbol: "#F2F2F2", webPreferences: prefs });
    expect(p.material).toBe("acrylic");
    expect(p.options).toMatchObject({ titleBarStyle: "hidden", backgroundMaterial: "acrylic", titleBarOverlay: { height: 45, symbolColor: "#F2F2F2" } });
    const old = mainWindowPlan({ platform: "win32", acrylic: false, title: "Clover", dark: true, solid: "#202020", symbol: "#F2F2F2", webPreferences: prefs });
    expect(old.material).toBe("none");
    expect(old.options.backgroundMaterial).toBeUndefined();
    expect(windowsHasAcrylic("10.0.22621")).toBe(true);
    expect(windowsHasAcrylic("10.0.19045")).toBe(false);
  });

  test("Linux: a solid colour", () => {
    const p = mainWindowPlan({ platform: "linux", acrylic: false, title: "Clover", dark: false, solid: "#F5F5F5", symbol: "#1F1F1F", webPreferences: prefs });
    expect(p.material).toBe("none");
    expect(p.options).toMatchObject({ backgroundColor: "#F5F5F5", titleBarStyle: "hidden" });
  });
});

describe("the tray", () => {
  test("Open, safe mode one way or the other (with the plugin manager in it), and Quit", () => {
    const calls: string[] = [];
    const actions = { open: () => calls.push("open"), quit: () => calls.push("quit"), restart: (s: boolean) => calls.push(`restart ${s}`), managePlugins: () => calls.push("plugins") };
    const menu = trayMenu({ safeMode: false, status: "Reconnecting to Clover…" }, actions);
    expect(menu.map((m) => m.label ?? m.type)).toEqual(["Reconnecting to Clover…", "separator", "Open Clover", "Restart in Safe Mode", "separator", "Quit Clover"]);
    for (const m of menu) (m.click as (() => void) | undefined)?.();
    expect(calls).toEqual(["open", "restart true", "quit"]);
    // The pill's item flips between Hide and Show with its state, and only where the app offers it.
    const pillCalls: string[] = [];
    const withPill = { ...actions, togglePill: () => pillCalls.push("toggle") };
    const shown = trayMenu({ safeMode: false, pillHidden: false }, withPill);
    expect(shown.map((m) => m.label ?? m.type)).toEqual(["Open Clover", "Hide Dispatch Pill", "Restart in Safe Mode", "separator", "Quit Clover"]);
    (shown[1]!.click as () => void)();
    expect(pillCalls).toEqual(["toggle"]);
    expect(trayMenu({ safeMode: false, pillHidden: true }, withPill).map((m) => m.label ?? m.type)[1]).toBe("Show Dispatch Pill");
    expect(trayMenu({ safeMode: false }, withPill).map((m) => m.label ?? m.type)).not.toContain("Hide Dispatch Pill");
    // The four-finger tap's switch is a checkbox, there only where the Mac has the add-on for it.
    const tapCalls: string[] = [];
    const withTap = { ...actions, toggleFourFingerTap: () => tapCalls.push("tap") };
    const tapItem = trayMenu({ safeMode: false, fourFingerTap: true }, withTap).find((m) => m.label === "Four-Finger Tap Hides the Dispatch Pill")!;
    expect(tapItem.type).toBe("checkbox");
    expect(tapItem.checked).toBe(true);
    (tapItem.click as () => void)();
    expect(tapCalls).toEqual(["tap"]);
    expect(trayMenu({ safeMode: false, fourFingerTap: false }, withTap).find((m) => m.type === "checkbox")?.checked).toBe(false);
    expect(trayMenu({ safeMode: false }, withTap).some((m) => m.type === "checkbox")).toBe(false);
    // In safe mode the core's plugin manager is there too (§5.8).
    const safe = trayMenu({ safeMode: true }, actions);
    expect(safe.map((m) => m.label ?? m.type)).toEqual(["Open Clover", "Manage Plugins…", "Restart Normally", "separator", "Quit Clover"]);
    // In the app's language.
    expect(trayMenu({ safeMode: false }, actions, { lang: "fr", strings: { "clover.core.tray.quit": "Quitter Clover" } }).at(-1)?.label).toBe("Quitter Clover");
  });
});

describe("the guard: no Bun in the main process, no Node in pages", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)])).filter((f) => /\.tsx?$/.test(f));
  }
  const src = join(import.meta.dir, "..", "src");

  test("src/main uses no Bun API (it runs on Electron's Node)", () => {
    const hits = files(join(src, "main")).filter((f) => /\bBun\.[a-zA-Z]|from "bun"|from "bun:/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  test("src/layer and src/core use no Node API (they run in sandboxed pages)", () => {
    const hits = files(join(src, "layer")).concat(files(join(src, "core"))).filter((f) => /from "node:|require\(|\bprocess\.|\bBuffer\b/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("the app's shortcuts", () => {
  const key = (k: string, mods: Partial<{ control: boolean; meta: boolean; alt: boolean; shift: boolean }> = {}) => ({ type: "keyDown", key: k, control: false, meta: false, alt: false, shift: false, ...mods });
  test("⌘Q, ⌘W and ⌘, on macOS, ahead of every layer; Ctrl elsewhere", () => {
    expect(appShortcut(key("q", { meta: true }), "darwin")).toBe("quit");
    expect(appShortcut(key("W", { meta: true }), "darwin")).toBe("close-window");
    expect(appShortcut(key(",", { meta: true }), "darwin")).toBe("settings");
    expect(appShortcut(key("q", { control: true }), "darwin")).toBeUndefined();
    expect(appShortcut(key("q", { control: true }), "win32")).toBe("quit");
    expect(appShortcut(key(",", { control: true }), "linux")).toBe("settings");
    expect(appShortcut(key("q", { meta: true }), "linux")).toBeUndefined();
    expect(appShortcut(key("w", { meta: true, shift: true }), "darwin")).toBeUndefined();
    expect(appShortcut(key("q", { meta: true, alt: true }), "darwin")).toBeUndefined();
    expect(appShortcut({ ...key("q", { meta: true }), type: "keyUp" }, "darwin")).toBeUndefined();
  });

  test("the smoke run's real input is test-only: a packaged app ignores the smoke's presses", () => {
    // Both click paths ask first: packaged, with or without headless, never attaches the debugger.
    expect(sealedInputAllowed({ packaged: true, headless: true })).toBe(false);
    expect(sealedInputAllowed({ packaged: true, headless: false })).toBe(false);
    // Unpackaged alone isn't enough either: the smoke run is always headless.
    expect(sealedInputAllowed({ packaged: false, headless: false })).toBe(false);
    expect(sealedInputAllowed({ packaged: false, headless: true })).toBe(true);
  });
  test("the island's strip reads the pending cards' metas: elicitation draws as a link, the rest as approvals", () => {
    expect(islandCards([])).toEqual([]);
    const meta: CardMeta = {
      id: "card_1", kind: "tool", computer: "Laptop", origin: "user", issuedAt: 7, expiresAt: null,
      options: [{ id: "allow_once", kind: "approve" }, { id: "deny", kind: "deny" }],
    };
    expect(islandCards([meta])).toEqual([{
      id: "card_1", kind: "approval", tool: true, computer: "Laptop", issuedAt: 7,
      options: [{ id: "allow_once", kind: "approve" }, { id: "deny", kind: "deny" }],
    }]);
    // A link request draws as a link; no computer and no options fall back to the island's own defaults.
    const link: CardMeta = { ...meta, id: "card_2", kind: "elicitation", computer: null, options: [] };
    expect(islandCards([link])).toEqual([
      { id: "card_2", kind: "link", issuedAt: 7 },
    ]);
  });
});

describe("surface windows", () => {
  const prefs = webPreferences({ preload: "/p.cjs", partition: "persist:ui", headless: true, offscreen: false });
  test("an overlay is frameless, unfocused and out of the task switcher; on Wayland every surface is a normal window", () => {
    const overlay = surfaceWindowPlan({ surface: { type: "overlay", alwaysOnTop: true, transparent: true }, title: "Clover island", webPreferences: prefs });
    expect(overlay).toMatchObject({ show: false, frame: false, focusable: false, skipTaskbar: true, transparent: true, alwaysOnTop: true });
    // Nothing the OS draws behind it: fully clear, no shadow (computed from the opaque pixels, it reads as a dark halo),
    // no material of any kind.
    expect(overlay.backgroundColor).toBe("#00000000");
    expect(overlay.hasShadow).toBe(false);
    for (const key of ["vibrancy", "visualEffectState", "backgroundMaterial", "titleBarStyle", "thickFrame"] as const) expect((overlay as Record<string, unknown>)[key]).toBeUndefined();
    const wayland = surfaceWindowPlan({ surface: { type: "overlay", alwaysOnTop: true, transparent: true }, title: "Clover island", webPreferences: prefs, wayland: true });
    expect(wayland).toMatchObject({ show: false, frame: true, focusable: true, skipTaskbar: false, transparent: false, alwaysOnTop: false });
  });

  test("a floating overlay on macOS turns the menu-bar frame constraint off (the island hangs from the screen's top edge); nothing else does", () => {
    const float = { type: "overlay" as const, alwaysOnTop: true, transparent: true };
    expect(surfaceWindowPlan({ surface: float, title: "t", webPreferences: prefs, platform: "darwin" }).enableLargerThanScreen).toBe(true);
    expect(surfaceWindowPlan({ surface: float, title: "t", webPreferences: prefs, platform: "linux" }).enableLargerThanScreen).toBeUndefined();
    expect(surfaceWindowPlan({ surface: float, title: "t", webPreferences: prefs, platform: "darwin", wayland: true }).enableLargerThanScreen).toBeUndefined();
    expect(surfaceWindowPlan({ surface: { type: "overlay", transparent: true }, title: "t", webPreferences: prefs, platform: "darwin" }).enableLargerThanScreen).toBeUndefined();
    expect(surfaceWindowPlan({ surface: { type: "window" }, title: "t", webPreferences: prefs, platform: "darwin" }).enableLargerThanScreen).toBeUndefined();
  });

  test("Linux's display server, as Electron runs on it", () => {
    expect(linuxSession({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe("wayland");
    expect(linuxSession({ XDG_SESSION_TYPE: "wayland" }, "linux")).toBe("wayland");
    expect(linuxSession({ DISPLAY: ":99" }, "linux")).toBe("x11");
    expect(linuxSession({ WAYLAND_DISPLAY: "wayland-0" }, "darwin")).toBeUndefined();
  });
});

describe("the fallback card window", () => {
  test("a headless run never shows it, except the sealed smoke that asks for it in a test run", () => {
    expect(fallbackMayShow({ headless: true, smokeFallback: false, testInput: false })).toBe(false);
    expect(fallbackMayShow({ headless: true, smokeFallback: false, testInput: true })).toBe(false);
    expect(fallbackMayShow({ headless: true, smokeFallback: true, testInput: false })).toBe(false);
    expect(fallbackMayShow({ headless: true, smokeFallback: true, testInput: true })).toBe(true);
  });
  test("a normal run shows it", () => {
    expect(fallbackMayShow({ headless: false, smokeFallback: false, testInput: false })).toBe(true);
  });
  test("its timer: disarmed once both buttons show somewhere, started again only when no surface still shows both (§5.5)", () => {
    // A frame that shows: both buttons visible somewhere disarms; one button alone keeps the timer as it is.
    expect(fallbackOnVisibility({ visible: true, bothVisible: true, fallbackOpen: false })).toBe("disarm");
    expect(fallbackOnVisibility({ visible: true, bothVisible: false, fallbackOpen: false })).toBe("keep");
    // A frame that stops showing (her conversation scrolled, a window resized) while the island still shows both: no timer.
    expect(fallbackOnVisibility({ visible: false, bothVisible: true, fallbackOpen: false })).toBe("keep");
    // No surface shows both any more: the 2 s start again, unless the fallback card is already up.
    expect(fallbackOnVisibility({ visible: false, bothVisible: false, fallbackOpen: false })).toBe("arm");
    expect(fallbackOnVisibility({ visible: false, bothVisible: false, fallbackOpen: true })).toBe("keep");
  });
});
