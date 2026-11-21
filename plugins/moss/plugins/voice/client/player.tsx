// MOSS Voice's background part (`app.background`, spec §6.6): the player. It accepts the host half's speech streams
// (`streams.accept("speech")`), plays them one at a time in the device's speech turn (`src/player.ts`), sends the
// bots' mouths to the plugins that fill its `moss.voice.speech` point (`src/levels.ts`, point messages), and hears the host half's stops and push-to-talk
// holds (`host.on`, the host half's `ui.send`) and its own "Speak replies" setting (off: what plays stops). It draws
// nothing. Both messages carry the whole state (the held utterances; each bot's stop count, which only goes up), since
// the app hands a part only the newest message of each name within a tick; on mount it asks its host half for that
// state (`ready`), which also tells the host half it now accepts speech.
import { usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect } from "react";
import { SpeechCues } from "../src/levels";
import { SpeechPlayer, type AudioContextLike } from "../src/player";

declare const __MOSS_TEST_BUILD__: string | false | undefined;
declare const __MOSS_ACCEPTANCE_BUILD__: string | false | undefined;

/** The device's speech turn, which every plugin that speaks takes (P2). */
export const DEVICE_SPEECH = "device/speech";
/** MOSS Voice's own point, whose fillers hear what it says and when (its mouth levels). */
export const SPEECH_POINT = "moss.voice.speech";

let made: (() => AudioContextLike) | undefined;
/** Test seam: the next players' AudioContext (undefined: the browser's). */
export function setPlayerAudio(make: (() => AudioContextLike) | undefined): void {
  made = make;
}

export function Player() {
  const api = usePluginApi();
  useEffect(() => {
    // The run's counters on the document's root (test and acceptance builds only; compiled out of a real build).
    const marked = (typeof __MOSS_TEST_BUILD__ === "string" && __MOSS_TEST_BUILD__ !== "") || (typeof __MOSS_ACCEPTANCE_BUILD__ === "string" && __MOSS_ACCEPTANCE_BUILD__ !== "");
    const cues = new SpeechCues((bot, cue) => api.points.send(SPEECH_POINT, { bot, ...cue }));
    const show = (): void => {
      if (!marked || typeof document === "undefined") return;
      const c = player.counters();
      const d = document.documentElement.dataset;
      d.voicePieces = String(c.pieces);
      d.voiceFrames = String(c.frames);
      d.voiceSpeaking = c.speaking.join(",");
      d.voiceOverlap = String(c.overlap);
      d.voiceCut = String(c.cut);
      d.voiceCues = String(cues.sent);
      d.voiceSpans = JSON.stringify(c.spans);
    };
    const player: SpeechPlayer = new SpeechPlayer({
      audio: made ?? (() => new AudioContext({ sampleRate: 48_000 }) as unknown as AudioContextLike),
      take: (bot) => api.turns.take(DEVICE_SPEECH, { limitMs: 600_000, note: bot }),
      cues,
      changed: show,
    });
    show();
    const accepting = api.streams.accept("speech", (stream, meta) => {
      const bot = typeof meta.bot === "string" ? meta.bot : undefined;
      const id = typeof meta.utterance === "string" ? meta.utterance : undefined;
      if (bot === undefined || id === undefined || !player.begin({ bot, id, asked: meta.asked === true })) {
        void stream.cancel("not played").catch(() => undefined);
        return;
      }
      const reader = stream.getReader();
      void (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Stopped or replaced: the rest isn't wanted, and the host half's provider call ends with it.
          if (player.gone(id)) return void (await reader.cancel("stopped").catch(() => undefined));
          player.push(id, value);
        }
        player.end(id);
      })().catch(() => player.end(id));
    });
    // The host half's controls, as state: the utterances push-to-talk holds now, and each bot's stop count.
    const held = new Set<string>();
    const holds = (data: unknown): void => {
      const now = new Set(Array.isArray((data as { utterances?: unknown } | null)?.utterances) ? (data as { utterances: unknown[] }).utterances.filter((u): u is string => typeof u === "string") : []);
      for (const u of [...held]) if (!now.has(u)) { held.delete(u); player.hold(u, false); }
      for (const u of now) if (!held.has(u)) { held.add(u); player.hold(u, true); }
    };
    const seen = new Map<string, number>();
    const stops = (data: unknown, baseline = false): void => {
      if (typeof data !== "object" || data === null) return;
      for (const [bot, n] of Object.entries(data as Record<string, unknown>)) {
        if (typeof n !== "number" || n <= (seen.get(bot) ?? 0)) continue;
        seen.set(bot, n);
        if (!baseline) player.stop(bot);
      }
    };
    const offHolds = api.host.on("holds", holds);
    const offStops = api.host.on("stops", (d) => stops(d));
    let live = true;
    void Promise.resolve(api.host.call<{ holds?: unknown; stops?: unknown }>("ready", {})).then((s) => {
      if (!live || s === undefined || s === null) return;
      stops(s.stops, true);
      holds({ utterances: s.holds });
    }, () => undefined);
    const mute = (): void => void api.settings.get<boolean>("speakReplies").then((on) => { if (live) player.setMuted(on === false); }, () => undefined);
    // Subscribe first, then read (a change between the read's answer and the subscription taking effect would be lost).
    const offMute = api.settings.watch("speakReplies", mute);
    mute();
    return () => {
      live = false;
      accepting();
      offHolds();
      offStops();
      offMute();
      player.stopAll();
      cues.close();
    };
  }, [api]);
  return null;
}
