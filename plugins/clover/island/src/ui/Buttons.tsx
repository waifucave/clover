// The island's answer circles: a white ✕ and a blue ✓, glowing softly in their own colour under the
// pointer (Winter's `IslandAnswerButton`). A question's are the island's own buttons; an approval's are
// the core's sealed buttons, which the island only places, in a slot of the same shape.

import type { ReactElement } from "react";
import { Glyph, type GlyphName } from "./glyphs";
import { useSealedKit, type SealedButtonProps } from "./sealed";

export interface CircleButtonProps {
  role: "accept" | "refuse";
  glyph?: GlyphName;
  label: string;
  enabled?: boolean;
  /** Draw it as if under the pointer (the gallery cannot hover). */
  hover?: boolean;
  onClick?: () => void;
}

export function CircleButton({ role, glyph, label, enabled = true, hover, onClick }: CircleButtonProps): ReactElement {
  return (
    <button
      type="button"
      className="clv-circle"
      data-role={role}
      data-hover={hover || undefined}
      aria-label={label}
      title={label}
      disabled={!enabled}
      onClick={onClick}
    >
      <Glyph name={glyph ?? (role === "accept" ? "check" : "xmark")} size={12} />
    </button>
  );
}

export interface SealedSlotProps {
  approve: boolean;
  look: SealedButtonProps["look"];
  hover?: boolean;
}

/** Where a sealed approve or deny button goes: the circle's place, its glow, nothing on the frame itself. */
export function SealedSlot({ approve, look, hover }: SealedSlotProps): ReactElement {
  const kit = useSealedKit();
  const Button = approve ? kit.Approve : kit.Deny;
  return (
    <span className="clv-sealed-slot" data-role={approve ? "accept" : "refuse"} data-hover={hover || undefined}>
      <Button look={look} size={30} />
    </span>
  );
}
