// The panel toggles at the end of the window's title bar, then ⋯. Each opens its view in the panel; two can be open
// at once. A toggle says whether its view is open (`aria-pressed`). Which ones show depends on the session the tab
// shows (lane B's `SessionKind`): a coding session has its column, the terminal, the changes, the browser and the
// files; a bot's tab has its slim column and the browser; an agent's has its column and the browser. The terminal,
// the changes and the files work on a coding session's folder, so no other tab offers them, whatever the host asks.
import type { ReactNode } from "react";
import { IconAgent, IconDiff, IconFolder, IconGlobe, IconMore, IconSession, IconTerminal } from "./icons";
import { S } from "./strings";
import { OwnPanelToggles } from "./OwnPanelToggles";
import type { PanelTogglesProps, PanelView, PanelViewId, SessionKind } from "./panel-types";

/** The views each kind of tab offers, in the order their toggles show. */
export const VIEWS_BY_KIND: Readonly<Record<SessionKind, readonly PanelViewId[]>> = {
  coding: ["session", "terminal", "diff", "browser", "files"],
  bot: ["session", "browser"],
  agent: ["session", "browser"],
  "side-thread": ["browser"],
};

/** A coding session's views (every default panel). */
export const PANEL_VIEWS: readonly PanelViewId[] = VIEWS_BY_KIND.coding;

/** The panels that work on a coding session's folder: never anywhere else (`when.session: "coding"`). */
export const CODE_ONLY: readonly string[] = ["terminal", "diff", "files"];

/** Whether a view may show in this kind of tab. A code-only panel shows only in a coding session, even if a plugin
 *  says otherwise; otherwise the view's own `sessions` (its entry's `when.session`) decide, and absent, it may. */
export function belongsIn(view: Pick<PanelView, "id" | "sessions">, kind: SessionKind): boolean {
  if (kind !== "coding" && CODE_ONLY.includes(view.id)) return false;
  return view.sessions === undefined || view.sessions.includes(kind);
}

const ICONS: Record<PanelViewId, () => ReactNode> = {
  session: IconSession,
  terminal: IconTerminal,
  diff: IconDiff,
  browser: IconGlobe,
  files: IconFolder,
  agent: IconAgent,
};

/** One panel toggle: its glyph, whether its view is open, and the app's own press. The bar draws them in a row; a bot's layout
 *  may place any one of them (`chrome.action`, keyed `session` or `browser`). */
export function PanelToggleButton({ id, kind, open, onToggle }: { id: PanelViewId; kind: SessionKind; open: readonly string[]; onToggle: (id: PanelViewId) => void }) {
  const Icon = ICONS[id];
  const pressed = open.includes(id);
  const label = id === "session" && kind === "bot" ? S.botColumn : S.views[id] ?? id;
  return (
    <button type="button" className="cl-panel-toggle" aria-pressed={pressed} aria-label={label} title={S.toggle(label, pressed)} onClick={() => onToggle(id)}>
      <Icon />
    </button>
  );
}

export function PanelToggles({ kind, open, onToggle, onMore, available, skip, own }: PanelTogglesProps & { skip?: readonly string[] }) {
  const offered = VIEWS_BY_KIND[kind].filter((id) => (available === undefined || available.includes(id)) && !(skip ?? []).includes(id));
  return (
    <div className="cl-panel-toggles" data-kind={kind}>
      {offered.map((id) => {
        const Icon = ICONS[id];
        const pressed = open.includes(id);
        const label = id === "session" && kind === "bot" ? S.botColumn : S.views[id] ?? id;
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
      {own !== undefined && own.length > 0 && <OwnPanelToggles own={own} open={open} onToggle={onToggle} />}
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
