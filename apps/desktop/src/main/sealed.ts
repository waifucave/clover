// The sealed frames' runtime (spec §5.5; plan §4 E M3): the store behind the per-card frames the sdk's `<Card>` places.
// The app's main process hears the cards with their sealed fields (`card_requested`, the app's role), keeps them, and
// answers each field's and button's frame itself: one frame per sealed element, mounted under its own single-use
// token, answered over `card.answer` signed with this desktop's answer key (lane H's). Pure apart from the signer, so
// the tests drive it under Bun.
//
// What never happens here: a plugin reads the sealed fields (the events on the layer's role carry ids only
// (`card_pending`), a plugin's page carries no field's url, and the sealed pages' contents go nowhere (their scheme
// serves once for the one mount), and nothing signs except the answer key — so a plugin can't answer.
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

/** The card option a sealed button answers with, once its proof is built. */
export interface SealedFrame {
  /** The frame's own mount token, unguessable, one per element, named on the proof. */
  token: string;
  cardId: string;
  /** `field:<name>` for a sealed field's frame, `button:<option id>` for a button's. */
  element: string;
  /** The page's window where it was mounted (its own visibility check runs there). */
  windowId: number;
}

export type SealedOutcome = "approved" | "denied" | "expired" | "withdrawn" | "cancelled";

/** One sealed field's content, as the core's own shape (`approvals.ts`'s `SealedValue`), what a frame's page draws. */
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

const CHANNEL_TTL_MS = 60_000;

/**
 * Where the app's sealed path is:
 *
 * - A card arrives (`fromCore`), with its window's fields; the frames' mounts live here for the SDK's placement to
 *   read; a card resolved before its answer forgets its channel (`lost`), and an answer out of resolution is
 *   refused.
 * - A button's answer goes `signAnswer(...)` (lane H's own key, over lane B's `cardAnswerSigningInput`), and the proof
 *   is used once (`takeAnswer`): a channel answered is gone, win or lose (the core's "first answer wins" reads the
 *   answer from whoever it accepted, not twice from one frame).
 */
