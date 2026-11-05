// The diff panel's props: a session's changes, base against a target (the working tree by default),
// per file, read from the folder tree (`files`) by the host.

export interface DiffLine {
  kind: "context" | "add" | "del";
  /** Line numbers on the base side and the target side. */
  old?: number;
  new?: number;
  text: string;
}

export interface DiffHunk {
  /** `@@ -12,7 +12,9 @@ function name`. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** The path inside the project. */
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** A rename's old path. */
  from?: string;
  added: number;
  removed: number;
  hunks?: DiffHunk[];
  /** Too large to show here; it opens in the editor instead. */
  tooLarge?: boolean;
  binary?: boolean;
}

export type DiffLayout = "unified" | "split";

export interface DiffPanelProps {
  files: DiffFile[];
  layout: DiffLayout;
  /** Files drawn open at first. */
  initialOpen?: string[];
  /** Open the file itself (in the files panel or an editor). */
  onOpenFile?: (path: string) => void;
  /** A line above the list, such as why large files start folded. */
  notice?: string;
}

export interface DiffTitleProps {
  base: string;
  target: string;
  /** Other targets to compare against: the last commit, a branch. */
  targets?: string[];
  onTarget?: (target: string) => void;
}
