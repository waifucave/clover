// A stand-in for the plugin SDK's UI API (spec §5.5), written against lane B's declarations in
// `packages/plugin-sdk/src/api/ui-api.ts` (B-M0, cde691273) and the card data in
// `packages/protocol/src/approvals.ts`. Lane E builds the real module; in M2 this file becomes a
// re-export of it. Until then a host (the gallery, the tests) provides an implementation through
// <UiRuntimeProvider>. The view never sees a sealed field's text or an option's label: it only says
// where each frame goes.
//
// Each part takes `className` (B pinned it); this view still wraps each sealed part in an element of its
// own and passes none, so its layout never depends on how the core draws a frame.
import { createContext, useContext, type ReactNode } from "react";
import { S } from "./strings";

/** Every sealed field a card may have, in lane B's order (`CARD_FIELD_NAMES`). A field the card
 *  doesn't have draws nothing. */
export const SEALED_FIELDS = [
  "title", "what", "command", "computer", "risk", "reason", "source", "host", "paths", "detail", "expires",
] as const;
export type SealedField = (typeof SEALED_FIELDS)[number];

/** What a card is about (lane B's `CARD_KINDS`). */
export type CardKind = "tool" | "agent-permission" | "plugin-ok" | "change" | "confirm" | "elicitation";

/** An option as a plugin hears it: its id and kind, and whether it is the "always" one; never its label. */
export interface CardOptionMeta {
  id: string;
  kind: "approve" | "deny";
  remember?: "always";
}

export interface CardButtonProps {
  /** A named option; absent, the first of the button's kind. */
  option?: string;
  look?: "label" | "check" | "cross" | "open";
  size?: number;
  className?: string;
}

export interface UiRuntime {
  /** A sealed card's frame set for one card id. */
  Card: (props: { id: string; children: ReactNode; className?: string }) => ReactNode;
  /** One sealed field of the card around it. */
  CardField: (props: { name: SealedField; lines?: number; className?: string }) => ReactNode;
  CardApprove: (props: CardButtonProps) => ReactNode;
  CardDeny: (props: CardButtonProps) => ReactNode;
  /** An MCP Apps page for a tool call, in its isolated view. */
  AppView: (props: { call: { session: string; callId: string }; className?: string }) => ReactNode;
}

const RuntimeContext = createContext<UiRuntime | null>(null);

export function UiRuntimeProvider({ runtime, children }: { runtime: UiRuntime; children: ReactNode }) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

function useRuntime(): UiRuntime | null {
  return useContext(RuntimeContext);
}

function CardRoot(props: { id: string; children: ReactNode; className?: string }) {
  const runtime = useRuntime();
  if (!runtime) return <div data-sealed-unavailable="">{S.sealedUnavailable}</div>;
  return <>{runtime.Card(props)}</>;
}

function Field(props: { name: SealedField; lines?: number; className?: string }) {
  const runtime = useRuntime();
  return runtime ? <>{runtime.CardField(props)}</> : null;
}

function Approve(props: CardButtonProps) {
  const runtime = useRuntime();
  return runtime ? <>{runtime.CardApprove(props)}</> : null;
}

function Deny(props: CardButtonProps) {
  const runtime = useRuntime();
  return runtime ? <>{runtime.CardDeny(props)}</> : null;
}

export const Card = Object.assign(CardRoot, { Field, Approve, Deny });

export function AppView(props: { call: { session: string; callId: string }; className?: string }) {
  const runtime = useRuntime();
  return runtime ? <>{runtime.AppView(props)}</> : null;
}
