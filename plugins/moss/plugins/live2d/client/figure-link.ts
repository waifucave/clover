// How this renderer plugs into the avatar plugin (moss/character) and MOSS Voice, through their own points alone: it
// fills the avatar plugin's UI spot `moss.character.renderer` (keyed by its format) and MOSS Voice's point
// `moss.voice.speech`, each named on this plugin's OK card, and talks to them with point messages.
//
// * The figure's cues: the avatar plugin sends `{ mount, cue }`; the cues for this drawing (its `mount` prop) reach
//   `control.onCue`. What the model has and where the figure stands go back as `{ mount, names?, box? }`: the names when
//   they change, the box at most every BOX_MIN_MS and only when it moved more than BOX_MIN_DELTA pixels.
// * The mouth: MOSS Voice sends `{ bot, frames, cut? }` (levels stamped in epoch milliseconds, ahead of the clock); the
//   SDK's `TimedSpeech` keeps them by time as the speech feed the lip-sync reads. In a test or acceptance build the feed's
//   counters show on the document's root (`data-figure-speech`).
import { TimedSpeech, type TimedSpeechStats, usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect, useMemo, useRef, useState } from "react";

export const RENDERER_SPOT = "moss.character.renderer";
export const SPEECH_POINT = "moss.voice.speech";
export const BOX_MIN_MS = 250;
export const BOX_MIN_DELTA = 3;

declare const __MOSS_TEST_BUILD__: string | false | undefined;
declare const __MOSS_ACCEPTANCE_BUILD__: string | false | undefined;
const marked = (): boolean => (typeof __MOSS_TEST_BUILD__ === "string" && __MOSS_TEST_BUILD__ !== "") || (typeof __MOSS_ACCEPTANCE_BUILD__ === "string" && __MOSS_ACCEPTANCE_BUILD__ !== "");

type Box = { readonly canvas: { readonly width: number; readonly height: number }; readonly figure?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; readonly anchors?: Readonly<Record<string, { readonly x: number; readonly y: number } | undefined>> };
type Names = { readonly expressions: readonly string[]; readonly motions: readonly string[]; readonly outfits: readonly { readonly name: string; readonly on: boolean }[] };

/** What this renderer's drawing code takes: the cues in, what the model has and where it stands out. */
export interface LinkControl {
  onCue(listener: (cue: never) => void): () => void;
  setCatalogue(names: Names | undefined): void;
  setBox(box: Box | undefined): void;
}

const near = (a: Box | undefined, b: Box | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  const d = (x: number | undefined, y: number | undefined) => Math.abs((x ?? 0) - (y ?? 0)) <= BOX_MIN_DELTA;
  if (!d(a.canvas.width, b.canvas.width) || !d(a.canvas.height, b.canvas.height)) return false;
  if ((a.figure === undefined) !== (b.figure === undefined)) return false;
  if (a.figure !== undefined && b.figure !== undefined && !(d(a.figure.x, b.figure.x) && d(a.figure.y, b.figure.y) && d(a.figure.width, b.figure.width) && d(a.figure.height, b.figure.height))) return false;
  return JSON.stringify(Object.keys(a.anchors ?? {})) === JSON.stringify(Object.keys(b.anchors ?? {}));
};

/** The speech feed from MOSS Voice's point, and whether it speaks now. */
export function useVoiceSpeech(): { feed: TimedSpeech; speaking: boolean } {
  const api = usePluginApi();
  const feed = useMemo(() => new TimedSpeech(), []);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    const show = (stats: TimedSpeechStats): void => {
      if (!marked() || typeof document === "undefined") return;
      document.documentElement.dataset.figureSpeech = JSON.stringify({ ...stats, minAheadMs: Number.isFinite(stats.minAheadMs) ? stats.minAheadMs : null, maxAheadMs: Number.isFinite(stats.maxAheadMs) ? stats.maxAheadMs : null });
    };
    feed.reopen();
    const offSpeaking = feed.onSpeaking((now) => { setSpeaking(now); show(feed.stats); });
    const off = api.points.onMessage(SPEECH_POINT, (m) => {
      // Keyed by the sender: a `cut` drops only its own levels.
      feed.accept(m.value, m.from);
      show(feed.stats);
    });
    return () => { off(); offSpeaking(); feed.close(); setSpeaking(false); };
  }, [api, feed]);
  return { feed, speaking };
}

/** The avatar plugin's cues for this drawing, and what goes back to it. */
export function useFigureControl(mount: string | undefined): LinkControl {
  const api = usePluginApi();
  const listeners = useRef(new Set<(cue: never) => void>());
  const sentNames = useRef<string | undefined>(undefined);
  const box = useRef<{ want: Box | undefined; sent: Box | undefined; at: number; timer: ReturnType<typeof setTimeout> | undefined }>({ want: undefined, sent: undefined, at: -Infinity, timer: undefined });
  useEffect(() => {
    if (mount === undefined) return;
    const off = api.points.onMessage(RENDERER_SPOT, (m) => {
      const v = m.value as { mount?: unknown; cue?: unknown; ask?: unknown } | null;
      if (v === null || typeof v !== "object" || v.mount !== mount) return;
      // The avatar plugin asks again what it may have missed (it starts listening after this drawing may have spoken).
      if (v.ask === "report") {
        if (sentNames.current !== undefined) void api.points.send(RENDERER_SPOT, { mount, names: JSON.parse(sentNames.current) as unknown }).catch(() => undefined);
        if (box.current.sent !== undefined) void api.points.send(RENDERER_SPOT, { mount, box: box.current.sent }).catch(() => undefined);
        return;
      }
      if (v.cue === null || typeof v.cue !== "object") return;
      for (const l of [...listeners.current]) {
        try { l(v.cue as never); } catch (err) { console.error("a figure cue failed", err); }
      }
    });
    return () => {
      off();
      if (box.current.timer !== undefined) clearTimeout(box.current.timer);
      box.current = { want: undefined, sent: undefined, at: -Infinity, timer: undefined };
      sentNames.current = undefined;
    };
  }, [api, mount]);
  return useMemo<LinkControl>(() => {
    const send = (value: Record<string, unknown>) => {
      if (mount !== undefined) void api.points.send(RENDERER_SPOT, { mount, ...value }).catch(() => undefined);
    };
    const flushBox = (): void => {
      const b = box.current;
      if (near(b.want, b.sent)) return;
      const wait = BOX_MIN_MS - (Date.now() - b.at);
      if (wait > 0) {
        b.timer ??= setTimeout(() => { b.timer = undefined; flushBox(); }, wait);
        return;
      }
      b.sent = b.want;
      b.at = Date.now();
      send({ box: b.want ?? null });
    };
    return {
      onCue: (l) => { listeners.current.add(l); return () => listeners.current.delete(l); },
      setCatalogue: (names) => {
        const text = JSON.stringify(names ?? null);
        if (text === sentNames.current) return;
        sentNames.current = text;
        send({ names: names ?? null });
      },
      setBox: (b) => { box.current.want = b; flushBox(); },
    };
  }, [api, mount]);
}
