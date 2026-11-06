// The sidebar on the runtime: the `sidebar` entry. It reads the bots (`bots.read`), their sessions and the coding
// sessions (`conversation.read`) through the plugin API, draws each bot's row through `sidebar.bot` keyed by bot (its
// own row when no plugin fills the key), and shows the `sidebar.app` entries as app buttons, each opening the `main`
// key its `opens` field names.
//
// The shell hands it where `main` is (`route`) and a way to go elsewhere (`navigate`): B's catalog gives `sidebar` no
// props, so how the sidebar moves the shell is a question for B and E.
import { useEffect, useState, type ReactNode } from "react";
import type { BotView, SessionView } from "../../shell/runtime/types";
import { isCloverTree } from "../../shell/runtime/ui";
import { plain } from "../../shell/runtime/views";
import { Sidebar } from "./Sidebar";
import { Spot, useCore, useSpotEntries, usePluginApi } from "./sdk";
import type { AgentStatus, AppGlyph, BotStatus, SidebarApp, SidebarBot, SidebarProject, SidebarRoute, SidebarSide } from "./types";

/** `main`'s route, as the shell holds it. */
export interface ShellRoute {
  route: string;
  params: Record<string, string>;
}

export interface SidebarEntryProps {
  route: ShellRoute;
  navigate: (route: ShellRoute) => void;
  /** Search: the shell's command palette, when it has one. */
  onSearch?: () => void;
}

/** The shell's route as the sidebar's, and back. */
export function toSidebarRoute(r: ShellRoute): SidebarRoute {
  switch (r.route) {
    case "bot":
      return { kind: "bot", botId: r.params.bot ?? "" };
    case "agent":
      return { kind: "agent", agentId: r.params.session ?? "" };
    case "settings":
      return { kind: "settings" };
    case "plugins":
      return { kind: "plugins" };
    default:
      return { kind: "app", appId: r.route };
  }
}

export function toShellRoute(r: SidebarRoute): ShellRoute {
  switch (r.kind) {
    case "bot":
      return { route: "bot", params: { bot: r.botId } };
    case "agent":
      return { route: "agent", params: { session: r.agentId } };
    case "settings":
      return { route: "settings", params: {} };
    case "plugins":
      return { route: "plugins", params: {} };
    case "app":
      return { route: r.appId, params: {} };
  }
}

/** A session's status as the sidebar draws it. */
export function agentStatus(s: SessionView): AgentStatus {
  if (s.needsYou && s.needsYou.cards + s.needsYou.questions > 0) return "needs-you";
  if (s.failure === "stalled") return "stalled";
  switch (s.status) {
    case "starting":
    case "ready":
    case "prompting":
    case "cancelling":
      return "running";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "idle":
      return "completed";
  }
}

/** A bot's state as the sidebar draws it: what waits for the user comes first. */
export function botStatus(b: BotView, main: SessionView | undefined): BotStatus {
  if (main?.needsYou && main.needsYou.cards + main.needsYou.questions > 0) return "needs-you";
  if (b.state === "asleep" || b.state === "paused") return b.state;
  if (b.state === "thinking") return main?.status === "prompting" ? "working" : "thinking";
  return "idle";
}

/** The folder a tree path names, and its parent's name, for a project's label. */
const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** The shell's own glyphs for the apps we ship, by what they open. */
const GLYPHS: Record<string, AppGlyph> = { archive: "archive", usage: "chart", browser: "globe", plugins: "grid" };

