// A stand-in for the plugin SDK's UI API (spec §5.5), which lane E builds in
// `packages/plugin-sdk/src/ui/`. The components below use exactly the names the spec gives:
//   <Card id> with <Card.Field name>, <Card.Approve> and <Card.Deny>: the core's sealed frames
//   <AppView call>: an MCP Apps page where a tool's result shows
// In M2 this file becomes a re-export of the real module; until then a host (the gallery, the tests)
// provides an implementation through <UiRuntimeProvider>. The view never sees a sealed field's text:
// it only says where each frame goes.
import { createContext, useContext, type ReactNode } from "react";
import { S } from "./strings";

/** The sealed fields this view places, in the order it places them. Names to confirm against the
 *  card data lane C pins (plan, C-M3). */
export const SEALED_FIELDS = ["title", "command", "computer", "risk", "reason"] as const;
export type SealedField = (typeof SEALED_FIELDS)[number];

export interface UiRuntime {
  /** A sealed card's frame set for one card id. */
  Card: (props: { id: string; children: ReactNode; className?: string }) => ReactNode;
  /** One sealed field of the card around it. */
  CardField: (props: { name: SealedField; className?: string }) => ReactNode;
  CardApprove: (props: { className?: string }) => ReactNode;
  CardDeny: (props: { className?: string }) => ReactNode;
  /** An MCP Apps page for a tool call, in its isolated view. */
  AppView: (props: { call: string; className?: string }) => ReactNode;
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
  if (!runtime) {
    return (
      <div className={props.className} data-sealed-unavailable="">
        {S.sealedUnavailable}
      </div>
    );
  }
  return <>{runtime.Card(props)}</>;
}

function Field(props: { name: SealedField; className?: string }) {
  const runtime = useRuntime();
  return runtime ? <>{runtime.CardField(props)}</> : null;
}

function Approve(props: { className?: string }) {
  const runtime = useRuntime();
  return runtime ? <>{runtime.CardApprove(props)}</> : null;
}

function Deny(props: { className?: string }) {
  const runtime = useRuntime();
  return runtime ? <>{runtime.CardDeny(props)}</> : null;
}

export const Card = Object.assign(CardRoot, { Field, Approve, Deny });

export function AppView(props: { call: string; className?: string }) {
  const runtime = useRuntime();
  return runtime ? <>{runtime.AppView(props)}</> : null;
}
