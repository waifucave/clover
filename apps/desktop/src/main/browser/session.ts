// Each browser partition's session, locked down once, the first time a tab uses it (spec §12.1). This is where the
// URL rule is enforced for every load however it starts (a page's link or redirect, a frame, a DevTools
// `Page.navigate`), never by reading DevTools parameters (lane B's review S17).
import type { Session } from "electron";
import { isBrowserUrlAllowed } from "./contract";

const hardened = new WeakSet<Session>();

export function hardenSession(session: Session): void {
  if (hardened.has(session)) return;
  hardened.add(session);
  // A bot's page raises nothing the person would see: no permission is ever granted (camera, notifications,
  // geolocation, clipboard reads, …). The person's own sign-ins still work: cookies and storage aren't permissions.
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  // Every request, the main frame's and every subresource's: refused schemes never load.
  // (A `file:` load from a web page never reaches the network service, and Chromium refuses it anyway; each tab also
  // refuses navigations itself, `tab.ts`.)
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isBrowserUrlAllowed(details.url) }));
  // Downloads have nowhere to go yet (a bot's scratch folder comes with lane C's fenced set): refused.
  session.on("will-download", (event) => event.preventDefault());
  session.setSpellCheckerEnabled(false);
}
