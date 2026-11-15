// Clover Voice's background part (`app.background`, spec §6.6): the player. It accepts the host half's speech streams
// (`streams.accept("speech")`), plays them one at a time in the device's speech turn (`src/player.ts`), sends the
// bots' mouths as speech cues (`src/levels.ts`, `avatar.control.all`), and hears the host half's stop and push-to-talk
// hold (`streams.accept("control")`, a stream's meta) and its own "Speak replies" setting (off: what plays stops). It
// draws nothing.
import { useEffect } from "react";
import { usePluginApi } from "./sdk";
import { SpeechCues } from "../src/levels";
import { SpeechPlayer, type AudioContextLike } from "../src/player";

declare const __CLOVER_TEST_BUILD__: string | false | undefined;
declare const __CLOVER_ACCEPTANCE_BUILD__: string | false | undefined;

/** The device's speech turn, which every plugin that speaks takes (P2). */
export const DEVICE_SPEECH = "device/speech";

let made: (() => AudioContextLike) | undefined;
/** Test seam: the next players' AudioContext (undefined: the browser's). */
export function setPlayerAudio(make: (() => AudioContextLike) | undefined): void {
  made = make;
}

export function Player() {
  const api = usePluginApi();
  useEffect(() => {
    // The run's counters on the document's root (test and acceptance builds only; compiled out of a real build).
    const marked = (typeof __CLOVER_TEST_BUILD__ === "string" && __CLOVER_TEST_BUILD__ !== "") || (typeof __CLOVER_ACCEPTANCE_BUILD__ === "string" && __CLOVER_ACCEPTANCE_BUILD__ !== "");
    const cues = new SpeechCues((bot, cue) => api.avatar?.cue?.(cue, { bot }));
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
    // The host half's controls: a stream with only its meta (the user's stop on a bot, push-to-talk's hold).
    const controls = api.streams.accept("control", (stream, meta) => {
      void stream.cancel("read").catch(() => undefined);
      if (meta.op === "stop" && typeof meta.bot === "string") player.stop(meta.bot);
      else if (meta.op === "hold" && typeof meta.utterance === "string") player.hold(meta.utterance, meta.on === true);
    });
    let live = true;
    const mute = (): void => void api.settings.get<boolean>("speakReplies").then((on) => { if (live) player.setMuted(on === false); }, () => undefined);
    mute();
    const offMute = api.settings.watch("speakReplies", mute);
    return () => {
      live = false;
      accepting();
      controls();
      offMute();
      player.stopAll();
      cues.close();
    };
  }, [api]);
  return null;
}
