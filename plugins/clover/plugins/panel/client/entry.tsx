// The column beside the conversation, on the runtime:
// - `SessionColumn` fills the shell's `panel` keyed `session`, for a coding session or an agent: its agents, where it
//   runs (the computer, its level, the root folder), context, connectors, outputs, and a coding session's changes
//   with the pull requests they became;
// - `BotColumn` fills `bot.side`, a bot's slim column (the owner's item 90): its coding agents and tasks, context and
//   outputs. Clicking an agent opens its live tab in the panel.
// The session, its agents and the computers come through the plugin API. Changes, outputs, context use and connectors
// have no plugin-API call yet: the `clover` layer reads them from the core (provisional methods, `session.changes`
// and the rest, for lanes A and D to settle).
import { outputsFolder } from "../../shell/runtime/files";
import { useEffect, useState } from "react";
import type { ComputerView, CoreClient, PluginApi, SessionView as Session } from "../../shell/runtime/types";
import { SessionView } from "./SessionView";
import { useCore, usePluginApi } from "./sdk";
import { S } from "./strings";
import type { SessionAgentStatus, SessionKind, SessionViewProps } from "./types";

function agentState(s: Session): SessionAgentStatus {
  if (s.needsYou && s.needsYou.cards + s.needsYou.questions > 0) return "needs-you";
  if (s.failure === "stalled") return "stalled";
  if (s.status === "failed") return "failed";
  if (s.status === "stopped") return "stopped";
  if (s.status === "idle") return "completed";
  return "running";
}

/** The folder a tree path names (`home/Studio/projects/clover` → `clover`), with where it sits. */
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
  context?: { used: number; tokens?: number; window?: number } | null;
  connectors?: { total: number; needSignIn: number };
}

/** Where a session's outputs live (`shell/runtime/files.ts`: the tree's name for its computer's Clover home). */
export { outputsFolder };

const PAGE = /\.(html?|md|markdown)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const SHOWN = 4;

/** A session's outputs, newest first, kept current while the folder changes. */
function useOutputs(api: PluginApi, session: Session | undefined): { items: { id: string; name: string; kind: "page" | "file" | "image" | "link" }[]; folder: string } | undefined {
  const [items, setItems] = useState<{ id: string; name: string; kind: "page" | "file" | "image" | "link" }[] | undefined>(undefined);
  const files = api.files;
  const folder = session ? outputsFolder(session) : undefined;
  useEffect(() => {
    if (!files || !folder) return;
    let live = true;
    const read = () =>
      void files.list(folder).then(
        (list) => {
          if (!live) return;
          setItems(
            // A link is listed as a link and never followed (the controller's note: a runner can leave one pointing
            // at another bot's data); only plain files open. The tree (lane J's) judges every real path.
            list
              .filter((f) => f.type === "file" || f.type === "symlink")
              .sort((a, b) => b.modifiedAt - a.modifiedAt)
              .map((f) => {
                const name = f.path.split("/").pop() ?? f.path;
                return { id: f.path, name, kind: f.type === "symlink" ? "link" : PAGE.test(name) ? "page" : IMAGE.test(name) ? "image" : "file" };
              }),
          );
        },
        () => live && setItems([]),
      );
    read();
    let stop: (() => void) | undefined;
    void files.watch?.(folder, () => read()).then((s) => (live ? (stop = s) : s()), () => undefined);
    return () => {
      live = false;
      stop?.();
    };
  }, [files, folder]);
  return items && folder ? { items, folder } : undefined;
}

/** The outputs section's props: the newest few, Show more for the rest, each opening in the right panel. */
function outputsProps(outputs: ReturnType<typeof useOutputs>, all: boolean, showAll: () => void, onOpen: ((path: string, folder: string) => void) | undefined): Partial<SessionViewProps> {
  if (!outputs || outputs.items.length === 0) return {};
  const items = all ? outputs.items : outputs.items.slice(0, SHOWN);
  const more = outputs.items.length - items.length;
  return { outputs: { items, onOpen: (id: string) => onOpen?.(id, outputs.folder), ...(more > 0 ? { more, onShowMore: showAll } : {}) } };
}

