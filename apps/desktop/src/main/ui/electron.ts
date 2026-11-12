// The Electron half of the plugin runtime: the app's schemes, the UI session's hardening, the protocol handlers that
// serve the core root and the layers, the IPC the preload's bridge speaks, and the crash census. Spike S9's measured
// design, with decision 94 (stock Electron) and the E-M0 review: the WebRTC UDP policy on every window, no PAC.
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import { app, ipcMain, protocol, webFrameMain, BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents, type WebFrameMain } from "electron";
import type { ShellApp, ShellState } from "@waifucave/clover-plugin-sdk";
import { cleanAvatarDown, cleanAvatarUp, cleanSpeechMessage, type LayerMessage, type OpenTarget, type SurfaceEnvironment } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { CORE_CSP, CORE_SCHEME, LAYER_SCHEME, SEALED_SCHEME, WEB_SCHEME, commonHeaders, layerDocument, layerHeaders } from "./documents";
import { checkMenu, frameGesture, mayPlaceView, menuPoint, openTarget, viewRect, type MenuItem, type Rect } from "./brokers";
import { avatarModelFile, builtClientFile, isInside, mediaType, modelResponse, pluginFile, userAvatarFile } from "./files";
import { LayerError, type FrameRef, type UiRuntime } from "./runtime";
import { FileGrants, PICK_METHODS, grantResponse, routeDrop, routePick, type DialogRequest, type Grant } from "./file-grants";
import { PickTokens, routeCall, type KeyTarget, type PickUse } from "./tree-calls";
import { iconRequest } from "./plugin-icon";
import { routeComposer } from "./composer-calls";
import { cleanReport, hearsShell, ownsShownBot, routeShell } from "./shell-calls";
import type { UiPlugin } from "./model";
import type { IpcStats } from "./ipc-stats";

/** Registers the app's schemes as standard and secure origins, before the app is ready. Service workers and
 *  `bypassCSP` are never granted. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([CORE_SCHEME, LAYER_SCHEME, SEALED_SCHEME, WEB_SCHEME].map((scheme) => ({
    scheme,
    // `stream`: a layer's <video> and <audio> may play from the app's own scheme (the granted-file route answers Range requests).
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
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
  /** The core's folder of the user's own avatar models, `<home>/user-layers/avatars` (`bot.importAvatar`): served at
   *  `/_a/<bot>/…` to the layers, and only for a bot that is installed. */
  avatarsDir?: string;
  /** A plugin's own icon for the Plugins page's lists (`plugin-icon.ts`): served at `/_icon/<id>` in the clover tree's
   *  layer only, a raster picture or nothing. */
  pluginIcon?: (id: string) => Promise<{ data: Buffer; type: string } | undefined>;
  /** The files the user handed plugins' pages (`files.pick*`), served at `/_g/<id>` on the plugin's own layer: the same
   *  record `installIpc` fills. Without it nothing is served there. */
  grants?: FileGrants;
}

/** The most one file of the user's own model may be (the core's import refuses more). */

