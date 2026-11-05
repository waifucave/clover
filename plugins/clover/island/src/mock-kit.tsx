// A stand-in sealed kit for the gallery and the tests, never part of the client entry: each field draws the
// fixture text for its card, the buttons are plain buttons reporting the answer, and the card carries the
// `card.*` values it was handed as custom properties. Every part is marked (`data-sealed`), so a test can walk
// what lies around it and after it.

import type { CSSProperties, ReactElement } from "react";
import { Glyph } from "./ui/glyphs";
import { MIN_SEALED_BUTTON, SealedCardIdProvider, tokenProperty, useSealedCardId, type SealedButtonProps, type SealedCardKit, type SealedField, type SealedFieldProps } from "./ui/sealed";

export type SealedFixtures = Readonly<Record<string, Partial<Record<SealedField, string>>>>;

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
      <SealedCardIdProvider id={id}>
        <div className={className} data-sealed-card={id} style={tokenStyle(tokens)}>
          {children}
        </div>
      </SealedCardIdProvider>
    ),
    Field,
    Approve: button(true),
    Deny: button(false),
  };
}

function tokenStyle(tokens: Readonly<Record<string, string>> | undefined): CSSProperties | undefined {
  if (!tokens) return undefined;
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(tokens)) style[tokenProperty(name)] = value;
  return style as CSSProperties;
}
