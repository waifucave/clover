// A bot's tab, kept (the owner's report on try 14d: coming back to Alpha's tab from an app's page drew the stock
// layout and an empty conversation for a moment, then her room). Leaving her tab used to unmount it: every part of
// her own layer's (her room, her header, her figure) was released, the core dropped their documents and her layer's
// process, and the conversation forgot its transcript; coming back built them all again while the window showed what
// was ready first. Now the last bot tab shown stays mounted while another page shows, hidden (`display: none`, inert),
// so its frames and its transcript are there the moment the user comes back. Frames far from the screen still sleep
// after their minute (the runtime's own rule), so a tab kept hidden costs no drawing.
//
// When the tab shows with something of it not drawn yet (its first showing, the window's start, a frame that slept and
// wakes, a part still resolving), it is held invisible (`visibility: hidden`: laid out, so its frames load and wake)
// until it is ready, at most `HOLD_MAX_MS`: the window's backdrop shows meanwhile, never a half-built tab.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** The longest a tab is held invisible while its parts draw. */
export const HOLD_MAX_MS = 1_200;

/** What of a tab isn't drawn yet, by the runtime's own marks: a spot still resolving (`data-clover-pending`), a frame
 *  whose document hasn't drawn (an `iframe` part with no `data-clover-drawn`), a part asleep, the shell's loading note.
 *  A tab with no part at all yet isn't ready either. Empty: ready. */
export function notDrawn(root: ParentNode): string[] {
  const out: string[] = [];
  if (root.querySelector("[data-clover-entry]") === null) out.push("no part yet");
  for (const el of root.querySelectorAll("[data-clover-pending]")) out.push(`spot ${el.getAttribute("data-clover-spot") ?? "?"} resolving`);
  for (const el of root.querySelectorAll("iframe[data-clover-entry]")) if (!el.hasAttribute("data-clover-drawn")) out.push(`${el.getAttribute("data-clover-entry")} loading`);
  for (const el of root.querySelectorAll("[data-clover-asleep]")) out.push(`${el.getAttribute("data-clover-entry")} asleep`);
  if (root.querySelector(".cl-shell-empty") !== null) out.push("loading note");
  return out;
}

export function KeptTab({ shown, children, holdMaxMs = HOLD_MAX_MS }: { shown: boolean; children: ReactNode; holdMaxMs?: number }) {
  const box = useRef<HTMLDivElement>(null);
  // Held from the moment it shows until it is ready (or the cap): checked at each frame.
  const [held, setHeld] = useState(shown);
  useLayoutEffect(() => {
    if (!shown) return setHeld(false);
    const el = box.current;
    if (el === null || typeof requestAnimationFrame !== "function") return setHeld(false);
    if (notDrawn(el).length === 0) return setHeld(false);
    setHeld(true);
    const start = performance.now();
    let frame = requestAnimationFrame(function check() {
      if (notDrawn(el).length === 0 || performance.now() - start >= holdMaxMs) return setHeld(false);
      frame = requestAnimationFrame(check);
    });
    return () => cancelAnimationFrame(frame);
  }, [shown, holdMaxMs]);
  return (
    <div
      ref={box}
      className="cl-shell-kept"
      data-shown={shown ? "" : undefined}
      data-held={shown && held ? "" : undefined}
      aria-hidden={shown ? undefined : true}
      inert={!shown}
      style={shown ? { display: "contents", visibility: held ? "hidden" : undefined } : { display: "none" }}
    >
      {children}
    </div>
  );
}
