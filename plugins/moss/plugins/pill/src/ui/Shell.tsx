// The main pill's shape (the Swift reference's `DispatchPillShell`): a black capsule at rest, a rounded rect once it
// grows taller, its corner following the spring's CURRENT height. The content is laid out at the target
// height, bottom-anchored, so a growing pill reveals its upper lines as the shape rises; its width follows
// the spring's current width, so the circle rides the edge. While the shape changes the content blurs by
// how far the spring still has to go; the plume underneath is clipped by the shape and never blurred.

import type { CSSProperties, ReactElement, ReactNode } from "react";
import { usePillStyles } from "./styles";
import { PILL, contentBlur, cornerRadius, morphBlur, type Size } from "../model/metrics";

export interface ShellProps {
  /** The spring's size now. */
  size: Size;
  /** Where the spring is going. */
  target: Size;
  /** A content swap's visibility (the old content fading out, the new one revealed); 1 outside a swap. */
  visibility?: number;
  /** The plume: under the content, sharp, laid out once at the compact pill's place. */
  underlay?: ReactNode;
  /** Whether the underlay shows (it stays mounted while a turn runs). */
  underlayShown?: boolean;
  /** The content stays what it was while the shape moves (the bar widening as the user types): it does not blur. */
  steady?: boolean;
  label?: string;
  children?: ReactNode;
}

export function Shell({ size, target, visibility = 1, underlay, underlayShown = false, steady = false, label, children }: ShellProps): ReactElement {
  usePillStyles();
  const blur = Math.max(steady ? 0 : morphBlur(size, target), contentBlur(visibility));
  const content: CSSProperties = { width: size.width, height: target.height };
  if (visibility < 1) content.opacity = visibility;
  if (blur > 0) content.filter = `blur(${blur.toFixed(2)}px)`;
  return (
    <div
      className="clp-shell"
      role="group"
      aria-label={label}
      style={{ width: size.width, height: size.height, borderRadius: cornerRadius(size.height) }}
      data-moving={size.width !== target.width || size.height !== target.height || undefined}
    >
      {underlay ? (
        <div
          className="clp-underlay"
          data-shown={underlayShown}
          style={{ width: PILL.compactWidth, height: PILL.pillHeight, marginLeft: -PILL.compactWidth / 2, opacity: underlayShown ? visibility : 0 }}
        >
          {underlay}
        </div>
      ) : null}
      <div className="clp-content" style={content}>
        {children}
      </div>
    </div>
  );
}
