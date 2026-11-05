// The Dispatch pill's geometry, ported from the Swift reference's `DispatchPillMetrics` and its pure functions
// (the Swift reference: DispatchPillLayout.swift). Geometry only: no type metric lives here,
// and the composer's measured height is an input, never a constant. Pure.

export interface Size {
  width: number;
  height: number;
}

export const PILL = {
  compactWidth: 316,
  expandedWidth: 560,
  /** The capsule's resting height: one line of text plus the send circle's margin. */
  pillHeight: 44,
  /** The tallest a typing pill grows before the composer scrolls inside it. */
  maxExpandedHeight: 240,
  composerVerticalPadding: 18,
  leadingPadding: 18,
  trailingPadding: 6,
  sendCircleSize: 32,
  accessoryButtonSize: 28,
  /** How close the typed text gets to ↗ and ⋯ before they blur out of its way. */
  accessoryApproachMargin: 14,
  rowSpacing: 6,
  previewVerticalInset: 12,
  previewLineGap: 4,
  previewMaxScreenShare: 0.6,
  /** How far above the Dock the pill's bottom sits. */
  dockGap: 28,
  /** Transparent margin all round, for the shadow. */
  shadowPad: 24,
  /** The compact pill's grow under the pointer: the points every hover-growing panel matches. */
  hoverScale: 1.03,
  /** Between the stacked layers: cards, child pills, the main pill. */
  stackGap: 8,
  childPillGap: 6,
  /** A chip's own chrome (its padding, glyph and stop button) takes about 82 points; this leaves its title a few
   *  letters even beside a "+n" circle (the review saw names cut to one letter at 72). */
  minChildPillWidth: 120,
  /** The width the pill morphs to as a card; a typing pill keeps its own. */
  cardWidth: 440,
  maxCardHeight: 520,
  cardEstimatedHeight: 132,
  cardVerticalPadding: 14,
  cardChromeAllowance: 112,
  maxMorphBlur: 8,
  morphBlurFalloff: 12,
  plumeFadeIn: 0.12,
  /** A content swap: the share of the shape's travel during which the new content stays hidden. */
  contentRevealStart: 0.62,
  contentFadeOut: 0.12,
  /** The radius a tall pill settles on: a capsule's at `pillHeight`. */
  maxCornerRadius: 22,
  /** The target's portrait at the leading end (Clover: the bot the pill messages). */
  portraitSize: 24,
} as const;

export const FIELD_BOTTOM_INSET = PILL.composerVerticalPadding / 2;
export const SEND_BOTTOM_INSET = (PILL.pillHeight - PILL.sendCircleSize) / 2;
export const CHILD_ROW_HEIGHT = PILL.pillHeight;

export type Presentation = "compact" | "expanded";

/** The text field's width in a pill this wide: everything left of the send circle. */
export function fieldWidth(pillWidth: number, leading: number = PILL.leadingPadding): number {
  return Math.max(1, pillWidth - leading - PILL.trailingPadding - PILL.sendCircleSize - PILL.rowSpacing);
}

/** Where ⋯'s leading edge sits in the typing pill's field: the line the typed text "reaches". */
export function fieldWidthBesideAccessories(leading: number = PILL.leadingPadding): number {
  return fieldWidth(PILL.expandedWidth, leading) - 2 * PILL.accessoryButtonSize - 2 * PILL.rowSpacing;
}

/** The main pill's target size: compact, typing (grown with the text), or a pinned turn's. */
export function mainSize(presentation: Presentation, composerContentHeight: number, previewHeight?: number, visibleHeight = 900): Size {
  if (presentation === "compact") return { width: PILL.compactWidth, height: PILL.pillHeight };
  if (previewHeight !== undefined) {
    return { width: PILL.expandedWidth, height: Math.min(Math.max(previewHeight, PILL.pillHeight), previewCeiling(visibleHeight)) };
  }
  const total = Math.max(PILL.pillHeight, composerContentHeight + PILL.composerVerticalPadding);
  return { width: PILL.expandedWidth, height: Math.min(Math.max(total, PILL.pillHeight), PILL.maxExpandedHeight) };
}

