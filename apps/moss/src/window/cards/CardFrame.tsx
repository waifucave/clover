// A card the router placed in MOSS's window (spec §3.5, §5.5, §6.10): drawn by the core's own sealed frame, one
// single-use `moss-sealed://` page per card that MOSS's main process mints, serves and answers. The window knows the
// card's id, its bot and its kind; never its words, which live in the frame alone. A press on its buttons is judged
// by MOSS's main process (press.ts), not here. No filter, opacity or transform touches the frame (they read as hidden).
import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import type { CardRow } from "../../shared/view";

export function CardFrame(props: { card: CardRow }) {
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [height, setHeight] = useState(220);
  const [said, setSaid] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void bridge().cardFrame(props.card.id).then((url) => { if (live) setSrc(url); });
    const off = bridge().onCardHeight((id, h) => { if (id === props.card.id) setHeight(h); });
    // Why a press on it was refused (MOSS's main process says; the words are MOSS's or the engine's, shown as text).
    const offSaid = bridge().onCardSaid((id, words) => { if (id === props.card.id) setSaid(words.slice(0, 300)); });
    return () => { live = false; off(); offSaid(); };
  }, [props.card.id]);
  return (
    <div className="card" data-card={props.card.id} data-card-place={props.card.place}>
      {src !== undefined
        ? <iframe data-card-frame={props.card.id} src={src} title="A card that needs you" style={{ height }} />
        : <p className="card__wait">Opening the card…</p>}
      {said !== undefined ? <p className="card__said" role="status" data-card-said>{said}</p> : null}
    </div>
  );
}

/** The window's own strip (§3.5 ruling A): cards for another bot, or with no bot, while this window is in front. */
export function Strip(props: { cards: CardRow[]; botName: (id: string) => string | undefined; onOpen: (bot: string) => void }) {
  if (props.cards.length === 0) return null;
  return (
    <section className="strip" aria-label="Needs you">
      {props.cards.map((c) => {
        const name = c.bot !== undefined ? props.botName(c.bot) : undefined;
        return (
          <div key={c.id} className="strip__item">
            <p className="strip__who">
              {name !== undefined ? <><strong>{name}</strong> needs you</> : "MOSS needs you"}
              {c.bot !== undefined ? <button type="button" className="text-button" onClick={() => props.onOpen(c.bot!)}>Open</button> : null}
            </p>
            <CardFrame card={c} />
          </div>
        );
      })}
    </section>
  );
}
