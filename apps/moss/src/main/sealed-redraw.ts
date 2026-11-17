// A sealed button's frame that stays stuck under load (lane SV's finding, ported from MOSS Code's
// apps/desktop/src/main/index.ts `watchSealedDraw` / `redrawSealed`): Chromium sometimes never sends a loaded button page
// the IntersectionObserver v2 change that says it shows, so the page keeps the "no room" reading of the 0x0 frame it
// started in, and its button never becomes pressable. Resizing or moving the frame doesn't send it again; a change of the
// frame element's own visibility does. So a loaded button page that has not said "visible" by each mark below gets that
// change: its frame is hidden for 200 ms and shown again (the element's own inline visibility put back).
//
// Only a page that has never said "visible" since it loaded: one that did is current, and a later "not visible" is its own
// reading (a cover, a scroll), where hiding its frame could take a press away. It only makes the page's reading current:
// a covered, see-through, clipped or scrolled-away button still reads as not showing, and a press still needs its own fresh
// reading. Twice at most per load. The call into the embedding document carries no user gesture.

export const SEALED_REDRAW_AT_MS: readonly number[] = [700, 2000];
export const SEALED_REDRAW_HIDDEN_MS = 200;

/** The part of a frame the watcher uses (Electron's WebFrameMain). */
export interface RedrawFrame {
  readonly url: string;
  readonly detached: boolean;
  readonly parent: RedrawFrame | null;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

export interface RedrawDeps {
  /** The frame by its ids now (Electron's `webFrameMain.fromId`), or undefined when it is gone. */
  frameOf(processId: number, routingId: number): RedrawFrame | undefined;
  sealed: {
    elementOf(token: string): string | undefined;
    cardOf(token: string): string | undefined;
    isPending(cardId: string): boolean;
    isTokenVisible(token: string): boolean;
  };
  /** Tokens whose page said "visible" at least once since it loaded (capped by the caller). */
  everSeen: ReadonlySet<string>;
  /** Whether the frame still sits in a window that draws (MOSS's window, not destroyed). */
  inWindow(frame: RedrawFrame): boolean;
  log(line: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
}

/** The token of a sealed card frame's address, or null. */
function tokenOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "moss-sealed:" && u.host === "card" ? u.searchParams.get("token") : null;
  } catch {
    return null;
  }
}

/** A frame finished loading (`did-frame-finish-load`, not the main frame): a sealed button's page is watched. */
export function watchSealedDraw(d: RedrawDeps, processId: number, routingId: number): void {
  const f = d.frameOf(processId, routingId);
  if (f === undefined || f.parent === null) return;
  const token = tokenOf(f.url);
  if (token === null || d.sealed.elementOf(token)?.startsWith("button:") !== true) return;
  const url = f.url;
  for (const at of SEALED_REDRAW_AT_MS) d.setTimeout(() => void redrawSealed(d, processId, routingId, url, token, at), at);
}

export async function redrawSealed(d: RedrawDeps, processId: number, routingId: number, url: string, token: string, at: number): Promise<boolean> {
  const f = d.frameOf(processId, routingId);
  if (f === undefined || f.detached || f.url !== url || f.parent === null || f.parent.detached) return false;
  // A page that said "visible" once reads itself: it is current, and what hides it now (a cover, a scroll) is its reading's to say.
  if (d.everSeen.has(token) || d.sealed.isTokenVisible(token)) return false;
  const cardId = d.sealed.cardOf(token);
  if (cardId === undefined || !d.sealed.isPending(cardId)) return false;
  if (!d.inWindow(f)) return false;
  const js = `(() => { const f = [...document.querySelectorAll("iframe")].find((x) => x.src === ${JSON.stringify(url)}); if (!f) return false; const was = f.style.visibility; f.style.visibility = "hidden"; setTimeout(() => { f.style.visibility = was; }, ${SEALED_REDRAW_HIDDEN_MS}); return true; })()`;
  const done = await Promise.race([f.parent.executeJavaScript(js, false).catch(() => false), new Promise<false>((r) => setTimeout(() => r(false), 500))]);
  d.log(`sealed: ${cardId} ${d.sealed.elementOf(token) ?? "?"} in MOSS's window said nothing visible ${at} ms after it loaded: its frame ${done === true ? "was hidden and shown again so its page reads itself again" : "wasn't found in its embedder"}`);
  return done === true;
}
