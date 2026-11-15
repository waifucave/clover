// The narrator: a plain plugin with `voices.use` asks a voice provider to transcribe a short recording and keeps the text
// as its own data (the providers' listening; speaking is a provider's entry on Clover Voice's own point).
type Api = {
  voices: {
    providers(): Promise<{ id: string }[]>;
    listen(provider: string, o: { id: string; format: "pcm16-16k" }, l: (e: { text?: string; error?: string }) => void): unknown;
    feed(id: string, data: Uint8Array, final: boolean): Promise<void>;
  };
};
let api: Api | undefined;
export function start(a: Api): void {
  api = a;
}

/** 0.1 s of silence, pcm16-16k: the recording it has transcribed. */
export const RECORDING_BYTES = 3_200;

/** Asks the run's tone voice to transcribe; what came back. */
export async function transcribeWith(a: Api | undefined, id: string): Promise<Record<string, unknown>> {
  if (a === undefined) return { error: "not started" };
  try {
    const providers = (await a.voices.providers()).map((p) => p.id);
    return await new Promise((resolve) => {
      const r = a.voices.listen("acceptance-voice", { id, format: "pcm16-16k" }, (e) => resolve(e.text !== undefined ? { providers, text: e.text } : { error: e.error ?? "nothing heard" }));
      void Promise.resolve(r).catch((err: unknown) => resolve({ error: err instanceof Error ? err.message : String(err) }));
      void a.voices.feed(id, new Uint8Array(RECORDING_BYTES), true).catch((err: unknown) => resolve({ error: err instanceof Error ? err.message : String(err) }));
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export const narrate = () => transcribeWith(api, `n${Date.now().toString(36)}`);
