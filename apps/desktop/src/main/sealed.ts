// The sealed frames' runtime (spec §5.5; plan §4 E M3): the store behind the per-card frames the sdk's `<Card>` places.
// The app's main process hears the cards with their sealed fields (`card_requested`, the app's role), keeps them, and
// answers each button's frame itself: one frame per sealed element, mounted under its own token — crypto-random,
// twenty bytes, bound at mint to the frame that may answer and the window it sits in — over `card.answer` with the
// desktop's `{via:"device", device, at, signature}` proof signed by the answer key (lane H's). Pure apart from the
// signer, so the tests drive it under Bun.
//
// What never happens here: a plugin reads the sealed fields (the events on the layer's role carry ids only
// (`card_pending`), a plugin's page carries no field's url, each token serves once (the store marks it served),
// and nothing signs except the answer key. A part's
// token is bound to its own document's frame (the mint holds it; the answer's sender's parent must match), the
// fallback's `own` channel to its window's main frame. The channel's lifetime covers the *serve* alone: an answer
// self-expires with a mint's own band (a reader takes their time), and the core's own `card.answer` decides the
// card's fate, not a local guess (S5, S6).
import { randomBytes } from "node:crypto";
import { cardAnswerSigningInput } from "@waifucave/clover-protocol";
import type { TokenValue } from "@waifucave/clover-plugin-sdk";

/** What the app hears of a card: the whole sealed one (`card_requested`, or `card.get`'s re-read for a resolved one a
 *  plugin still shows). The store keeps `hash` and the fields verbatim from the core; nothing else ships anywhere. */
export interface SealedCard {
  id: string;
  kind: string;
  computer: string | null;
  session?: string;
  bot?: string;
  pluginId?: string;
  origin: string;
  issuedAt: number;
  expiresAt: number | null;
  hash: string;
  fields: Readonly<Record<string, unknown>>;
  options: readonly { id: string; kind: "approve" | "deny"; label: unknown; remember?: "always" }[];
}

/** The answer's signature comes from the answer key: the app is the signer of its own frames' answers. */
export interface AnswerSigner {
  sign(message: Uint8Array): Uint8Array;
}

/** One frame's own identity, for the binding and the sender's check: a frame's `processId:routingId` key. */
export type FrameKey =
  | { parent: { processId: number; routingId: number } }
  | { main: { processId: number; routingId: number } };

/** The answer's signer, the device it signs for, and the option a sealed button answers with. */
export interface SealedFrame {
  /** The frame's own token: `se_` + 20 crypto-random bytes' hex (B4's fix, reviewed). */
  token: string;
  cardId: string;
  /** `field:<name>` for a sealed field's frame, `button:<option id>` for a button's, `own` for the app's own card's
   *  page. */
  element: string;
  /** The frame's own window (its page's own answers run there). */
  windowId?: number;
}

export type SealedOutcome = "approved" | "denied" | "expired" | "withdrawn" | "cancelled";

export type SealedValue = {
  type: "text";
  text: string;
} | {
  type: "code";
  code: string;
  language?: string;
} | {
  type: "list";
  items: readonly string[];
} | {
  type: "rows";
  rows: readonly { label: string; value: string }[];
};

/** The first seal frame's channel, and each's own binding. `parent`: the document frame that asked for the part's
 *  frame (the sender's page's parent in the frame tree must match); `main`: the fallback card's window's main frame
 *  (the sender must be it). */
interface Channel {
  cardId: string;
  element: string;
  at: number;
  windowId?: number;
  tokens?: Readonly<Record<string, TokenValue>>;
  /** The binding's own key, as `token()` in the store makes it: `p:<pid>:<rid>` for a parent, `m:<pid>:<rid>` for the
   *  main frame. */
  bound?: string;
  /** Set when the scheme served this token's page once; a serve again reads nothing. */
  served?: boolean;
}

const SERVE_TTL_MS = 60_000;
/** An answer's own used-by: `cardAnswerSigningInput`'s `at` inside the check, answered inside the hour of the mint
 *  (a reader takes their time, S5: the serve's ttl is the scheme's alone). */
const ANSWER_TTL_MS = 60 * 60_000;

/** The app's own fallback card's channel element: the page answers with the user's pick, checked like any button's. */
export const OWN_ELEMENT = "own";

