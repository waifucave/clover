// The files panel, a code session's only: the open file on the left (or a note saying how to open one),
// and on the right the session's folder as a tree under a filter box. Nothing outside that folder shows.
// A filter narrows the tree to matching names among the folders listed so far; one that starts with `?`
// searches inside files instead. It fills `panel` keyed `files`; `FilesTitle` goes in the panel's header
// and names the folder and its computer.
//
// The tree is a real tree for the keyboard: one item takes Tab, the arrows move through what shows,
// Right opens a folder (or steps into it), Left closes it (or steps out to its folder), Home and End
// go to the ends. A listing that loops back on itself (a link to a folder above) draws each folder
// once. Names and the file's lines show hidden characters (bidi controls, zero-width ones) as marks.
import { ChevronDown, ChevronRight, File, Folder, Search } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { visiblePaths } from "./filter";
import { hasHidden, ShowHidden } from "./hidden";
import { S } from "./strings";
import type { FileEntry, FilesPanelProps, FilesTitleProps } from "./types";

// Lucide's icons (ISC, `LICENSES/lucide-react.txt`), at Lucide's 2 stroke. Decorative.
const Icon = ({ kind, open }: { kind: "dir" | "file"; open?: boolean }) => {
  const Glyph = kind === "dir" ? (open ? ChevronDown : ChevronRight) : File;
  return <Glyph className="cl-files-icon" size={14} strokeWidth={2} aria-hidden="true" focusable="false" />;
};

/** The last part of a path, either separator. */
export const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** The panel's header: the session's folder and the computer that holds it. */
export function FilesTitle({ root, computer }: FilesTitleProps) {
  return (
    <div className="cl-files-title" title={root} aria-label={S.title(folderName(root), computer)}>
      <Folder className="cl-files-icon" size={14} strokeWidth={2} aria-hidden="true" focusable="false" />
      <span className="cl-files-title__name">
        <ShowHidden text={folderName(root)} />
      </span>
      <span className="cl-files-title__computer">{S.on(computer)}</span>
    </div>
  );
}

