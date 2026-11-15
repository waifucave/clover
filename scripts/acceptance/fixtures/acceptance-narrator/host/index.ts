// The narrator: a plain plugin with `voices.use` asks a voice provider to say a line and keeps the audio as its own data.
type Api = {
  voices: {
    providers(): Promise<{ id: string }[]>;
    speak(provider: string, o: { text: string; voice: string }, l: (e: { audio?: Uint8Array; done?: { bytes: number }; error?: string }) => void): unknown;
  };
};
let api: Api | undefined;
export function start(a: Api): void {
  api = a;
}

/** Asks the run's tone voice for a line; what came back. */
async function narrateWith(a: Api | undefined): Promise<Record<string, unknown>> {
  if (a === undefined) return { error: "not started" };
  try {
    const providers = (await a.voices.providers()).map((p) => p.id);
    return await new Promise((resolve) => {
      let bytes = 0;
      const r = a.voices.speak("acceptance-voice", { text: "A line to narrate.", voice: "tone" }, (e) => {
        if (e.audio !== undefined) bytes += e.audio.length;
        else if (e.done !== undefined) resolve({ providers, bytes });
        else resolve({ error: e.error ?? "no audio" });
      });
      void Promise.resolve(r).catch((err: unknown) => resolve({ error: err instanceof Error ? err.message : String(err) }));
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export const narrate = () => narrateWith(api);
