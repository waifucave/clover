// The right panel, opened on demand from the conversation's header (spec §6.10): the bot's own screen, live and watch
// only, and under it the bot's routines (name, schedule in words, paused or not, §7), each with Run now, Pause or Resume,
// and Edit (its name, schedule and what it does: the engine rewrites its file, `routine.edit`). Settings and close at the
// top; the owner's picture also has "share", which is left out until item 126 says what it does.
//
// The screen is a tool's live picture (§3.6): inert pixels, an <img> fed with the frames main checked (a data URL of a
// png, jpeg or webp), with the publisher's name beside it. Nothing in it takes a pointer, a key or the focus: no button,
// link, field or tabindex, and the image itself ignores the pointer; a click or a scroll on it is only told to main, which
// says it reached nothing (watch only) and sends nothing on. Taking the screen over comes later (item 106, G11).
import { useEffect, useState } from "react";
import { bridge, shortTime } from "../bridge";
import type { BotRow, PictureRow, RoutineEdit, RoutineRow } from "../../shared/view";

/** Only an image's pixels are drawn: a data URL of one of the three image types a picture may carry, nothing else. */
export function inertFrame(url: string): string | undefined {
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url) ? url : undefined;
}

export function SidePanel(props: { bot: BotRow; onClose: () => void; onSettings?: () => void; /** Changes when the window's cards do: an OK pressed changes a routine's state. */ cardsKey?: string }) {
  const [pictures, setPictures] = useState<PictureRow[] | "waiting" | undefined>(undefined);
  const [frame, setFrame] = useState<string | undefined>(undefined);
  const id = props.bot.id;
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
      <Routines bot={props.bot} {...(props.cardsKey !== undefined ? { cardsKey: props.cardsKey } : {})} />
    </aside>
  );
}

const STATE_WORDS: Record<RoutineRow["state"], string> = {
  active: "On",
  paused: "Paused",
  "waiting-for-ok": "Waiting for your OK",
  duplicate: "A copy: paused",
  "bot-removed": "Its bot is gone",
};

/** The bot's routines, each usable: run now, pause or resume, edit. A change is the person's own press (main checks it);
 *  the engine's why shows beside the routine when it refuses. */
