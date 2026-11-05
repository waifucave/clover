// The files panel's props. It belongs to a code session: its tree is that session's folder and nothing
// outside it, read from the computer that holds the folder through lane J's API, which lane B's `files`
// calls carry (`files.list(path)` → `FileStat[]`, `files.readText(path)`, `files.grep`). There are no
// mounts: the host lists folders as they open and hands their entries in; the panel never reads a disk.

/** A folder's entry, as `files.list` gives it (B's `FileStat`: `path`, `type`), plus the name shown. */
export interface FileEntry {
  path: string;
  name: string;
  type: "file" | "dir" | "symlink" | "other";
}

export interface FilesPanelProps {
  /** The session's folder, as a path on the computer that holds it: the tree shows it and what's inside
   *  it, nothing more. */
  root: string;
  /** Each listed folder's entries, by its path. A folder not here is still to be listed. */
  listing: Readonly<Record<string, readonly FileEntry[]>>;
  /** A folder opened whose entries aren't listed yet: the host lists it. */
  onList?: (path: string) => void;
  /** Folders drawn open at first. */
  initialOpen?: string[];
  /** Open a file in the viewer. */
  onOpen: (path: string) => void;
  /** The open file, as `files.readText` read it. */
  open?: { path: string; text: string };
  /** Search inside files: a filter that starts with `?` (`files.grep`). */
  onSearch?: (query: string) => void;
}

export interface FilesTitleProps {
  /** The session's folder, as `FilesPanelProps.root`. */
  root: string;
  /** The computer that holds it. */
  computer: string;
}
