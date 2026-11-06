// What becomes of a window a bot's page opens (spec §12.1; S7 §7.2, round fourteen; Electron #55565). On stock
// Electron (the owner's decision 94) an offscreen page's same-site child is never sized or painted, while a
// cross-site child moves to a renderer of its own and works offscreen. So:
// * cross-site: the child stays offscreen and becomes a tab of the same owner, opener kept (most sign-in windows);
// * same-site, while the person watches the tab: a real window, which they use;
// * same-site, while a bot is alone: refused, and its address opened as a new tab of the same owner, without its
//   opener.

/** A site, as Chromium's process model groups pages, close enough for the choice above: the scheme and the last two
 *  labels of the host (an IP address or a one-label host is its own site). A wrong guess costs a popup its opener or
 *  its paint, never a window the person didn't expect; the host checks a cross-site child really paints. */
export function siteOf(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const host = u.hostname.toLowerCase();
  if (/^[0-9.]+$/.test(host) || host.includes(":") || !host.includes(".")) return `${u.protocol}//${host}`;
  return `${u.protocol}//${host.split(".").slice(-2).join(".")}`;
}

export type PopupChoice = "offscreen-tab" | "real-window" | "new-tab";

export function choosePopup(openerUrl: string, popupUrl: string, watched: boolean): PopupChoice {
  const a = siteOf(openerUrl);
  const b = siteOf(popupUrl);
  const crossSite = a !== undefined && b !== undefined && a !== b;
  if (crossSite) return "offscreen-tab";
  return watched ? "real-window" : "new-tab";
}