function Routines(props: { bot: BotRow; cardsKey?: string }) {
  const [routines, setRoutines] = useState<RoutineRow[] | "waiting" | undefined>(undefined);
  const [said, setSaid] = useState<{ id: string; words: string } | undefined>(undefined);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const id = props.bot.id;
  useEffect(() => { setRoutines(undefined); setEditing(undefined); setSaid(undefined); }, [id]);
  useEffect(() => {
    let live = true;
    void bridge().routines(id).then((r) => { if (live) setRoutines("waiting" in r ? "waiting" : r); });
    return () => { live = false; };
  }, [id, reload, props.cardsKey]);
  const name = props.bot.name;
  const run = async (r: RoutineRow): Promise<void> => {
    setBusy(r.id);
    const out = await bridge().runRoutine(r.id);
    setBusy(undefined);
    setSaid({ id: r.id, words: out.ok ? "Started. Its result posts in the conversation." : out.why });
    setReload((n) => n + 1);
  };
  const pause = async (r: RoutineRow, paused: boolean): Promise<void> => {
    setBusy(r.id);
    const out = await bridge().editRoutine(id, r.id, { paused });
    setBusy(undefined);
    setSaid(out.ok ? undefined : { id: r.id, words: out.why });
    setReload((n) => n + 1);
  };
  return (
    <section className="routines" aria-label={`${name}'s routines`}>
      <h3>Routines</h3>
      {routines === "waiting" ? <p className="routines__note">Waiting for the engine's routines.</p> : null}
      {Array.isArray(routines) && routines.length === 0 ? <p className="routines__note">{name} has no routines yet. Ask {name} to make one.</p> : null}
      <ul>
        {Array.isArray(routines) ? routines.map((r) => (
          <li key={r.id} className={`routine${r.paused ? " is-paused" : ""}`} data-routine={r.id} data-paused={r.paused ? "true" : "false"} data-state={r.state}>
            <span className="routine__name">{r.name}</span>
            <span className="routine__when">{r.schedule}{r.state === "active" && r.nextRunAt !== undefined ? ` · next ${shortTime(r.nextRunAt)}` : ""}</span>
            <span className={`chip${r.paused ? " chip--paused" : " chip--on"}`}>{STATE_WORDS[r.state]}</span>
            {r.pausedWhy !== undefined ? <span className="routine__why">{r.pausedWhy}</span> : null}
            {editing === r.id ? (
              <RoutineForm bot={id} routine={r} onDone={(words) => { setEditing(undefined); setSaid(words === undefined ? undefined : { id: r.id, words }); setReload((n) => n + 1); }} />
            ) : (
              <span className="routine__actions">
                <button type="button" className="text-button" data-routine-run disabled={r.state !== "active" || busy === r.id} onClick={() => void run(r)}>Run now</button>
                {r.state === "paused" ? <button type="button" className="text-button" data-routine-resume disabled={busy === r.id} onClick={() => void pause(r, false)}>Resume</button>
                  : r.state === "active" || r.state === "waiting-for-ok" ? <button type="button" className="text-button" data-routine-pause disabled={busy === r.id} onClick={() => void pause(r, true)}>Pause</button> : null}
                <button type="button" className="text-button" data-routine-edit disabled={r.state === "duplicate" || r.state === "bot-removed"} onClick={() => { setSaid(undefined); setEditing(r.id); }}>Edit</button>
              </span>
            )}
            {said?.id === r.id ? <span className="routine__said" role="status" data-routine-said>{said.words}</span> : null}
          </li>
        )) : null}
      </ul>
    </section>
  );
}

/** A routine's edit form: its name, its schedule and what it does, as its file has them now (`routine.get`), so a save
 *  never writes over words the person couldn't see. Only what changed is sent. */
function RoutineForm(props: { bot: string; routine: RoutineRow; onDone: (words?: string) => void }) {
  const r = props.routine;
  const [name, setName] = useState(r.name);
  const [schedule, setSchedule] = useState(r.scheduleSpec ?? "");
  const [instructions, setInstructions] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState<string | undefined>(undefined);
  const [why, setWhy] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    void bridge().routineInstructions(props.bot, r.id).then((got) => {
      if (!live) return;
      if ("text" in got) { setInstructions(got.text.trimEnd()); setLoaded(got.text.trimEnd()); } else setWhy(got.why);
    });
    return () => { live = false; };
  }, [props.bot, r.id]);
  const save = async (): Promise<void> => {
    const patch: RoutineEdit = {};
    if (name.trim() !== "" && name.trim() !== r.name) patch.name = name.trim();
    if (schedule.trim() !== "" && schedule.trim() !== (r.scheduleSpec ?? "")) patch.schedule = schedule.trim();
    if (instructions !== undefined && instructions.trim() !== "" && instructions.trim() !== (loaded ?? "").trim()) patch.instructions = instructions.trim();
    if (Object.keys(patch).length === 0) { props.onDone(); return; }
    setSaving(true);
    const out = await bridge().editRoutine(props.bot, r.id, patch);
    setSaving(false);
    if (out.ok) props.onDone("Saved.");
    else setWhy(out.why);
  };
  return (
    <form className="routine__form" data-routine-form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>Name<input data-routine-name value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></label>
      <label>Schedule<input data-routine-schedule value={schedule} maxLength={200} placeholder="every 6h, or 0 8 * * 1-5" onChange={(e) => setSchedule(e.target.value)} /></label>
      <label>What it does
        {instructions === undefined ? <span className="muted">{why === undefined ? "Reading…" : ""}</span>
          : <textarea data-routine-instructions rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />}
      </label>
      {why !== undefined ? <span className="routine__said" role="status" data-routine-said>{why}</span> : null}
      <span className="routine__actions">
        <button type="submit" className="text-button" data-routine-save disabled={saving || instructions === undefined}>Save</button>
        <button type="button" className="text-button" data-routine-cancel onClick={() => props.onDone()}>Cancel</button>
      </span>
    </form>
  );
}
