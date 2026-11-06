// The Electron half of the plugin runtime: the app's schemes, the UI session's hardening, the protocol handlers that
// serve the core root and the layers, the IPC the preload's bridge speaks, and the crash census. Spike S9's measured
// design, with decision 94 (stock Electron) and the E-M0 review: the WebRTC UDP policy on every window, no PAC.
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import { app, ipcMain, protocol, webFrameMain, BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents, type WebFrameMain } from "electron";
import type { LayerMessage, OpenTarget, SurfaceEnvironment } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { CORE_CSP, CORE_SCHEME, LAYER_SCHEME, SEALED_SCHEME, WEB_SCHEME, commonHeaders, layerDocument, layerHeaders } from "./documents";
import { checkMenu, mayPlaceView, menuPoint, openTarget, viewRect, type MenuItem, type Rect } from "./brokers";
import { isInside, mediaType, pluginFile } from "./files";
import { LayerError, type FrameRef, type UiRuntime } from "./runtime";
import type { UiPlugin } from "./model";

/** Registers the app's schemes as standard and secure origins, before the app is ready. Service workers and
 *  `bypassCSP` are never granted. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([CORE_SCHEME, LAYER_SCHEME, SEALED_SCHEME, WEB_SCHEME].map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  })));
}

/** Every session the app has, the default one included (S9, and the E-M0 review's S2): no permission, an explicit
 *  proxy (no WPAD lookups), no spellchecker. On Windows and Linux Chromium's spellchecker loads a dictionary for the
 *  app's language as soon as the session exists, downloading it from Google's CDN, which no request filter sees and
 *  turning it off doesn't stop (the UI test's net log caught it on Linux): so the session gets no languages at all,
 *  first thing, and a download URL on loopback in case one starts anyway. Call it right after the session is made. */
export async function hardenSession(ses: Session, log: (line: string) => void): Promise<void> {
  if (process.platform !== "darwin") {
    ses.setSpellCheckerLanguages([]);
    ses.setSpellCheckerDictionaryDownloadURL("http://127.0.0.1:9/");
  }
  ses.setSpellCheckerEnabled(false);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("spellcheck-dictionary-download-begin", (_e, lang) => log(`session: the spellchecker began a dictionary download (${lang}); it should be off`));
  ses.on("will-download", (e) => e.preventDefault());
  await ses.setProxy({ mode: "direct" });
}

const ALLOWED_PROTOCOLS = new Set([`${CORE_SCHEME}:`, `${LAYER_SCHEME}:`, `${SEALED_SCHEME}:`, "data:", "blob:", "devtools:"]);

/** A theme asset's CSP: an SVG opened as a document runs nothing, loads nothing and has no origin of its own. */
const THEME_ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function forbidden(): Response {
  return new Response("forbidden", { status: 403, headers: commonHeaders() });
}

function notFound(): Response {
  return new Response("not found", { status: 404, headers: commonHeaders() });
}

function fileResponse(path: string, type: string, headers: Record<string, string>): Response {
  try {
    return new Response(readFileSync(path), { headers: { ...headers, "Content-Type": type } });
  } catch {
    return notFound();
  }
}

/** Serves the core root (`clover-core://app/`) and the layers on the UI session, and keeps the session off the
 *  network: no plugin layer declares a host until lane B's registry hands them over, so every request outside the
 *  app's own schemes is cancelled. */
export interface UiSessionOptions {
  /** Layers served without `Connection-Allowlist`: only the UI test's positive control for the DNS probe, and only in
   *  an unpackaged run (index.ts decides). */
  unguardedLayers?: ReadonlySet<string>;
}

