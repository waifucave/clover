// The files panel: the open file on the left (or a note saying how to open one), and on the right the
// project's tree under a filter box. A filter narrows the tree to matching names among the folders
// listed so far; one that starts with `?` searches inside files instead. It fills `panel` keyed
// `files`.
import { useState, type ReactElement } from "react";
import { visiblePaths } from "./filter";
import { S } from "./strings";
import type { FileEntry, FilesPanelProps } from "./types";

const Icon = ({ kind, open }: { kind: "dir" | "file"; open?: boolean }) => (
  <svg className="cl-files-icon" width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {kind === "dir" ? (open ? <path d="M4.5 6.5L8 10l3.5-3.5" /> : <path d="M6.5 4.5L10 8l-3.5 3.5" />) : <path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7zM9 2.5V5h2.5" />}
  </svg>
);

function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => (a.type === "dir") === (b.type === "dir") ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);
}

export function FilesPanel({ root, listing, onList, initialOpen, onOpen, open, onSearch }: FilesPanelProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initialOpen ?? []));
  const visible = visiblePaths(root, listing, filter);

  const toggle = (entry: FileEntry) => {
    const willOpen = !expanded.has(entry.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (willOpen && listing[entry.path] === undefined) onList?.(entry.path);
  };

  const rows = (folder: string, depth: number): ReactElement[] => {
    const entries = listing[folder];
    if (entries === undefined) {
      return [
        <li key={`${folder}:loading`} className="cl-files__loading" style={{ paddingLeft: 12 + depth * 14 }}>
          {S.loading}
        </li>,
      ];
    }
    return sortEntries(entries)
      .filter((e) => !visible || visible.has(e.path))
      .flatMap((entry) => {
        const isDir = entry.type === "dir";
        const isOpen = isDir && (expanded.has(entry.path) || visible !== undefined);
        const row = (
          <li key={entry.path} role="none">
            <button
              type="button"
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={isDir ? isOpen : undefined}
              aria-selected={open?.path === entry.path}
              className="cl-files__row"
              data-type={entry.type}
              style={{ paddingLeft: 8 + depth * 14 }}
              title={entry.path}
              onClick={() => (isDir ? toggle(entry) : onOpen(entry.path))}
            >
              <Icon kind={isDir ? "dir" : "file"} open={isOpen} />
              <span className="cl-files__name">{entry.name}</span>
            </button>
          </li>
        );
        return isDir && isOpen ? [row, ...rows(entry.path, depth + 1)] : [row];
      });
  };

  const tree = rows(root, 0);
  const lines = open ? open.text.split("\n") : [];
  return (
    <div className="cl-files">
      <div className="cl-files__viewer">
        {open ? (
          <div className="cl-files__file">
            <div className="cl-files__path">{open.path}</div>
            <pre className="cl-files__code" aria-label={S.viewer(open.path)} tabIndex={0}>
              {lines.map((line, i) => (
                <span key={i} className="cl-files__line">
                  <span className="cl-files__num" aria-hidden="true">
                    {i + 1}
                  </span>
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
          </div>
        ) : (
          <div className="cl-files__empty">
            <Icon kind="file" />
            <p className="cl-files__empty-title">{S.emptyTitle}</p>
            <p className="cl-files__empty-text">{S.emptyText}</p>
          </div>
        )}
      </div>
      <div className="cl-files__side">
        <input
          className="cl-files__filter"
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
        <ul className="cl-files__tree" role="tree" aria-label={S.tree}>
          {tree.length > 0 ? tree : <li className="cl-files__loading">{S.noMatch}</li>}
        </ul>
      </div>
    </div>
  );
}
