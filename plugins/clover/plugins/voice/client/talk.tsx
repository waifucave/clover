// Clover Voice's hold-to-talk button: its own entry in the composer's buttons (`composer.action`, key `voice`), shown only
// while the bot's voice would hear it (`listens`, read again whenever this plugin's settings change, the voice picked in
// Settings changes, or a provider comes or goes).
//
// Held (the mouse, or Space or Enter while it has the focus): it takes the device's microphone turn
// (`device/microphone`), records 16 kHz PCM (`src/recorder.ts`: the real microphone through the `microphone` capability,
// a generated clip in a test or acceptance build) and streams it to its host half (`streams.open("talk")`), which holds
// the player meanwhile. Released: the stream ends, the host half has the voice picked write it down (`heard`), and the
// words go to the bot as the user's message (`useUserSend`): the app counts it as the user's because main saw this
// frame's press and release, for one send within 30 s of the release.
//
// It never sticks on: a hold that ends without the user's release (the window losing the focus or going hidden, the button
// losing the focus, the pointer cancelled, the button going away) is dropped: the microphone closes, the stream is aborted,
// the turn is let go, and nothing is sent.
//
// A test or acceptance build marks its counters on the document's root (`data-voice-talk-*`).
import { useCallback, useEffect, useRef, useState } from "react";
import type { BotRef, EntryProps } from "../../shell/runtime/types";
import { usePluginApi, useUserSend } from "./sdk";
import { S } from "./strings";
import { defaultSource, testBuild, type PcmHandle, type PcmSource } from "../src/recorder";

/** The device turn a recording holds (P2). */
export const DEVICE_MICROPHONE = "device/microphone";
const PROVIDERS = "clover.voice.providers";
const MODES = "clover.voice.modes";

let made: PcmSource | undefined;
/** Test seam: the next recordings' source (undefined: the build's own). */
export function setTalkSource(source: PcmSource | undefined): void {
  made = source;
}

let count = 0;

/** Whether a hold was dropped (read after each wait: another handler may have dropped it meanwhile). */
const gone = (r: Rec): boolean => r.dropped === true;

type Phase = "idle" | "listening" | "hearing";

/** One recording: its stream's writer, its source, its turn; `released` once the user let go. */
interface Rec {
  id: string;
  released: boolean;
  /** Ended without the user's release: nothing is sent. */
  dropped?: boolean;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  handle?: PcmHandle;
  turn?: { done(): Promise<void> | void };
}

