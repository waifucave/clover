// The archive's props: the old Winter sessions the migration kept (spec §14.1, "Existing Winter installs"), readable,
// never a bot's history. A session opens beside the list, its transcript drawn by the conversation part.
import type { ReactNode } from "react";

export interface ArchivedSession {
  id: string;
  title?: string;
  mode: "code" | "chat" | "dispatch";
  /** A code session's project folder. */
  project?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messages: number;
}

export interface ArchiveProps {
  sessions: ArchivedSession[];
  /** Still loading the first page. */
  loading?: boolean;
  /** More sessions than shown, older. */
  more?: boolean;
  onMore?: () => void;
  query: string;
  onQuery: (query: string) => void;
  onSearch: (query: string) => void;
  selected?: string;
  onSelect: (id: string) => void;
  /** The selected session's transcript. */
  transcript?: ReactNode;
  now: number;
  format?: { locale: string; timeZone?: string };
}
