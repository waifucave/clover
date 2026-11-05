// The files panel's props, over the folder tree that lane J provides and lane B's `files` API carries
// (`files.list(path)` → `FileStat[]`, `files.readText(path)`). The host lists folders as they open and
// hands their entries in; the panel never reads the disk itself.

/** A folder's entry, as `files.list` gives it (B's `FileStat`: `path`, `type`), plus the name shown. */
export interface FileEntry {
  path: string;
  name: string;
  type: "file" | "dir" | "symlink" | "other";
}

export interface FilesPanelProps {
  /** The folder the tree starts at, a tree path (`home/<Computer>/…`). */
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
