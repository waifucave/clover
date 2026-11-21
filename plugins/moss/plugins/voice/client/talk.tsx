// MOSS Voice's hold-to-talk button: its own entry in the composer's buttons (`composer.action`, key `voice`), shown only
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
// What is sent is the voice's words made one plain line (`spokenText`: control characters collapsed as the SDK's
// `plainLine` does) and cut to TALK_TEXT_MAX characters, never refused for its length (a hold is at most a minute).
//
// From the keyboard: Ctrl+Shift+Space anywhere in the window (this plugin's held key binding, `push-to-talk`, which its
// host half passes on as `talk-down`, `talk-up` and `talk-cancel`) holds it the same way: the key's down starts (a repeat
// does nothing), its release ends it and the words go once, and a cancel (the window let go of the hold, never the user)
// drops it as a lost pointer does; the chord never types. The release main saw counts as the user's for this
// plugin's documents, as the button's own press and release do. Of several talk buttons it is the one nearest the focus
// (in the composer being typed in), else the first.
//
// It never sticks on: a hold that ends without the user's release (the window losing the focus or going hidden, the button
// losing the focus, the pointer cancelled, the button going away, the stream refusing a piece, or the host half's minute
// passing) is dropped: the microphone closes (every track ends), the stream is aborted, the turn is let go, and nothing is sent.
//
// A test or acceptance build marks its counters on the document's root (`data-voice-talk-*`).
import { useCallback, useEffect, useRef, useState } from "react";
import type { EntryProps } from "@waifucave/moss-plugin-sdk";
import { usePluginApi, useUserSend } from "@waifucave/moss-plugin-sdk/ui";
import type { BotRef } from "./local";
import { S } from "./strings";
import { defaultSource, testBuild, type PcmHandle, type PcmSource } from "../src/recorder";

/** The device turn a recording holds (P2). */
export const DEVICE_MICROPHONE = "device/microphone";
const PROVIDERS = "moss.voice.providers";
const MODES = "moss.voice.modes";
/** The host half's TALK_MAX_BYTES (60 s of 16 kHz 16-bit mono). */
const TALK_LIMIT_BYTES = 60 * 16_000 * 2;

/** The most a transcription sends as the user's message; longer is cut. */
export const TALK_TEXT_MAX = 2_000;
/** The host half's limit on a recording (TALK_MAX_BYTES: 60 s of 16 kHz PCM), and the little past it the button waits
 *  before it closes the microphone itself, should the stream not have refused a piece by then. */
export const TALK_LIMIT_MS = 60_000;
export const TALK_GRACE_MS = 2_000;

/** A transcription as the message it sends: control, line-break, zero-width and direction characters to one space (the
 *  SDK's `plainLine`), runs of space to one, trimmed, and cut to `max` (never half a surrogate pair). */
