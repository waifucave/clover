// The panel's props contract: plain data and callbacks the host routes back (spec §5.5).

/** The kind of session (lane B's `SessionKind`): the column is a coding session's in full, a bot's slim. */
export type SessionKind = "bot" | "side-thread" | "agent" | "coding";

export type SessionAgentStatus = "running" | "needs-you" | "completed" | "failed" | "stopped" | "stalled";

/** The column beside the conversation. In a code session, what it runs on and what it has made. In a bot's
 *  tab, the slim column: the bot's agents and tasks, its context and its outputs, and nothing about a
 *  folder. Each part is optional. */
export interface SessionViewProps {
  /** The session's kind; a coding session's when absent. A bot's tab (and a side thread) draws only the agents,
   *  context and outputs. */
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
  };
}