export function SidebarEntry({ props }: { props: SidebarEntryProps }) {
  const api = usePluginApi();
  const [bots, setBots] = useState<BotView[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [side, setSide] = useState<SidebarSide>("bots");
  const [collapsed, setCollapsed] = useState(false);
  const [account, setAccount] = useState<{ name: string; detail?: string }>({ name: "" });
  const core = useCore();

  useEffect(() => {
    let live = true;
    // The account row: who is signed in, and which computer this is.
    void Promise.all([core?.call("account.status", {}).catch(() => undefined), api.computers?.list?.().catch(() => [])]).then(([a, computers]) => {
      if (!live) return;
      const here = computers?.find((c) => c.link === "self");
      const name = a?.user?.name ?? a?.user?.email ?? here?.name ?? "";
      setAccount({ name, ...(here && name !== here.name ? { detail: here.name } : {}) });
    });
    api.bots?.list().then((b) => live && setBots(b), () => undefined);
    api.conversation?.list?.().then((s) => live && setSessions(s), () => undefined);
    const stop = api.bots?.watch((b) => setBots((list) => (list.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? b : x)) : [...list, b])));
    return () => {
      live = false;
      stop?.();
    };
  }, [api, core]);

  // A coding session's tab shows the code side.
  const shown = props.route.route === "agent" ? sessions.find((s) => s.id === props.route.params.session) : undefined;
  useEffect(() => {
    if (shown?.kind === "coding") setSide("code");
  }, [shown?.kind]);

  const sidebarBots: SidebarBot[] = bots.map((b) => {
    const main = sessions.find((s) => s.id === b.mainSession);
    const agents = sessions.filter((s) => s.kind === "agent" && (s.parent === b.mainSession || s.bot === b.id));
    return {
      id: b.id,
      name: plain(b.name),
      ...(b.portrait ? { portraitUrl: b.portrait } : {}),
      state: botStatus(b, main),
      ...(main?.needsYou ? { needsYou: main.needsYou } : {}),
      agents: agents.map((a) => ({ id: a.id, title: a.title ?? a.backend ?? a.id, backend: a.backend ?? "", computer: a.computer, status: agentStatus(a) })),
    };
  });

  const projects: SidebarProject[] = [];
  const where = new Map<string, { computer: string; root: string }>();
  for (const s of sessions.filter((x) => x.kind === "coding")) {
    const path = s.root ?? `home/${s.computer}`;
    let project = projects.find((p) => p.path === path);
    if (!project) {
      projects.push((project = { id: path, name: folderName(path), path, sessions: [] }));
      where.set(path, { computer: s.computer, root: path });
    }
    // The branch and how many files it changed, once lane B's session view carries them (asked).
    const git = s as typeof s & { branch?: string; changes?: number };
    project.sessions.push({
      id: s.id,
      title: s.title ?? s.id,
      status: s.status === "idle" ? "idle" : agentStatus(s),
      ...(s.needsYou ? { needsYou: s.needsYou } : {}),
      ...(s.backend ? { backend: s.backend } : {}),
      computer: s.computer,
      ...(typeof git.branch === "string" ? { branch: git.branch } : {}),
      ...(typeof git.changes === "number" ? { changes: git.changes } : {}),
    });
  }

  // A new coding session in a project: lane K's `agent.start`, on the project's computer and folder, with the first
  // backend installed there; it opens as the agent's live tab.
  const startIn = (projectId: string) => {
    const at = where.get(projectId);
    if (!core || !at) return;
    void core.call("agent.backends", {}).then(({ backends }) => {
      const backend = backends.find((b) => b.computers.some((c) => c.computer === at.computer && c.installed));
      if (!backend) return;
      return core.call("agent.start", { backend: backend.id, computer: at.computer, root: at.root }).then(({ session }) => props.navigate({ route: "agent", params: { session } }));
    }, () => undefined);
  };

  const apps: SidebarApp[] = useSpotEntries("sidebar.app").entries.flatMap((e) => {
    const opens = e.fields?.opens;
    const title = e.fields?.title;
    if (typeof opens !== "string" || typeof title !== "string") return [];
    // The apps Clover ships wear the shell's own glyphs, drawn in the text colour; another plugin's, its icon.
    const glyph = GLYPHS[opens];
    const icon = isCloverTree(e.pluginId) && glyph ? { glyph } : typeof e.fields?.icon === "string" ? { url: e.fields.icon } : glyph ? { glyph } : undefined;
    return [{ id: opens, title, ...(icon ? { icon } : {}) }];
  });

  const go = (r: SidebarRoute) => props.navigate(toShellRoute(r));

  return (
    <Sidebar
      side={side}
      onSideChange={setSide}
      route={toSidebarRoute(props.route)}
      onNavigate={go}
      bots={sidebarBots}
      projects={projects}
      apps={apps}
      account={account}
      onOpenSettings={() => go({ kind: "settings" })}
      onPlugins={() => go({ kind: "plugins" })}
      {...(core && projects.length > 0 ? { onNewSession: startIn } : {})}
      {...(core && side === "code" && projects[0] ? { onNew: () => startIn(projects[0]!.id) } : {})}
      {...(props.onSearch ? { onSearch: props.onSearch } : {})}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
      renderBot={(bot, standard: ReactNode) => {
        const view = bots.find((b) => b.id === bot.id);
        return (
          <Spot
            name="sidebar.bot"
            spotKey={bot.id}
            props={{ bot: { id: bot.id, name: bot.name }, selected: props.route.route === "bot" && props.route.params.bot === bot.id, state: view?.state ?? "idle", needsYou: bot.needsYou ?? { cards: 0, questions: 0 } }}
            fallback={standard}
          />
        );
      }}
    />
  );
}