export class SealedFrames {
  private readonly cards = new Map<string, SealedCard>();
  /** The frame's token → its element: minted at mount, answered once. */
  private readonly channels = new Map<string, { cardId: string; element: string; at: number; windowId?: number; tokens?: Readonly<Record<string, TokenValue>> }>();
  /** A card's channel is gone when its card resolved (the store's own sanity). */
  private readonly resolved = new Set<string>();
  /** Each token's own page served once (`sealed.ts`'s own comment will read it in the scheme's handler). */
  private readonly served = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Every channel of one card's frames, gone (a resolution, a withdrawal, an expiry). */
  private dropChannels(cardId: string): void {
    for (const [t, ch] of [...this.channels]) if (ch.cardId === cardId) this.channels.delete(t);
  }

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
    for (const [token, ch] of [...this.channels]) {
      if (ch.cardId !== id) continue;
      this.channels.delete(token);
      this.served.delete(token);
    }
  }

  /** Mints one frame's channel, once per element of a pending card (`card.frame` names it on the proof). Tokens are
   *  single-use and expire; the same element of the same card minted again replaces its older token. A card past its
   *  expiry (its turn wasn't the user's, §5.5) mints none. The mint carries the frame's own window, for its page to
   *  answer against, and the part's `card.*` tokens, which its page alone sees. */
  mint(cardId: string, element: string, windowId?: number, tokens?: Readonly<Record<string, TokenValue>>): { token: string; card: SealedCard } | undefined {
    if (this.resolved.has(cardId)) return undefined;
    const card = this.cards.get(cardId);
    if (card === undefined) return undefined;
    if (card.expiresAt !== null && card.expiresAt <= this.now()) return undefined;
    const token = this.token();
    for (const [t, ch] of [...this.channels]) if (ch.cardId === cardId && ch.element === element) this.channels.delete(t);
    this.channels.set(token, { cardId, element, at: this.now(), ...(windowId !== undefined ? { windowId } : {}), ...(tokens !== undefined ? { tokens: { ...tokens } } : {}) });
    return { token, card };
  }

  /** Who a frame's token names: its card's and element ("field:<name>", "button:<option>"), once. */
  look(token: string): { card: SealedCard; element: string } | undefined {
    const ch = this.channels.get(token);
    if (ch === undefined || this.now() - ch.at > CHANNEL_TTL_MS) return undefined;
    return { card: this.cards.get(ch.cardId)!, element: ch.element };
  }

  /** Marks a served frame's token: the scheme serves a frame's page once, and a second serve reads nothing. The
   *  answer channel lives on (a reload mints its own token, its own page, its own channel), and the frame's own
   *  window is the mint's. */
  serve(token: string): { card: SealedCard; element: string; windowId?: number; tokens?: Readonly<Record<string, TokenValue>> } | undefined {
    const ch = this.channels.get(token);
    if (ch === undefined || this.now() - ch.at > CHANNEL_TTL_MS) return undefined;
    if (this.served.has(token)) return undefined;
    this.served.add(token);
    return { card: this.cards.get(ch.cardId)!, element: ch.element, ...(ch.windowId !== undefined ? { windowId: ch.windowId } : {}), ...(ch.tokens !== undefined ? { tokens: ch.tokens } : {}) };
  }

  /** Builds the proof for a button's answer, and burns the channel: the answer is used once, and the core takes the
   *  first. `children` is a plugin OK's checked children, signed with the same answer (§5.5). */
  buildAnswer(token: string, option: string, children: readonly string[] | undefined, signer: AnswerSigner, deviceId: string, at = this.now()): { proof: { card: unknown; option: string; children?: readonly string[]; device: string; at: number; signature: string }; card: SealedCard } | { error: string } {
    const ch = this.channels.get(token);
    const card = ch !== undefined ? this.cards.get(ch.cardId) : undefined;
    if (ch === undefined || card === undefined || this.now() - ch.at > CHANNEL_TTL_MS) return { error: "no such sealed button" };
    if (!ch.element.startsWith("button:") && ch.element !== "own") return { error: "a field's frame answers nothing" };
    // The app's own fallback card answers with the page's own token: the option is the user's pick, checked against
    // the card's own options like any button's (§5.5).
    const whole = ch.element === "own";
    const want = whole ? option : ch.element.slice("button:".length);
    const opt = card.options.find((o) => o.id === option);
    if (opt === undefined || (!whole && option !== want)) return { error: "a button answers its own option" };
    if (this.resolved.has(card.id)) return { error: "that card is answered already" };
    this.channels.delete(token);
    const kids = children === undefined ? undefined : [...children];
    const sig = signer.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option, at, children: kids })));
    this.resolved.add(card.id);
    for (const [t, other] of [...this.channels]) if (other.cardId === card.id) this.channels.delete(t);
    return {
      proof: { card: cardContentOf(card), option, ...(kids !== undefined ? { children: kids } : {}), device: deviceId, at, signature: Buffer.from(sig).toString("base64") },
      card,
    };
  }

  /** An element's default answer: a button channel's own option (the token carries it), or undefined for the app's
   *  own whole-card page, whose pick the user names. */
  optionOf(token: string): string | undefined {
    const ch = this.channels.get(token);
    if (ch === undefined || !ch.element.startsWith("button:")) return undefined;
    return ch.element.slice("button:".length);
  }

  /** The core events' reason to drop or keep a card's frames: an outcome names what closed it, and every outcome ends
   *  the frames' business (the core takes the first answer, and frames of a closed card stop). */
  resolvedOutcome(id: string, outcome: SealedOutcome): void {
    this.dropChannels(id);
    if (outcome === "approved" || outcome === "denied") this.resolved.add(id);
    else this.cards.delete(id);
  }

  /** For the tests: how many cards and live channels are held. */
  get size(): { cards: number; channels: number } {
    return { cards: this.cards.size, channels: this.channels.size };
  }

  private token(): string {
    return `se_${Buffer.from([Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)]).toString("hex")}${this.now().toString(36)}`;
  }
}

/** The proof carries the card's content the hash binds (B's contract), never the app-side extras. */
export function cardContentOf(card: SealedCard): unknown {
  return { id: card.id, hash: card.hash, kind: card.kind, fields: card.fields, options: card.options, ...(card.computer !== null ? { computer: card.computer } : {}) };
}
