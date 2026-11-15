// The acceptance voice mode's background part: on its host half's `say`, it takes the device's speech turn
// (`device/speech`), plays a tone for that long (an AudioContext; the test build is muted at the app's output), lets the
// turn go, and records the span with its host half. It draws nothing. Its document's root shows what it holds now
// (`data-avm-speaking`) for the run's record.
import { useEffect } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";

export function Speaker() {
  const api = usePluginApi();
  useEffect(() => {
    let ctx: AudioContext | undefined;
    let chain: Promise<unknown> = Promise.resolve();
    const say = async (what: string, seconds: number) => {
      const turn = await api.turns.take("device/speech", { limitMs: 30_000, note: what });
      const from = Date.now();
      document.documentElement.dataset.avmSpeaking = what;
      try {
        ctx ??= new AudioContext({ sampleRate: 24_000 });
        const n = Math.round(seconds * 24_000);
        const buffer = ctx.createBuffer(1, n, 24_000);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < n; i++) data[i] = Math.sin((2 * Math.PI * 330 * i) / 24_000) * 0.3;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start();
      } catch {
        // no audio here: its length still holds the turn
      }
      await new Promise((r) => setTimeout(r, seconds * 1000));
      delete document.documentElement.dataset.avmSpeaking;
      await turn.done();
      await api.host.call("record", { what, from, to: Date.now() });
    };
    const off = api.host.on("say", (d) => {
      const s = d as { what?: unknown; seconds?: unknown } | null;
      if (typeof s?.what !== "string" || typeof s.seconds !== "number") return;
      const what = s.what;
      const seconds = s.seconds;
      chain = chain.then(() => say(what, seconds)).catch(() => undefined);
    });
    return () => {
      off();
      void ctx?.close().catch(() => undefined);
    };
  }, [api]);
  return null;
}