function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => ((a.type === "dir") === (b.type === "dir") ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

/** One row the tree shows, in order, with what the keyboard needs to move from it. */
interface Shown {
  entry: FileEntry;
  depth: number;
  open: boolean;
  /** The folder it sits in, `undefined` at the top. */
  parent: string | undefined;
  /** Not an entry: the line that says a folder is still being listed. */
  listing?: true;
}

export function FilesPanel({ root, listing, onList, initialOpen, onOpen, open, onSearch }: FilesPanelProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initialOpen ?? []));
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const tree = useRef<HTMLUListElement>(null);
  const visible = visiblePaths(root, listing, filter);

  const setOpen = (entry: FileEntry, to: boolean) => {
    if (expanded.has(entry.path) === to) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (to) next.add(entry.path);
      else next.delete(entry.path);
      return next;
    });
    if (to && listing[entry.path] === undefined) onList?.(entry.path);
  };

  // What shows, top to bottom. Each folder is drawn once, even if a listing loops back to it.
  const shown: Shown[] = [];
  const walk = (folder: string, depth: number, parent: string | undefined, seen: ReadonlySet<string>) => {
    const entries = listing[folder];
    if (entries === undefined) {
      shown.push({ entry: { path: `${folder}\0listing`, name: S.loading, type: "other" }, depth, open: false, parent, listing: true });
      return;
    }
    const inside = new Set(seen).add(folder);
    for (const entry of sortEntries(entries)) {
      if (visible && !visible.has(entry.path)) continue;
      const isDir = entry.type === "dir";
      const looped = isDir && inside.has(entry.path);
      const isOpen = isDir && !looped && (expanded.has(entry.path) || visible !== undefined);
      shown.push({ entry, depth, open: isOpen, parent });
      if (isOpen) walk(entry.path, depth + 1, entry.path, inside);
    }
  };
  walk(root, 0, undefined, new Set());
  const items = shown.filter((s) => !s.listing);
  const focusable = items.some((s) => s.entry.path === current) ? current : (items.find((s) => s.entry.path === open?.path) ?? items[0])?.entry.path;

  const focusItem = (path: string | undefined) => {
    if (!path) return;
    setCurrent(path);
    const el = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find((i) => i.dataset.path === path);
    el?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, item: Shown) => {
    const at = items.indexOf(item);
    const isDir = item.entry.type === "dir";
    let to: string | undefined;
    switch (e.key) {
      case "ArrowDown":
        to = items[at + 1]?.entry.path;
        break;
      case "ArrowUp":
        to = items[at - 1]?.entry.path;
        break;
      case "Home":
        to = items[0]?.entry.path;
        break;
      case "End":
        to = items[items.length - 1]?.entry.path;
        break;
      case "ArrowRight":
        if (isDir && !item.open) setOpen(item.entry, true);
        else if (isDir) to = items[at + 1]?.parent === item.entry.path ? items[at + 1]?.entry.path : undefined;
        break;
      case "ArrowLeft":
        if (isDir && item.open) setOpen(item.entry, false);
        else to = item.parent;
        break;
      default:
        return;
    }
    e.preventDefault();
    focusItem(to);
  };

  const rows: ReactElement[] = shown.map((item) => {
    const { entry, depth } = item;
    const pad = { paddingLeft: 12 + depth * 16 };
    if (item.listing) {
      return (
        <li key={entry.path} className="cl-files__loading" style={pad} role="none">
          {entry.name}
        </li>
      );
    }
    const isDir = entry.type === "dir";
    return (
      <li key={entry.path} role="none">
        <button
          type="button"
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isDir ? item.open : undefined}
          aria-selected={open?.path === entry.path}
          tabIndex={entry.path === focusable ? 0 : -1}
          data-path={entry.path}
          className="cl-files__row"
          data-type={entry.type}
          style={pad}
          title={entry.path}
          onFocus={() => setCurrent(entry.path)}
          onKeyDown={(e) => onKeyDown(e, item)}
          onClick={() => (isDir ? setOpen(entry, !item.open) : onOpen(entry.path))}
        >
          <Icon kind={isDir ? "dir" : "file"} open={item.open} />
          <span className="cl-files__name">
            <ShowHidden text={entry.name} />
          </span>
        </button>
      </li>
    );
  });

  const lines = open ? open.text.split("\n") : [];
  return (
    <div className="cl-files">
      <div className="cl-files__viewer">
        {open ? (
          <div className="cl-files__file">
            <div className="cl-files__path">
              <ShowHidden text={open.path} />
              {hasHidden(open.text) && <span className="cl-files__warning">{S.hiddenWarning}</span>}
            </div>
            <pre className="cl-files__code" aria-label={S.viewer(open.path)} tabIndex={0}>
              {lines.map((line, i) => (
                <span key={i} className="cl-files__line">
                  <span className="cl-files__num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <ShowHidden text={line} />
                  {"\n"}
                </span>
              ))}
            </pre>
          </div>
        ) : (
          <div className="cl-files__empty">
            <Folder className="cl-files-icon" size={18} strokeWidth={1.75} aria-hidden="true" focusable="false" />
            <p className="cl-files__empty-title">{S.emptyTitle}</p>
            <p className="cl-files__empty-text">{S.emptyText}</p>
          </div>
        )}
      </div>
      <div className="cl-files__side">
        <label className="cl-files__filter">
          <Search className="cl-files-icon" size={14} strokeWidth={2} aria-hidden="true" focusable="false" />
          <input
            className="cl-files__filter-input"
            type="search"
            value={filter}
            placeholder={S.filterHint}
            aria-label={S.filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filter.trim().startsWith("?") && onSearch) {
                e.preventDefault();
                onSearch(filter.trim().slice(1).trim());
              }
            }}
          />
        </label>
        <ul className="cl-files__tree" role="tree" aria-label={S.tree} ref={tree}>
          {rows.length > 0 ? rows : <li className="cl-files__loading">{S.noMatch}</li>}
        </ul>
      </div>
    </div>
  );
}
