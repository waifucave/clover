// The language chooser: a dialog with a search box over every language, each named in itself and in
// the language the app shows now, the current one checked. A pick goes to the host, which loads the
// strings (spec §5.5, "Translations").
import { useEffect, useId, useRef, useState } from "react";
import { S } from "./strings";
import type { LanguageChooserProps } from "./types";

export function LanguageChooser({ languages, current, onPick, onClose }: LanguageChooserProps) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const titleId = useId();
  useEffect(() => search.current?.focus(), []);
  const q = query.trim().toLowerCase();
  const shown = q.length === 0 ? languages : languages.filter((l) => l.native.toLowerCase().includes(q) || l.name.toLowerCase().includes(q) || l.id.toLowerCase() === q);
  return (
    <div
      className="cl-languages"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="cl-settings__head">
        <h2 className="cl-settings__title" id={titleId}>
          {S.chooseLanguage}
        </h2>
        <button type="button" className="cl-settings__close" aria-label={S.closeLanguages} onClick={onClose}>
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className="cl-languages__body">
        <input ref={search} className="cl-settings__search cl-languages__search" type="search" placeholder={S.searchLanguages} aria-label={S.searchLanguages} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="cl-languages__grid" role="radiogroup" aria-label={S.chooseLanguage}>
          {shown.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={l.id === current} className="cl-languages__option" lang={l.id} onClick={() => onPick(l.id)}>
              <span className="cl-languages__native">{l.native}</span>
              <span className="cl-languages__name" lang="">
                {l.name}
              </span>
              {l.id === current && (
                <svg className="cl-languages__check" width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="M3.5 8.5l3 3 6-7" />
                </svg>
              )}
            </button>
          ))}
          {shown.length === 0 && <p className="cl-settings__note">{S.noLanguage}</p>}
        </div>
      </div>
    </div>
  );
}