export class SealedFrames {
  private readonly cards = new Map<string, SealedCard>();
  /** A card's channel is gone when its card resolved (the store's own sanity). */
  private readonly resolved = new Set<string>();
  /** A card whose proof the core accepted: served pages' answers carry, and a second answer is "answered already". */
  private readonly answered = new Set<string>();
  /** The frame's channels: one per element of a pending card. */
  private readonly channels = new Map<string, { cardId: string; element: string; at: number; windowId?: number; tokens?: Readonly<Record<string, TokenValue>>; bound?: string; served?: boolean }>();
  /** The answers whose own `card.answer` went out and is not answered back yet: `buildAnswer` burns the channel, the
   *  core's own result (`confirmedAnswer`) sets the card's fate (S6). */
  private readonly pending = new Map<string, string>();
  /** The frame tokens whose page has reported itself visible (IOv2), for the fallback rule (§5.5: only show the
   *  fallback when no plugin has both buttons visible within 2 s). */
  private readonly visible = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The store takes the app's incoming cards off the core events and the re-reads. */
  fromCore(card: unknown): void {
    const c = card as Partial<SealedCard>;
    if (c === null || typeof c !== "object" || typeof c.id !== "string" || typeof c.hash !== "string" || !Array.isArray(c.options)) return;
    this.cards.set(c.id, {
      id: c.id, kind: String(c.kind ?? "tool"), computer: c.computer ?? null, session: c.session, bot: c.bot,
      pluginId: c.pluginId, origin: String(c.origin ?? "user"), issuedAt: Number(c.issuedAt ?? this.now()),
      expiresAt: c.expiresAt == null ? null : Number(c.expiresAt), hash: c.hash, fields: c.fields ?? {}, options: c.options,
    });
  }

  /** One card, pending or resolved. */
  get(id: string): SealedCard | undefined {
    return this.cards.get(id);
  }

  /** A card the core says is elsewhere now: its channel dies, and its frames' loads get nothing. */
  cancelled(id: string): void {
    this.cards.delete(id);
    this.resolved.add(id);
    this.dropChannels(id);
  }

  private dropChannels(cardId: string): void {
    for (const [t, ch] of [...this.channels]) if (ch.cardId === cardId) this.channels.delete(t);
  }

  /** Mints one frame's channel: one per element of a pending card, `card.frame`'s channel in the app's own hands. The
   *  binding carries the frame that may answer (a part's token hangs on its document's own frame; the fallback's
   *  `own` on its window's main frame), the window it sits in, and the part's `card.*` tokens (the page's own tokens
   *  go in alone, the part's resolved ones). Same element, same card: replaces the older token. A card past its
   *  non-user expiry, or resolved, mints none. */
  mint(cardId: string, element: string, bind?: FrameKey, windowId?: number, tokens?: Readonly<Record<string, TokenValue>>): { token: string; card: SealedCard } | undefined {
    if (this.resolved.has(cardId) || this.answered.has(cardId)) return undefined;
    const card = this.cards.get(cardId);
    if (card === undefined) return undefined;
    if (card.expiresAt !== null && card.expiresAt <= this.now()) return undefined;
    const token = `se_${randomBytes(20).toString("hex")}`;
    for (const [t, ch] of [...this.channels]) if (ch.cardId === cardId && ch.element === element) this.channels.delete(t);
    this.channels.set(token, { cardId, element, at: this.now(), ...(windowId !== undefined ? { windowId } : {}), ...(tokens !== undefined ? { tokens: { ...tokens } } : {}), ...(bind !== undefined ? { bound: bindKey(bind) } : {}) });
    return { token, card };
  }

  /** The scheme's single serve of a frame's page: once, before its ttl runs. The token is 20 crypto-random bytes
   *  and single-use, so no header gate is needed. The answer's channel stays. */
  serve(token: string): { card: SealedCard; element: string; windowId?: number; tokens?: Readonly<Record<string, TokenValue>> } | undefined {
    const ch = this.channels.get(token);
    if (ch === undefined || ch.served === true || this.now() - ch.at > SERVE_TTL_MS) return undefined;
    ch.served = true;
    return { card: this.cards.get(ch.cardId)!, element: ch.element, ...(ch.windowId !== undefined ? { windowId: ch.windowId } : {}), ...(ch.tokens !== undefined ? { tokens: ch.tokens } : {}) };
  }

  /** Who a token's channel belongs to, for the sender's own binding's check: the frame key the mint bound it to, or
   *  undefined (a token that never bound, or past its band). */
  boundOf(token: string): string | undefined {
    return this.channels.get(token)?.bound;
  }

  /** The card a token's channel belongs to. */
  cardOf(token: string): string | undefined {
    return this.channels.get(token)?.cardId;
  }

  /** Records that a frame's page has reported itself visible or not (IOv2). */
  markVisible(token: string, visible: boolean): void {
    if (visible) this.visible.add(token);
    else this.visible.delete(token);
  }

  /** Whether a frame's page has reported itself visible (its IOv2 verdict): what the smoke run waits for before it
   *  presses, since the page refuses presses it hasn't seen yet. */
  isTokenVisible(token: string): boolean {
    return this.visible.has(token);
  }

  /** Whether a card's approve and deny buttons both show (the fallback rule: only show the fallback when no
   *  plugin has both buttons on screen and visible within 2 s). Matched to the card's own options: at least one
   *  visible button channel for an approve option, and at least one for a deny option. A plugin that places only
   *  Approve never cancels the fallback alone. */
  buttonsVisible(cardId: string): boolean {
    const card = this.cards.get(cardId);
    if (card === undefined) return false;
    const approveIds = new Set(card.options.filter((o) => o.kind === "approve").map((o) => o.id));
    const denyIds = new Set(card.options.filter((o) => o.kind === "deny").map((o) => o.id));
    if (approveIds.size === 0 || denyIds.size === 0) return false;
    let approveSeen = false;
    let denySeen = false;
    for (const [t, ch] of this.channels) {
      if (ch.cardId !== cardId || !ch.element.startsWith("button:")) continue;
      if (!this.visible.has(t)) continue;
      const optionId = ch.element.slice("button:".length);
      if (approveIds.has(optionId)) approveSeen = true;
      if (denyIds.has(optionId)) denySeen = true;
    }
    return approveSeen && denySeen;
  }

