// The column beside the conversation, on the runtime:
// - `SessionColumn` fills the shell's `panel` keyed `session`, for a coding session or an agent: its agents, where it
//   runs (the computer, its level, the root folder), context, connectors, outputs, and a coding session's changes
//   with the pull requests they became. Clicking an agent opens its live tab in the panel.
// The session, its agents and the computers come through the plugin API. Changes, outputs, context use and connectors
// have no plugin-API call yet: the `moss` layer reads them from the core (provisional methods, `session.changes`
// and the rest, for lanes A and D to settle).
import type { ComputerView, PluginApi, SessionView as Session } from "@waifucave/moss-plugin-sdk";
import { type CoreClient, useBackendNames, useCore, usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect, useState } from "react";
import { SessionView } from "./SessionView";
import type { SessionAgentStatus, SessionKind, SessionViewProps } from "./types";

const LEVEL_LABELS: Record<string, string> = {
  "read-only": "Read only",
  ask: "Ask first",
  "ask-risky": "Ask when risky",
  "accept-edits": "Accept edits",
  automatic: "Fully automatic",
};

function agentState(s: Session): SessionAgentStatus {
  if (s.needsYou && s.needsYou.cards + s.needsYou.questions > 0) return "needs-you";
  if (s.failure === "stalled") return "stalled";
  if (s.status === "failed") return "failed";
  if (s.status === "stopped") return "stopped";
  if (s.status === "idle") return "completed";
  return "running";
}

/** The folder a tree path names (`home/Studio/projects/moss` → `moss`), with where it sits. */
function folder(path: string): { name: string; path: string } {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop() ?? path;
  const at = parts.length > 2 ? `~/${parts.slice(2).join("/")}` : undefined;
  return { name: at ? `${name} · ${at}` : name, path };
}

interface Loaded {
  session?: Session;
  agents: Session[];
  computers: ComputerView[];
  changes?: SessionViewProps["changes"];
  outputs?: { items: { id: string; name: string; kind: "page" | "file" | "image" }[]; more: number };
  context?: { used: number; tokens?: number; window?: number } | { reported: false } | null;
  connectors?: { total: number; needSignIn: number };
}

function useColumn(api: PluginApi, core: CoreClient | undefined, id: string | undefined, withChanges: boolean): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ agents: [], computers: [] });
  useEffect(() => {
    if (!id) return;
    let live = true;
    const quiet = <T,>(p: Promise<T> | undefined) => (p ? p.catch(() => undefined) : Promise.resolve(undefined));
    void Promise.all([
      quiet(api.sessions?.get?.(id)),
      quiet(api.sessions?.list?.()),
      quiet(api.computers?.list?.()),
      withChanges ? quiet(core?.call("session.changes", { id })) : Promise.resolve(undefined),
      quiet(core?.call("session.outputs", { id, limit: 4 })),
      quiet(core?.call("session.context", { id })),
      quiet(core?.call("session.connectors", { id })),
    ]).then(([session, sessions, computers, changes, outputs, context, connectors]) => {
      if (!live) return;
      setLoaded({
        ...(session ? { session } : {}),
        agents: (sessions ?? []).filter((s) => s.parent === id && (s.kind === "agent" || s.kind === "side-thread")),
        computers: computers ?? [],
        ...(changes ? { changes: { ...changes } } : {}),
        ...(outputs ? { outputs } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(connectors ? { connectors } : {}),
      });
    });
    return () => {
      live = false;
    };
  }, [api, core, id, withChanges]);
  return loaded;
}

const contextOf = (c: Loaded["context"]): SessionViewProps["context"] =>
  !c ? undefined
    // The agent reports none: said as such, with no meter.
    : "reported" in c ? { notReported: true }
    : { used: c.used, ...(c.tokens && c.window ? { detail: `${c.tokens.toLocaleString("en-US")} of ${c.window.toLocaleString("en-US")} tokens. Older turns are summarized near the limit.` } : {}) };

export interface ColumnProps {
  session?: string;
  sessionKind?: SessionKind;
  /** The agent open in the panel now, and a way to open one there. */
  openAgent?: string;
  onOpenAgent?: (session: string) => void;
  /** Where `main` goes: the shell's (a question for B, as for the sidebar). */
  navigate?: (route: { route: string; params: Record<string, string> }) => void;
}

/** A coding session's or an agent's column: `panel` keyed `session`. */
export function SessionColumn({ props }: { props: ColumnProps }) {
  const api = usePluginApi();
  const core = useCore();
  const nameOf = useBackendNames();
  const kind = props.sessionKind ?? "coding";
  const data = useColumn(api, core, props.session, kind === "coding");
  const s = data.session;
  if (!s) return null;
  const computer = data.computers.find((c) => c.name === s.computer);
  const environment: SessionViewProps["environment"] = {
    computer: s.computer,
    here: computer?.link === "self",
    // A level change is a sealed card from every layer (§5.5); Change opens Settings' Levels page, where the pick
    // raises it.
    ...(computer
      ? { level: { label: LEVEL_LABELS[computer.level] ?? computer.level, ...(props.navigate ? { onChange: () => props.navigate!({ route: "settings", params: { section: "levels" } }) } : {}) } }
      : {}),
    folders: s.root ? [folder(s.root)] : [],
  };
  return (
    <SessionView
      kind={kind}
      agents={data.agents.map((a) => ({ id: a.id, title: a.title ?? nameOf(a.backend) ?? a.id, backend: nameOf(a.backend) ?? "", status: agentState(a) }))}
      {...(props.onOpenAgent ? { onOpenAgent: props.onOpenAgent } : {})}
      environment={environment}
      {...(data.context ? { context: contextOf(data.context)! } : {})}
      {...(data.connectors ? { connectors: data.connectors } : {})}
      {...(data.outputs && data.outputs.items.length > 0 ? { outputs: { items: data.outputs.items, onOpen: () => undefined, ...(data.outputs.more ? { more: data.outputs.more, onShowMore: () => undefined } : {}) } } : {})}
      {...(data.changes ? { changes: { ...data.changes, ...(core ? { onCreatePr: () => void core.call("session.createPr", { id: s.id }) } : {}) } } : {})}
    />
  );
}
