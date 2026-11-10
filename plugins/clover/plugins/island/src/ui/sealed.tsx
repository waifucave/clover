// Sealed approval parts (spec §5.5): the island places them, styles them with `card.*` tokens, and never
// reads them. The app's plugin runtime (lane E) provides the real kit — `<Card id>` and its
// `<Card.Field name>`, `<Card.Approve>`, `<Card.Deny>`, each a frame from a core-owned origin — to a
// plugin with the `approvals` capability. Until it lands, the island takes the kit from context: the
// gallery and the tests hand it a stand-in (`../mock-kit.tsx`, never part of the client entry), which
// draws fixture text where the core would draw the card's own.
//
// What the island promises the real kit, and what `sealed.test.tsx` holds it to: at rest, no ancestor of a
// sealed part has a filter, an opacity below 1 or a transform other than a move or an enlargement; nothing
// is drawn over a part; and every button shows whole at 24 × 24 or more.
//
// The `card.*` values it hands the frames come from the island's own tokens, resolved where the card sits:
// a theme that restyles the island's ✓ restyles the approval's ✓ with the question's.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";

/** The sealed fields a card may carry (lane B's `CARD_FIELD_NAMES`); a field the card lacks draws nothing. */
export type SealedField =
  /** The card's heading. */
  | "title"
  /** A tool call in one line ("Alpha wants to edit story.md in Downloads"), composed by the app from the card's own fields. */
  | "summary"
  /** A short preview of what it does (a small diff, a command, a file's start), shortened only where it says so. */
  | "preview"
  /** What it asks, in a sentence. */
  | "what"
  /** The command, the edit or the call's input, as code. */
  | "command"
  /** Where it runs. */
  | "computer"
  /** The safety reviewer's verdict. */
  | "risk"
  /** Why the bot wants it. */
  | "reason"
  /** Who asks. */
  | "source"
  /** The site a link or a fetch goes to. */
  | "host"
  /** The files it touches. */
  | "paths"
  /** Anything more, as rows. */
  | "detail"
  /** When it is denied unanswered. */
  | "expires";

export interface SealedCardProps {
  id: string;
  /** `card.*` token values handed to the frames: style goes in, nothing comes out. */
  tokens?: Readonly<Record<string, string>>;
  className?: string;
  /** Told whether the card's frames are all in place (each has its page and has said its size). A kit that holds a card
   *  back until it is whole (`holdsUntilWhole`) reports it here; the island shows nothing of a card until it is. */
  onReady?: (ready: boolean) => void;
  children?: ReactNode;
}

export interface SealedFieldProps {
  name: SealedField;
  /** The most lines the field shows before it is cut. */
  lines?: number;
  className?: string;
}

export interface SealedButtonProps {
  /** The answer it gives: an option's id from the card's options; absent, the first option of its kind. */
  option?: string;
  /** The option's own sealed label (the default), or a glyph: ✓ `check`, ✕ `cross`, ↗ `open` (a link). */
  look?: "label" | "check" | "cross" | "open";
  /** A glyph button's side, in CSS pixels; never under 24. */
  size?: number;
  className?: string;
}

export interface SealedCardKit {
  /** The kit's frames arrive after the card does (the app's real kit): the island holds a card back until they are all
   *  in place, rather than draw an empty one. The stand-ins draw at once and leave it unset. */
  holdsUntilWhole?: boolean;
  Card(props: SealedCardProps): ReactElement;
  /** A field the card lacks draws nothing. */
  Field(props: SealedFieldProps): ReactElement | null;
  Approve(props: SealedButtonProps): ReactElement;
  Deny(props: SealedButtonProps): ReactElement;
}

export const MIN_SEALED_BUTTON = 24;

const CardIdContext = createContext<string | null>(null);

/** With no kit at all the parts take their place and stay empty: nothing to read, nothing to answer. */
export const EMPTY_KIT: SealedCardKit = {
  Card: ({ id, className, children }) => (
    <CardIdContext.Provider value={id}>
      <div className={className} data-sealed-card={id}>
        {children}
      </div>
    </CardIdContext.Provider>
  ),
  Field: ({ name, className }) => <span className={className} data-sealed="field" data-field={name} />,
  Approve: ({ size = 30, className }) => <span className={className} data-sealed="approve" style={{ width: size, height: size }} />,
  Deny: ({ size = 30, className }) => <span className={className} data-sealed="deny" style={{ width: size, height: size }} />,
};

export const SealedKitContext = createContext<SealedCardKit>(EMPTY_KIT);

export function useSealedKit(): SealedCardKit {
  return useContext(SealedKitContext);
}

