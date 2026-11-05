import { useId, useState } from "react";
import type { MessageContext } from "../context";
import { formatDuration } from "../format";
import { IconChevron, IconClover } from "../icons";
import { S } from "../strings";
import type { ThinkingItem } from "../types";

/** What the row says: the core's title when there is one, else "Thinking" while the block streams,
 *  else "Thought for 12s" (or "Thought"). A block whose turn ended without closing reads as done,
 *  never as thinking forever. */
export function thinkingLabel(item: ThinkingItem, turnLive: boolean): string {
  const title = item.title?.trim();
  const running = item.live && turnLive;
  if (title) return running || item.durationMs === undefined ? title : `${title} · ${formatDuration(item.durationMs)}`;
  if (running) return S.thinkingLive;
  return item.durationMs === undefined ? S.thinkingDone : S.thinkingFor(formatDuration(item.durationMs));
}

export function ThinkingRow({ item, ctx, defaultOpen = false }: { item: ThinkingItem; ctx: MessageContext; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const running = item.live && ctx.turnLive;
  const text = item.text?.trim() ?? "";
  const canOpen = !running && (text.length > 0 || item.reasoning === "hidden");
  return (
    <div className="cl-conv-thinking" data-running={running || undefined} data-open={open || undefined}>
      <button
        type="button"
        className="cl-conv-thinking__toggle"
        aria-expanded={canOpen ? open : undefined}
        aria-controls={canOpen ? bodyId : undefined}
        disabled={!canOpen}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cl-conv-thinking__glyph" aria-hidden="true">
          <IconClover />
        </span>
        <span className="cl-conv-thinking__label">{thinkingLabel(item, ctx.turnLive)}</span>
        {canOpen && (
          <span className="cl-conv-chevron" aria-hidden="true">
            <IconChevron />
          </span>
        )}
      </button>
      {open && (
        <div className="cl-conv-thinking__body" id={bodyId}>
          {item.reasoning === "hidden" || text.length === 0 ? S.thinkingHidden : text}
          {item.truncated && <div className="cl-conv-thinking__truncated">{S.thinkingTruncated}</div>}
        </div>
      )}
    </div>
  );
}
