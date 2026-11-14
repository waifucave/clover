// The buttons of the panels plugins add (§5.5, a `panel` entry whose key isn't a stock panel's): they follow the stock buttons in
// their `order`, up to three of them; any more go into one menu button, so the bar never overflows. A button says whether its panel is
// open (`aria-pressed`), as the stock ones do. The press is the app's own.
import { useEffect, useRef, useState } from "react";
import { IconOwnPanel } from "./icons";
import type { OwnPanel } from "./panel-types";
import { S } from "./strings";

/** The most added panels given a button of their own; the rest are in the menu. */
export const OWN_BUTTONS_MAX = 3;

/** A plugin's picture (only one the app already holds as an image), else the stock glyph. */
const SAFE_ASSET = /^(blob:|data:image\/|clover-asset:)/i;

function OwnGlyph({ icon }: { icon: string | undefined }) {
  return icon !== undefined && SAFE_ASSET.test(icon) ? <img className="cl-panel-toggle__image" src={icon} alt="" width={18} height={18} /> : <IconOwnPanel />;
}

export function OwnPanelToggles({ own, open, onToggle }: { own: readonly OwnPanel[]; open: readonly string[]; onToggle: (id: string) => void }) {
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: Event) => { if (!root.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [menu]);
  if (own.length === 0) return null;
  const buttons = own.length > OWN_BUTTONS_MAX ? own.slice(0, OWN_BUTTONS_MAX) : own;
  const rest = own.slice(buttons.length);
  const restOpen = rest.some((p) => open.includes(p.id));
  return (
    <div className="cl-panel-toggles cl-panel-toggles--own" data-own-panels={own.length} ref={root}>
      {buttons.map((p) => {
        const pressed = open.includes(p.id);
        return (
          <button key={p.id} type="button" className="cl-panel-toggle" data-own-panel={p.id} aria-pressed={pressed} aria-label={p.title} title={S.toggle(p.title, pressed)} onClick={() => onToggle(p.id)}>
            <OwnGlyph icon={p.icon} />
          </button>
        );
      })}
      {rest.length > 0 && (
        <div className="cl-panel-toggles__menu-wrap">
          <button type="button" className="cl-panel-toggle" data-own-menu="" aria-haspopup="menu" aria-expanded={menu} aria-pressed={restOpen} aria-label={S.otherPanels} title={S.otherPanels} onClick={() => setMenu((m) => !m)}>
            <IconOwnPanel />
          </button>
          {menu && (
            <div className="cl-panel-toggles__menu" role="menu" aria-label={S.otherPanels}>
              {rest.map((p) => {
                const pressed = open.includes(p.id);
                return (
                  <button key={p.id} type="button" role="menuitemcheckbox" aria-checked={pressed} className="cl-panel-toggles__item" data-own-panel={p.id} onClick={() => { onToggle(p.id); setMenu(false); }}>
                    <OwnGlyph icon={p.icon} />
                    <span>{p.title}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