/** The pill as a card: a typing pill keeps its width, a compact one widens to the card's. */
export function cardSize(presentation: Presentation, measuredHeight: number, visibleHeight = 900): Size {
  const width = presentation === "expanded" ? PILL.expandedWidth : PILL.cardWidth;
  const content = measuredHeight > 0 ? measuredHeight : PILL.cardEstimatedHeight;
  return { width, height: Math.ceil(Math.min(Math.max(content, PILL.pillHeight), cardCeiling(visibleHeight))) };
}

export function cardCeiling(visibleHeight: number): number {
  return Math.min(PILL.maxCardHeight, Math.max(PILL.pillHeight, visibleHeight * 0.7));
}

export function previewCeiling(visibleHeight: number): number {
  return Math.max(PILL.maxExpandedHeight, Math.floor(visibleHeight * PILL.previewMaxScreenShare));
}

/** A pinned turn's height: its prompt line and its whole reply, plus the insets, within the capsule and the ceiling. */
export function previewHeight(replyHeight: number, lineHeight: number, ceiling: number): number {
  const height = 2 * PILL.previewVerticalInset + lineHeight + PILL.previewLineGap + Math.max(lineHeight, replyHeight);
  return Math.min(Math.max(PILL.pillHeight, Math.ceil(height)), Math.max(PILL.pillHeight, ceiling));
}

/** Capsule to rounded rect: half the height at rest, holding at `maxCornerRadius` once taller. */
export function cornerRadius(height: number): number {
  return Math.min(Math.max(0, height) / 2, PILL.maxCornerRadius);
}

/** How much the content blurs while the shape changes: by how far the spring still has to go. */
export function morphBlur(size: Size, target: Size): number {
  const remaining = Math.max(Math.abs(target.width - size.width), Math.abs(target.height - size.height));
  const radius = Math.min(PILL.maxMorphBlur, remaining / PILL.morphBlurFalloff);
  return radius < 0.25 ? 0 : radius;
}

/** A content swap's new content: hidden until the shape has covered `contentRevealStart` of the way. */
export function contentReveal(origin: Size, size: Size, target: Size): number {
  const total = Math.max(Math.abs(target.width - origin.width), Math.abs(target.height - origin.height));
  if (total <= 0.5) return 1;
  const remaining = Math.max(Math.abs(target.width - size.width), Math.abs(target.height - size.height));
  const progress = 1 - remaining / total;
  return Math.min(1, Math.max(0, (progress - PILL.contentRevealStart) / (1 - PILL.contentRevealStart)));
}

export function contentBlur(visibility: number): number {
  const radius = (1 - Math.min(1, Math.max(0, visibility))) * PILL.maxMorphBlur;
  return radius < 0.25 ? 0 : radius;
}

/** The hover's scale for a shape this wide: the compact pill's 9.48 points, whatever the width. */
export function hoverScale(width: number): number {
  return width > 0 ? 1 + (PILL.compactWidth * (PILL.hoverScale - 1)) / width : 1;
}

/** ↗ and ⋯ float over the field's end and give way to the text: hidden on a second line, or once the text nears them. */
export function accessoriesVisible(draft: string, textWidth: number, leading: number = PILL.leadingPadding): boolean {
  if (draft.includes("\n")) return false;
  return textWidth + PILL.accessoryApproachMargin <= fieldWidthBesideAccessories(leading);
}

export type CircleRole = "send" | "stop" | "voice";

/** The bar's look: the working plume (no composer), the circle's role, the placeholder. */
export function barLook(expanded: boolean, running: boolean, draft: string, cardShown: boolean, placeholder: string, verb: string) {
  const working = !expanded && running && !cardShown;
  const canSend = draft.trim().length > 0;
  const circle: CircleRole = running ? "stop" : canSend ? "send" : "voice";
  const shownPlaceholder = draft.length === 0 && !working ? (running ? verb : placeholder) : null;
  return { working, circle, placeholder: shownPlaceholder };
}

/** The panel's canvas: the main pill, what floats above it, and the shadow margin. */
export function canvasSize(main: Size, accessory: Size | null): Size {
  const has = accessory !== null && accessory.width > 0 && accessory.height > 0;
  const width = Math.max(main.width, has ? accessory!.width : 0);
  const height = main.height + (has ? accessory!.height + PILL.stackGap : 0);
  return { width: Math.ceil(width + 2 * PILL.shadowPad), height: Math.ceil(height + 2 * PILL.shadowPad) };
}
