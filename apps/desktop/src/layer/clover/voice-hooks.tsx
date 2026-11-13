// The voice player's place in the `clover` layer: one player per document (made when first needed, with the AudioContext
// only when the first sound is due), fed by the `voice` messages main forwards, and the hooks the character stage reads
// it through. Idle, it is a map and nothing else.
import { useEffect, useState } from "react";
import { useCore, useLayerMessage } from "@waifucave/clover-plugin-sdk/ui";
import { VoiceStage, type AudioContextLike, type SpeechState } from "./voice";

declare const __CLOVER_TEST_BUILD__: string | false | undefined;
declare const __CLOVER_ACCEPTANCE_BUILD__: string | false | undefined;

let stage: VoiceStage | undefined;
let made: (() => VoiceStage) | undefined;

/** The document's player. `audio` is for tests and the gallery (a fake clock); the app makes a real AudioContext. */
export function voiceStage(): VoiceStage {
  if (stage === undefined) {
    stage = (made ?? (() => new VoiceStage({ audio: () => new AudioContext({ sampleRate: 48_000 }) as unknown as AudioContextLike })))();
    // The acceptance run's counters (pieces received, frames made, who speaks, most bots speaking at once, utterances cut), on the document's root element: test and
    // acceptance builds only (the define is `false` in a real build and this is compiled out).
    if (typeof __CLOVER_TEST_BUILD__ === "string" || typeof __CLOVER_ACCEPTANCE_BUILD__ === "string") {
      const s = stage;
      const show = (): void => {
        const c = s.counters();
        document.documentElement.dataset.voicePieces = String(c.pieces);
        document.documentElement.dataset.voiceFrames = String(c.frames);
        document.documentElement.dataset.voiceSpeaking = c.speaking.join(",");
        document.documentElement.dataset.voiceOverlap = String(c.overlap);
        document.documentElement.dataset.voiceCut = String(c.cut);
      };
      s.onChange(show);
      show();
    }
  }
  return stage;
}
/** Test seam: the next `voiceStage()` is built by `make` (and the current one forgotten). */
export function setVoiceStage(make: (() => VoiceStage) | undefined): void {
  stage = undefined;
  made = make;
}

/** For the shell: plays the pieces main sends and applies the user's mute (`voice.speakReplies`). */
export function useVoicePlayback(): void {
  const core = useCore();
  useLayerMessage((m) => {
    if (m.type === "voice") voiceStage().piece(m.piece);
  });
  useEffect(() => {
    if (core === undefined) return;
    let live = true;
    const apply = (settings: unknown): void => {
      const on = (settings as { voice?: { speakReplies?: boolean } } | null | undefined)?.voice?.speakReplies;
      if (live) voiceStage().setMuted(on === false);
    };
    void Promise.resolve(core.call("ui.settings", {})).then((r) => apply((r as { settings?: unknown } | undefined)?.settings ?? r), () => undefined);
    const off = core.on("ui_settings_changed", (e) => apply(e.settings));
    return () => {
      live = false;
      off();
    };
  }, [core]);
}

/** A bot's speech for its stage: the feed (stable) and whether it is speaking now. */
export function useBotSpeech(bot: string): { feed: ReturnType<VoiceStage["feedOf"]>; speaking: boolean } {
  const s = voiceStage();
  const [speaking, setSpeaking] = useState(() => s.speaking(bot));
  useEffect(() => {
    setSpeaking(s.speaking(bot));
    return s.watch(bot, (x: SpeechState) => setSpeaking(x.speaking));
  }, [s, bot]);
  return { feed: s.feedOf(bot), speaking };
}

export interface VoiceControls {
  speaking: boolean;
  /** Whether replies are spoken (the one global switch). */
  speakReplies: boolean;
  stop(): void;
  toggle(): void;
}

/** The stage's stop / mute button: stop ends this bot's speech now and tells the core; toggle flips `voice.speakReplies`. */
export function useVoiceControls(bot: string): VoiceControls {
  const core = useCore();
  const s = voiceStage();
  const { speaking } = useBotSpeech(bot);
  const [muted, setMuted] = useState(() => s.isMuted());
  useEffect(() => {
    setMuted(s.isMuted());
    return s.watchMuted(setMuted);
  }, [s]);
  return {
    speaking,
    speakReplies: !muted,
    stop: () => {
      s.stop(bot);
      void Promise.resolve(core?.call("voice.stop", { bot })).catch(() => undefined);
    },
    toggle: () => {
      const next = muted; // muted now: turn speaking back on
      s.setMuted(!next);
      void Promise.resolve(core?.call("ui.set", { patch: { voice: { speakReplies: next } } })).catch(() => undefined);
    },
  };
}