export function spokenText(raw: string, max: number = TALK_TEXT_MAX): string {
  const line = raw.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  let cut = line.slice(0, max);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

let made: PcmSource | undefined;
/** Test seam: the next recordings' source (undefined: the build's own). */
export function setTalkSource(source: PcmSource | undefined): void {
  made = source;
}

let limitAfter: number | undefined;
/** Test seam: when the backstop closes a hold that is still held (undefined: TALK_LIMIT_MS + TALK_GRACE_MS). */
export function setTalkLimit(ms: number | undefined): void {
  limitAfter = ms;
}

let count = 0;

/** The talk buttons shown in this document, for the key binding to pick one. */
const shown = new Set<HTMLElement>();

/** How deep the nearest element holding both `el` and the focus is (the focus's own composer is the deepest). */
function nearFocus(el: HTMLElement): number {
  const focus = typeof document !== "undefined" ? document.activeElement : null;
  if (focus === null) return 0;
  let at: Node | null = el;
  while (at !== null && !at.contains(focus)) at = at.parentNode;
  let depth = 0;
  for (let n: Node | null = at; n !== null; n = n.parentNode) depth++;
  return depth;
}

/** The talk button the key binding holds: the one nearest the focus, else the first in the document. */
function keyButton(): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let bestDepth = -1;
  const inOrder = [...shown].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  for (const el of inOrder) {
    const d = nearFocus(el);
    if (d > bestDepth) [best, bestDepth] = [el, d];
  }
  return best;
}

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
  /** The backstop at the host half's limit. */
  limit?: ReturnType<typeof setTimeout>;
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
  /** This button's element, while it shows. */
  const self = useRef<HTMLSpanElement | null>(null);
  /** The hold now is the key binding's (only its release ends it). */
  const byKey = useRef(false);

  useEffect(() => {
    let live = true;
    const read = (): void => {
      void Promise.resolve(api.host.call<boolean>("listens", { bot, session: props.session })).then((on) => { if (live) setListens(on === true); }, () => { if (live) setListens(false); });
    };
    // What decides it is this plugin's own: its settings, the voice picked, its providers. No window focus needed.
    // Subscribe first, then read (a change between the read's answer and the subscription taking effect would be lost).
    const offs = [api.settings.watch(null, read), api.points.onActive(MODES, read), api.points.watch(PROVIDERS, read), api.points.watch(MODES, read)];
    read();
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
    if (rec.limit !== undefined) clearTimeout(rec.limit);
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
    const text = typeof r?.text === "string" ? spokenText(r.text) : "";
    if (text !== "") {
      if (send === undefined) return setNote(S.talkNoSend);
      // One send after this frame's press and release (the app's 30 s allowance).
      await send({ session: props.session }, { text }).catch(() => setNote(S.talkRefused));
    } else setNote(r?.note ?? S.talkNothing);
  }, [api, send, props.session]);

  /** A hold that ended without the user's release: closed, nothing heard, nothing sent. */
  const drop = useCallback((rec: Rec, why?: string) => {
    if (rec.dropped === true) return;
    rec.dropped = true;
    rec.released = true;
    if (rec.limit !== undefined) clearTimeout(rec.limit);
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
      // The host half takes at most a minute: past it (and a little), the microphone closes even if the user still holds.
      rec.limit = setTimeout(() => drop(rec, S.talkTooLong), limitAfter ?? TALK_LIMIT_MS + TALK_GRACE_MS);
      let bytes = 0;
      const starts = Number((typeof document !== "undefined" ? document.documentElement.dataset.voiceTalkStarts : undefined) ?? 0) + 1;
      mark({ voiceTalkStarts: starts, voiceTalkSource: made !== undefined ? "test" : testBuild() ? "clip" : "mic", voiceTalkBytes: 0 });
      rec.handle = await source({
        chunk: (pcm) => {
          bytes += pcm.length;
          mark({ voiceTalkBytes: bytes });
          // A piece the stream refuses (the host half cut it at its minute, or it ended) ends the recording: the
          // microphone closes at once, not when the user lets go.
          void rec.writer?.write(pcm).catch(() => { if (!rec.released) drop(rec, bytes > TALK_LIMIT_BYTES ? S.talkTooLong : S.talkCut); });
        },
        end: () => {
          rec.released = true;
          void finish(rec);
        },
      });
      if (gone(rec) || rec.released) rec.handle.stop();
    } catch (err) {
      if (rec.limit !== undefined) clearTimeout(rec.limit);
      rec.handle?.stop();
      void rec.writer?.abort(err instanceof Error ? err.message : "the recording didn't start").catch(() => undefined);
      await Promise.resolve(rec.turn?.done()).catch(() => undefined);
      if (current.current === rec) current.current = undefined;
      setPhase("idle");
      setNote(S.talkRefused);
    }
  }, [api, bot, finish, drop, mark]);

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

  // The key binding's down and release (its host half passes them on): the button nearest the focus holds.
  useEffect(() => {
    const offDown = api.host.on("talk-down", () => {
      const el = self.current;
      if (el === null || keyButton() !== el || current.current !== undefined) return;
      byKey.current = true;
      void start();
    });
    const offUp = api.host.on("talk-up", () => {
      if (!byKey.current) return;
      byKey.current = false;
      end();
    });
    // No release of the user's: the hold is dropped (nothing heard, nothing sent).
    const offCancel = api.host.on("talk-cancel", () => {
      if (!byKey.current) return;
      byKey.current = false;
      cancel();
    });
    return () => {
      offDown();
      offUp();
      offCancel();
    };
  }, [api, start, end, cancel]);

  const place = useCallback((el: HTMLSpanElement | null) => {
    if (self.current !== null) shown.delete(self.current);
    self.current = el;
    if (el !== null) shown.add(el);
  }, []);

  if (!listens) return null;
  return (
    <span className="cl-voice-talk" data-voice-talk={phase} ref={place}>
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
