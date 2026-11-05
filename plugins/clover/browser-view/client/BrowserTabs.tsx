// The tab row: one tab per page, a close button on each, and + for a new one. It is the panel's header row, 45 px
// high like the title bar. A tab shows its page's title, a spinner in place of its globe while the page loads, and a
// hand while the user holds it in the view. The hand is for the eye; for a screen reader the tab's description
// (its `title`) says what the hand means, and the tab's name stays the page's title.
import { IconClose, IconGlobe, IconHeld, IconLoading, IconPlus } from "./icons";
import { S } from "./strings";
import type { BrowserTabsProps } from "./types";

export function BrowserTabs({ tabs, active, onSelect, onClose, onNew }: BrowserTabsProps) {
  return (
    <div className="cl-browser-tabs" role="tablist" aria-label={S.tabs}>
      {tabs.map((tab) => (
        <div key={tab.id} className="cl-browser-tabs__tab" data-active={tab.id === active || undefined} data-held={tab.held || undefined} data-loading={tab.loading || undefined}>
          <button
            type="button"
            role="tab"
            aria-selected={tab.id === active}
            aria-busy={tab.loading || undefined}
            className="cl-browser-tabs__select"
            title={tab.held ? `${tab.url}\n${S.held}` : tab.url}
            onClick={() => onSelect(tab.id)}
          >
            {tab.loading ? <IconLoading /> : <IconGlobe />}
            <span className="cl-browser-tabs__title">{tab.title}</span>
            {tab.held && (
              <span className="cl-browser-tabs__held" aria-hidden="true">
                <IconHeld />
              </span>
            )}
          </button>
          <button type="button" className="cl-browser-tabs__close" aria-label={S.close(tab.title)} title={S.close(tab.title)} onClick={() => onClose(tab.id)}>
            <IconClose />
          </button>
        </div>
      ))}
      {onNew && (
        <button type="button" className="cl-browser-tabs__new" aria-label={S.newTab} title={S.newTab} onClick={onNew}>
          <IconPlus />
        </button>
      )}
    </div>
  );
}