  /** Binds a channel to a frame key after the page has loaded (the fallback's own window's main frame isn't known at
   *  mint time). Fail-closed: a channel with no binding never answers. */
  bindChannel(token: string, frameKey: string): void {
    const ch = this.channels.get(token);
    if (ch !== undefined) ch.bound = frameKey;
  }

  /** The card a token's answer runs for, and its option's default (a button's own; the own page's pick names theirs).
   *  Past the answer's own band (an hour from the mint) or unknown: undefined. */
  private channelOf(token: string): { card: SealedCard; element: string } | undefined {
    const ch = this.channels.get(token);
    if (ch === undefined || this.now() - ch.at > ANSWER_TTL_MS) return undefined;
    return { card: this.cards.get(ch.cardId)!, element: ch.element };
  }

  /** An element's default answer: a button's own option (its channel's), or undefined for the `own` page (its pick
   *  names theirs). */
  optionOf(token: string): string | undefined {
    const ch = this.channels.get(token);
    if (ch === undefined || !ch.element.startsWith("button:")) return undefined;
    return ch.element.slice("button:".length);
  }

  /** Builds the answer's proof ({via:"device", device, at, signature}, B2), burns the channel, and holds the truth of
   *  the answer on the store's own books until the core's own answer (`confirmedAnswer`) reads it: a lost `card.answer`
   *  call doesn't kill the card (S6's fix — the mark goes on accepted answers only). `frameKey` is the sender's own
   *  key, checked against the mint's binding (B4: the token's own sender, always). */
  buildAnswer(token: string, option: string | undefined, children: readonly string[] | undefined, frameKey: string, signer: AnswerSigner, device: string, at = this.now()): { proof: { via: "device"; device: string; at: number; signature: string }; card: SealedCard; kids?: readonly string[] } | { error: string } {
    const ch = this.channels.get(token);
    const card = ch !== undefined ? this.cards.get(ch.cardId) : undefined;
    if (ch === undefined || card === undefined || this.now() - ch.at > ANSWER_TTL_MS || ch.bound !== frameKey) return { error: "no such sealed button" };
    const whole = ch.element === OWN_ELEMENT;
    if (whole === false && !ch.element.startsWith("button:")) return { error: "a field's frame answers nothing" };
    const want = whole ? undefined : ch.element.slice("button:".length);
    const pick = option ?? want;
    if (pick === undefined) return { error: "a button answers its own option" };
    const opt = card.options.find((o) => o.id === pick);
    if (opt === undefined || (!whole && pick !== want)) return { error: "a button answers its own option" };
    if (this.answered.has(card.id)) return { error: "that card is answered already" };
    if (this.pending.has(card.id)) return { error: "that card is answering already" };
    this.channels.delete(token);
    const kids = children === undefined ? undefined : [...children];
    const sig = signer.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: pick, at, children: kids })));
    this.pending.set(card.id, pick);
    return { proof: { via: "device", device, at, signature: Buffer.from(sig).toString("base64") }, card, ...(kids !== undefined ? { kids } : {}) };
  }

  /** The core's own answer marked the card's fate: its frames' business ends either way, and the store's own pending
   *  pick stands for the display that still shows it. */
  confirmedAnswer(cardId: string, accepted: boolean): void {
    const pick = this.pending.get(cardId);
    if (accepted === true && pick !== undefined) {
      this.answered.add(cardId);
      const card = this.cards.get(cardId);
      if (card !== undefined) (card as { picked?: string }).picked = pick;
    }
    // A refused answer leaves the card able to answer again from this desktop: only the core's own outcome closes
    // the card's frames. An accepted answer burns them.
    this.pending.delete(cardId);
    if (accepted === true) this.dropChannels(cardId);
  }

  /** The core events' reason to drop or keep a card's frames: an outcome names what closed it, and every outcome ends
   *  the frames' business (the core takes the first answer). */
  resolvedOutcome(id: string, outcome: SealedOutcome): void {
    this.dropChannels(id);
    if (outcome === "approved" || outcome === "denied") {
      this.answered.add(id);
    } else this.cards.delete(id);
  }

  /** For the tests: how many cards and live channels are held. */
  get size(): { cards: number; channels: number } {
    return { cards: this.cards.size, channels: this.channels.size };
  }
}

function bindKey(k: FrameKey): string {
  const f = "parent" in k ? k.parent : k.main;
  return ("parent" in k ? "p:" : "m:") + `${f.processId}:${f.routingId}`;
}

/** The proof carries the card's content the hash binds (B's contract), never the app-side extras. */
export function cardContentOf(card: SealedCard): unknown {
  return { id: card.id, hash: card.hash, kind: card.kind, fields: card.fields, options: card.options, ...(card.computer !== null ? { computer: card.computer } : {}) };
}
