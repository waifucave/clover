// The recorder's place in the `clover` layer: one recording at a time, started only by main's `listen` message (which main sends
// only after the user's own press reached it) and ended by its `stop`, the window losing the focus, or the document going away.
// The audio goes back through `voice.listen`, which main numbers and checks (tree-calls.ts, listen.ts). Idle, it is a ref and nothing else.
import { useEffect, useRef } from "react";
import { useCore, useLayerMessage } from "@waifucave/clover-plugin-sdk/ui";
import { Recorder, defaultSource, type PcmSource } from "./listen";
import { voiceStage } from "./voice-hooks";

declare const __CLOVER_TEST_BUILD__: string | false | undefined;
declare const __CLOVER_ACCEPTANCE_BUILD__: string | false | undefined;

let sourceFor: (() => PcmSource) | undefined;
/** Test seam: the next recordings take `make`'s source (undefined: the default one). */
export function setListenSource(make: (() => PcmSource) | undefined): void {
  sourceFor = make;
}

/** For the shell: records while main says so, and sends the audio on. */
export function useListenRecorder(): void {
  const core = useCore();
  const current = useRef<{ utterance: string; recorder: Recorder } | undefined>(undefined);
  const stopCurrent = (): void => {
    const c = current.current;
    if (c !== undefined) void c.recorder.stop();
  };
  useLayerMessage((m) => {
    if (m.type !== "listen") return;
    if (m.op === "stop") {
      if (current.current?.utterance === m.utterance) stopCurrent();
      return;
    }
    if (core === undefined) return;
    // A new recording ends one still going (main holds one per window, so this is a stale one).
    stopCurrent();
    // The user holds push-to-talk: whatever sounds stops at once (the voice mode holds what comes until they let go).
    voiceStage().stopAll();
    // The acceptance run's counters (recordings begun, pieces and bytes sent, which source), on the document's root element: test and
    // acceptance builds only (the define is `false` in a real build and this is compiled out).
    const marked = typeof __CLOVER_TEST_BUILD__ === "string" || typeof __CLOVER_ACCEPTANCE_BUILD__ === "string";
    const recorder: Recorder = new Recorder({
      source: (sourceFor ?? defaultSource)(),
      maxMs: m.maxMs,
      send: (piece) => {
        const sent = core.call("voice.listen", piece);
        if (marked) {
          const d = document.documentElement.dataset;
          d.listenPieces = String(recorder.pieces);
          d.listenBytes = String(recorder.bytes);
        }
        return sent;
      },
    });
    current.current = { utterance: m.utterance, recorder };
    if (marked) {
      const d = document.documentElement.dataset;
      d.listenStarts = String(Number(d.listenStarts ?? 0) + 1);
      d.listenSource = "clip";
    }
    void recorder.start();
  });
  // The window loses the focus or hides: the recording ends (the composer's own release does too; whichever comes first).
  useEffect(() => {
    const hidden = (): void => {
      if (document.visibilityState !== "visible") stopCurrent();
    };
    window.addEventListener("blur", stopCurrent);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", stopCurrent);
      document.removeEventListener("visibilitychange", hidden);
      stopCurrent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
