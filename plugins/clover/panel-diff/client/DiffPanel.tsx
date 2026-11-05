// The diff panel: the session's changes, base against the working tree, one row per file with its
// counts, opening to its hunks in a unified or a split layout. It fills `panel.view` keyed `diff`;
// `DiffTitle` and `DiffLayoutSwitch` go in the panel's header.
import { useState } from "react";
import { splitRows } from "./split";
import { S } from "./strings";
import type { DiffFile, DiffHunk, DiffLayout, DiffPanelProps, DiffTitleProps } from "./types";

const Chevron = ({ open }: { open: boolean }) => (
  <svg className="cl-diff-icon" width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {open ? <path d="M4.5 6.5L8 10l3.5-3.5" /> : <path d="M6.5 4.5L10 8l-3.5 3.5" />}
  </svg>
);

const OpenIcon = () => (
  <svg className="cl-diff-icon" width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M6 3.5H3.5v9h9V10M9 3h4v4M13 3L7.5 8.5" />
  </svg>
);

export function DiffTitle({ base, target, targets, onTarget }: DiffTitleProps) {
  return (
    <div className="cl-diff-title" aria-label={S.compare(base, target)}>
      <span className="cl-diff-title__base">{base}</span>
      <span className="cl-diff-title__arrow" aria-hidden="true">
        →
      </span>
      {targets && targets.length > 0 && onTarget ? (
        <select className="cl-diff-title__select" aria-label={S.target} value={target} onChange={(e) => onTarget(e.target.value)}>
          {[target, ...targets.filter((t) => t !== target)].map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      ) : (
        <span className="cl-diff-title__target">{target}</span>
      )}
    </div>
  );
}

export function DiffLayoutSwitch({ layout, onChange }: { layout: DiffLayout; onChange: (layout: DiffLayout) => void }) {
  return (
    <div className="cl-diff-switch" role="radiogroup" aria-label={S.layout}>
      {(["unified", "split"] as const).map((l) => (
        <button key={l} type="button" role="radio" aria-checked={layout === l} className="cl-diff-switch__option" onClick={() => onChange(l)}>
          {l === "unified" ? S.unified : S.split}
        </button>
      ))}
    </div>
  );
}

function Num({ value }: { value: number | undefined }) {
  return <span className="cl-diff-line__num">{value ?? ""}</span>;
}

function Unified({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      <div className="cl-diff-hunk">{hunk.header}</div>
      {hunk.lines.map((line, i) => (
        <div key={i} className="cl-diff-line" data-kind={line.kind}>
          <Num value={line.old} />
          <Num value={line.new} />
          <span className="cl-diff-line__mark" aria-hidden="true">
            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
          </span>
          <span className="cl-diff-line__text">{line.text}</span>
        </div>
      ))}
    </>
  );
}

function Split({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      <div className="cl-diff-hunk">{hunk.header}</div>
      {splitRows(hunk.lines).map((row, i) => (
        <div key={i} className="cl-diff-split">
          <div className="cl-diff-line" data-kind={row.left ? row.left.kind : "empty"}>
            <Num value={row.left?.old} />
            <span className="cl-diff-line__text">{row.left?.text ?? ""}</span>
          </div>
          <div className="cl-diff-line" data-kind={row.right ? row.right.kind : "empty"}>
            <Num value={row.right?.new} />
            <span className="cl-diff-line__text">{row.right?.text ?? ""}</span>
          </div>
        </div>
      ))}
    </>
  );
}

function FileRow({ file, open, onToggle, layout, onOpenFile }: { file: DiffFile; open: boolean; onToggle: () => void; layout: DiffLayout; onOpenFile?: (path: string) => void }) {
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const folder = slash > 0 ? file.path.slice(0, slash) : "";
  const canOpen = !file.tooLarge && !file.binary && (file.hunks?.length ?? 0) > 0;
  return (
    <li className="cl-diff-file" data-status={file.status} data-open={open || undefined}>
      <div className="cl-diff-file__row">
        <button
          type="button"
          className="cl-diff-file__toggle"
          aria-expanded={canOpen ? open : undefined}
          disabled={!canOpen}
          aria-label={`${canOpen ? (open ? S.fold(file.path) : S.unfold(file.path)) : file.path}, ${S.status[file.status]}, ${S.stat(file.added, file.removed)}`}
          onClick={onToggle}
        >
          <Chevron open={open} />
          <span className="cl-diff-file__name">{name}</span>
          <span className="cl-diff-file__folder">{folder}</span>
          {file.from && <span className="cl-diff-file__note">{S.renamed(file.from)}</span>}
          {file.tooLarge && <span className="cl-diff-file__note">{S.tooLarge}</span>}
          {file.binary && <span className="cl-diff-file__note">{S.binary}</span>}
          <span className="cl-diff-file__added">+{file.added}</span>
          <span className="cl-diff-file__removed">−{file.removed}</span>
        </button>
        {onOpenFile && (
          <button type="button" className="cl-diff-file__open" aria-label={S.open(file.path)} title={S.open(file.path)} onClick={() => onOpenFile(file.path)}>
            <OpenIcon />
          </button>
        )}
      </div>
      {open && canOpen && (
        <div className="cl-diff-file__body" data-layout={layout}>
          {file.hunks!.map((hunk, i) => (layout === "split" ? <Split key={i} hunk={hunk} /> : <Unified key={i} hunk={hunk} />))}
        </div>
      )}
    </li>
  );
}

export function DiffPanel({ files, layout, initialOpen, onOpenFile, notice }: DiffPanelProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(initialOpen ?? []));
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <div className="cl-diff">
      {notice && <div className="cl-diff__notice">{notice}</div>}
      {files.length === 0 ? (
        <div className="cl-diff__empty">{S.none}</div>
      ) : (
        <ul className="cl-diff__files" aria-label={S.files}>
          {files.map((file) => (
            <FileRow key={file.path} file={file} open={open.has(file.path)} onToggle={() => toggle(file.path)} layout={layout} onOpenFile={onOpenFile} />
          ))}
        </ul>
      )}
    </div>
  );
}
