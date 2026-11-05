// The tabs' shared language (Winter's `IslandQuietRow`, docs/claude/island.md "Island visual language"):
// no boxes — content floats on the island's black; typography carries the hierarchy, a clear title over
// muted words; one accent per source, used sparingly, amber only for what needs you; quiet at rest and
// lifting under the pointer, the title growing from its leading edge while the details appear under it;
// actions, links and groups are words. Each tab keeps the shape that fits its data. The island's own
// tabs (Usage, Devices — M2) and any plugin's `island.tab` entry can build on these.

import type { ReactElement, ReactNode } from "react";
import { Glyph } from "./glyphs";

export type StatusMark =
  | { kind: "dot"; color: string }
  | { kind: "ring"; color: string }
  | { kind: "glyph"; glyph: "check" | "xmark" | "bolt" | "hand"; color: string };

export function StatusMarkView({ mark }: { mark: StatusMark }): ReactElement {
  if (mark.kind === "dot") return <span className="clv-mark-dot" style={{ color: mark.color }} />;
  if (mark.kind === "ring") return <span className="clv-mark-ring" style={{ color: mark.color }} />;
  return <Glyph name={mark.glyph} style={{ color: mark.color }} />;
}

export interface LiftRowProps {
  title: string;
  /** Muted words right after the title (a folder, "2 agents"). */
  side?: string;
  mark?: StatusMark;
  /** Something that is over: its title is quieter. */
  quiet?: boolean;
  hovered?: boolean;
  /** What trails the title line: a status word, a chevron. */
  trailing?: ReactNode;
  /** The lines under the title: a note worth scanning at rest, the details the pointer reveals. */
  below?: ReactNode;
  onHover?: (hovered: boolean) => void;
  onClick?: () => void;
}

export function LiftRow({ title, side, mark, quiet = false, hovered = false, trailing, below, onHover, onClick }: LiftRowProps): ReactElement {
  return (
    <div
      className="clv-row"
      data-hovered={hovered}
      data-quiet={quiet}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      onClick={onClick}
    >
      <span className="clv-row-mark">{mark ? <StatusMarkView mark={mark} /> : null}</span>
      <span className="clv-row-main">
        <span className="clv-row-title-line">
          <span className="clv-row-title">{title}</span>
          {side ? <span className="clv-row-side">{side}</span> : null}
          <span className="clv-row-spacer" />
          {trailing}
        </span>
        {below}
      </span>
    </div>
  );
}

export function RowWords({ text, color, trailing }: { text: string; color?: string; trailing?: ReactNode }): ReactElement {
  return (
    <span className="clv-row-words">
      <span style={color ? { color } : undefined}>{text}</span>
      <span className="clv-row-spacer" />
      {trailing}
    </span>
  );
}

export function StatusWord({ mark, word }: { mark: StatusMark; word?: string }): ReactElement {
  return (
    <span className="clv-status-word">
      <StatusMarkView mark={mark} />
      {word ? <span>{word}</span> : null}
    </span>
  );
}

export function GroupTitle({ title, meta, metaColor }: { title: string; meta?: string; metaColor?: string }): ReactElement {
  return (
    <div className="clv-group-title">
      <span>{title}</span>
      {meta ? (
        <span className="clv-group-meta" style={metaColor ? { color: metaColor } : undefined}>
          {meta}
        </span>
      ) : null}
    </div>
  );
}

export function LinkWords({ text, onClick }: { text: string; onClick?: () => void }): ReactElement {
  return (
    <button type="button" className="clv-link-words" onClick={onClick}>
      <span>{text}</span>
      <Glyph name="open" size={8} />
    </button>
  );
}

export type ActionTone = "plain" | "amber" | "red" | "muted";

export function ActionWords({ text, tone = "plain", onClick }: { text: string; tone?: ActionTone; onClick?: () => void }): ReactElement {
  return (
    <button type="button" className="clv-action-words" data-tone={tone} onClick={onClick}>
      {text}
    </button>
  );
}