export function installUiSession(ses: Session, runtime: UiRuntime, dirs: { core: string; layer: string }, log: (line: string) => void, options: UiSessionOptions = {}): void {
  ses.protocol.handle(CORE_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return notFound();
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = normalize(join(dirs.core, ...name.split("/")));
    if (!isInside(dirs.core, file)) return forbidden();
    const type = mediaType(file) ?? (file.endsWith(".html") ? "text/html; charset=utf-8" : undefined);
    if (type === undefined) return notFound();
    // The core's document is the top of every window: same-origin opener policy (with the embedder policy of `commonHeaders`) is
    // what lets a frame of it be cross-origin isolated; it severs `window.opener`, which no window of the app uses (popups are denied).
    return fileResponse(file, type, { ...commonHeaders(), ...(type.startsWith("text/html") ? { "Content-Security-Policy": CORE_CSP, "Cross-Origin-Opener-Policy": "same-origin" } : {}) });
  });

  // The sealed frames' own scheme (§5.5; E-M3): the frame's page answered once, served once, from the store's own
  // copy of the card's sealed content. What runs in it is the page's own check (IOv2 in E-M3's next piece); its
  // answers go over the preload's own channel (`clover:sealed-answer`). Nothing in production relaxes `isTrusted`
  // or the open-delay: there is no `trust` knob. Serving is single-use per token (the store marks it); the token
  // itself is 20 crypto-random bytes, so no header gate is needed.
  ses.protocol.handle(SEALED_SCHEME, (request) => {
    const url = new URL(request.url);
    // Minted URLs are `clover-sealed://card/<cardId>/<element>?token=…` (parts and the fallback alike); the token's
    // single use is the real gate.
    if (url.host !== "card") {
      log(`sealed: refusing a sealed load (bad host)`);
      return notFound();
    }
    const token = url.searchParams.get("token");
    if (token === null || token === "" || token.length > 128) {
      log(`sealed: refusing a sealed load (bad token)`);
      return forbidden();
    }
    const serving = runtime.serveSeal(token);
    if (serving === undefined) {
      log(`sealed: refusing a sealed load (no channel)`);
      return forbidden();
    }
    return new Response(serving.html, { headers: serving.headers });
  });

  ses.protocol.handle(LAYER_SCHEME, (request) => {
    const url = new URL(request.url);
    const layer = url.host;
    if (url.pathname === "/") {
      const mount = runtime.serveDocument(layer, url.searchParams.get("mount"));
      if (mount === undefined) return forbidden();
      const doc = runtime.mountForDocument(mount);
      const headers = layerHeaders("text/html; charset=utf-8", [], doc.layers, doc.layer !== "clover");
      // The DNS probe's positive control (the UI test, unpackaged runs only): the same document without its allowlist.
      if (options.unguardedLayers?.has(doc.layer) === true) delete headers["Connection-Allowlist"];
      return new Response(layerDocument({ css: doc.assets.css, title: doc.pluginId }), { headers });
    }
    if (url.pathname.startsWith("/_icon/")) {
      // The Plugins page's lists: a plugin's icon, even one off or waiting for its OK, as a small still raster picture
      // only (plugin-icon.ts). Who asks is checked before this, by the requesting frame (`onBeforeRequest`); this
      // host check is a second lock, not the gate.
      if (layer !== "clover" || options.pluginIcon === undefined) return forbidden();
      let id: string;
      try {
        id = decodeURIComponent(url.pathname.slice("/_icon/".length));
      } catch {
        return notFound();
      }
      return options.pluginIcon(id).then(
        (icon) => (icon === undefined
          ? notFound()
          : new Response(new Uint8Array(icon.data), { headers: { ...commonHeaders(), "Content-Type": icon.type, "Content-Security-Policy": THEME_ASSET_CSP } })),
        () => notFound(),
      );
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
    if (url.pathname.startsWith("/_b/")) {
      // A plugin's client the core built at load (its view's `clientBuild`): on its own layer's origin only, with a
      // shipped client's headers, and only while the file is the one the core built.
      const [, , encoded, key, name, ...more] = url.pathname.split("/");
      if (more.length > 0) return notFound();
      let id: string;
      let file: string;
      try {
        id = decodeURIComponent(encoded ?? "");
        file = decodeURIComponent(name ?? "");
      } catch {
        return notFound();
      }
      const plugin = runtime.registry.find((p) => p.id === id && p.layer === layer);
      if (plugin === undefined) return forbidden();
      const bytes = builtClientFile(plugin, key ?? "", file);
      if (bytes === undefined) return notFound();
      const type = "text/javascript; charset=utf-8";
      return new Response(bytes, { headers: { ...layerHeaders(type), "Content-Type": type } });
    }
    if (url.pathname.startsWith("/_a/") && options.avatarsDir !== undefined) {
      // The user's own avatar model (the core copied it here): data only, the kinds the installed renderers declared, one bot's folder.
      const served = userAvatarFile(options.avatarsDir, runtime.registry, url.pathname);
      if (served === "forbidden") return forbidden();
      if (served === "missing") return notFound();
      return modelResponse(served.file, served.type, { ...commonHeaders(), "Content-Security-Policy": THEME_ASSET_CSP }, served.maxBytes);
    }
    if (url.pathname.startsWith("/_g/") && options.grants !== undefined) {
      // A file the user handed this plugin's page (`files.pickOpen`, `files.pickSave`): only its own READ-capable grant on
      // a file, with Range support, never a listing. The id alone names it; whose it is, is the layer's plugin.
      const rest = url.pathname.slice("/_g/".length);
      if (rest.includes("/")) return notFound();
      const range = request.headers.get("range");
      for (const p of runtime.registry) {
        if (p.layer !== layer) continue;
        if (options.grants.byId(p.id, rest) !== undefined) return grantResponse(options.grants, p.id, rest, range, commonHeaders());
      }
      return forbidden();
    }
    if (url.pathname.startsWith("/_t/")) {
      // A theme's or a layout's images and fonts, a bot's portrait (the core's `assetUrl`) and a plugin's icon, in every layer they
      // reach (§5.5): only a plugin with themes, style entries, a bot's layout or a bot, only images and fonts, inside
      // its folder. Never a document: an SVG opened as a page gets no origin.
      const [, , encoded, ...rest] = url.pathname.split("/");
      let id: string;
      let path: string;
      try {
        id = decodeURIComponent(encoded ?? "");
        path = rest.map((p) => decodeURIComponent(p)).join("/");
      } catch {
        return notFound();
      }
      // A plugin's own picture (its view's `icon`) too, by that exact path: the Plugins page's lists.
      const plugin = runtime.registry.find((p) => p.id === id && (p.isBot || p.themes.length > 0 || p.botLayout !== undefined || p.entries.some((e) => e.style !== undefined) || (p.icon !== undefined && p.icon === path)));
      if (plugin === undefined) return forbidden();
      let file: string;
      try {
        file = pluginFile(plugin, path);
      } catch {
        return notFound();
      }
      // A bot's own model files (a VRM, a Live2D `.moc3` and its JSON, a sprite's picture list…) are the bot plugin's inert data its stage's
      // avatar entry reads: served by the kinds the installed renderer of the bot's format declared (`avatar.formats`), inside the folder
      // its avatar sits in, capped, nosniff and sandboxed, never as a document.
      const model = avatarModelFile(plugin, runtime.registry, file);
      if (model !== undefined) return modelResponse(file, model.media, { ...commonHeaders(), "Content-Security-Policy": THEME_ASSET_CSP }, model.maxBytes);
      const type = mediaType(file);
      if (type === undefined || !(type.startsWith("image/") || type.startsWith("font/"))) return forbidden();
      return fileResponse(file, type, { ...commonHeaders(), "Content-Security-Policy": THEME_ASSET_CSP });
    }
    return notFound();
  });

  // The sealed frames' scheme: handled above with its own single-use serving (E-M3's own registration). The web
  // scheme never carries a card (§5.5 "Where cards appear").
  const refused = new Set<string>();
  const iconRefusals = new Set<string>();
  ses.webRequest.onBeforeRequest((details, callback) => {
    let protocolName = "";
    try {
      protocolName = new URL(details.url).protocol;
    } catch {
      /* refused */
    }
    // A plugin's icon (`/_icon/`): only for a frame main bound to the clover tree's layer, by the frame that asks.
    if (protocolName === `${LAYER_SCHEME}:`) {
      const f = details.frame;
      const layer = f === undefined || f === null || f.detached ? undefined : runtime.layerOfFrame({ processId: f.processId, routingId: f.routingId });
      if (iconRequest(layer, details.url) === "refuse") {
        // Said once per icon and asker: a frame main doesn't know, or another layer's.
        const id = (() => {
          try {
            return decodeURIComponent(new URL(details.url).pathname.slice("/_icon/".length)).slice(0, 64);
          } catch {
            return "?";
          }
        })();
        const said = `${layer ?? ""}\u0000${id}`;
        if (!iconRefusals.has(said) && iconRefusals.size < 1000) {
          iconRefusals.add(said);
          log(`layers: cancelled ${id}'s icon for ${layer === undefined ? "a frame main doesn't know" : `the ${layer} layer's frame`}`);
        }
        return callback({ cancel: true });
      }
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
      // A fallback card's own window is a main frame on the sealed scheme; every other main frame stays on the core.
      if (!e.url.startsWith(`${CORE_SCHEME}://app/`) && !e.url.startsWith(`${SEALED_SCHEME}://`)) {
        log(`layers: a window tried to leave for ${e.url.slice(0, 120)}`);
        e.preventDefault();
      }
      return;
    }
    // A sealed frame is an iframe on the sealed scheme inside a plugin's layer document; every other subframe stays
    // on the layer scheme.
    if (!e.url.startsWith(`${LAYER_SCHEME}://`) && !e.url.startsWith(`${SEALED_SCHEME}://`)) {
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
  /** One key press or click of the user's the main process saw come to the window, spent (the SendGate). */
  takeGesture(windowId: number): boolean;
  /** The bundled tree's call, already checked against the table (`tree-calls.ts`), on the app's own connection. */
  treeRequest(method: string, params: unknown): Promise<unknown>;
  /** Main's native folder or file dialog over a window, for the Plugins page's `ui.pick`: the path, or undefined. */
  pick?(windowId: number, kind: "folder" | "file", filters: readonly { name: string; extensions: string[] }[] | undefined, use: PickUse): Promise<string | undefined>;
  /** Main's native open, folder or save dialog over a window, for a plugin page's `files.pick*`: the chosen paths, none on cancel. */
  pickFiles?(windowId: number, request: DialogRequest): Promise<string[]>;
  /** Tells the core about a grant (`plugin.grant.add`): throws with a reason the user may be shown when the core refuses it,
   *  answers `"unserved"` when the core has no such call yet. */
  registerGrant?(grant: Grant): Promise<"ok" | "unserved">;
  /** The grants main holds (shared with `installUiSession`'s media route). */
  grants?: FileGrants;
  /** Opens the app's own key dialog for a plugin's key (the Plugins page's `ui.secret`, checked as one). */
  openKey?(target: KeyTarget): Promise<boolean>;
  /** A key press or paste in a terminal part's element, to write what the main process derives from its own input;
   *  `frameId` names the focused frame (the review's S2: the record the main process keeps is per frame). */
  terminalInput(windowId: number, frameId: string, pluginId: string, terminalId: string, input: { kind: "key"; key: string } | { kind: "paste" }): Promise<void>;
  /** The user's own words from a `clover` surface's part (`pill.send`), after the gate. */
  userSend(windowId: number, to: unknown, message: { text: string; images?: unknown }, active: boolean): Promise<{ seq?: number }>;
  /** The shell's press on a drag region (`shell`: the main process's own record says this is the shell in `app.root`). */
  windowDrag(windowId: number, shell: boolean): void;
  /** The session a window shows now, as the `clover` layer's shell says (null: none). */
  activeSession(windowId: number, session: string | null): void;
  /** Where a web page part's view goes in the window (undefined: hidden). */
  webFrame(windowId: number, mount: string, web: { plugin: UiPlugin; web: Readonly<Record<string, unknown>> }, bounds: Rect | undefined): void;
  /** Shows a checked menu at a point in the window; the id picked, or null. */
  menu(windowId: number, items: MenuItem[], point: { x: number; y: number }): Promise<string | null>;
  /** A sealed button's answer: the app signs it with the answer key over the frame's own channel (§5.5; E-M3), the
   *  computer-use gate first, in the main process (B3). `senderKey` is the sender frame's own key, checked against the
   *  mint's binding (B4). */
  sealedAnswer(token: string, option: string | undefined, senderKey: string, children?: readonly string[]): Promise<{ accepted: boolean; reason?: string; key?: "changed" | "fault" }>;
  /** A sealed frame's page reports its own visibility (IOv2), so the main process can disarm the fallback once all of
   *  a card's buttons show (§5.5's fallback rule). Checked like the answer: the sender must be the sealed frame its
   *  token was served to. */
  sealedVisible(token: string, visible: boolean): void;
  /** The app's own card page says how tall it is, so its window fits it (a number, nothing else). */
  sealedSize(token: string, height: number): void;
}

function rect(v: unknown): Rect | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const { x, y, width, height } = v as Record<string, unknown>;
  return [x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n)) ? { x: x as number, y: y as number, width: width as number, height: height as number } : undefined;
}

/** The IPC the preload's bridge speaks. Every call is bound to its sender's frame. */
export function installIpc(runtime: UiRuntime, hooks: IpcHooks, log: (line: string) => void, stats?: IpcStats): () => void {
  /** What the shell last said of each window's place, for the plugin frames that read it (`shell.state`). */
  const shellWindows = new Map<number, { state: ShellState; apps: ShellApp[] }>();
  /** Which essential handles a shown bot's own frames offer (`shell.provide`), by window and frame; only while a bot of the plugin shows its tab. */
  const shellProvides = new Map<number, Map<string, Set<string>>>();
  const sayProvides = (windowId: number): void => {
    const state = shellWindows.get(windowId)?.state;
    const mine = shellProvides.get(windowId);
    if (mine !== undefined) for (const key of [...mine.keys()]) if (!ownsShownBot(key.split(":")[0]!, state)) mine.delete(key);
    const all = [...(mine?.values() ?? [])];
    runtime.shellMessage(windowId, { type: "shell-provides", sidebar: all.some((p) => p.has("sidebar")), drag: all.some((p) => p.has("drag")) });
  };
  runtime.send = (frame, message: LayerMessage) => {
    const f = webFrameMain.fromId(frame.processId, frame.routingId);
    if (f === undefined || f === null || f.detached) return;
    stats?.sent(message.type);
    f.send("clover:message", message);
  };
  const handle = (channel: string, fn: (event: IpcMainInvokeEvent, arg: Record<string, unknown>) => unknown) =>
    ipcMain.handle(channel, (event, arg) => {
      stats?.received(channel);
      return fn(event, (arg ?? {}) as Record<string, unknown>);
    });
  const on = (channel: string, fn: (event: IpcMainEvent, arg: Record<string, unknown>) => void) =>
    ipcMain.on(channel, (event, arg) => {
      stats?.received(channel);
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
    const hints = typeof a.hints === "object" && a.hints !== null ? (a.hints as { session?: unknown; entry?: unknown; bot?: unknown }) : {};
    return runtime.resolve(s.frame, mount, spot, str(a.key), { ...(str(hints.session, 32) ? { session: str(hints.session, 32)! } : {}), ...(str(hints.entry, 300) ? { entry: str(hints.entry, 300)! } : {}), ...(str(hints.bot, 81) ? { bot: str(hints.bot, 81)! } : {}) });
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
  // An `avatar` child frame's speech, from the document that placed it: numbers only, or dropped.
  on("clover:speech", (event, a) => {
    const child = str(a.child, 32);
    const message = cleanSpeechMessage(a.message);
    if (child === undefined || message === undefined) return;
    runtime.speech(sender(event).frame, child, message);
  });
  // An `avatar` child frame's cue, from the document that placed it; and its state, to its parent only: plain data, or dropped.
  on("clover:avatar", (event, a) => {
    const child = str(a.child, 32);
    const message = cleanAvatarDown(a.message);
    if (child === undefined || message === undefined) return;
    runtime.avatarDown(sender(event).frame, child, message);
  });
  on("clover:avatar-up", (event, a) => {
    const message = cleanAvatarUp(a.message);
    if (message === undefined) return;
    runtime.avatarUp(sender(event).frame, message);
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
  // The Plugins page's picked folders, as one-use tokens (tree-calls.ts): their paths stay in main.
  const pickTokens = new PickTokens();
  handle("clover:api", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    const method = str(a.method, 128);
    if (mount === undefined || method === undefined) throw new LayerError("bad request");
    const pluginId = runtime.partOf(s.frame, mount);
    // The pickers are main's own: a plugin that holds `files`, the user's own click, main's dialog; the page gets tokens.
    if (PICK_METHODS.has(method)) {
      if (pluginId === "core" || hooks.pickFiles === undefined || hooks.registerGrant === undefined || hooks.grants === undefined) throw new LayerError("this part can't ask for a file");
      return routePick({
        method,
        params: a.params,
        plugin: { id: pluginId, capabilities: runtime.capabilitiesOf(s.frame, mount) },
        windowId: s.windowId,
        takeGesture: (w) => frameGesture(a.active, () => hooks.takeGesture(w)),
        dialog: hooks.pickFiles,
        grants: hooks.grants,
        register: hooks.registerGrant,
        log,
        refuse: (why) => new LayerError(why),
      });
    }
    return routeCall({
      tree: runtime.treePart(s.frame, mount),
      method,
      params: a.params,
      tokens: pickTokens,
      ...(hooks.pick ? { pick: (w: number, kind: "folder" | "file", filters: readonly { name: string; extensions: string[] }[] | undefined, use: PickUse) => hooks.pick!(w, kind, filters, use) } : {}),
      ...(hooks.openKey ? { openKey: (target: KeyTarget) => hooks.openKey!(target) } : {}),
      // The key press or click must have come to THIS frame (its own transient activation, read in the preload) and be
      // one the main process saw come to the window; a refused call spends nobody's gesture.
      takeGesture: (w) => frameGesture(a.active, () => hooks.takeGesture(w)),
      request: hooks.treeRequest,
      entries: (spot) => runtime.entries(s.frame, mount, spot),
      layer: () => hooks.api(pluginId, method, a.params),
      log,
      refuse: (why) => new LayerError(why),
    });
  });
  // A file dropped on a plugin's page (the preload read the real paths of a trusted drop): tokens like a pick's, for a plugin
  // that holds `files`, sent back to that frame's page as `files-dropped`.
  on("clover:drop-files", (event, a) => {
    const s = sender(event);
    const who = runtime.documentPlugin(s.frame);
    if (hooks.registerGrant === undefined || hooks.grants === undefined) return;
    void routeDrop({
      paths: a.paths,
      plugin: who === undefined ? undefined : { id: who.pluginId, capabilities: who.capabilities },
      grants: hooks.grants,
      register: hooks.registerGrant,
      log,
    }).then((out) => {
      if (out !== undefined) runtime.send(s.frame, { type: "files-dropped", grants: out.grants, ...(out.refused !== undefined ? { refused: out.refused } : {}) });
    }, () => undefined);
  });
  // `PluginApi.shell` (spec §5.4: `shell.read`, `shell.control`): every rule is in shell-calls.ts.
  handle("clover:shell", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    if (mount === undefined) throw new LayerError("bad request");
    const plugin = { id: runtime.partOf(s.frame, mount), capabilities: runtime.capabilitiesOf(s.frame, mount) };
    if (plugin.id.split("/")[0] === "clover") throw new LayerError("the shell's own parts do not ask");
    let r;
    try {
      r = routeShell({ method: a.method, args: a.args, plugin, window: shellWindows.get(s.windowId), appButtons: () => runtime.appButtons(), takeGesture: () => frameGesture(a.active, () => hooks.takeGesture(s.windowId)) });
    } catch (err) {
      throw new LayerError(err instanceof Error ? err.message : "refused");
    }
    if (r.kind === "answer") return Promise.resolve(r.value);
    if (r.kind === "provide") {
      const key = `${plugin.id}:${s.frame.processId}:${s.frame.routingId}`;
      const mine = shellProvides.get(s.windowId) ?? new Map<string, Set<string>>();
      if (r.parts.length === 0) mine.delete(key); else mine.set(key, new Set(r.parts));
      shellProvides.set(s.windowId, mine);
      sayProvides(s.windowId);
      return Promise.resolve();
    }
    if (r.kind === "drag") {
      hooks.windowDrag(s.windowId, true);
      return Promise.resolve();
    }
    runtime.shellMessage(s.windowId, { type: "shell-act", act: r.act });
    return Promise.resolve();
  });
  on("clover:shell-report", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    if (mount === undefined) return;
    // Only the app's own shell says where the window is.
    if (runtime.partOf(s.frame, mount).split("/")[0] !== "clover") return;
    const report = cleanReport(a.report);
    if (report === undefined) return;
    const before = JSON.stringify(shellWindows.get(s.windowId)?.state);
    shellWindows.set(s.windowId, report);
    sayProvides(s.windowId);
    if (JSON.stringify(report.state) !== before) runtime.windowPluginMessage(s.windowId, (p) => hearsShell(p, report.state), { type: "shell-state", state: report.state });
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
  handle("clover:composer", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    if (mount === undefined) throw new LayerError("bad request");
    const pluginId = runtime.partOf(s.frame, mount);
    return routeComposer({
      composer: runtime.composerOf(s.frame, mount),
      op: a.op,
      args: a.args,
      takeGesture: (w) => frameGesture(a.active, () => hooks.takeGesture(w)),
      asApp: hooks.treeRequest,
      asLayer: (id, method, params) => hooks.api(id || pluginId, method, params),
      log,
      refuse: (why) => new LayerError(why),
    });
  });
  handle("clover:user-send", (event, a) => {
    try {
    const s = sender(event);
    const mount = str(a.mount, 32);
    if (mount === undefined) throw new LayerError("bad request");
    const { windowId, only } = runtime.userSender(s.frame, mount);
    // A composer's words go to its own session and nowhere else.
    if (only !== undefined && !(typeof a.to === "object" && a.to !== null && Object.keys(a.to).length === 1 && (a.to as { session?: unknown }).session === only.session)) throw new LayerError("a composer sends to its own session");
    const m = (a.message ?? {}) as { text?: unknown; images?: unknown };
    if (typeof m.text !== "string" || m.text.length > 1_000_000) throw new LayerError("the words are text");
    return hooks.userSend(windowId, a.to, { text: m.text, ...(m.images !== undefined ? { images: m.images } : {}) }, a.active === true);
    } catch (err) {
      // Refused before the core's own checks (the part, the target, the words): the reason, never the words.
      if (err instanceof LayerError) log(`send: refused (${err.message})`);
      throw err;
    }
  });
  on("clover:window-drag", (event, a) => {
    const s = sender(event);
    const mount = str(a.mount, 32);
    if (mount === undefined) return;
    // The mount's own record decides (window-drag.ts); a layer's drag message from any other part is refused.
    const shell = runtime.mainShell(s.frame, mount);
    hooks.windowDrag(shell?.windowId ?? s.windowId, shell !== undefined);
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
    const look = typeof a.look === "string" && a.look.length <= 8 ? a.look : undefined;
    // The part's own `card.*` style values: names of the card's own family, plain values, a handful (the page keeps only
    // what its own grammar accepts).
    const given: Record<string, string> = {};
    if (a.tokens !== null && typeof a.tokens === "object") {
      for (const [name, value] of Object.entries(a.tokens as Record<string, unknown>).slice(0, 40)) {
        if (/^card\.[a-z0-9.]{1,60}$/.test(name) && typeof value === "string" && value.length <= 300) given[name] = value;
      }
    }
    return runtime.sealedFrameOf(s.frame, mount, cardId, element, look, given);
  });

  // The sealed frames' answer: the sender is the sealed page itself (its own scheme), and the sender's key is what the
  // mint bound (a part's channel, its document's own frame; the fallback's `own`, its window's main frame). The app
  // signs it out of doors and takes the core's answer, with the gate first (B3, B4).
  handle("clover:sealed-answer", (event, a) => {
    try {
      const f = event.senderFrame;
      if (f === null || f.detached || !f.url.startsWith("clover-sealed://")) throw new LayerError("not a sealed frame");
      const token = str(a.token, 128);
      const option = str(a.option, 64);
      const ch = Array.isArray(a.children) && a.children.every((c: unknown) => typeof c === "string") ? a.children as readonly string[] : undefined;
      if (token === undefined) throw new LayerError("bad sealed answer");
      // The token in the message must be the one in the sender's own URL (B4): a frame holding another frame's token
      // can't answer with it, and a plugin can't guess a fallback's `own` token and answer from its own page.
      const urlToken = new URL(f.url).searchParams.get("token");
      if (urlToken === null || urlToken !== token) throw new LayerError("bad sealed answer");
      // The sender's own key, the binding the mint held: the page's own parent (a part's channel) or its own main frame
      // (the fallback's `own`).
      const key = f.parent !== null && !f.parent.detached
        ? `p:${f.parent.processId}:${f.parent.routingId}`
        : `m:${f.processId}:${f.routingId}`;
      return hooks.sealedAnswer(token, option, key, ch);
    } catch (err) {
      if (err instanceof LayerError) log(`sealed: answer refused at handler (${err.message})`);
      throw err;
    }
  });
  // A sealed frame's page reports its own visibility (IOv2), so the main process can disarm the fallback once all of
  // a card's buttons show (§5.5's fallback rule). Checked like the answer: the sender must be the sealed frame its
  // token was served to, on the channel the mint bound (a part's document frame, the fallback's main frame).
  on("clover:sealed-visible", (event, a) => {
    const f = event.senderFrame;
    if (f === null || f.detached || !f.url.startsWith("clover-sealed://")) throw new LayerError("not a sealed frame");
    const token = str(a.token, 128);
    const visible = typeof a.visible === "boolean" ? a.visible : undefined;
    if (token === undefined || visible === undefined) throw new LayerError("bad sealed visibility");
    const urlToken = new URL(f.url).searchParams.get("token");
    if (urlToken === null || urlToken !== token) throw new LayerError("bad sealed visibility");
    const key = f.parent !== null && !f.parent.detached
      ? `p:${f.parent.processId}:${f.parent.routingId}`
      : `m:${f.processId}:${f.routingId}`;
    const bound = runtime.boundOf(token);
    if (bound === undefined || bound !== key) throw new LayerError("bad sealed visibility");
    return hooks.sealedVisible(token, visible);
  });
  // The app's own card page says how tall it is (a number): only its own window's main frame, on its own token, which the
  // mint bound to that frame, so a plugin's sealed frame can't size a card window.
  on("clover:sealed-size", (event, a) => {
    const f = event.senderFrame;
    if (f === null || f.detached || f.parent !== null || !f.url.startsWith("clover-sealed://")) return;
    const token = str(a.token, 128);
    const height = typeof a.height === "number" && Number.isFinite(a.height) ? Math.min(4000, Math.max(0, Math.round(a.height))) : undefined;
    if (token === undefined || height === undefined) return;
    const urlToken = new URL(f.url).searchParams.get("token");
    if (urlToken === null || urlToken !== token) return;
    if (runtime.boundOf(token) !== `m:${f.processId}:${f.routingId}`) return;
    hooks.sealedSize(token, height);
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
    for (const c of ["clover:describe", "clover:resolve", "clover:reload", "clover:wake", "clover:menu", "clover:drag-offer", "clover:drag-claim", "clover:surface-environment", "clover:open", "clover:root-call", "clover:entries", "clover:user-send", "clover:composer", "clover:api", "clover:terminal-input", "clover:shell", "clover:sealed-frame", "clover:sealed-answer", "clover:sealed-visible"]) ipcMain.removeHandler(c);
    for (const c of ["clover:props", "clover:callback", "clover:size", "clover:release", "clover:sleep", "clover:surface", "clover:rect-reply", "clover:frame-metrics", "clover:root-command", "clover:view-frame", "clover:web-frame", "clover:active-session", "clover:window-drag", "clover:shell-report", "clover:sealed-size"]) ipcMain.removeAllListeners(c);
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
