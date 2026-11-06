// Web page entries (spec §5.5 "Web pages"): a UI part that shows a web page, a URL or a page inside the plugin's
// folder, in an isolated view with its own session, with no Node, no plugin API and no reach to sealed cards. Each
// view is a WebContentsView the core draws over the place its part reports, clipped to the part's frame like the
// browser's live view, and gone with the part.
//
// The session is the plugin's own (`persist:clover-web-<layer>-<partition>`, so two plugins never share one), with the
// app's hardening: no permission, no download, no spellchecker, an explicit proxy. The page keeps to its own origin:
// popups are refused, and a navigation elsewhere is too. A folder page is served on `clover-web://<layer>/`, from that
// plugin's folder only.
import { session as sessions, WebContentsView, type BaseWindow, type Session, type WebContents } from "electron";
import type { Rect } from "./brokers";
import { isInside, mediaType, pluginFile } from "./files";
import type { UiPlugin } from "./model";
import { WEB_SCHEME, commonHeaders } from "./documents";
import { hardenSession } from "./electron";
import { readFileSync } from "node:fs";

export { WEB_SCHEME };

/** What a `web` entry asks for (lane B's manifest: `url` or `entry`, and a `partition`). */
export interface WebSpec {
  url?: string;
  entry?: string;
  partition: string;
}

export function webSpec(raw: Readonly<Record<string, unknown>> | undefined): WebSpec | undefined {
  if (raw === undefined) return undefined;
  const partition = typeof raw.partition === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(raw.partition) ? raw.partition : undefined;
  if (partition === undefined) return undefined;
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const entry = typeof raw.entry === "string" ? raw.entry : undefined;
  if ((url === undefined) === (entry === undefined)) return undefined;
  if (url !== undefined) {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    } catch {
      return undefined;
    }
  }
  return { ...(url !== undefined ? { url } : {}), ...(entry !== undefined ? { entry } : {}), partition };
}

/** The page's address: the URL, or the folder page on the plugin's own `clover-web` origin. */
export function webAddress(plugin: Pick<UiPlugin, "layer">, spec: WebSpec): string {
  if (spec.url !== undefined) return spec.url;
  return `${WEB_SCHEME}://${plugin.layer}/${spec.entry!.split("/").map(encodeURIComponent).join("/")}`;
}

/** The session partition a plugin's web page gets: its own, by its layer label and the entry's partition. */
export function webPartition(plugin: Pick<UiPlugin, "layer">, spec: WebSpec): string {
  return `persist:clover-web-${plugin.layer}-${spec.partition}`;
}

const webSessions = new WeakSet<Session>();

/** Whether a webContents is a web page entry's (the window guards leave those to this module). */
export function isWebViewContents(wc: WebContents): boolean {
  return webSessions.has(wc.session);
}

interface View {
  view: WebContentsView;
  windowId: number;
  window: BaseWindow;
  address: string;
}

export class WebViews {
  private readonly views = new Map<string, View>();
  private readonly prepared = new Map<string, Promise<Session>>();

  constructor(
    private readonly windowOf: (windowId: number) => BaseWindow | undefined,
    private readonly log: (line: string) => void,
  ) {}

  /** The plugin's session, hardened, with its folder served when the page is a folder page. */
  private session(plugin: UiPlugin, spec: WebSpec): Promise<Session> {
    const partition = webPartition(plugin, spec);
    let p = this.prepared.get(partition);
    if (p === undefined) {
      const ses = sessions.fromPartition(partition);
      webSessions.add(ses);
      p = (async () => {
        await hardenSession(ses, this.log);
        ses.protocol.handle(WEB_SCHEME, (request) => {
          const url = new URL(request.url);
          if (url.host !== plugin.layer) return new Response("forbidden", { status: 403, headers: commonHeaders() });
          let file: string;
          try {
            file = pluginFile(plugin, decodeURIComponent(url.pathname.slice(1)) || "index.html");
          } catch {
            return new Response("not found", { status: 404, headers: commonHeaders() });
          }
          const type = mediaType(file) ?? (file.endsWith(".html") ? "text/html; charset=utf-8" : undefined);
          if (type === undefined || !isInside(plugin.assetBase, file)) return new Response("not found", { status: 404, headers: commonHeaders() });
          try {
            return new Response(readFileSync(file), { headers: { ...commonHeaders(), "Content-Type": type } });
          } catch {
            return new Response("not found", { status: 404, headers: commonHeaders() });
          }
        });
        return ses;
      })();
      this.prepared.set(partition, p);
    }
    return p;
  }

  /** Places a web part's view (bounds in the window's content), or hides it (undefined). */
  async place(windowId: number, mount: string, plugin: UiPlugin, spec: WebSpec, bounds: Rect | undefined): Promise<void> {
    let v = this.views.get(mount);
    if (v === undefined) {
      if (bounds === undefined) return;
      const window = this.windowOf(windowId);
      if (window === undefined) return;
      const ses = await this.session(plugin, spec);
      // The part may have gone, or another report placed it, while the session was made.
      if (this.views.has(mount)) return this.place(windowId, mount, plugin, spec, bounds);
      const view = new WebContentsView({
        webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, spellcheck: false, safeDialogs: true },
      });
      const address = webAddress(plugin, spec);
      guardWebPage(view.webContents, address, this.log);
      v = { view, windowId, window, address };
      this.views.set(mount, v);
      window.contentView.addChildView(view);
      void view.webContents.loadURL(address).catch((err: unknown) => this.log(`web: ${plugin.id}'s page didn't load: ${err instanceof Error ? err.message : String(err)}`));
    }
    if (bounds === undefined) {
      v.view.setVisible(false);
      return;
    }
    v.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)) });
    v.view.setVisible(true);
  }

  /** A part gone: its view and page with it. */
  drop(mount: string): void {
    const v = this.views.get(mount);
    if (v === undefined) return;
    this.views.delete(mount);
    try {
      v.window.contentView.removeChildView(v.view);
    } catch {
      // The window went first.
    }
    v.view.webContents.close();
  }

  dropWindow(windowId: number): void {
    for (const [mount, v] of [...this.views]) if (v.windowId === windowId) this.drop(mount);
  }

  /** What the smoke run reports: each view's page and whether it shows. */
  list(): { mount: string; windowId: number; address: string; url: string; visible: boolean; contents: WebContents }[] {
    return [...this.views].map(([mount, v]) => ({ mount, windowId: v.windowId, address: v.address, url: v.view.webContents.getURL(), visible: v.view.getVisible(), contents: v.view.webContents }));
  }
}

/** A URL's scheme, host and port (the folder pages' scheme is the app's own, which WHATWG gives no origin). */
export function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

/** A web page keeps to its own origin: no popups, no navigation away, no `<webview>`, WebRTC's UDP only through a
 *  proxy, as the app's own windows. */
export function guardWebPage(wc: WebContents, address: string, log: (line: string) => void): void {
  const origin = originOf(address);
  const sameOrigin = (url: string) => originOf(url) === origin;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e) => {
    if (!sameOrigin(e.url)) {
      log(`web: a page tried to leave ${origin} for another site; it stays`);
      e.preventDefault();
    }
  });
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
}
