// The sidebar on the runtime: the `sidebar` entry. It reads the code sessions (`sessions.read`) through the plugin API
// and lists them by project folder (MOSS Code's window has no bots, spec §9.4), offers New (the shell's page that
// starts a session), and shows the `sidebar.app` entries as app buttons, each opening the `main` key its `opens` field
// names.
//
// The shell hands it where `main` is (`route`) and a way to go elsewhere (`navigate`): B's catalog gives `sidebar` no
// props, so how the sidebar moves the shell is a question for B and E.
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import { fieldText } from "./local";
import { Spot, useCore, useSpotEntries, usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import type { AgentStatus, AppGlyph, SidebarApp, SidebarProject, SidebarRoute } from "./types";

/** `main`'s route, as the shell holds it. */
export interface ShellRoute {
  route: string;
  params: Record<string, string>;
}

export interface SidebarEntryProps {
  route: ShellRoute;
  navigate: (route: ShellRoute) => void;
  /** The shell holds whether the sidebar is a rail of icons: set, the sidebar follows it. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

/** The shell's route as the sidebar's, and back. */
export function toSidebarRoute(r: ShellRoute): SidebarRoute {
  switch (r.route) {
    case "new":
      return { kind: "new" };
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
    case "new":
      return { route: "new", params: {} };
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
      // A coding session whose last turn failed stays open (idle), and reads failed until a turn ends well.
      return s.failure !== undefined ? "failed" : "completed";
  }
}

/** A session that has been archived leaves the sidebar's lists (the Archive page is where it lives). One that has stopped or
 *  failed stays, marked, so what ended and what went wrong are seen. */
export function leftTheList(s: SessionView): boolean {
  return s.archived === true;
}


/** The folder a tree path names, and its parent's name, for a project's label. */
const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** The shell's own glyphs for the apps we ship, by what they open. */
const GLYPHS: Record<string, AppGlyph> = { archive: "archive", usage: "chart", browser: "globe", plugins: "grid" };

export function SidebarEntry({ props }: { props: SidebarEntryProps }) {
  const api = usePluginApi();
  const [sessions, setSessions] = useState<SessionView[]>([]);
  // The shell may hold the state (its own sidebar button toggles it); on its own it is local.
  const [ownCollapsed, setOwnCollapsed] = useState(false);
  const collapsed = props.collapsed ?? ownCollapsed;
  const setCollapsed = (next: (c: boolean) => boolean): void => {
    const v = next(collapsed);
    if (props.onCollapsedChange) props.onCollapsedChange(v);
    else setOwnCollapsed(v);
  };
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
    api.sessions?.list?.().then((s) => live && setSessions(s), () => undefined);
    // A session started outside the window (the CLI, another window, a bot's coding task) or changed anywhere shows
    // without a remount (`sessions.watch`, code sessions only).
    const stop = api.sessions?.watch?.((v: SessionView) => setSessions((list) => (list.some((x) => x.id === v.id) ? list.map((x) => (x.id === v.id ? v : x)) : [...list, v])));
    return () => {
      live = false;
      stop?.();
    };
  }, [api, core]);

  // Code sessions by project folder: a coding session the person started, and a bot's coding task (an agent), which is
  // a code session too.
  const projects: SidebarProject[] = [];
  for (const s of sessions.filter((x) => (x.kind === "coding" || x.kind === "agent") && !leftTheList(x))) {
    const path = s.root ?? `home/${s.computer}`;
    let project = projects.find((p) => p.path === path);
    if (!project) projects.push((project = { id: path, name: folderName(path), path, sessions: [] }));
    project.sessions.push({
      id: s.id,
      title: s.title ?? s.id,
      status: s.status === "idle" && s.failure === undefined ? "idle" : agentStatus(s),
      ...(s.needsYou ? { needsYou: s.needsYou } : {}),
      ...(s.backend ? { backend: s.backend } : {}),
      computer: s.computer,
    });
  }

  const apps: SidebarApp[] = useSpotEntries("sidebar.app").entries.flatMap((e) => {
    const opens = e.fields?.opens;
    const title = fieldText(e.fields?.title);
    if (typeof opens !== "string" || title === undefined) return [];
    // A button whose `opens` names a place the shell has a glyph for wears that glyph, drawn in the text colour, whichever
    // plugin's it is (no plugin's id decides it, F2b); any other wears its own icon.
    const glyph = GLYPHS[opens];
    const icon = glyph ? { glyph } : typeof e.fields?.icon === "string" ? { url: e.fields.icon } : undefined;
    // Its component, the button's badge: by its ref (the runtime's `ref`, or `<plugin>#<id>` in the gallery's).
    const badgeRef = (e as { ref?: string }).ref ?? `${e.pluginId}#${(e as { id?: string }).id ?? ""}`;
    return [{ id: opens, title, ...(icon ? { icon } : {}), badgeRef }];
  });

  // An app's name travels with the route as `title`: the window's title bar reads it there (the shell does not declare `sidebar.app`, so it cannot list the apps itself).
  const go = (r: SidebarRoute) => {
    const to = toShellRoute(r);
    const app = r.kind === "app" ? apps.find((a) => a.id === r.appId) : undefined;
    props.navigate(app !== undefined ? { ...to, params: { ...to.params, title: app.title } } : to);
  };

  return (
    <Sidebar
      route={toSidebarRoute(props.route)}
      onNavigate={go}
      projects={projects}
      apps={apps}
      renderAppBadge={(app) => (app.badgeRef !== undefined ? <Spot name="sidebar.app" only={app.badgeRef} props={{}} /> : null)}
      account={account}
      onNew={() => go({ kind: "new" })}
      onNewSession={() => go({ kind: "new" })}
      onOpenSettings={() => go({ kind: "settings" })}
      onPlugins={() => go({ kind: "plugins" })}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
    />
  );
}
