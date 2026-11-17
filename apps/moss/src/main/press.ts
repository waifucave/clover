// MOSS's press path for the sealed cards it draws (spec §5.5 "Only sealed buttons answer", E7; §3.4 "Two programs show
// parts"; §3.5 ruling A). MOSS's main process holds its OWN press record, trusted pointer-down report, fresh visibility
// reading and stacking rule, as MOSS Code's main process does for its own cards; no press is forwarded from or to another
// program, and the answer is signed with MOSS's own answer key (answer-key.ts) as the `moss` program.
//
// A press on a sealed button counts only when every one of these holds, checked in this order, each refusal said in the
// log by its reason alone (never a field's text):
//   1. The sender is the sealed frame its token was served to (the `moss-sealed://` page, the token in its own URL, on the
//      binding the mint made: MOSS's window's own page frame), and never a render window's (index.ts's IPC handler).
//   2. The fresh visibility reading: the report the press itself asked for (a new IntersectionObserver v2 made at the
//      press) says the button showed whole, uncovered and at 24 by 24 px or more (sealed.ts `takeFresh`).
//   3. The press record: MOSS's main process saw the press come to its window (`before-mouse-event`'s mouse down, or
//      `before-input-event`'s key down with that frame focused) within `PRESS_MS`, and, for a click, the sealed frame's
//      own document reported a trusted pointerdown (`isTrusted`, the preload's report, which a page script can't make)
//      for that same press. One press answers once: taking it spends it.
//   4. The stacking rule: the router places the card in THIS window (`pressMatchesPlacement`, from `card_placed` and
//      `card.placement` alone: MOSS keeps no placement of its own), and the window is visible, focused and not
//      minimised. MOSS draws nothing of its own over a pending card, so anything over the button is another window, and
//      that the fresh reading (2) already refuses.
//   5. No computer use is acting on this computer (`computer.acting`, fail closed: no answer, no press).
//   6. MOSS's answer key is registered with the engine for this device (a press waits a moment for it).
// Then the store signs (`programCardAnswerSigningInput`, program `moss`) and the engine's `card.answer` decides.
//
// §5.5 also names a hardware check (an event no other process posted: `eventSourceUnixProcessID`, `LLMHF_INJECTED`,
// XTEST). Neither app has it yet; it is not built here either (the report says so).
import { pressMatchesPlacement, type CardPlacement } from "@waifucave/moss-protocol";
import type { SealedFrames, AnswerSigner } from "./sealed";
import type { KeyState } from "./answer-key";

/** How long after the press main saw the answer it carries may still be taken (the page asks for its fresh reading
 *  first, up to 400 ms, then answers). */
export const PRESS_MS = 1_500;
/** How long after main's mouse down the frame's own trusted pointerdown report may come. */
export const REPORT_MS = 1_000;

interface Down {
  at: number;
  /** The frame whose own document reported a trusted pointerdown for this press. */
  frame?: string;
  spent?: boolean;
}

/** MOSS's press record: what its main process saw come to its window, and which frame's document took the press. */
export class PressRecord {
  private readonly downs = new Map<number, Down>();
  private readonly keys = new Map<number, Down>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A mouse down main saw in a window (`before-mouse-event`). */
  mouseDown(windowId: number): void {
    this.downs.set(windowId, { at: this.now() });
  }

  /** A frame's document reported a trusted pointerdown (the preload's `moss:press-seen`, bound to the sender frame): it
   *  names where main's latest mouse down landed, if it is recent and not yet claimed. First report wins. */
  frameSaw(windowId: number, frame: string): void {
    const d = this.downs.get(windowId);
    if (d === undefined || d.frame !== undefined || this.now() - d.at > REPORT_MS) return;
    d.frame = frame;
  }

  /** A key down main saw in a window, with the frame that had the focus (`before-input-event`; repeats are no press). */
  keyDown(windowId: number, focusedFrame: string | undefined): void {
    if (focusedFrame === undefined) return;
    this.keys.set(windowId, { at: this.now(), frame: focusedFrame });
  }

  /** Takes the press for an answer from `frame`: a recent click whose own trusted pointerdown landed in that frame, or a
   *  recent key down while that frame had the focus. Spent once taken. */
  take(windowId: number, frame: string): "click" | "key" | undefined {
    const now = this.now();
    const d = this.downs.get(windowId);
    if (d !== undefined && !d.spent && d.frame === frame && now - d.at <= PRESS_MS) {
      d.spent = true;
      return "click";
    }
    const k = this.keys.get(windowId);
    if (k !== undefined && !k.spent && k.frame === frame && now - k.at <= PRESS_MS) {
      k.spent = true;
      return "key";
    }
    return undefined;
  }

