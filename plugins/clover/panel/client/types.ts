// The panel's props contract: plain data and callbacks the host routes back (spec §5.5).
import type { ReactNode } from "react";

/** The panels the default plugins are (each fills `panel`, keyed by these). A third-party plugin may
 *  fill any of them instead, or add its own key. */
export type PanelViewId = "session" | "terminal" | "diff" | "browser" | "files";

export interface PanelTogglesProps {
  /** The views open now. */
  open: readonly string[];
  onToggle: (id: string) => void;
  /** The ⋯ menu: more views, and the panel's own settings. */
  onMore?: () => void;
  /** The views offered; the default five when absent. */
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
  content: ReactNode;
}

export interface PanelHostProps {
  /** The open views, at most two, top to bottom. */
  views: readonly PanelView[];
  onClose: (id: string) => void;
  /** Make one view fill the panel. */
  onExpand?: (id: string) => void;
}

export type SessionAgentStatus = "running" | "needs-you" | "completed" | "failed" | "stopped" | "stalled";

/** The session column: what this session runs on and what it has made. Each part is optional. */
export interface SessionViewProps {
  /** Its background agents and tasks, as live tabs. */
  agents?: { id: string; title: string; backend: string; status: SessionAgentStatus }[];
  onOpenAgent?: (id: string) => void;
  environment?: {
    /** The computer it runs on. */
    computer: string;
    /** It is this computer. */
    here: boolean;
    /** The folders it may work in, as tree paths. */
    folders: { name: string; path: string }[];
    branch?: string;
    /** Reach this session from the phone and the web (spec §6.4). */
    remote?: { on: boolean; onToggle: (on: boolean) => void };
    /** Keep this setup for new sessions in the same project. */
    onSave?: () => void;
  };
  /** How much of the model's context the session uses, 0 to 1. */
  context?: { used: number; detail?: string };
  connectors?: { total: number; needSignIn: number; onOpen?: () => void };
  outputs?: {
    items: { id: string; name: string; kind: "artifact" | "file" | "image" }[];
    onOpen: (id: string) => void;
    /** More than these. */
    more?: number;
    onShowMore?: () => void;
  };
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
