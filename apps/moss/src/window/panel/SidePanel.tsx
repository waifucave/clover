// The right panel, opened on demand from the conversation's header (spec §6.10): the bot's own screen, live and watch
// only, and under it the bot's routines (name, schedule in words, paused or not, §7). Settings and close at the top; the
// owner's picture also has "share", which is left out until item 126 says what it does.
//
// The screen is a tool's live picture (§3.6): inert pixels, an <img> fed with the frames main checked (a data URL of a
// png, jpeg or webp), with the publisher's name beside it. Nothing in it takes a pointer, a key or the focus: no button,
// link, field or tabindex, and the image itself ignores the pointer; a click or a scroll on it is only told to main, which
// says it reached nothing (watch only) and sends nothing on. Taking the screen over comes later (item 106, G11).
import { useEffect, useState } from "react";
import { bridge, shortTime } from "../bridge";
import type { BotRow, PictureRow, RoutineRow } from "../../shared/view";

/** Only an image's pixels are drawn: a data URL of one of the three image types a picture may carry, nothing else. */
export function inertFrame(url: string): string | undefined {
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url) ? url : undefined;
}

export function SidePanel(props: { bot: BotRow; onClose: () => void; onSettings?: () => void }) {
  const [pictures, setPictures] = useState<PictureRow[] | "waiting" | undefined>(undefined);
  const [routines, setRoutines] = useState<RoutineRow[] | "waiting" | undefined>(undefined);
  const [frame, setFrame] = useState<string | undefined>(undefined);
  const id = props.bot.id;
  useEffect(() => {
    let live = true;
    setRoutines(undefined);
    void bridge().routines(id).then((r) => { if (live) setRoutines("waiting" in r ? "waiting" : r); });
    return () => { live = false; };
  }, [id]);
  useEffect(() => { setPictures(undefined); }, [id]);
  // A picture starts and ends with the bot's tool use, so the list is read again whenever the feed says the bot moved on
  // (its mood or its tool), not only when another bot is opened.
  useEffect(() => {
    let live = true;
    void bridge().pictures(id).then((p) => { if (live) setPictures("waiting" in p ? "waiting" : p); });
    return () => { live = false; };
  }, [id, props.bot.mood, props.bot.tool]);
  const picture = Array.isArray(pictures) ? pictures[0] : undefined;
  useEffect(() => {
    setFrame(undefined);
    if (picture === undefined) return;
    const off = bridge().onPictureFrame((f) => {
      if (f.id !== picture.id) return;
      const url = inertFrame(f.url);
      if (url !== undefined) setFrame(url);
    });
    void bridge().openPicture(picture.id);
    return () => { off(); bridge().closePicture(picture.id); };
  }, [picture?.id]);
  const name = props.bot.name;
  return (
    <aside className="panel" data-col="panel" aria-label={`${name}'s screen and routines`}>
      <header className="panel__head">
        <h2>{name}'s screen</h2>
        {props.onSettings !== undefined ? (
          <button type="button" className="icon-button" aria-label={`${name}'s settings`} title={`${name}'s settings`} onClick={props.onSettings}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></svg>
          </button>
        ) : null}
        <button type="button" className="icon-button" aria-label="Close the side panel" title="Close" onClick={props.onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <section className="screen ma2-screen" data-picture={picture?.id ?? "none"} aria-label={`${name}'s screen, watch only`}>
        {picture !== undefined ? (
          <>
            <div
              className="screen__view" role="img" aria-label={`${name}'s screen, from ${picture.publisherName ?? picture.publisher}`} style={{ aspectRatio: `${picture.width} / ${picture.height}` }}
              data-watch-only onPointerDown={() => bridge().pictureInput("pointer")} onWheel={() => bridge().pictureInput("wheel")}
            >
              {frame !== undefined ? <img src={frame} alt="" draggable={false} /> : <span className="screen__wait">Connecting…</span>}
              <span className="screen__live" aria-hidden="true">Live</span>
            </div>
            <p className="screen__from" data-publisher={picture.publisher}>
              <span>From&nbsp;</span>
              <span className="ma2-publisher">{picture.publisherName ?? picture.publisher}</span>
              {picture.publisherName !== undefined && picture.publisherName !== picture.publisher ? <span className="ma2-publisher-id">&nbsp;({picture.publisher})</span> : null}
              {picture.screen ? <span> · your screen, MOSS's own windows blacked out</span> : null}
              <span className="ma2-watch"> · watch only</span>
            </p>
          </>
        ) : (
          <div className="screen__view screen__view--empty ma2-screen__none" data-screen-state={pictures === "waiting" ? "waiting" : pictures === undefined ? "loading" : "none"}>
            {pictures === "waiting" ? <span>Waiting for the engine's live pictures.</span>
              : pictures === undefined ? <span>…</span>
              : (
                <span className="ma2-none">
                  <strong>Nothing on {name}'s screen</strong>
                  <span>When {name} uses a tool that shows its work, like the browser, you can watch it here.</span>
                </span>
              )}
          </div>
        )}
      </section>
      <section className="routines" aria-label={`${name}'s routines`}>
        <h3>Routines</h3>
        {routines === "waiting" ? <p className="routines__note">Waiting for the engine's routines.</p> : null}
        {Array.isArray(routines) && routines.length === 0 ? <p className="routines__note">{name} has no routines yet. Ask {name} to make one.</p> : null}
        <ul>
          {Array.isArray(routines) ? routines.map((r) => (
            <li key={r.id} className={`routine${r.paused ? " is-paused" : ""}`} data-routine={r.id} data-paused={r.paused ? "true" : "false"}>
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
