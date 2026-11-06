// The Clover Browser's own policy (spec §12.1). Its webContents are its own: lane E's main process guards only the
// app's windows, and asks `isBrowserContents` to tell them apart, so neither side touches the other's.
//
// Every browser partition's session is locked down, and its traffic pointed at the network filter (`network.ts`, R13),
// before its first tab is made: the predicate already holds when `web-contents-created` fires, and no page loads
// before its proxy is set (review S3: `prepareTabSession` is the one place that sets it, and a tab is only made after
// it has resolved). This is where the URL rule is enforced for every load however it starts (a page's link or
// redirect, a frame, a DevTools `Page.navigate`), never by reading DevTools parameters (lane B's review S17). Every page
// of the browser's, a tab or a window a page opened, gets `guardPage`.
import { session as sessions, type Session, type WebContents } from "electron";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBrowserUrlAllowed } from "./contract";

/** WebRTC never sends UDP outside a proxy, as in the app's own windows (lane E, S9 and the E-M0 review's B3): no
 *  local address reaches a page, and no page probes the local network over UDP. Tabs get no camera or microphone
 *  anyway; a site that needs a peer-to-peer data channel falls back to a relay over TCP, or doesn't connect. */
export const BROWSER_WEBRTC_POLICY = "disable_non_proxied_udp" as const;

/** The viewport pages' partition: in memory, with no network at all. */
export const VIEWPORT_PARTITION = "clover-browser-viewport";

/** Where the spellchecker would fetch a dictionary: loopback's discard port, so nothing is ever downloaded (E's netlogs
 *  found the dictionary fetched on Linux with the spellchecker off). */
const NO_DICTIONARY_URL = "http://127.0.0.1:9/";

const tabSessions = new WeakSet<Session>();
/** Each tab session's proxy: the rules it was set to, and whether that has finished. */
const proxies = new WeakMap<Session, { rules: string; ready: Promise<void>; done: boolean }>();
const viewportFiles = new Set<string>();
let viewportSession: Session | undefined;

/** Locks down a tab session: the same set of rules every time, whichever tab or window of the browser's uses it. */
export function hardenSession(session: Session): void {
  if (tabSessions.has(session)) return;
  tabSessions.add(session);
  // A bot's page raises nothing the person would see: no permission is ever granted (camera, notifications,
  // geolocation, clipboard reads, …). The person's own sign-ins still work: cookies and storage aren't permissions.
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  // Every request, the main frame's and every subresource's: refused schemes never load.
  // (A `file:` load from a web page never reaches the network service, and Chromium refuses it anyway; each page also
  // refuses navigations itself, `guardPage`.)
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isBrowserUrlAllowed(details.url) }));
  // Downloads have nowhere to go yet (a bot's scratch folder comes with lane C's fenced set): refused.
  session.on("will-download", (event) => event.preventDefault());
  noSpellchecker(session);
}

/** No spellchecker, no languages and no place to download a dictionary from (S9: no request filter sees that
 *  download). The default session's is lane E's. */
function noSpellchecker(session: Session): void {
  session.setSpellCheckerEnabled(false);
  try {
    // Both are no-ops on macOS, which uses the system's spellchecker.
    session.setSpellCheckerLanguages([]);
    session.setSpellCheckerDictionaryDownloadURL(NO_DICTIONARY_URL);
  } catch {
    // Not on this platform.
  }
}

/** A browser partition's session, locked down, with all its traffic going through `proxy` (the network filter's
 *  listener for its owner, `127.0.0.1:<port>`), before a tab is made in it. Loopback goes through it too
 *  (`<-loopback>`: Chromium otherwise sends loopback direct). A proxy that can't be set fails the open: nothing loads
 *  with an unknown network path. The proxy is a fixed one, so neither the system's settings nor WPAD are consulted. */
export async function prepareTabSession(partition: string, proxy: string): Promise<Session> {
  const session = sessions.fromPartition(partition);
  hardenSession(session);
  let current = proxies.get(session);
  if (current === undefined || current.rules !== proxy) {
    const entry = { rules: proxy, done: false, ready: Promise.resolve() };
    entry.ready = (async () => {
      await session.setProxy({ mode: "fixed_servers", proxyRules: proxy, proxyBypassRules: "<-loopback>" });
      // Connections made before (another filter's) go: every new one takes the path just set.
      await session.closeAllConnections();
      entry.done = true;
    })();
    entry.ready.catch(() => { if (proxies.get(session) === entry) proxies.delete(session); });
    proxies.set(session, entry);
    current = entry;
  }
  await current.ready;
  return session;
}

/** The session's proxy is set: a page made in it now (a window a page opens) takes the filter's path. */
export function isSessionReady(session: Session): boolean {
  return proxies.get(session)?.done === true;
}

/** The viewport pages' session: no permission, no spellchecker, no download, and no request but the viewport page's
 *  own file. Locked down before the first viewport is made. */
export function prepareViewportSession(html: string): Session {
  viewportFiles.add(resolve(html));
  if (viewportSession !== undefined) return viewportSession;
  const session = sessions.fromPartition(VIEWPORT_PARTITION);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isViewportFile(details.url) }));
  session.on("will-download", (event) => event.preventDefault());
  noSpellchecker(session);
  void session.setProxy({ mode: "direct" }).catch(() => undefined);
  viewportSession = session;
  return session;
}

/** The browser host is shutting down (review M3): the viewport pages' file is no longer allowed, and a new host locks
 *  the viewport session down again with its own. */
export function resetViewportSession(): void {
  viewportFiles.clear();
  viewportSession = undefined;
}

function isViewportFile(url: string): boolean {
  if (!url.startsWith("file:")) return false;
  try {
    return viewportFiles.has(resolve(fileURLToPath(url)));
  } catch {
    return false;
  }
}

/** The guards every page of the browser's gets, a tab or a window a page opened (its popups are the opener's
 *  `setWindowOpenHandler`, item 94: `index.ts`). */
export function guardPage(contents: WebContents): void {
  const guard = (event: { preventDefault(): void }, url: string): void => { if (!isBrowserUrlAllowed(url)) event.preventDefault(); };
  contents.on("will-navigate", (e, url) => guard(e, url));
  contents.on("will-frame-navigate", (e) => guard(e, e.url));
  contents.on("will-redirect", (e, url) => guard(e, url));
  // A page's `beforeunload` never holds a tab open or asks the person anything.
  contents.on("will-prevent-unload", (e) => e.preventDefault());
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.setWebRTCIPHandlingPolicy(BROWSER_WEBRTC_POLICY);
}

function sessionOf(contents: WebContents): Session | undefined {
  try {
    return contents.isDestroyed() ? undefined : contents.session;
  } catch {
    return undefined;
  }
}

/** A web page of the Clover Browser's: a tab, or a window a page opened. True from `web-contents-created` on, since
 *  its session is locked down before it is made. */
export function isBrowserTab(contents: WebContents): boolean {
  const session = sessionOf(contents);
  return session !== undefined && tabSessions.has(session);
}

/** Anything the browser module made and guards itself: its tabs and pages' windows, and the viewport pages that
 *  draw a tab in the browser view. Lane E's window guards skip these. */
export function isBrowserContents(contents: WebContents): boolean {
  if (isBrowserTab(contents)) return true;
  const session = sessionOf(contents);
  return session !== undefined && session === viewportSession;
}
