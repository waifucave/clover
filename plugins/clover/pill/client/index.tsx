// The pill's client entry (spec §10): what the manifest's `ui` entry names, and its parts.

export { DispatchPill, type DispatchPillProps } from "../src/ui/DispatchPill";
export { Shell, type ShellProps } from "../src/ui/Shell";
export { Bar, Menu, Portrait, measureText, type BarProps, type BarMenu, type PillTarget } from "../src/ui/Bar";
export { CardBody, SealedCardBody, QuestionCardBody, type CardBodyProps } from "../src/ui/Card";
export { Preview, type PreviewProps } from "../src/ui/Preview";
export { Children, type ChildrenProps } from "../src/ui/Children";
export { Plume, drawPlume, plumeStill, BROWSER_FRAMES, PILL_EMITTER_INSET, type PlumeProps, type FrameTimers, type ScheduledThrow } from "../src/ui/Plume";
export { Glyph, GLYPHS, drawGlyph, type PillGlyphName } from "../src/ui/glyphs";
export {
  SealedKitContext,
  SealedCardIdProvider,
  EMPTY_KIT,
  useSealedKit,
  useSealedCardId,
  useCardTokens,
  resolveCardTokens,
  tokenProperty,
  PILL_CARD_SOURCES,
  MIN_SEALED_BUTTON,
  type CardTokenSource,
  type SealedCardKit,
  type SealedField,
} from "../src/ui/sealed";
export { ensurePillStyles, PILL_CSS } from "../src/ui/styles";
export * from "../src/model/metrics";
export * from "../src/model/spring";
export * from "../src/model/cards";
export * from "../src/model/children";
export * from "../src/model/preview";
export * from "../src/model/plume";
