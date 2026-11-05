// The right-hand panel: the panels it holds, at most two, one above the other, each with its header
// (its title or its own header, such as a browser's tabs), its actions, expand and close. Each panel is
// a plugin of its own that fills the `panel` spot keyed by its id (session, terminal, diff, files,
// browser; lane B's catalog), so a third-party plugin can replace any of them. A key no installed plugin
// fills shows the host's own placeholder, which says so.
//
// The host draws only views that belong in the tab (`belongsIn`): in a bot's tab, never the terminal, the
// changes or the files, which work on a code session's folder. A bot's tab may hold one of its agents
// instead (its transcript, with a composer of its own), and the browser.
import { IconClose, IconExpand, IconPlugin } from "./icons";
import { belongsIn } from "./PanelToggles";
import { S } from "./strings";
import type { PanelHostProps, PanelView } from "./types";

function Empty({ view, onFindPlugin }: { view: PanelView; onFindPlugin?: (id: string) => void }) {
  return (
    <div className="cl-panel__empty" data-empty-view={view.id}>
      <IconPlugin />
      <p className="cl-panel__empty-title">{S.empty(view.title)}</p>
      <p className="cl-panel__empty-detail">{S.emptyDetail}</p>
      {onFindPlugin && (
        <button type="button" className="cl-panel__empty-action" onClick={() => onFindPlugin(view.id)}>
          {S.findPlugin}
        </button>
      )}
    </div>
  );
}

export function PanelHost({ kind, views, onClose, onExpand, onFindPlugin }: PanelHostProps) {
  const shown = views.filter((v) => belongsIn(v, kind)).slice(0, 2);
  if (shown.length === 0) return null;
  return (
    <div className="cl-panel" role="region" aria-label={S.panel} data-kind={kind} data-count={shown.length}>
      {shown.map((view) => (
        <section key={view.id} className="cl-panel__view" data-view={view.id} aria-label={view.title}>
          <header className="cl-panel__head">
            <div className="cl-panel__head-main">{view.header ?? <h2 className="cl-panel__title">{view.title}</h2>}</div>
            {view.actions && <div className="cl-panel__actions">{view.actions}</div>}
            {onExpand && (
              <button type="button" className="cl-panel__icon-button" aria-label={S.expand(view.title)} title={S.expand(view.title)} onClick={() => onExpand(view.id)}>
                <IconExpand />
              </button>
            )}
            <button type="button" className="cl-panel__icon-button" aria-label={S.close(view.title)} title={S.close(view.title)} onClick={() => onClose(view.id)}>
              <IconClose />
            </button>
          </header>
          <div className="cl-panel__body">{view.content === undefined ? <Empty view={view} onFindPlugin={onFindPlugin} /> : view.content}</div>
        </section>
      ))}
    </div>
  );
}
