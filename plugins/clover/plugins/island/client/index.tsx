// The island's client entry (spec §10): what the manifest's `ui` entry names, and the parts other
// surfaces of the island family reuse.

export { IslandApp, DevicesTabEntry, IslandHostContext, useIslandHost, type IslandHost, type IslandEntryProps } from "../src/ui/host";
export { Island, BROWSER_TIMERS, type IslandProps, type IslandTabEntry, type IslandTimers } from "../src/ui/Island";
export { IslandSurface, type IslandSurfaceProps, type SurfaceHostApi } from "../src/ui/IslandSurface";
export { DevicesTab, DevicesList, type DevicesSource } from "../src/ui/DevicesTab";
export { Strip, stripLabel, type StripProps } from "../src/ui/Strip";
export { LiquidCard, Melt, restingFluid, HOVER_EASING, type LiquidCardProps } from "../src/ui/Liquid";
export { WaitingPill, type WaitingPillProps } from "../src/ui/WaitingPill";
export { OpenIsland, OpenHeader, TabDots, TabScroll, EmptyTab, NeedsYou, openFrame, type OpenIslandProps, type NeedsYouProps } from "../src/ui/OpenIsland";
export { SealedCardContent, QuestionCardContent, type SealedCardContentProps, type QuestionCardContentProps } from "../src/ui/CardContent";
export { CircleButton, SealedSlot } from "../src/ui/Buttons";
export { LiftRow, RowWords, StatusWord, StatusMarkView, GroupTitle, LinkWords, ActionWords, type StatusMark, type ActionTone } from "../src/ui/rows";
export {
  SealedKitContext,
  SealedCardIdProvider,
  EMPTY_KIT,
  useSealedKit,
  useSealedCardId,
  useCardTokens,
  resolveCardTokens,
  tokenProperty,
  ISLAND_CARD_SOURCES,
  MIN_SEALED_BUTTON,
  type CardTokenSource,
  type SealedCardKit,
  type SealedField,
} from "../src/ui/sealed";
export { Glyph, type GlyphName } from "../src/ui/glyphs";
export { ensureIslandStyles, ISLAND_CSS } from "../src/ui/styles";
export * from "../src/model/cards";
export * from "../src/model/geometry";
export { IslandQueue } from "../src/model/queue";
export { fluidFrame, fluidSeconds, FLUID, type FluidFrame } from "../src/model/fluid";
export { morphFrame, edgeShapePath, MORPH, type MorphFrame } from "../src/model/morph";
export { NEEDS_YOU, OWN_PLUGIN, isOwnPlugin, guestTabs, isReservedTab, isReservedPluginName, tabState, swipe, select, selectedTab, showsDots, type IslandTab, type GuestTab, type TabState } from "../src/model/tabs";
export { nameSkeleton, readsAs, shownName } from "../src/model/names";
export { hoverScale, isOver, grownFromTop } from "../src/model/hover";
export * from "../src/model/placement";
export * from "../src/model/devices";
