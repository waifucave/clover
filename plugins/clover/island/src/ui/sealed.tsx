// Sealed approval parts (spec §5.5): the island places them, styles them with `card.*` tokens, and never
// reads them. The app's plugin runtime (lane E) provides the real kit — `<Card id>` and its
// `<Card.Field name>`, `<Card.Approve>`, `<Card.Deny>`, each a frame from a core-owned origin — to a
// plugin with the `approvals` capability. Until it lands, the island takes the kit from context: the
// gallery and the tests hand it the mock below, which draws fixture text where the core would draw the
// card's own.
//
// What the island promises the real kit, and what `sealed.test.tsx` holds it to: at rest, no ancestor of a
// sealed part has a filter, an opacity below 1 or a transform other than a move or an enlargement, and
// every button shows whole at 24 × 24 or more.

import { createContext, useContext, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Glyph } from "./glyphs";

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

export type SealedFixtures = Readonly<Record<string, Partial<Record<SealedField, string>>>>;

/**
 * A stand-in kit for the gallery and the tests: each field draws the fixture text for its card, the
 * buttons are plain buttons reporting the answer. Every part is marked (`data-sealed`), so a test can
 * walk its ancestors.
 */
export function mockSealedKit(fixtures: SealedFixtures, onAnswer?: (cardId: string, approved: boolean) => void): SealedCardKit {
  function Field({ name, lines, className }: SealedFieldProps): ReactElement {
    const id = useSealedCardId();
    const text = (id && fixtures[id]?.[name]) ?? "";
    const style: CSSProperties = lines
      ? { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }
      : {};
    return (
      <span className={className} data-sealed="field" data-field={name} style={style}>
        {text}
      </span>
    );
  }
  function button(approved: boolean) {
    return function SealedButton({ look, size = 30, className }: SealedButtonProps): ReactElement {
      const id = useSealedCardId();
      const side = Math.max(size, MIN_SEALED_BUTTON);
      return (
        <button
          type="button"
          className={className}
          data-sealed={approved ? "approve" : "deny"}
          data-look={look}
          aria-label={approved ? (look === "open" ? "Open the link" : "Allow once") : look === "open" ? "Decline the link" : "Deny"}
          style={{ width: side, height: side }}
          onClick={() => id && onAnswer?.(id, approved)}
        >
          <Glyph name={look === "cross" ? "xmark" : look === "open" ? "open" : "check"} size={12} />
        </button>
      );
    };
  }
  return {
    Card: ({ id, tokens, className, children }) => (
      <CardIdContext.Provider value={id}>
        <div className={className} data-sealed-card={id} style={tokenStyle(tokens)}>
          {children}
        </div>
      </CardIdContext.Provider>
    ),
    Field,
    Approve: button(true),
    Deny: button(false),
  };
}

function tokenStyle(tokens: Readonly<Record<string, string>> | undefined): CSSProperties | undefined {
  if (!tokens) return undefined;
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(tokens)) style[`--${name.replaceAll(".", "-")}`] = value;
  return style as CSSProperties;
}

/** The `card.*` values the island hands its frames: white words on the island's black, Winter's circles. */
export const ISLAND_CARD_TOKENS: Readonly<Record<string, string>> = {
  "card.background": "#00000000",
  "card.text": "#FFFFFF",
  "card.muted": "#8B8B8B",
  "card.rim": "#00000000",
  "card.radius": "0px",
  "card.padding": "0px",
  "card.approve.background": "#0A85FF",
  "card.approve.text": "#FFFFFF",
  "card.deny.background": "#FFFFFF",
  "card.deny.text": "#000000",
  "card.button.radius": "999px",
  "card.font.size": "14px",
};
