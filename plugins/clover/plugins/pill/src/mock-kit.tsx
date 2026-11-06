// A stand-in sealed kit for the gallery and the tests, never part of the client entry: each field draws the
// fixture text for its card (a field the card lacks draws nothing), the buttons are plain buttons reporting the
// answer, and the card carries the `card.*` values it was handed as custom properties. Every part is marked
// (`data-sealed`), so a test can walk what lies around it and after it.

import type { CSSProperties, ReactElement } from "react";
import { Glyph } from "./ui/glyphs";
import { MIN_SEALED_BUTTON, SealedCardIdProvider, tokenProperty, useSealedCardId, type SealedButtonProps, type SealedCardKit, type SealedField, type SealedFieldProps } from "./ui/sealed";

/** Each card's field text, and its options' labels by id (what the core's frames would draw). */
export type SealedFixtures = Readonly<Record<string, Partial<Record<SealedField, string>> & { readonly options?: Readonly<Record<string, string>> }>>;

export function mockSealedKit(fixtures: SealedFixtures, onAnswer?: (cardId: string, approved: boolean) => void): SealedCardKit {
  function Field({ name, lines, className }: SealedFieldProps): ReactElement | null {
    const id = useSealedCardId();
    const text = (id && fixtures[id]?.[name]) ?? "";
    // As the core's kit does (lane B's rule): a field the card lacks draws nothing, not an empty box.
    if (!text) return null;
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
    return function SealedButton({ option, look = "label", size = 30, className }: SealedButtonProps): ReactElement {
      const id = useSealedCardId();
      const side = Math.max(size, MIN_SEALED_BUTTON);
      const label = (id && option && fixtures[id]?.options?.[option]) || (approved ? (look === "open" ? "Open the link" : "Allow once") : look === "open" ? "Decline the link" : "Deny");
      return (
        <button
          type="button"
          className={className}
          data-sealed={approved ? "approve" : "deny"}
          data-option={option}
          data-look={look}
          aria-label={label}
          style={look === "label" ? { minWidth: side, height: side } : { width: side, height: side }}
          onClick={() => id && onAnswer?.(id, approved)}
        >
          {look === "label" ? label : <Glyph name={look === "cross" ? "xmark" : look === "open" ? "open" : "check"} size={12} />}
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
