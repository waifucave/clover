// The archive: a page in the main area (`main` keyed `archive`). The old sessions in a searchable list on the left,
// newest first, each with its mode, its project and when it was last used; the one picked reads on the right,
// read only.
import { IconArchive, IconSearch } from "./icons";
import { S } from "./strings";
import type { ArchiveProps, ArchivedSession } from "./types";

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function dateText(at: number, now: number, format: ArchiveProps["format"]): string {
  const opts = { ...(format?.timeZone ? { timeZone: format.timeZone } : {}) };
  const locale = format?.locale ?? "en-US";
  const sameYear = new Date(at).getUTCFullYear() === new Date(now).getUTCFullYear();
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), ...opts }).format(at);
}

function meta(s: ArchivedSession, now: number, format: ArchiveProps["format"]): string {
  return [S.mode[s.mode], s.project ? folderName(s.project) : undefined, dateText(s.updatedAt, now, format)].filter(Boolean).join(" · ");
}

export function Archive(props: ArchiveProps) {
  const selected = props.sessions.find((s) => s.id === props.selected);
  return (
    <div className="cl-archive">
      <aside className="cl-archive__list">
        <header className="cl-archive__head">
          <h1 className="cl-archive__title">{S.title}</h1>
          <p className="cl-archive__intro">{S.intro}</p>
          <form
            className="cl-archive__search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              props.onSearch(props.query.trim());
            }}
          >
            <IconSearch />
            <input className="cl-archive__search-input" type="search" aria-label={S.search} placeholder={S.search} value={props.query} onChange={(e) => props.onQuery(e.target.value)} />
          </form>
        </header>
        {props.loading ? (
          <p className="cl-archive__note" role="status">
            {S.loading}
          </p>
        ) : props.sessions.length === 0 ? (
          <p className="cl-archive__note">{S.none(props.query.trim())}</p>
        ) : (
          <ul className="cl-archive__sessions" aria-label={S.sessions}>
            {props.sessions.map((s) => (
              <li key={s.id}>
                <button type="button" className="cl-archive__session" aria-current={s.id === props.selected ? "true" : undefined} onClick={() => props.onSelect(s.id)}>
                  <span className="cl-archive__session-title">{s.title ?? S.untitled}</span>
                  <span className="cl-archive__session-meta">{meta(s, props.now, props.format)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {props.more && props.onMore && (
          <button type="button" className="cl-archive__more" onClick={props.onMore}>
            {S.more}
          </button>
        )}
      </aside>
      <section className="cl-archive__reader" aria-label={selected ? (selected.title ?? S.untitled) : S.title}>
        {selected ? (
          <>
            <header className="cl-archive__reader-head">
              <h2 className="cl-archive__reader-title">{selected.title ?? S.untitled}</h2>
              <p className="cl-archive__reader-meta">
                {[meta(selected, props.now, props.format), selected.model, S.messages(selected.messages)].filter(Boolean).join(" · ")}
              </p>
              <p className="cl-archive__reader-note">{S.readOnly}</p>
            </header>
            <div className="cl-archive__transcript">{props.transcript}</div>
          </>
        ) : (
          <div className="cl-archive__empty">
            <IconArchive />
            <p>{S.pick}</p>
          </div>
        )}
      </section>
    </div>
  );
}