function useColumn(api: PluginApi, core: CoreClient | undefined, id: string | undefined, withChanges: boolean): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ agents: [], computers: [] });
  useEffect(() => {
    if (!id) return;
    let live = true;
    const quiet = <T,>(p: Promise<T> | undefined) => (p ? p.catch(() => undefined) : Promise.resolve(undefined));
    void Promise.all([
      quiet(api.conversation?.get?.(id)),
      quiet(api.conversation?.list?.()),
      quiet(api.computers?.list?.()),
      withChanges ? quiet(core?.call("session.changes", { id })) : Promise.resolve(undefined),
      quiet(core?.call("session.context", { id })),
      quiet(core?.call("session.connectors", { id })),
    ]).then(([session, sessions, computers, changes, context, connectors]) => {
      if (!live) return;
      setLoaded({
        ...(session ? { session } : {}),
        agents: (sessions ?? []).filter((s) => s.parent === id && (s.kind === "agent" || s.kind === "side-thread")),
        computers: computers ?? [],
        ...(changes ? { changes: { ...changes } } : {}),
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
  c ? { used: c.used, ...(c.tokens && c.window ? { detail: `${c.tokens.toLocaleString("en-US")} of ${c.window.toLocaleString("en-US")} tokens. Older turns are summarized near the limit.` } : {}) } : undefined;

export interface ColumnProps {
  session?: string;
  sessionKind?: SessionKind;
  /** The agent open in the panel now, and a way to open one there. */
  openAgent?: string;
  onOpenAgent?: (session: string) => void;
  /** Opens one of the session's outputs (a tree path) in the right panel. */
  onOpenOutput?: (path: string, folder: string) => void;
  /** Where `main` goes: the shell's (a question for B, as for the sidebar). */
  navigate?: (route: { route: string; params: Record<string, string> }) => void;
}

/** A coding session's or an agent's column: `panel` keyed `session`. */
export function SessionColumn({ props }: { props: ColumnProps }) {
  const api = usePluginApi();
  const core = useCore();
  const kind = props.sessionKind ?? "coding";
  const data = useColumn(api, core, props.session, kind === "coding");
  const outputs = useOutputs(api, data.session);
  const [allOutputs, setAllOutputs] = useState(false);
  const s = data.session;
  if (!s) return null;
  const computer = data.computers.find((c) => c.name === s.computer);
  const environment: SessionViewProps["environment"] = {
    computer: s.computer,
    here: computer?.link === "self",
    // A level change is a sealed card from every layer (§5.5); Change opens Settings' Levels page, where the pick
    // raises it.
    ...(computer
      ? { level: { label: S.levelName(computer.level), ...(props.navigate ? { onChange: () => props.navigate!({ route: "settings", params: { section: "levels" } }) } : {}) } }
      : {}),
    folders: s.root ? [folder(s.root)] : [],
  };
  return (
    <SessionView
      kind={kind}
      agents={data.agents.map((a) => ({ id: a.id, title: a.title ?? a.backend ?? a.id, backend: a.backend ?? "", status: agentState(a) }))}
      {...(props.onOpenAgent ? { onOpenAgent: props.onOpenAgent } : {})}
      environment={environment}
      {...(data.context ? { context: contextOf(data.context)! } : {})}
      {...(data.connectors ? { connectors: data.connectors } : {})}
      {...outputsProps(outputs, allOutputs, () => setAllOutputs(true), props.onOpenOutput)}
      {...(data.changes ? { changes: data.changes } : {})}
    />
  );
}

/** A bot's slim column: `bot.side`. */
export function BotColumn({ props }: { props: ColumnProps & { bot?: { id: string; name: string } } }) {
  const api = usePluginApi();
  const core = useCore();
  const data = useColumn(api, core, props.session, false);
  const outputs = useOutputs(api, data.session);
  const [allOutputs, setAllOutputs] = useState(false);
  if (!props.session) return null;
  return (
    <SessionView
      kind="bot"
      agents={data.agents.map((a) => ({ id: a.id, title: a.title ?? a.backend ?? a.id, backend: a.kind === "side-thread" ? "Task" : (a.backend ?? ""), status: agentState(a) }))}
      {...(props.onOpenAgent ? { onOpenAgent: props.onOpenAgent } : {})}
      {...(props.openAgent ? { openAgent: props.openAgent } : {})}
      {...(data.context ? { context: contextOf(data.context)! } : {})}
      {...outputsProps(outputs, allOutputs, () => setAllOutputs(true), props.onOpenOutput)}
    />
  );
}
