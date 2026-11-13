// The narrator's child: the same ask as its parent's `narrate`, with no `voices.use` of its own.
type Api = { voices: { providers(): Promise<unknown[]>; speak(provider: string, o: { text: string; voice: string }, l: (e: { audio?: Uint8Array; done?: unknown; error?: string }) => void): unknown } };
let api: Api | undefined;
export function start(a: Api): void {
  api = a;
}
export const nosy = async (): Promise<Record<string, unknown>> => {
  if (api === undefined) return { error: "not started" };
  try {
    // The providers' list first, as its parent asks: the plain call the core refuses without voices.use.
    await api.voices.providers();
    return await new Promise((resolve) => {
      let bytes = 0;
      const r = api!.voices.speak("acceptance-voice", { text: "A line to narrate.", voice: "tone" }, (e) => {
        if (e.audio !== undefined) bytes += e.audio.length;
        else if (e.done !== undefined) resolve({ bytes });
        else resolve({ error: e.error ?? "no audio" });
      });
      // A refused watch: the call's own promise rejects.
      void Promise.resolve(r).catch((err: unknown) => resolve({ error: err instanceof Error ? err.message : String(err) }));
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