export function installUiSession(ses: Session, runtime: UiRuntime, dirs: { core: string; layer: string }, log: (line: string) => void, options: UiSessionOptions = {}): void {
  ses.protocol.handle(CORE_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return notFound();
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = normalize(join(dirs.core, ...name.split("/")));
    if (!isInside(dirs.core, file)) return forbidden();
    const type = mediaType(file) ?? (file.endsWith(".html") ? "text/html; charset=utf-8" : undefined);
    if (type === undefined) return notFound();
    return fileResponse(file, type, { ...commonHeaders(), ...(type.startsWith("text/html") ? { "Content-Security-Policy": CORE_CSP } : {}) });
  });

  // The sealed frames' own scheme (§5.5; E-M3): the frame's page answered once, served once, from the store's own
  // copy of the card's sealed content. What runs in it is the page's own check (IOv2 in E-M3's next piece); its
  // answers go over the preload's own channel (`clover:sealed-answer`).
  ses.protocol.handle(SEALED_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/" && !url.pathname.startsWith("/card/")) return notFound();
    const token = url.searchParams.get("token");
    if (token === null || token === "" || token.length > 128) return forbidden();
    const serving = runtime.serveSeal(token);
    if (serving === undefined) return forbidden();
    return new Response(serving.html, { headers: serving.headers });
  });

  ses.protocol.handle(LAYER_SCHEME, (request) => {
    const url = new URL(request.url);
    const layer = url.host;
    if (url.pathname === "/") {
      const mount = runtime.serveDocument(layer, url.searchParams.get("mount"));
      if (mount === undefined) return forbidden();
      const doc = runtime.mountForDocument(mount);
      const headers = layerHeaders("text/html; charset=utf-8", [], doc.layers);
      // The DNS probe's positive control (the UI test, unpackaged runs only): the same document without its allowlist.
      if (options.unguardedLayers?.has(doc.layer) === true) delete headers["Connection-Allowlist"];
      return new Response(layerDocument({ css: doc.assets.css, title: doc.pluginId }), { headers });
    }
    if (url.pathname.startsWith("/_clover/")) {
      const file = normalize(join(dirs.layer, ...url.pathname.slice("/_clover/".length).split("/")));
      if (!isInside(dirs.layer, file)) return forbidden();
      const type = mediaType(file);
      if (type === undefined) return notFound();
      // The `clover` tree's bundle is served only in the `clover` layer, and no source map to anyone.
      if (url.pathname.endsWith(".map")) return notFound();
      if (/^clover\.(js|css)$/.test(url.pathname.slice("/_clover/".length)) && layer !== "clover") return forbidden();
      return fileResponse(file, type, layerHeaders(type));
    }
    if (url.pathname.startsWith("/_p/")) {
      const [, , encoded, ...rest] = url.pathname.split("/");
      let id: string;
      let path: string;
      try {
        id = decodeURIComponent(encoded ?? "");
        path = rest.map((p) => decodeURIComponent(p)).join("/");
      } catch {
        return notFound();
      }
      // A layer serves its own plugin's files only.
      const plugin = runtime.registry.find((p) => p.id === id && p.layer === layer);
      if (plugin === undefined) return forbidden();
      let file: string;
      try {
        file = pluginFile(plugin, path);
      } catch {
        return notFound();
      }
      const type = mediaType(file);
      if (type === undefined) return forbidden();
      return fileResponse(file, type, layerHeaders(type));
    }
    if (url.pathname.startsWith("/_t/")) {
      // A theme's or a layout's images and fonts, in every layer they reach (§5.5): only a plugin with themes, style
      // entries or a bot's layout, only images and fonts, inside its folder. Never a document: an SVG opened as a
      // page gets no origin.
      const [, , encoded, ...rest] = url.pathname.split("/");
      let id: string;
      let path: string;
      try {
        id = decodeURIComponent(encoded ?? "");
        path = rest.map((p) => decodeURIComponent(p)).join("/");
      } catch {
        return notFound();
      }
      const plugin = runtime.registry.find((p) => p.id === id && (p.themes.length > 0 || p.botLayout !== undefined || p.entries.some((e) => e.style !== undefined)));
      if (plugin === undefined) return forbidden();
      let file: string;
      try {
        file = pluginFile(plugin, path);
      } catch {
        return notFound();
      }
      const type = mediaType(file);
      if (type === undefined || !(type.startsWith("image/") || type.startsWith("font/"))) return forbidden();
      return fileResponse(file, type, { ...commonHeaders(), "Content-Security-Policy": THEME_ASSET_CSP });
    }
    return notFound();
  });

  // The sealed frames' scheme: handled above with its own single-use serving (E-M3's own registration). The web
  // scheme never carries a card (§5.5 "Where cards appear").
  const refused = new Set<string>();
  ses.webRequest.onBeforeRequest((details, callback) => {
    let protocolName = "";
    try {
      protocolName = new URL(details.url).protocol;
    } catch {
      /* refused */
    }
    if (ALLOWED_PROTOCOLS.has(protocolName)) return callback({});
    const origin = details.initiatorOrigin ?? "unknown";
    if (!refused.has(origin)) {
      refused.add(origin);
      log(`layers: refused a request to the network from ${origin} (no layer declares a host yet)`);
    }
    callback({ cancel: true });
  });
}

