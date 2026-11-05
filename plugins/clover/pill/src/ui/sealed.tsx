// Sealed approval parts (spec §5.5), as the pill places them: the same `<Card id>`, `<Card.Field name>`,
// `<Card.Approve>` and `<Card.Deny>` the island uses, from the plugin SDK once lane E's runtime provides it
// to a plugin with the `approvals` capability. The pill takes the kit from context; the gallery and the
// tests hand it a stand-in (`../mock-kit.tsx`, never part of the client entry), which draws fixture text
// where the core would draw the card's own. (A copy of the island's: each part plugin stays
// self-contained, and both copies go when the SDK's kit lands.)
//
// What the pill promises the real kit (`sealed.test.tsx`): at rest, no ancestor of a sealed part has a
// filter, an opacity below 1 or a transform other than a move or an enlargement; nothing is drawn over a
// part; and every button shows whole at 24 × 24 or more.
//
// The `card.*` values it hands the frames come from the pill's own tokens, resolved where the card sits:
// a theme that restyles the pill's ✓ restyles the approval's ✓ with the question's.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";

/** The fields an approval card carries. Assumed names, until lane C pins the card data (C-M3). */
export type SealedField =
  /** Who asks, and with what: "Alpha · Bash". */
  | "source"
  /** What is asked, in a sentence. */
  | "ask"
  /** The command or the input, as written. */
  | "command"
  /** The computer it runs on. */
  | "computer"
  /** The reviewer's word on the risk. */
  | "risk"
  /** A link request's host. */
  | "host";

export interface SealedCardProps {
  id: string;
  /** `card.*` token values handed to the frames: style goes in, nothing comes out. */
  tokens?: Readonly<Record<string, string>>;
  className?: string;
  children?: ReactNode;
}

export interface SealedFieldProps {
  name: SealedField;
  /** The most lines the field shows before it is cut. */
  lines?: number;
  className?: string;
}

export interface SealedButtonProps {
  /** The button's look: a ✓ circle, a ↗ circle (open a link), or a ✕ circle. */
  look: "check" | "open" | "cross";
  /** Its side, in CSS pixels; never under 24. */
  size?: number;
  className?: string;
}

export interface SealedCardKit {
  Card(props: SealedCardProps): ReactElement;
  Field(props: SealedFieldProps): ReactElement;
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

/** The `card.*` values the pill hands its frames: its words and circles, see-through on its own black. */
export const PILL_CARD_SOURCES: Readonly<Record<string, CardTokenSource>> = {
  "card.background": { value: "#00000000" },
  "card.rim": { value: "#00000000" },
  "card.text": { token: "pill.text", fallback: "#FFFFFF" },
  "card.muted": { token: "pill.muted", fallback: "#8B8B8B" },
  "card.approve.background": { token: "pill.accept", fallback: "#C2387A" },
  "card.approve.text": { token: "pill.text", fallback: "#FFFFFF" },
  "card.deny.background": { token: "pill.send", fallback: "#FFFFFF" },
  "card.deny.text": { token: "pill.send.glyph", fallback: "#000000" },
  "card.font.size": { token: "font.size.large", fallback: "15px" },
  "card.radius": { value: "0px" },
  "card.padding": { value: "0px" },
  "card.button.radius": { value: "999px" },
};

/** A token's CSS custom property (lane B's mapping; catalog names hold no hyphen). */
export const tokenProperty = (name: string): string => `--clover-${name.replace(/-/g, "_").replace(/\./g, "-")}`;

// What a resolved value may hold before it goes to a frame: lane B's rule for any token value.
const UNSAFE = /[;{}\\@<>]|\/\*|url\s*\(|expression\s*\(|image-set|image\s*\(|element\s*\(/i;

/** The card values, each read through `read` (a custom property's computed value) or fixed. */
export function resolveCardTokens(sources: Readonly<Record<string, CardTokenSource>>, read: (property: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, source] of Object.entries(sources)) {
    if ("value" in source) {
      out[name] = source.value;
      continue;
    }
    const value = read(tokenProperty(source.token)).trim();
    out[name] = value.length > 0 && value.length <= 300 && !UNSAFE.test(value) ? value : source.fallback;
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