export function useSealedCardId(): string | null {
  return useContext(CardIdContext);
}

/** Gives the parts inside a card their card's id: what a kit's `Card` does for its fields and buttons. */
export function SealedCardIdProvider({ id, children }: { id: string; children?: ReactNode }): ReactElement {
  return <CardIdContext.Provider value={id}>{children}</CardIdContext.Provider>;
}

/** A `card.*` value: one of the surface's own tokens (with the base theme's value when nothing sets it), or a
 *  fixed part of its shape. */
export type CardTokenSource = { readonly token: string; readonly fallback: string } | { readonly value: string };

/** The `card.*` values the island hands its frames: its words and circles, see-through on its own black. */
export const ISLAND_CARD_SOURCES: Readonly<Record<string, CardTokenSource>> = {
  "card.background": { value: "#00000000" },
  "card.rim": { value: "#00000000" },
  "card.text": { token: "island.text", fallback: "#FFFFFF" },
  "card.muted": { token: "island.muted", fallback: "#8B8B8B" },
  "card.approve.background": { token: "island.accept", fallback: "#4180E3" },
  "card.approve.text": { token: "island.accept.text", fallback: "#FFFFFF" },
  "card.deny.background": { token: "island.refuse", fallback: "#FFFFFF" },
  "card.deny.text": { token: "island.refuse.text", fallback: "#000000" },
  "card.font.family": { token: "card.font.family", fallback: "system-ui, -apple-system, \"Segoe UI Variable Text\", \"Segoe UI\", \"Noto Sans\", Ubuntu, Cantarell, sans-serif" },
  "card.font.size": { token: "font.size.body", fallback: "15px" },
  "card.radius": { value: "0px" },
  "card.padding": { value: "0px" },
  "card.button.radius": { value: "999px" },
};

/** A token's CSS custom property (lane B's mapping; catalog names hold no hyphen). */
export const tokenProperty = (name: string): string => `--clover-${name.replace(/-/g, "_").replace(/\./g, "-")}`;

// What a resolved value may hold before it goes to a frame: lane B's `isSafeTokenValue`.
const UNSAFE = /[;{}\\@<>\n\r\f\0]|\/\*|url\s*\(|src\s*\(|expression\s*\(|image-set|image\s*\(|element\s*\(|cross-fade|!\s*important/i;
const quotesClosed = (value: string) => (value.match(/"/g)?.length ?? 0) % 2 === 0 && (value.match(/'/g)?.length ?? 0) % 2 === 0;

/** The card values, each read through `read` (a custom property's computed value) or fixed. */
export function resolveCardTokens(sources: Readonly<Record<string, CardTokenSource>>, read: (property: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, source] of Object.entries(sources)) {
    if ("value" in source) {
      out[name] = source.value;
      continue;
    }
    const value = read(tokenProperty(source.token)).trim();
    // A theme's keywords (`system`, `auto`) are the theme engine's to resolve; one left unresolved is no colour.
    const keyword = value === "system" || value === "auto";
    out[name] = value.length > 0 && value.length <= 300 && !keyword && !UNSAFE.test(value) && quotesClosed(value) ? value : source.fallback;
  }
  return out;
}

const same = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

/**
 * The card values for a card drawn inside the element `ref` points at, read from its computed style after
 * each render and again when the appearance or the document's stylesheets change (a theme swap needs no
 * render of ours). Nothing runs while nothing changes.
 */
export function useCardTokens(sources: Readonly<Record<string, CardTokenSource>>): { ref: RefObject<HTMLDivElement | null>; tokens: Readonly<Record<string, string>> } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [tokens, setTokens] = useState<Readonly<Record<string, string>>>(() => resolveCardTokens(sources, () => ""));
  const sync = useRef(() => {});
  sync.current = () => {
    const el = ref.current;
    if (!el || typeof getComputedStyle !== "function") return;
    const style = getComputedStyle(el);
    const next = resolveCardTokens(sources, (property) => style.getPropertyValue(property));
    setTokens((prev) => (same(prev, next) ? prev : next));
  };
  useLayoutEffect(() => sync.current());
  useEffect(() => {
    const update = () => sync.current();
    const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    media?.addEventListener?.("change", update);
    const observer = typeof MutationObserver === "function" && typeof document !== "undefined" ? new MutationObserver(update) : null;
    if (observer) {
      observer.observe(document.head, { childList: true, subtree: true, characterData: true });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-appearance"] });
    }
    return () => {
      media?.removeEventListener?.("change", update);
      observer?.disconnect();
    };
  }, []);
  return { ref, tokens };
}
