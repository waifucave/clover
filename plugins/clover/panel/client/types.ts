// The panel's props contract: plain data and callbacks the host routes back (spec §5.5).
import type { ReactNode } from "react";

/** The tab the panel belongs to. A code session works in a folder on one computer, so it has every panel:
 *  its column, the terminal, the changes, the files and the browser. A bot's tab has a slim column (its
 *  agents and tasks, context and outputs) and the browser, and nothing that works on a folder. */
export type SessionKind = "code" | "bot";

/** The panels the default plugins are (each fills `panel`, keyed by these). A third-party plugin may
 *  fill any of them instead, or add its own key. */
export type PanelViewId = "session" | "terminal" | "diff" | "browser" | "files";

export interface PanelTogglesProps {
  /** The tab's kind: it decides which views are offered at all. */
  kind: SessionKind;
  /** The views open now. */
  open: readonly string[];
  onToggle: (id: string) => void;
  /** The ⋯ menu: more views, and the panel's own settings. */
  onMore?: () => void;
  /** The views offered, of those the kind has; every one the kind has when absent. */
  available?: readonly PanelViewId[];
}

/** One view the panel holds: a header (a title, or the view's own header such as a browser's tabs),
 *  its actions, and its content. */
export interface PanelView {
  id: string;
  title: string;
  /** The view's own header, in place of the title. */
  header?: ReactNode;
  /** Buttons at the header's end, before expand and close. */
  actions?: ReactNode;
  /** What the plugin keyed for this panel draws. Absent: no installed plugin fills the key, and the host
   *  says so in its place. */
  content?: ReactNode;
  /** The tab kinds the view belongs in: its plugin's manifest says so, once lane B's catalog has the field
   *  (`sessions`). Absent: any. The terminal, the changes and the files are code-only whatever it says. */
  sessions?: readonly SessionKind[];
}

export interface PanelHostProps {
  /** The tab's kind: a view that doesn't belong in it is never drawn. */
  kind: SessionKind;
  /** The open views, at most two, top to bottom. */
  views: readonly PanelView[];
  onClose: (id: string) => void;
  /** Make one view fill the panel. */
  onExpand?: (id: string) => void;
  /** Look for a plugin that fills an empty panel (the plugin manager). */
  onFindPlugin?: (id: string) => void;
}

export type SessionAgentStatus = "running" | "needs-you" | "completed" | "failed" | "stopped" | "stalled";

/** The column beside the conversation. In a code session, what it runs on and what it has made. In a bot's
 *  tab, the slim column: the bot's agents and tasks, its context and its outputs, and nothing about a
 *  folder. Each part is optional. */
export interface SessionViewProps {
  /** The tab's kind; a code session's when absent. A bot's tab draws only the agents, context and outputs. */
  kind?: SessionKind;
  /** Its agents and tasks: the coding agents (ACP) it runs, and its background tasks. */
  agents?: { id: string; title: string; backend: string; status: SessionAgentStatus }[];
  /** Opens one in the panel: its transcript, with a composer of its own. */
  onOpenAgent?: (id: string) => void;
  /** The agent open in the panel now. */
  openAgent?: string;
  environment?: {
    /** The computer it runs on. */
    computer: string;
    /** It is this computer. */
    here: boolean;
    /** That computer's level (spec §9.1): what its bots may do without asking. A change is always a sealed
     *  card (§5.5), so a pick shows as asked for until the card is answered. */
    level?: { label: string; requested?: string; onChange?: () => void };
    /** The folders it works in, as paths on that computer. */
    folders: { name: string; path: string }[];
    branch?: string;
  };
  /** How much of the model's context the session uses, 0 to 1. */
  context?: { used: number; detail?: string };
  connectors?: { total: number; needSignIn: number; onOpen?: () => void };
  outputs?: {
    /** A page (HTML or Markdown the bot made to be read), a file, or an image. */
    items: { id: string; name: string; kind: "page" | "file" | "image" }[];
    onOpen: (id: string) => void;
    /** More than these. */
    more?: number;
    onShowMore?: () => void;
  };
  /** Its changes (lane D's), and the pull requests they became. A code session's only. */
  changes?: {
    /** The branch the changes are on, against its base. */
    label: string;
    added: number;
    removed: number;
    files: number;
    onOpenDiff?: () => void;
    onCreatePr?: () => void;
    prs: { id: string; title: string; repo: string; number: number; state: "open" | "draft" | "merged" }[];
    onOpenPr?: (id: string) => void;
  };
}
