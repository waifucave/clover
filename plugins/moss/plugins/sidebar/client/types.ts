// The sidebar's props contract: plain data and callbacks the host routes back (spec §5.5).
import type { ReactNode } from "react";

/** What `main` shows (the shell's `main` spot is keyed by these routes, spec §5.5). */
export type SidebarRoute =
  | { kind: "new" }
  | { kind: "agent"; agentId: string }
  | { kind: "settings" }
  | { kind: "plugins" }
  | { kind: "app"; appId: string };

/** `needs-you`: an approval or a question waits in its main conversation. `asleep`: no computer
 *  running it can be reached (spec §6.4). `paused`: the core's pause switch is on (spec §9.2). */

/** What waits for the user: approval cards and questions, counted without their content (lane B). */
export interface NeedsYou {
  cards: number;
  questions: number;
}

/** The two counts as one number, for a badge. */
export const needsYouCount = (n: NeedsYou | undefined): number => (n ? n.cards + n.questions : 0);

export type AgentStatus = "running" | "needs-you" | "completed" | "failed" | "stopped" | "stalled";

/** A session the user can open as a live tab: a bot's background agent, or a coding session the user
 *  started directly (spec §9.3). */
export interface SidebarAgent {
  id: string;
  /** What it was asked to do. */
  title: string;
  /** The agent backend: "Codex", "OpenCode"… */
  backend: string;
  computer?: string;
  status: AgentStatus;
}


/** One of the shell's own glyphs, for the apps we ship; a third-party app brings an icon file. */
export type AppGlyph = "globe" | "archive" | "chart" | "grid";

/** An app button: an entry in the `sidebar.app` spot, with the fields that spot defines (title,
 *  icon, what it opens). */
export interface SidebarApp {
  id: string;
  title: string;
  icon?: { url: string } | { glyph: AppGlyph };
  badge?: number;
  /** The `sidebar.app` entry whose component draws beside the title (its badge), by its ref. */
  badgeRef?: string;
}

/** This device's link to the computer running the bots (spec §6.4). */
export type LinkState =
  | { state: "connected" }
  /** The main computer is alive but can't be reached: the app says so instead of taking over. */
  | { state: "unreachable"; main: string }
  /** The main is offline and this computer runs the bots until it is back. */
  | { state: "takeover"; main: string; here: string }
  /** No link to any other device. */
  | { state: "offline" };


/** A coding session the user started directly: a live tab like an agent's (spec §9.3), grouped by the
 *  project folder it works in. */
export interface SidebarSession {
  id: string;
  title: string;
  /** The git branch it works on. */
  branch?: string;
  /** Files it has changed on that branch. */
  changes?: number;
  status: AgentStatus | "idle";
  /** What waits for the user in it (lane B's `SessionView.needsYou`). */
  needsYou?: NeedsYou;
  backend?: string;
  computer?: string;
}

/** A project folder and the sessions in it. */
export interface SidebarProject {
  id: string;
  name: string;
  /** Its tree path (`home/<Computer>/…`). */
  path: string;
  sessions: SidebarSession[];
}

/** Who is signed in to this app, at the bottom of the sidebar. */
export interface SidebarAccount {
  name: string;
  /** A second word: the plan, or the computer. */
  detail?: string;
}

export interface SidebarProps {
  route: SidebarRoute;
  onNavigate: (route: SidebarRoute) => void;
  /** The code side's project folders. */
  projects?: SidebarProject[];
  /** `sidebar.app` buttons. */
  apps?: SidebarApp[];
  /** Draws an app button's own badge: its `sidebar.app` entry's component (§5.4: a UI spot's entry carries one), in
   *  its own plugin's layer. Display only: a press on it is the button's. */
  renderAppBadge?: (app: SidebarApp) => ReactNode;
  account: SidebarAccount;
  onOpenSettings: () => void;
  onOpenAccount?: () => void;
  /** New: a coding session (the shell's page that starts one). */
  onNew?: () => void;
  onSearch?: () => void;
  /** The files the bots made. */
  onOutputs?: () => void;
  /** Plugins and themes. */
  onPlugins?: () => void;
  onMore?: () => void;
  /** A new session in one project. */
  onNewSession?: (projectId: string) => void;
  /** Close a finished agent's or session's tab. */
  onCloseAgent?: (id: string) => void;
  /** Projects drawn folded at first. */
  initialFoldedProjects?: string[];
  link?: LinkState;
  paused?: boolean;
  onResume?: () => void;
  safeMode?: boolean;
  onOpenPluginManager?: () => void;
  /** The narrow rail: icons with accessible names, banners as marks. It stays wide enough for the
   *  window's controls (`--cl-window-controls`, 80 px by default). */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}
