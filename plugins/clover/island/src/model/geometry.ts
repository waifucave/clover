// The island's geometry, ported from Winter's `IslandLayout` and `DesktopIslandGeometry`
// (apple/Winter/Sources/Island/IslandLayout.swift, WinterCUPresentation/Platform/DesktopIsland.swift).
// CSS pixels, top-left origin. Strip and island rects are given with x measured from the screen's
// horizontal centre (the island always hangs centred under the housing); a card's geometry is in its
// own panel's space. Pure.

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The top of the island's screen: its camera housing (null without one) and its menu bar's height. */
export interface ScreenShape {
  housing: Size | null;
  menuBarHeight: number;
}

export const ISLAND = {
  /** Each side of the housing the strip extends it by, for its icon and count. */
  stripWing: 46,
  /** Without a housing: a short black tab hanging from the top centre. */
  stripWidthWithoutHousing: 112,
  stripCorner: 10,
  /** Room around the strip for its dark hover glow. */
  stripGlowMargin: 14,
  cardWidth: 400,
  cardCorner: 24,
  cardPadding: 16,
  waitingHeight: 32,
  waitingWidth: 280,
  waitingGap: 8,
  rowCorner: 16,
  rowGap: 8,
  listInset: 14,
  innerCardCorner: 28,
  headerInset: 20,
  /** One size for every tab: 560 is the island family's widest (the typing Dispatch pill). */
  islandWidth: 560,
  islandHeight: 168,
  islandCorner: 32,
  islandShoulder: 14,
  islandMaxScreenFraction: 0.6,
  /** Without a housing the open island's header is its own row. */
  headerHeight: 46,
} as const;

/** The desktop-switch pill's own numbers, which the island's cards take (DesktopIslandGeometry). */
export const LIQUID = {
  pillHeight: 44,
  /** Between the housing (or the menu bar) and the resting card. */
  gap: 10,
  /** Room for the shadow around the card inside its panel. */
  margin: 24,
  /** While the shape still moves, the content blurs by how far it has to go. */
  maxMorphBlur: 8,
  morphBlurFalloff: 12,
} as const;

export function topInset(shape: ScreenShape): number {
  return shape.housing ? shape.housing.height : Math.max(shape.menuBarHeight, 22);
}

/**
 * The strip's rect (x from the centre), or null when it is not there. While nothing waits or works it is
 * exactly the housing (black on black: nothing a menu could have is covered), and without a housing
 * there is none at all.
 */
export function stripRect(shape: ScreenShape, showsWings: boolean): Rect | null {
  if (!showsWings) {
    if (!shape.housing) return null;
    const { width, height } = shape.housing;
    return { x: -width / 2, y: 0, width, height };
  }
  if (shape.housing) {
    const width = shape.housing.width + 2 * ISLAND.stripWing;
    return { x: -width / 2, y: 0, width, height: shape.housing.height };
  }
  const height = Math.max(shape.menuBarHeight, 22);
  return { x: -ISLAND.stripWidthWithoutHousing / 2, y: 0, width: ISLAND.stripWidthWithoutHousing, height };
}

export type StripPart = "waitingWing" | "housing" | "workingWing";

export interface StripCounts {
  waiting: number;
  working: number;
}

export function showsWings(counts: StripCounts): boolean {
  return counts.waiting > 0 || counts.working > 0;
}

/** Which part of the strip a point is over (x from the centre), null outside it. An empty wing is the housing's. */
export function stripPartAt(point: { x: number; y: number }, shape: ScreenShape, counts: StripCounts): StripPart | null {
  const rect = stripRect(shape, showsWings(counts));
  if (!rect || !contains(rect, point)) return null;
  const waiting = counts.waiting > 0;
  const working = counts.working > 0;
  if (shape.housing) {
    if (point.x < -shape.housing.width / 2) return waiting ? "waitingWing" : "housing";
    if (point.x > shape.housing.width / 2) return working ? "workingWing" : "housing";
    return "housing";
  }
  if (waiting && working) return point.x < 0 ? "waitingWing" : "workingWing";
  if (waiting) return "waitingWing";
  if (working) return "workingWing";
  return "housing";
}