  forget(windowId: number): void {
    this.downs.delete(windowId);
    this.keys.delete(windowId);
  }
}

export interface WindowStanding {
  /** MOSS's window id in presence and placements (`main`). */
  window: string;
  visible: boolean;
  focused: boolean;
  minimized: boolean;
}

/** The stacking rule (4): the router's place for the card is this window, and the window is in front of the person. */
export function stackingRule(placement: CardPlacement | undefined, w: WindowStanding): string | undefined {
  if (placement === undefined) return "the router hasn't placed this card";
  if (!pressMatchesPlacement(placement, { kind: "window", program: "moss", window: w.window })) return `the card is placed ${placement.kind === "island" ? "on the island" : placement.kind === "elsewhere" ? "elsewhere" : "in another window"}`;
  if (!w.visible || w.minimized) return "MOSS's window isn't showing";
  if (!w.focused) return "MOSS's window isn't in front";
  return undefined;
}

export interface PressDeps {
  sealed: SealedFrames;
  record: PressRecord;
  placementOf: (cardId: string) => CardPlacement | undefined;
  standing: (windowId: number) => WindowStanding | undefined;
  /** `computer.acting` on the engine: undefined when it couldn't be asked. */
  acting: () => Promise<boolean | undefined>;
  keyReady: (ms: number) => Promise<KeyState>;
  signer: AnswerSigner;
  device: () => string | undefined;
  answer: (a: { id: string; hash: string; option: string; proof: unknown; children?: readonly string[] }) => Promise<{ accepted: boolean; reason?: string }>;
  log: (line: string) => void;
}

export type PressResult = { accepted: true } | { accepted: false; reason: string };

/** One press's answer, from the sealed frame's own channel (checks 2 to 6; check 1 is the IPC handler's). */
export async function answerPress(d: PressDeps, a: { token: string; option: string | undefined; senderKey: string; frame: string; windowId: number; children?: readonly string[] }): Promise<PressResult> {
  const refuse = (why: string, say = why): PressResult => {
    d.log(`sealed: answer refused (${why})`);
    return { accepted: false, reason: say };
  };
  const cardId = d.sealed.cardOf(a.token);
  if (cardId === undefined) return refuse("no such sealed button");
  // 2. The fresh reading, spent first so a refused answer spends it.
  const fresh = d.sealed.takeFresh(a.token);
  if (fresh !== "ok") return refuse(fresh === "covered" ? "the button was covered or not shown at the press" : "no visibility reading came with the press", fresh === "covered" ? "the button wasn't fully showing when it was pressed" : "the press wasn't checked just now");
  // 3. The press record.
  const how = d.record.take(a.windowId, a.frame);
  if (how === undefined) return refuse("MOSS saw no press of its own land in this button", "the press didn't come to this button");
  // 4. The stacking rule.
  const w = d.standing(a.windowId);
  const stacked = w === undefined ? "not MOSS's window" : stackingRule(d.placementOf(cardId), w);
  if (stacked !== undefined) return refuse(stacked);
  // 5. Computer use, fail closed.
  const acting = await d.acting();
  if (acting === undefined) return refuse("the computer-use check couldn't run");
  if (acting) return refuse("computer use is acting right now");
  // 6. The key.
  const key = await d.keyReady(2_000);
  if (key.kind !== "registered") return refuse(`MOSS's answer key isn't registered (${key.kind === "refused" || key.kind === "waiting" ? key.why : key.kind})`, "this computer's answer key for MOSS isn't registered yet");
  const device = d.device();
  if (device === undefined) return refuse("no device");
  const option = a.option ?? d.sealed.optionOf(a.token);
  if (option === undefined) return refuse("no option named");
  const out = d.sealed.buildAnswer(a.token, option, a.children, a.senderKey, d.signer, device);
  if ("error" in out) return refuse(out.error);
  const r = await d.answer({ id: out.card.id, hash: out.card.hash, option, proof: out.proof, ...(out.kids !== undefined ? { children: out.kids } : {}) })
    .catch((err: unknown) => ({ accepted: false, reason: err instanceof Error ? err.message.slice(0, 200) : "refused" }));
  if (r.accepted !== true) {
    d.sealed.confirmedAnswer(out.card.id, false);
    return refuse(`the engine refused the answer (${typeof r.reason === "string" ? r.reason.slice(0, 120) : "no reason"})`, typeof r.reason === "string" ? r.reason.slice(0, 200) : "refused");
  }
  d.sealed.confirmedAnswer(out.card.id, true);
  d.log(`sealed: answer accepted for ${out.card.id} (${how})`);
  return { accepted: true };
}
