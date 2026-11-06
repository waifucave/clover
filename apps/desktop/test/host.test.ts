// The host's pure parts: the headers and documents on the app's schemes, the windows' options per OS, reading a
// plugin's files, the tray's menu, and the guard that keeps Bun out of the main process and Node out of pages.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_CSP, IMPORT_MAP, connectionAllowlist, layerCsp, layerDocument, layerHeaders } from "../src/main/ui/documents";
import { appShortcut } from "../src/main/shortcuts";
import { mediaType, pluginFile } from "../src/main/ui/files";
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
});

describe("surface windows", () => {
  const prefs = webPreferences({ preload: "/p.cjs", partition: "persist:ui", headless: true, offscreen: false });
  test("an overlay is frameless, unfocused and out of the task switcher; on Wayland every surface is a normal window", () => {
    const overlay = surfaceWindowPlan({ surface: { type: "overlay", alwaysOnTop: true, transparent: true }, title: "Clover island", webPreferences: prefs });
    expect(overlay).toMatchObject({ show: false, frame: false, focusable: false, skipTaskbar: true, transparent: true, alwaysOnTop: true });
    const wayland = surfaceWindowPlan({ surface: { type: "overlay", alwaysOnTop: true, transparent: true }, title: "Clover island", webPreferences: prefs, wayland: true });
    expect(wayland).toMatchObject({ show: false, frame: true, focusable: true, skipTaskbar: false, transparent: false, alwaysOnTop: false });
  });

  test("Linux's display server, as Electron runs on it", () => {
    expect(linuxSession({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe("wayland");
    expect(linuxSession({ XDG_SESSION_TYPE: "wayland" }, "linux")).toBe("wayland");
    expect(linuxSession({ DISPLAY: ":99" }, "linux")).toBe("x11");
    expect(linuxSession({ WAYLAND_DISPLAY: "wayland-0" }, "darwin")).toBeUndefined();
  });
});