export type StripAction = { kind: "open"; tab: string | null } | { kind: "select"; tab: string } | { kind: "close" };

/** The tab a part opens the island on (null: the one it was on). */
export function tabForPart(part: StripPart, tabs: { needsYou: string; working: string }): string | null {
  if (part === "waitingWing") return tabs.needsYou;
  if (part === "workingWing") return tabs.working;
  return null;
}

/** Closed: open on the wing's tab. Open: a wing whose tab is not showing switches to it; anything else closes. */
export function stripAction(tab: string | null, isOpen: boolean, selectedTab: string | null): StripAction {
  if (!isOpen) return { kind: "open", tab };
  if (tab !== null && tab !== selectedTab) return { kind: "select", tab };
  return { kind: "close" };
}

/** The open island's rect (x from the centre): fixed for every tab; a short screen clamps its height. */
export function islandRect(shape: ScreenShape, screenHeight?: number): Rect {
  let height: number = ISLAND.islandHeight;
  if (screenHeight !== undefined && screenHeight > 0) {
    height = Math.min(height, Math.max(topInset(shape) + 160, Math.floor(screenHeight * ISLAND.islandMaxScreenFraction)));
  }
  return { x: -ISLAND.islandWidth / 2, y: 0, width: ISLAND.islandWidth, height };
}

/** Where a floating card is born and comes to rest, in its own panel (DesktopIslandGeometry). */
export interface CardGeometry {
  panelSize: Size;
  /** What the card is born from: the housing, or a thin strip at the top edge without one. */
  source: Rect;
  sourceIsHousing: boolean;
  /** Where the card rests. */
  card: Rect;
  /** A second card grows in place, born from nothing. */
  floating: boolean;
  /** null for a capsule, a radius for a rounded rectangle. */
  cornerRadius: number | null;
}

export function cardGeometry(shape: ScreenShape, size: Size, options: { rounded: boolean; slot?: number }): CardGeometry {
  const m = LIQUID.margin;
  if ((options.slot ?? 0) > 0) {
    return {
      panelSize: { width: size.width + 2 * m, height: size.height + 2 * m },
      source: { x: 0, y: 0, width: 0, height: 0 },
      sourceIsHousing: false,
      card: { x: m, y: m, width: size.width, height: size.height },
      floating: true,
      cornerRadius: options.rounded ? ISLAND.cardCorner : null,
    };
  }
  const housing = shape.housing && shape.housing.width > 0 && shape.housing.height > 0 ? shape.housing : null;
  const top = housing ? housing.height : Math.max(shape.menuBarHeight, 22);
  const sourceWidth = housing ? housing.width : 120;
  const width = Math.max(size.width, sourceWidth) + 2 * m;
  const source = { x: (width - sourceWidth) / 2, y: 0, width: sourceWidth, height: housing ? top : 0 };
  const card = { x: (width - size.width) / 2, y: top + LIQUID.gap, width: size.width, height: size.height };
  return {
    panelSize: { width, height: card.y + card.height + m },
    source,
    sourceIsHousing: housing !== null,
    card,
    floating: false,
    cornerRadius: options.rounded ? ISLAND.cardCorner : null,
  };
}

/** The waiting pill's rect inside a card's panel: just below the card. */
export function waitingRect(geometry: CardGeometry): Rect {
  const { card } = geometry;
  return {
    x: card.x + card.width / 2 - ISLAND.waitingWidth / 2,
    y: card.y + card.height + ISLAND.waitingGap,
    width: ISLAND.waitingWidth,
    height: ISLAND.waitingHeight,
  };
}

/** The content's blur for a shape of `size` heading to `target`: none within `morphBlurFalloff` of it. */
export function morphBlur(size: Size, target: Size): number {
  const remaining = Math.max(Math.abs(target.width - size.width), Math.abs(target.height - size.height));
  const radius = Math.min(LIQUID.maxMorphBlur, remaining / LIQUID.morphBlurFalloff);
  return radius < 0.25 ? 0 : radius;
}

export function contains(rect: Rect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}
