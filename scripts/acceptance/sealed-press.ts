// The pieces of a real sealed press the run decides on its own words (run.ts `pressApprove`): when a sealed page says it will
// take a press, and when the page's own answer to a press means "press again". Pure and with injected time, so each is tested.
// Nothing here takes a press without the page's own reading: the press still needs the page's `data-ready` and its fresh report
// (apps/desktop/src/main/sealed-pages.ts), and the app and the core still judge the answer.

/** What a sealed page's `body[data-ready]` read as: "yes" (it takes a press), "no" (visible or opened too lately), "none" (the page
 *  has not marked yet, or is an older build that never does), or undefined (the read failed: the frame was between documents). */
export type ReadyRead = string | undefined;

/** The page's ready mark waited for. "yes": it says it takes a press. "none": it said nothing for `noneForMs` running (an older
 *  build; the caller gives it a fixed wait). "never": not within `timeoutMs`, or the page could not be read for `goneForMs` running
 *  (its frame went away: the caller finds the card's page again).
 *
 *  A page that is only just loaded reads "none" until its own first mark (a tick every 100 ms) and a read that fails mid-load reads
 *  nothing: neither is a page that is ready. Run 44815142351/44816507198 took both for "ready", pressed 1.5 s after finding the page
 *  (at 250 to 430 ms after it first showed, its own gate wants 500 ms), got "settling", and the press was lost for good. */
export async function waitSealedReady(
  read: () => Promise<ReadyRead>,
  o: { timeoutMs: number; noneForMs: number; goneForMs?: number; everyMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<"yes" | "none" | "never"> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = now() + o.timeoutMs;
  let noneSince: number | undefined;
  let goneSince: number | undefined;
  for (;;) {
    const v = await read();
    if (v === "yes") return "yes";
    if (v === undefined) {
      goneSince ??= now();
      if (now() - goneSince >= (o.goneForMs ?? 5_000)) return "never";
    } else goneSince = undefined;
    if (v === "none") {
      noneSince ??= now();
      if (now() - noneSince >= o.noneForMs) return "none";
    } else noneSince = undefined;
    if (now() >= end) return "never";
    await sleep(o.everyMs ?? 100);
  }
}

/** The words a sealed page says to a press that came before it was ready (apps/desktop/src/main/sealed-pages.ts `SEALED_PRESS_WORDS`):
 *  the page was not showing yet, was opened under 400 ms ago, had shown for under 500 ms, or its fresh reading did not come in time.
 *  The page tells the person to press again; so does the run, at once. "covered" is never here (a press on a covered button is not
 *  made again: the run fails on one), and neither is "answering". */
const PRESS_AGAIN = /sealed: press on \S+ \S+ in [^\n]*: (?:not-visible|opening|settling|no-pointer|late)$/m;

/** Whether the app's log (the text written since a click) says the page turned the press down as too early. */
export function pressTurnedDownAsEarly(logSinceClick: string): boolean {
  return PRESS_AGAIN.test(logSinceClick);
}
