// The plugin index browser's props: what the user searched for, what the indexes they added answered, and the
// indexes themselves (spec §5.6, open question 25's answer: an official curated index, and others added by URL with a
// warning). Installing asks for the plugin's OK, which is a sealed card (§5.6): the page says it waits on it.

export interface IndexResult {
  id: string;
  /** The index it came from: its URL, and its name when it has one. */
  index: string;
  indexName: string;
  official: boolean;
  name: string;
  description?: string;
  /** Its newest version. */
  version?: string;
  /** The version installed now, when it is. */
  installed?: string;
  /** Self-declared adult content (§5.7). */
  adult?: boolean;
}

export interface IndexSource {
  url: string;
  name?: string;
  official: boolean;
  lastCheckedAt?: number;
}

/** Where an install got to: asked for (its OK waits on a card), installed, or failed. */
export type InstallState = "asking" | "waiting" | "installed" | "failed";

export interface PluginIndexProps {
  query: string;
  onQuery: (query: string) => void;
  onSearch: (query: string) => void;
  results: IndexResult[];
  /** Still searching. */
  searching?: boolean;
  indexes: IndexSource[];
  /** The user came from a placeholder: a spot (and key) no plugin fills. */
  looking?: { spot: string; key?: string };
  installs?: Record<string, InstallState>;
  onInstall: (result: IndexResult) => void;
  /** The 18+ gate before an adult plugin installs (§5.7): its name, and the user's answer. */
  gate?: { name: string; onConfirm: () => void; onCancel: () => void };
  /** Settings' Plugins page, for what is installed. */
  onOpenInstalled?: () => void;
  /** The clock and how to show times. */
  now: number;
  format?: { locale: string; timeZone?: string };
}
