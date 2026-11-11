// The Plugins page's Updates and Indexes tabs. Updates: what is newer (`plugin.update { list }`, a read), each with
// why it isn't applied on its own, Apply (one plugin at a time: an update from an index the user added or npm asks on
// a sealed card first; one that asks for its OK again shows that card) and Hold back (a pin, this computer's only).
// Indexes: where plugins come from, each with its health (last checked, a failed fetch, a stale copy, its revocation
// list); Add one by its address and key (the core's warning card names the key's fingerprint), Remove one (a card when
// installed plugins came from it). The official slot says plainly when this build has none.
import { useState } from "react";
import { IconOfficial } from "./icons";
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
  const [key, setKey] = useState("");
  const official = props.indexes.find((i) => i.official);
  const others = props.indexes.filter((i) => !i.official);
  const keyOk = /^[0-9a-f]{64}$/.test(key.trim());
  return (
    <div className="cl-plugin-index__manage-indexes">
      {props.status && (
        <p className="cl-plugin-index__status" data-tone={props.status.tone} role="status">
          {props.status.text}
        </p>
      )}
      <section className="cl-plugin-index__section" aria-label={S.officialIndex}>
        <h2 className="cl-plugin-index__subhead">{S.officialIndex}</h2>
        {official ? (
          <ul className="cl-plugin-index__indexes">
            <li className="cl-plugin-index__index">
              <span className="cl-plugin-index__name">
                {official.name ?? official.url}
                <span className="cl-plugin-index__badge" data-tone="accent">
                  <IconOfficial />
                  {S.official}
                </span>
              </span>
              <span className="cl-plugin-index__meta">{props.health(official)}</span>
            </li>
          </ul>
        ) : (
          <p className="cl-plugin-index__note" data-official="none">{S.noOfficial}</p>
        )}
      </section>

      <section className="cl-plugin-index__section" aria-label={S.yourIndexes}>
        <h2 className="cl-plugin-index__subhead">{S.yourIndexes}</h2>
        <p className="cl-plugin-index__note">{S.yourIndexesDetail}</p>
        {others.length === 0 ? (
          <p className="cl-plugin-index__note">{S.noIndexes}</p>
        ) : (
          <ul className="cl-plugin-index__indexes" aria-label={S.yourIndexes}>
            {others.map((i) => (
              <li key={i.url} className="cl-plugin-index__index cl-plugin-index__setting" data-index={i.url}>
                <span className="cl-plugin-index__name">
                  {i.name ?? i.url}
                  <span className="cl-plugin-index__badge" data-tone="attention">{S.notReviewed}</span>
                </span>
                <span className="cl-plugin-index__meta" data-tone={i.error || i.stale ? "attention" : undefined}>
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
            if (url.trim() !== "" && keyOk) props.onAdd(url.trim(), key.trim());
          }}
        >
          <input className="cl-plugin-index__field" type="url" aria-label={S.indexUrl} placeholder={S.indexUrl} value={url} onChange={(e) => setUrl(e.target.value)} />
          <input className="cl-plugin-index__field" aria-label={S.indexKey} placeholder={S.indexKey} value={key} spellCheck={false} onChange={(e) => setKey(e.target.value)} />
          <button type="submit" className="cl-plugin-index__install" disabled={url.trim() === "" || !keyOk}>
            {S.addIndexButton}
          </button>
        </form>
        <p className="cl-plugin-index__note">{S.indexKeyDetail}</p>
      </section>
    </div>
  );
}
