// The host's pure parts: the headers and documents on the app's schemes, the windows' options per OS, reading a
// plugin's files, the tray's menu, and the guard that keeps Bun out of the main process and Node out of pages.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_CSP, IMPORT_MAP, connectionAllowlist, layerCsp, layerDocument, layerHeaders } from "../src/main/ui/documents";
import { mediaType, pluginFile } from "../src/main/ui/files";
import { trayMenu } from "../src/main/tray-menu";
import { mainWindowPlan, webPreferences, windowsHasAcrylic } from "../src/main/window";

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
    expect(connectionAllowlist()).toBe("(response-origin)");
    expect(connectionAllowlist([], true)).toBe('("clover-plugin://*/*" response-origin)');
    expect(connectionAllowlist(["https://api.example.com"])).toBe('("https://api.example.com/*" response-origin)');
    expect(layerHeaders("text/html; charset=utf-8")).toMatchObject({ "Connection-Allowlist": '("clover-plugin://*/*" response-origin)', "X-Content-Type-Options": "nosniff", "X-DNS-Prefetch-Control": "off" });
    expect(layerHeaders("text/javascript; charset=utf-8")["Connection-Allowlist"]).toBe("(response-origin)");
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
  test("Open, safe mode one way or the other, and Quit", () => {
    const calls: string[] = [];
    const actions = { open: () => calls.push("open"), quit: () => calls.push("quit"), restart: (s: boolean) => calls.push(`restart ${s}`) };
    const menu = trayMenu({ safeMode: false, status: "Reconnecting to Clover…" }, actions);
    expect(menu.map((m) => m.label ?? m.type)).toEqual(["Reconnecting to Clover…", "separator", "Open Clover", "Restart in Safe Mode", "separator", "Quit Clover"]);
    for (const m of menu) (m.click as (() => void) | undefined)?.();
    expect(calls).toEqual(["open", "restart true", "quit"]);
    expect(trayMenu({ safeMode: true }, actions).map((m) => m.label)).toContain("Restart Normally");
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
