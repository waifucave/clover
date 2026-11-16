// The Plugins page's Updates and Indexes tabs. Updates: what is newer (`plugin.update { list }`, a read); nothing
// updates on its own (the owner's ruling, 2026-11-13). Apply (one plugin at a time: it asks on a sealed card first; one
// that asks for its OK again shows that card) and Hold back (a pin, this computer's only: no updates offered).
// Indexes: the plain lists of plugins the user added, each with its health (last checked, a failed fetch); Add one by
// its address (each plugin from it still asks for its OK), Remove one (a card when installed plugins came from it).
import { useState } from "react";
import { S } from "./strings";
import type { IndexesProps, UpdatesProps } from "./types";

export function Updates(props: UpdatesProps) {
  return (
    <div className="cl-plugin-index__updates">
      <div className="cl-plugin-index__row">
        <button type="button" className="cl-plugin-index__button" disabled={props.checking} onClick={props.onCheck}>
          {props.checking ? S.checking : S.checkNow}
        </button>
      </div>
      {props.status && (
        <p className="cl-plugin-index__status" data-tone={props.status.tone} role="status">
          {props.status.text}
        </p>
      )}
      {props.updates.length === 0 ? (
        <p className="cl-plugin-index__note">{props.checking ? S.checking : S.noUpdates}</p>
      ) : (
        <ul className="cl-plugin-index__results" aria-label={S.tabs.updates}>
          {props.updates.map((u) => (
            <li key={u.id} className="cl-plugin-index__result" data-update={u.id}>
              <div className="cl-plugin-index__text">
                <span className="cl-plugin-index__name">{u.name}</span>
                <span className="cl-plugin-index__meta">{S.fromTo(u.from, u.to)}</span>
                <span className="cl-plugin-index__description">{u.why}</span>
              </div>
              <div className="cl-plugin-index__action">
                <button type="button" className="cl-plugin-index__button" onClick={() => props.onPin(u.id, !u.pinned)}>
                  {u.pinned ? S.letThrough : S.holdBack}
                </button>
                {!u.pinned && (
                  <button type="button" className="cl-plugin-index__install" aria-label={S.applyName(u.name)} onClick={() => props.onApply(u.id)}>
                    {S.apply}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Indexes(props: IndexesProps) {
  const [url, setUrl] = useState("");
  return (
    <div className="cl-plugin-index__manage-indexes">
      {props.status && (
        <p className="cl-plugin-index__status" data-tone={props.status.tone} role="status">
          {props.status.text}
        </p>
      )}
      <section className="cl-plugin-index__section" aria-label={S.yourIndexes}>
        <h2 className="cl-plugin-index__subhead">{S.yourIndexes}</h2>
        <p className="cl-plugin-index__note">{S.yourIndexesDetail}</p>
        {props.indexes.length === 0 ? (
          <p className="cl-plugin-index__note">{S.noIndexes}</p>
        ) : (
          <ul className="cl-plugin-index__indexes" aria-label={S.yourIndexes}>
            {props.indexes.map((i) => (
              <li key={i.url} className="cl-plugin-index__index cl-plugin-index__setting" data-index={i.url}>
                <span className="cl-plugin-index__name">{i.name ?? i.url}</span>
                <span className="cl-plugin-index__meta" data-tone={i.error ? "attention" : undefined}>
                  {i.name ? `${i.url} · ` : ""}
                  {props.health(i)}
                </span>
                <button type="button" className="cl-plugin-index__button" data-tone="danger" aria-label={S.removeIndexName(i.name ?? i.url)} onClick={() => props.onRemove(i.url)}>
                  {S.removeIndex}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="cl-plugin-index__row"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim() !== "") props.onAdd(url.trim());
          }}
        >
          <input className="cl-plugin-index__field" type="url" aria-label={S.indexUrl} placeholder={S.indexUrl} value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="submit" className="cl-plugin-index__install" disabled={url.trim() === ""}>
            {S.addIndexButton}
          </button>
        </form>
      </section>
    </div>
  );
}
