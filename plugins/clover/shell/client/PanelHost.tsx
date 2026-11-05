// The right-hand panel: the panels it holds, at most two, one above the other, each with its header
// (its title or its own header, such as a browser's tabs), its actions, expand and close. Each panel is
// a plugin of its own that fills the `panel` spot keyed by its id (session, terminal, diff, files,
// browser; lane B's catalog), so a third-party plugin can replace any of them. A key no installed plugin
// fills shows the host's own placeholder, which says so.
//
// The host draws only views that belong in the tab (`belongsIn`): the terminal, the changes and the files only in a
// coding session, whose folder they work on. A bot's tab may hold one of its coding agents instead (its transcript,
// with a composer of its own), and the browser.
import { useRef, useState } from "react";
import { IconClose, IconExpand, IconPlugin } from "./icons";
import { belongsIn } from "./PanelToggles";
import { S } from "./strings";
import type { PanelHostProps } from "./panel-types";

/** The host's placeholder for a panel no installed plugin fills: it says so, and offers to find one (the plugins
 *  page, searched for this spot and key). */
export function PanelEmpty({ id, title, onFindPlugin }: { id: string; title: string; onFindPlugin?: (id: string) => void }) {
  return (
    <div className="cl-panel__empty" data-empty-view={id}>
      <IconPlugin />
      <p className="cl-panel__empty-title">{S.empty(title)}</p>
      <p className="cl-panel__empty-detail">{S.emptyDetail}</p>
      {onFindPlugin && (
        <button type="button" className="cl-panel__empty-action" onClick={() => onFindPlugin(id)}>
          {S.findPlugin}
        </button>
      )}
    </div>
  );
}

export function PanelHost({ kind, views, onClose, onExpand, onFindPlugin }: PanelHostProps) {
  const shown = views.filter((v) => belongsIn(v, kind)).slice(0, 2);
  // Each view's header row, offered to its contents: a panel that brings its own header (a terminal's tabs, the
  // changes' base) draws it there, and the title steps aside.
  const [slots, setSlots] = useState<Record<string, HTMLElement | null>>({});
  // One ref callback per view for the host's life: a new one each render would detach and reattach the slot, and
  // each would set state again.
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const slotFor = (id: string) => {
    let ref = refs.current.get(id);
    if (!ref) refs.current.set(id, (ref = (el: HTMLElement | null) => setSlots((s) => (s[id] === el ? s : { ...s, [id]: el }))));
    return ref;
  };
  if (shown.length === 0) return null;
  return (
    <div className="cl-panel" role="region" aria-label={S.panel} data-kind={kind} data-count={shown.length}>
      {shown.map((view) => (
        <section key={view.id} className="cl-panel__view" data-view={view.id} aria-label={view.title}>
          <header className="cl-panel__head">
            <div className="cl-panel__head-main" ref={slotFor(view.id)}>
              {view.header ?? <h2 className="cl-panel__title">{view.title}</h2>}
            </div>
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
          <div className="cl-panel__body">
            {view.content === undefined ? (
              <PanelEmpty id={view.id} title={view.title} onFindPlugin={onFindPlugin} />
            ) : typeof view.content === "function" ? (
              view.content(slots[view.id] ?? null)
            ) : (
              view.content
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
