// The panel toggles at the end of the window's title bar: the session column, the terminal, the
// changes, the browser and the files, then ⋯. Each opens its view in the panel; two can be open at
// once. A toggle says whether its view is open (`aria-pressed`).
import type { ReactNode } from "react";
import { IconDiff, IconFolder, IconGlobe, IconMore, IconSession, IconTerminal } from "./icons";
import { S } from "./strings";
import type { PanelTogglesProps, PanelViewId } from "./types";

export const PANEL_VIEWS: readonly PanelViewId[] = ["session", "terminal", "diff", "browser", "files"];

const ICONS: Record<PanelViewId, () => ReactNode> = {
  session: IconSession,
  terminal: IconTerminal,
  diff: IconDiff,
  browser: IconGlobe,
  files: IconFolder,
};

export function PanelToggles({ open, onToggle, onMore, available = PANEL_VIEWS }: PanelTogglesProps) {
  return (
    <div className="cl-panel-toggles">
      {available.map((id) => {
        const Icon = ICONS[id];
        const pressed = open.includes(id);
        return (
          <button
            key={id}
            type="button"
            className="cl-panel-toggle"
            aria-pressed={pressed}
            aria-label={S.views[id]}
            title={S.toggle(S.views[id], pressed)}
            onClick={() => onToggle(id)}
          >
            <Icon />
          </button>
        );
      })}
      {onMore && (
        <button type="button" className="cl-panel-toggle" aria-label={S.more} title={S.more} onClick={onMore}>
          <IconMore />
        </button>
      )}
    </div>
  );
}

/** Which views stay open after a toggle: a closed one opens below the last; a third pushes out the
 *  oldest, so at most two show. The session column is separate: it sits beside the conversation. */
export function toggleView(open: readonly string[], id: string, max = 2): string[] {
  if (open.includes(id)) return open.filter((v) => v !== id);
  if (id === "session") return [...open, id];
  const panels = open.filter((v) => v !== "session");
  const kept = panels.length >= max ? panels.slice(panels.length - max + 1) : panels;
  return [...(open.includes("session") ? ["session"] : []), ...kept, id];
}
