// The panel host's props contract: plain data and callbacks the host routes back (spec §5.5).
import type { ReactNode } from "react";

/** The kind of session the tab shows (lane B's `SessionKind`). A coding session works in a folder on one computer, so
 *  it has every panel: its column, the terminal, the changes, the files and the browser. A bot's tab has a slim column
 *  (its agents and tasks, context and outputs) and the browser, and nothing that works on a folder. */
export type SessionKind = "bot" | "side-thread" | "agent" | "coding";

/** The panels the default plugins are (each fills `panel`, keyed by these). A third-party plugin may
 *  fill any of them instead, or add its own key. */
export type PanelViewId = "session" | "terminal" | "diff" | "browser" | "files" | "agent";

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
  /** What the plugin keyed for this panel draws, or a function of the view's header row, which a panel that brings
   *  its own header portals into (the clover layer only: a question for E). Absent: no installed plugin fills the
   *  key, and the host says so in its place. */
  content?: ReactNode | ((header: HTMLElement | null) => ReactNode);
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
