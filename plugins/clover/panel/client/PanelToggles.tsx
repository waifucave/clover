// The panel toggles at the end of the window's title bar, then ⋯. Each opens its view in the panel; two
// can be open at once. A toggle says whether its view is open (`aria-pressed`). Which ones show depends
// on the tab: a code session has its column, the terminal, the changes, the browser and the files; a
// bot's tab has its slim column and the browser. The terminal, the changes and the files work on a code
// session's folder, so a bot's tab never offers them, whatever the host asks for.
import type { ReactNode } from "react";
import { IconDiff, IconFolder, IconGlobe, IconMore, IconSession, IconTerminal } from "./icons";
import { S } from "./strings";
import type { PanelTogglesProps, PanelView, PanelViewId, SessionKind } from "./types";

/** The views each kind of tab has, in the order their toggles show. */
export const VIEWS_BY_KIND: Readonly<Record<SessionKind, readonly PanelViewId[]>> = {
  code: ["session", "terminal", "diff", "browser", "files"],
  bot: ["session", "browser"],
};

/** A code session's views (every default panel). */
export const PANEL_VIEWS: readonly PanelViewId[] = VIEWS_BY_KIND.code;

/** The panels that work on a code session's folder: never in a bot's tab. */
export const CODE_ONLY: readonly string[] = ["terminal", "diff", "files"];

/** Whether a view may show in this kind of tab. A code-only panel never shows in a bot's tab, even if a
 *  plugin's manifest says it may; otherwise the view's own `sessions` decide, and absent, it may. */
export function belongsIn(view: Pick<PanelView, "id" | "sessions">, kind: SessionKind): boolean {
  if (kind === "bot" && CODE_ONLY.includes(view.id)) return false;
  return view.sessions === undefined || view.sessions.includes(kind);
}

const ICONS: Record<PanelViewId, () => ReactNode> = {
  session: IconSession,
  terminal: IconTerminal,
  diff: IconDiff,
  browser: IconGlobe,
  files: IconFolder,
};

export function PanelToggles({ kind, open, onToggle, onMore, available }: PanelTogglesProps) {
  const offered = VIEWS_BY_KIND[kind].filter((id) => available === undefined || available.includes(id));
  return (
    <div className="cl-panel-toggles" data-kind={kind}>
      {offered.map((id) => {
        const Icon = ICONS[id];
        const pressed = open.includes(id);
        const label = id === "session" && kind === "bot" ? S.botColumn : S.views[id];
        return (
          <button
            key={id}
            type="button"
            className="cl-panel-toggle"
            aria-pressed={pressed}
            aria-label={label}
            title={S.toggle(label, pressed)}
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
