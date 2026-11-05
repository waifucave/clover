// The sidebar's props contract: plain data and callbacks the host routes back (spec §5.5).
import type { ReactNode } from "react";

/** What `main` shows (the shell's `main` spot is keyed by these routes, spec §5.5). */
export type SidebarRoute =
  | { kind: "bot"; botId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "settings" }
  | { kind: "plugins" }
  | { kind: "app"; appId: string };

/** `needs-you`: an approval or a question waits in its main conversation. `asleep`: no computer
 *  running it can be reached (spec §6.4). `paused`: the core's pause switch is on (spec §9.2). */
export type BotStatus = "idle" | "thinking" | "working" | "needs-you" | "asleep" | "paused";

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

export interface SidebarBot {
  id: string;
  name: string;
  /** An asset URL for the bot's portrait (its avatar's `portrait`, spec §5.9). */
  portraitUrl?: string;
  status: BotStatus;
  /** How many approvals and questions wait for the user. */
  needsYou?: number;
  /** Something arrived since the user last looked. */
  unread?: boolean;
  /** What it is doing besides talking: a routine running in a side thread, say. */
  activity?: string;
  /** Its background agents, each a live tab under it. */
  agents?: SidebarAgent[];
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

/** The switch at the top of the sidebar: the bots and their agents, or coding sessions by project. */
export type SidebarSide = "bots" | "code";

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
  needsYou?: number;
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
  side: SidebarSide;
  onSideChange: (side: SidebarSide) => void;
  route: SidebarRoute;
  onNavigate: (route: SidebarRoute) => void;
  bots: SidebarBot[];
  /** The code side's project folders. */
  projects?: SidebarProject[];
  /** `sidebar.app` buttons. */
  apps?: SidebarApp[];
  account: SidebarAccount;
  onOpenSettings: () => void;
  onOpenAccount?: () => void;
  /** New: a chat with a bot on the bots side, a coding session on the code side. */
  onNew?: () => void;
  onSearch?: () => void;
  /** Files and artifacts the bots made. */
  onOutputs?: () => void;
  /** Plugins and themes. */
  onCustomize?: () => void;
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
  /** The narrow rail: icons with accessible names, banners as marks. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** The `sidebar.bot` spot: a plugin draws a bot's row its own way. */
  renderBot?: (bot: SidebarBot, standard: ReactNode) => ReactNode;
}