/** The guards every app window's page gets: no popups, no navigation away, no `<webview>`, WebRTC's UDP only through
 *  a proxy (the E-M0 review's B3: with Connection-Allowlist it read zero on every vector with a positive control). */
export function guardContents(wc: WebContents, log: (line: string) => void): void {
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.on("will-frame-navigate", (e) => {
    if (e.isMainFrame) {
      if (!e.url.startsWith(`${CORE_SCHEME}://app/`)) e.preventDefault();
      return;
    }
    if (!e.url.startsWith(`${LAYER_SCHEME}://`)) {
      log(`layers: a frame tried to leave for ${e.url.slice(0, 120)}`);
      e.preventDefault();
    }
  });
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
}

function frameRef(f: WebFrameMain, depth = 0): FrameRef {
  return {
    processId: f.processId,
    routingId: f.routingId,
    url: f.url,
    osPid: f.osProcessId,
    parent: f.parent !== null && depth < 1 ? frameRef(f.parent, depth + 1) : null,
  };
}

function sender(event: IpcMainEvent | IpcMainInvokeEvent): { frame: FrameRef; windowId: number } {
  const f = event.senderFrame;
  if (f === null || f.detached) throw new LayerError("the frame is gone");
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win === null) throw new LayerError("no window");
  return { frame: frameRef(f), windowId: win.id };
}

const MAX_PROPS_BYTES = 1_000_000;

function str(v: unknown, max = 256): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

export interface IpcHooks {
  /** The root's measured title-bar area, for the frame's variables. */
  frameMetrics(windowId: number, m: { top: number; start: number; end: number }): void;
  /** A command from the root (restart normally, open the plugin manager…). */
  rootCommand(windowId: number, name: string): void;
  /** A call from one of the core's own pages in the root (core-pages.ts checks it). */
  rootCall(windowId: number, name: string, params: unknown): Promise<unknown>;
  /** A surface window's own request: show or hide, its size or place, where it takes clicks. */
  surface(windowId: number, request: Record<string, unknown>): void;
  /** A surface window's environment: the OS, the display server, its display. */
  surfaceEnvironment(windowId: number): SurfaceEnvironment | undefined;
  /** Opens a place in the main window for a part of the plugin `pluginId`. */
  open(pluginId: string, target: OpenTarget): Promise<void>;
  /** Where a part's native view goes in the window (undefined: nowhere now); `used` when the person just used it. */
  viewFrame(windowId: number, mount: string, name: string, bounds: Rect | undefined, used: boolean): void;
  /** A part's plugin-API call, on its plugin's own connection to the core. */
  api(pluginId: string, method: string, params: unknown): Promise<unknown>;
  /** A key press or paste in a terminal part's element, to write what the main process derives from its own input;
   *  `frameId` names the focused frame (the review's S2: the record the main process keeps is per frame). */
  terminalInput(windowId: number, frameId: string, pluginId: string, terminalId: string, input: { kind: "key"; key: string } | { kind: "paste" }): Promise<void>;
  /** The user's own words from a `clover` surface's part (`pill.send`), after the gate. */
  userSend(windowId: number, to: unknown, message: { text: string; images?: unknown }): Promise<{ seq?: number }>;
  /** The session a window shows now, as the `clover` layer's shell says (null: none). */
  activeSession(windowId: number, session: string | null): void;
  /** Where a web page part's view goes in the window (undefined: hidden). */
  webFrame(windowId: number, mount: string, web: { plugin: UiPlugin; web: Readonly<Record<string, unknown>> }, bounds: Rect | undefined): void;
  /** Shows a checked menu at a point in the window; the id picked, or null. */
  menu(windowId: number, items: MenuItem[], point: { x: number; y: number }): Promise<string | null>;
  /** A sealed button's answer: the app signs it with the answer key over the frame's own channel (§5.5; E-M3). */
  sealedAnswer(token: string, option: string, children?: readonly string[]): Promise<{ accepted: boolean; reason?: string }>;
  /** Whether the sealed frame's button may answer in its own window now: visible and unplanned elsewhere (E-M3). */
  sealedVisible(token: string): Promise<boolean>;
}

