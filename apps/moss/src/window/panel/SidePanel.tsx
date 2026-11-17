// The right panel, opened on demand (spec §6.10): the bot's own screen, live and watch only (a tool's live picture,
// §3.6: inert pixels with the publisher's name beside them, never markup), and under it the bot's routines (name,
// schedule, paused or not). The picture's "share" button is left out until item 126 says what it does.
import { useEffect, useState } from "react";
import { bridge, shortTime } from "../bridge";
import type { BotRow, PictureRow, RoutineRow } from "../../shared/view";

export function SidePanel(props: { bot: BotRow; onClose: () => void }) {
  const [pictures, setPictures] = useState<PictureRow[] | "waiting" | undefined>(undefined);
  const [routines, setRoutines] = useState<RoutineRow[] | "waiting" | undefined>(undefined);
  const [frame, setFrame] = useState<string | undefined>(undefined);
  const id = props.bot.id;
  useEffect(() => {
    let live = true;
    setPictures(undefined);
    setRoutines(undefined);
    setFrame(undefined);
    void bridge().pictures(id).then((p) => { if (live) setPictures("waiting" in p ? "waiting" : p); });
    void bridge().routines(id).then((r) => { if (live) setRoutines("waiting" in r ? "waiting" : r); });
    return () => { live = false; };
  }, [id]);
  const picture = Array.isArray(pictures) ? pictures[0] : undefined;
  useEffect(() => {
    if (picture === undefined) return;
    const off = bridge().onPictureFrame((f) => { if (f.id === picture.id) setFrame(f.url); });
    void bridge().openPicture(picture.id);
    return () => { off(); bridge().closePicture(picture.id); };
  }, [picture?.id]);
  return (
    <aside className="panel" data-col="panel" aria-label={`${props.bot.name}'s screen and routines`}>
      <header className="panel__head">
        <h2>{props.bot.name}'s screen</h2>
        <button type="button" className="icon-button" aria-label="Close the side panel" onClick={props.onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <section className="screen" data-picture={picture?.id ?? "none"}>
        {picture !== undefined ? (
          <>
            <div className="screen__view" style={{ aspectRatio: `${picture.width} / ${picture.height}` }}>
              {frame !== undefined ? <img src={frame} alt={`${props.bot.name}'s screen`} draggable={false} /> : <span className="screen__wait">Connecting…</span>}
              <span className="screen__live">Live</span>
            </div>
            <p className="screen__from">From {picture.publisher}{picture.screen ? " · your screen, MOSS's own windows blacked out" : ""} · watch only</p>
          </>
        ) : (
          <div className="screen__view screen__view--empty">
            <span>{pictures === "waiting" ? "Waiting for the engine's live pictures." : pictures === undefined ? "…" : `Nothing on ${props.bot.name}'s screen right now.`}</span>
          </div>
        )}
      </section>
      <section className="routines">
        <h3>Routines</h3>
        {routines === "waiting" ? <p className="routines__note">Waiting for the engine's routines.</p> : null}
        {Array.isArray(routines) && routines.length === 0 ? <p className="routines__note">{props.bot.name} has no routines yet.</p> : null}
        <ul>
          {Array.isArray(routines) ? routines.map((r) => (
            <li key={r.id} className={`routine${r.paused ? " is-paused" : ""}`} data-routine={r.id}>
              <span className="routine__name">{r.name}</span>
              <span className="routine__when">{r.schedule}{!r.paused && r.nextRunAt !== undefined ? ` · next ${shortTime(r.nextRunAt)}` : ""}</span>
              <span className={`chip${r.paused ? " chip--paused" : " chip--on"}`}>{r.paused ? "Paused" : "On"}</span>
            </li>
          )) : null}
        </ul>
      </section>
    </aside>
  );
}