export function TalkButton({ props }: EntryProps<{ bot: BotRef; session: string }>) {
  const api = usePluginApi();
  const send = useUserSend();
  const bot = props.bot.id;
  const [listens, setListens] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState<string | undefined>(undefined);
  /** The recording now. */
  const current = useRef<Rec | undefined>(undefined);
  /** Mounted: a dropped hold's state is set only then. */
  const live = useRef(true);

  useEffect(() => {
    let live = true;
    const read = (): void => {
      void Promise.resolve(api.host.call<boolean>("listens", { bot, session: props.session })).then((on) => { if (live) setListens(on === true); }, () => { if (live) setListens(false); });
    };
    read();
    // What decides it is this plugin's own: its settings, the voice picked, its providers. No window focus needed.
    const offs = [api.settings.watch(null, read), api.points.onActive(MODES, read), api.points.watch(PROVIDERS, read), api.points.watch(MODES, read)];
    return () => {
      live = false;
      for (const off of offs) void Promise.resolve(off).then((f) => (typeof f === "function" ? f() : undefined), () => undefined);
    };
  }, [api, bot, props.session]);

  const mark = useCallback((what: Record<string, string | number>) => {
    if (!testBuild() || typeof document === "undefined") return;
    const d = document.documentElement.dataset as Record<string, string | undefined>;
    for (const [k, v] of Object.entries(what)) d[k] = String(v);
  }, []);

  /** The user let go: the recording ends, its words are heard, and they go to the bot as the user's message. */
  const finish = useCallback(async (rec: Rec) => {
    rec.handle?.stop();
    try {
      await rec.writer?.close();
    } catch {
      /* the stream already ended */
    }
    await Promise.resolve(rec.turn?.done()).catch(() => undefined);
    if (rec.writer === undefined) {
      if (current.current === rec) current.current = undefined;
      setPhase("idle");
      return;
    }
    setPhase("hearing");
    const r: { text?: string; note?: string } = await Promise.resolve(api.host.call<{ text?: string; note?: string }>("heard", { utterance: rec.id })).catch((err: unknown) => ({ note: err instanceof Error ? err.message : String(err) }));
    if (current.current === rec) current.current = undefined;
    setPhase("idle");
    if (typeof r?.text === "string" && r.text.trim() !== "") {
      if (send === undefined) return setNote(S.talkNoSend);
      // One send after this frame's press and release (the app's 30 s allowance).
      await send({ session: props.session }, { text: r.text }).catch(() => setNote(S.talkRefused));
    } else setNote(r?.note ?? S.talkNothing);
  }, [api, send, props.session]);

  /** A hold that ended without the user's release: closed, nothing heard, nothing sent. */
  const drop = useCallback((rec: Rec, why?: string) => {
    if (rec.dropped === true) return;
    rec.dropped = true;
    rec.released = true;
    rec.handle?.stop();
    void rec.writer?.abort("the hold ended without a release").catch(() => undefined);
    void Promise.resolve(rec.turn?.done()).catch(() => undefined);
    if (current.current === rec) current.current = undefined;
    if (live.current) {
      setPhase("idle");
      setNote(why);
    }
  }, []);

  const start = useCallback(async () => {
    if (current.current !== undefined) return;
    const rec: Rec = { id: `talk_${Date.now().toString(36)}_${(++count).toString(36)}`, released: false };
    current.current = rec;
    setNote(undefined);
    setPhase("listening");
    try {
      // One recording at a time on this device.
      rec.turn = await api.turns.take(DEVICE_MICROPHONE, { limitMs: 70_000, note: bot });
      if (gone(rec)) return void rec.turn.done();
      if (rec.released) return void finish(rec);
      const writable = await api.streams.open("talk", { meta: { bot, utterance: rec.id } });
      rec.writer = writable.getWriter();
      if (gone(rec)) return void rec.writer.abort("the hold ended without a release").catch(() => undefined);
      if (rec.released) return void finish(rec);
      const source = made ?? defaultSource();
      let bytes = 0;
      const starts = Number((typeof document !== "undefined" ? document.documentElement.dataset.voiceTalkStarts : undefined) ?? 0) + 1;
      mark({ voiceTalkStarts: starts, voiceTalkSource: made !== undefined ? "test" : testBuild() ? "clip" : "mic", voiceTalkBytes: 0 });
      rec.handle = await source({
        chunk: (pcm) => {
          bytes += pcm.length;
          mark({ voiceTalkBytes: bytes });
          void rec.writer?.write(pcm).catch(() => undefined);
        },
        end: () => {
          rec.released = true;
          void finish(rec);
        },
      });
      if (gone(rec) || rec.released) rec.handle.stop();
    } catch (err) {
      rec.handle?.stop();
      void rec.writer?.abort(err instanceof Error ? err.message : "the recording didn't start").catch(() => undefined);
      await Promise.resolve(rec.turn?.done()).catch(() => undefined);
      if (current.current === rec) current.current = undefined;
      setPhase("idle");
      setNote(S.talkRefused);
    }
  }, [api, bot, finish, mark]);

  const end = useCallback(() => {
    const rec = current.current;
    if (rec === undefined || rec.released) return;
    rec.released = true;
    // Not open yet: `start` finishes it as soon as it is.
    if (rec.writer !== undefined) void finish(rec);
  }, [finish]);

  /** Not a release: the hold is dropped. */
  const cancel = useCallback(() => {
    const rec = current.current;
    if (rec !== undefined && !rec.released) drop(rec, S.talkStopped);
  }, [drop]);

  // The window losing the focus or going hidden ends a hold without a release; so does the button going away.
  useEffect(() => {
    live.current = true;
    const hidden = () => {
      if (document.visibilityState !== "visible") cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
      live.current = false;
      const rec = current.current;
      if (rec !== undefined && rec.dropped !== true) drop(rec);
    };
  }, [cancel, drop]);

  if (!listens) return null;
  return (
    <span className="cl-voice-talk" data-voice-talk={phase}>
      <button
        type="button"
        className="cl-voice-talk__button"
        aria-label={S.holdToTalk}
        title={S.holdToTalk}
        aria-pressed={phase === "listening"}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          void start();
        }}
        onPointerUp={end}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onBlur={cancel}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            void start();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            end();
          }
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </svg>
      </button>
      {phase !== "idle" && <span className="cl-voice-talk__status" role="status">{phase === "listening" ? S.talkListening : S.talkHearing}</span>}
      {phase === "idle" && note !== undefined && <span className="cl-voice-talk__note" role="note">{note}</span>}
    </span>
  );
}