function rect(v: unknown): Rect | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const { x, y, width, height } = v as Record<string, unknown>;
  return [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n)) ? { x: x as number, y: y as number, width: width as number, height: height as number } : undefined;
}

/** The IPC the preload's bridge speaks. Every call is bound to its sender's frame. */
export function installIpc(runtime: UiRuntime, hooks: IpcHooks, log: (line: string) => void): () => void {
  runtime.send = (frame, message: LayerMessage) => {
    const f = webFrameMain.fromId(frame.processId, frame.routingId);
    if (f === undefined || f === null || f.detached) return;
    f.send("clover:message", message);
  };
  const handle = (channel: string, fn: (event: IpcMainInvokeEvent, arg: Record<string, unknown>) => unknown) =>
    ipcMain.handle(channel, (event, arg) => fn(event, (arg ?? {}) as Record<string, unknown>));
  const on = (channel: string, fn: (event: IpcMainEvent, arg: Record<string, unknown>) => void) =>
    ipcMain.on(channel, (event, arg) => {
      try {
        fn(event, (arg ?? {}) as Record<string, unknown>);
      } catch (err) {
        if (!(err instanceof LayerError)) log(`layers: ${channel} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  handle("clover:describe", (event, a) => {
    const s = sender(event);
    return runtime.describe(s.frame, s.windowId, str(a.token, 128));
  });
  handle("clover:resolve", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    const spot = str(a.spot, 128);
    if (mount === undefined || spot === undefined) throw new LayerError("bad request");
    const hints = typeof a.hints === "object" && a.hints !== null ? (a.hints as { session?: unknown; entry?: unknown }) : {};
    return runtime.resolve(s.frame, mount, spot, str(a.key), { ...(str(hints.session, 32) ? { session: str(hints.session, 32)! } : {}), ...(str(hints.entry, 300) ? { entry: str(hints.entry, 300)! } : {}) });
  });
  handle("clover:entries", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    const spot = str(a.spot, 128);
    if (mount === undefined || spot === undefined) throw new LayerError("bad request");
    return runtime.entries(s.frame, mount, spot, str(a.key));
  });
  handle("clover:reload", (event, a) => {
    const s = sender(event);
    const child = str(a.child, 32);
    return child === undefined ? undefined : runtime.reload(s.frame, child);
  });
  on("clover:props", (event, a) => {
    const child = str(a.child, 32);
    if (child === undefined) return;
    if (JSON.stringify(a.props ?? null).length > MAX_PROPS_BYTES) {
      log(`layers: props for ${child} were too large and were dropped`);
      return;
    }
    runtime.setProps(sender(event).frame, child, a.props);
  });
  on("clover:callback", (event, a) => {
    const id = str(a.id, 32);
    if (id === undefined || !Array.isArray(a.args) || JSON.stringify(a.args).length > MAX_PROPS_BYTES) return;
    runtime.callback(sender(event).frame, id, a.args);
  });
  on("clover:size", (event, a) => {
    if (typeof a.height === "number") runtime.reportSize(sender(event).frame, a.height);
  });
  on("clover:release", (event, a) => {
    if (!Array.isArray(a.mounts)) return;
    runtime.release(sender(event).frame, a.mounts.filter((m): m is string => typeof m === "string").slice(0, 1000));
  });
  on("clover:sleep", (event, a) => {
    const child = str(a.child, 32);
    if (child !== undefined) runtime.sleep(sender(event).frame, child);
  });
  handle("clover:wake", (event, a) => {
    const child = str(a.child, 32);
    return child === undefined ? undefined : runtime.wake(sender(event).frame, child);
  });
  on("clover:surface", (event, a) => {
    const id = runtime.surfaceOf(sender(event).frame);
    if (id !== undefined) hooks.surface(id, a);
  });
  handle("clover:surface-environment", (event) => {
    const id = runtime.surfaceOf(sender(event).frame);
    return id === undefined ? undefined : hooks.surfaceEnvironment(id);
  });
  handle("clover:open", (event, a) => {
    const mount = str(a.mount, 32);
    if (mount === undefined) throw new LayerError("bad request");
    const pluginId = runtime.partOf(sender(event).frame, mount);
    const target = openTarget(a.target);
    if (target === undefined) throw new LayerError("not a place the app opens");
    return hooks.open(pluginId, target);
  });
  // The menu broker: where the asking frame sits, from each document above it, then the menu at that point.
  const rects = new Map<string, { from: string; resolve: (r: Rect | undefined) => void }>();
  on("clover:rect-reply", (event, a) => {
    const id = str(a.id, 64);
    const f = event.senderFrame;
    const waiting = id === undefined ? undefined : rects.get(id);
    if (waiting === undefined || f === null || `${f.processId}:${f.routingId}` !== waiting.from) return;
    rects.delete(id!);
    waiting.resolve(rect(a.rect));
  });
  const askRect = (parent: { processId: number; routingId: number }, child: string) => new Promise<Rect | undefined>((resolve) => {
    const id = randomBytes(12).toString("hex");
    const timer = setTimeout(() => {
      rects.delete(id);
      resolve(undefined);
    }, 1000);
    rects.set(id, { from: `${parent.processId}:${parent.routingId}`, resolve: (r) => {
      clearTimeout(timer);
      resolve(r);
    } });
    runtime.send(parent, { type: "rect-query", id, child });
  });
  handle("clover:menu", async (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    // The part asking must be in the asking document.
    if (mount === undefined) throw new LayerError("bad request");
    runtime.partOf(s.frame, mount);
    const checked = checkMenu(a);
    if ("error" in checked) throw new LayerError(checked.error);
    const place = runtime.placeOf(s.frame);
    const chain = await Promise.all(place.steps.map((step) => askRect(step.parent, step.child)));
    if (chain.some((r) => r === undefined)) throw new LayerError("the frame's place in the window isn't known");
    const point = menuPoint({ x: typeof a.x === "number" ? a.x : 0, y: typeof a.y === "number" ? a.y : 0 }, chain as Rect[]);
    if (point === undefined) throw new LayerError("no place for the menu");
    return hooks.menu(place.windowId, checked.items, point);
  });
  // A native view's frame (the Clover Browser's live view): checked, clipped to the part's own frame, placed in the
  // window by each document above it. Reports from one part go in order, so a late answer never moves a view back.
  const viewSeq = new Map<string, number>();
  on("clover:view-frame", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    const name = str(a.name, 64);
    if (mount === undefined || name === undefined || !/^[a-z][a-z0-9:-]*$/.test(name)) return;
    if (!mayPlaceView(runtime.capabilitiesOf(s.frame, mount))) {
      log(`layers: ${runtime.partOf(s.frame, mount)} may not place the ${name} view (it needs the browser capability)`);
      return;
    }
    const used = a.used === true;
    const key = `${mount}|${name}`;
    const seq = (viewSeq.get(key) ?? 0) + 1;
    viewSeq.set(key, seq);
    const r = a.rect === null ? undefined : rect(a.rect);
    if (r === undefined) {
      hooks.viewFrame(s.windowId, mount, name, undefined, used);
      return;
    }
    const place = runtime.placeOf(s.frame);
    void Promise.all(place.steps.map((step) => askRect(step.parent, step.child))).then((chain) => {
      if (viewSeq.get(key) !== seq) return;
      const bounds = chain.some((c) => c === undefined) ? undefined : viewRect(r, chain as Rect[]);
      hooks.viewFrame(place.windowId, mount, name, bounds, used);
    });
  });
  // A web page part's view (§5.5 "Web pages"): the place its part reports, clipped to the frame, as for a native view.
  const webSeq = new Map<string, number>();
  on("clover:web-frame", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    if (mount === undefined) return;
    const web = runtime.webOf(s.frame, mount);
    const seq = (webSeq.get(mount) ?? 0) + 1;
    webSeq.set(mount, seq);
    const r = a.rect === null ? undefined : rect(a.rect);
    if (r === undefined) {
      hooks.webFrame(web.windowId, mount, web, undefined);
      return;
    }
    const place = runtime.placeOf(s.frame);
    void Promise.all(place.steps.map((step) => askRect(step.parent, step.child))).then((chain) => {
      if (webSeq.get(mount) !== seq) return;
      const bounds = chain.some((c) => c === undefined) ? undefined : viewRect(r, chain as Rect[]);
      hooks.webFrame(place.windowId, mount, web, bounds);
    });
  });
  handle("clover:api", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    const method = str(a.method, 128);
    if (mount === undefined || method === undefined) throw new LayerError("bad request");
    return hooks.api(runtime.partOf(s.frame, mount), method, a.params);
  });
  handle("clover:terminal-input", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    const terminalId = str(a.terminalId, 128);
    const input = (a.input ?? {}) as { kind?: unknown; key?: unknown };
    if (mount === undefined || terminalId === undefined) throw new LayerError("bad request");
    const checked = input.kind === "paste" ? { kind: "paste" as const } : input.kind === "key" && typeof input.key === "string" && input.key.length <= 32 ? { kind: "key" as const, key: input.key } : undefined;
    if (checked === undefined) throw new LayerError("not a key press or a paste");
    return hooks.terminalInput(s.windowId, `${s.frame.processId}:${s.frame.routingId}`, runtime.partOf(s.frame, mount), terminalId, checked);
  });
  handle("clover:user-send", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    if (mount === undefined) throw new LayerError("bad request");
    const { windowId } = runtime.userSender(s.frame, mount);
    const m = (a.message ?? {}) as { text?: unknown; images?: unknown };
    if (typeof m.text !== "string" || m.text.length > 1_000_000) throw new LayerError("the words are text");
    return hooks.userSend(windowId, a.to, { text: m.text, ...(m.images !== undefined ? { images: m.images } : {}) });
  });
  on("clover:active-session", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    if (mount === undefined) return;
    // Only the app's own shell says what the window shows.
    if (runtime.partOf(s.frame, mount).split("/")[0] !== "clover") return;
    const session = a.session === null ? null : str(a.session, 128);
    if (session !== undefined) hooks.activeSession(s.windowId, session);
  });
  handle("clover:drag-offer", (event, a) => {
    const mount = str(a.mount, 32);
    if (mount === undefined) throw new LayerError("bad request");
    return runtime.dragOffer(sender(event).frame, mount, a.offer);
  });
  handle("clover:drag-claim", (event, a) => {
    const mount = str(a.mount, 32);
    const token = str(a.token, 128);
    if (mount === undefined || token === undefined) throw new LayerError("bad request");
    return runtime.dragClaim(sender(event).frame, mount, token);
  });
  // A sealed frame's own single-use URL: its part asks, the runtime mints (the plugin's `approvals` capability's own
  // gate), and the scheme's handler serves once from the store's own copy of the card's sealed content.
  handle("clover:sealed-frame", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    const cardId = str(a.cardId, 64);
    const element = typeof a.element === "string" && (a.element.startsWith("field:") || a.element.startsWith("button:")) && a.element.length <= 80 ? a.element : undefined;
    if (mount === undefined || cardId === undefined || element === undefined) throw new LayerError("bad sealed frame");
    return runtime.sealedFrameOf(s.frame, mount, cardId, element);
  });

  // The sealed frames' answer: the sender is the sealed page itself (its own scheme), whose token names the channel;
  // the app signs it out of doors and takes the core's answer. Nothing between.
  handle("clover:sealed-answer", async (event, a) => {
    const f = event.senderFrame;
    if (f === null || f.detached || !f.url.startsWith("clover-sealed://")) throw new LayerError("not a sealed frame");
    const token = str(a.token, 128);
    const option = typeof a.option === "string" && a.option.length <= 64 ? a.option : undefined;
    const ch = token !== undefined && Array.isArray(a.children) ? a.children : undefined;
    if (token === undefined || option === undefined || (ch !== undefined && !ch.every((c: unknown) => typeof c === "string"))) throw new LayerError("bad sealed answer");
    return hooks.sealedAnswer(token, option, ch !== undefined ? (ch as readonly string[]) : undefined);
  });
  handle("clover:sealed-visible", async (event, a) => {
    const f = event.senderFrame;
    if (f === null || f.detached || !f.url.startsWith("clover-sealed://")) throw new LayerError("not a sealed frame");
    const token = str(a.token, 128);
    if (token === undefined) throw new LayerError("bad sealed look");
    return hooks.sealedVisible(token);
  });
  // The root's own calls: only from a window's main frame on the core's origin.
  const fromRoot = (event: IpcMainEvent | IpcMainInvokeEvent): number | undefined => {
    const f = event.senderFrame;
    if (f === null || f.parent !== null || !f.url.startsWith(`${CORE_SCHEME}://app/`)) return undefined;
    return BrowserWindow.fromWebContents(event.sender)?.id;
  };
  on("clover:frame-metrics", (event, a) => {
    const id = fromRoot(event);
    const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1000, Math.round(v))) : d);
    if (id !== undefined) hooks.frameMetrics(id, { top: n(a.top, 45), start: n(a.start, 0), end: n(a.end, 0) });
  });
  on("clover:root-command", (event, a) => {
    const id = fromRoot(event);
    const name = str(a.name, 64);
    if (id !== undefined && name !== undefined) hooks.rootCommand(id, name);
  });
  handle("clover:root-call", (event, a) => {
    const id = fromRoot(event);
    const name = str(a.name, 64);
    if (id === undefined || name === undefined) throw new LayerError("only the core's root calls that");
    return hooks.rootCall(id, name, a.params);
  });

  return () => {
    for (const c of ["clover:describe", "clover:resolve", "clover:reload", "clover:wake", "clover:menu", "clover:drag-offer", "clover:drag-claim", "clover:surface-environment", "clover:open", "clover:root-call", "clover:entries", "clover:user-send", "clover:api", "clover:terminal-input", "clover:sealed-frame", "clover:sealed-answer", "clover:sealed-visible"]) ipcMain.removeHandler(c);
    for (const c of ["clover:props", "clover:callback", "clover:size", "clover:release", "clover:sleep", "clover:surface", "clover:rect-reply", "clover:frame-metrics", "clover:root-command", "clover:view-frame", "clover:web-frame", "clover:active-session"]) ipcMain.removeAllListeners(c);
  };
}

/** S9: Electron 45 raises nothing when a subframe's renderer is killed, so the runtime counts processes. A census runs
 *  every few seconds while windows exist, and at once when any child process goes. */
export function startCensus(runtime: UiRuntime, intervalMs = 5_000): () => void {
  const run = () => {
    if (BrowserWindow.getAllWindows().length === 0) return;
    const pids = new Set(app.getAppMetrics().map((m) => m.pid));
    runtime.census((f) => {
      const wf = webFrameMain.fromId(f.processId, f.routingId);
      if (wf === undefined || wf === null || wf.detached) return false;
      return f.osPid === undefined || pids.has(f.osPid);
    });
  };
  const timer = setInterval(run, intervalMs);
  const soon = () => setTimeout(run, 50);
  app.on("render-process-gone", soon);
  app.on("child-process-gone", soon);
  return () => {
    clearInterval(timer);
    app.removeListener("render-process-gone", soon);
    app.removeListener("child-process-gone", soon);
  };
}
