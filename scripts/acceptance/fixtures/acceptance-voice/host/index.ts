// The acceptance voice's host half: `voice.speak` yields a 220 Hz tone as pcm16-24k (16-bit little-endian mono at
// 24 kHz), in three pieces of 0.2 s each, whatever the text. No key, no network: what the run asserts is that a reply
// became speech the app played, not what it said.
//
// `listen` is push-to-talk's other end: it reads the recording as the app's pieces arrive (`ctx.input`, one chunk per
// numbered piece) and answers with fixed words that say what reached it: how many pieces, how many bytes and in what format,
// so the run proves the numbered pieces crossed whole and in order. No key, no network, nothing of anyone's voice.

export const SAMPLE_RATE = 24_000;
export const TONE_HZ = 220;
export const PIECES = 3;
export const PIECE_SECONDS = 0.2;

/** One piece of the tone: `seconds` of samples from sample `start`, at three quarters of full scale. */
export function tone(start: number, seconds: number): Uint8Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * TONE_HZ * (start + i)) / SAMPLE_RATE) * 0.75 * 32767), true);
  return out;
}

/** The words `listen` answers with, for a recording of `pieces` pieces and `bytes` bytes. */
export const heard = (pieces: number, bytes: number, format: string): string => `heard ${pieces} pieces, ${bytes} bytes of ${format}`;

export const voice = {
  async *speak(args: { text?: unknown; format?: unknown }): AsyncGenerator<{ audio: Uint8Array }, { format: string; bytes: number }, undefined> {
    if (args.format !== undefined && args.format !== "pcm16-24k") throw new Error(`the acceptance voice speaks pcm16-24k, not ${String(args.format)}`);
    let bytes = 0;
    for (let p = 0; p < PIECES; p++) {
      const audio = tone(p * PIECE_SECONDS * SAMPLE_RATE, PIECE_SECONDS);
      bytes += audio.length;
      yield { audio };
    }
    return { format: "pcm16-24k", bytes };
  },

  // eslint-disable-next-line require-yield
  async *listen(args: { format?: unknown }, ctx: { input?: AsyncIterable<unknown> }): AsyncGenerator<never, { text: string }, undefined> {
    if (ctx.input === undefined) throw new Error("the acceptance voice listens to the app's pieces");
    let pieces = 0;
    let bytes = 0;
    for await (const chunk of ctx.input) {
      if (!(chunk instanceof Uint8Array)) throw new Error("listen's input is audio: chunks of bytes");
      if (chunk.length % 2 !== 0) throw new Error("a piece ends on a whole 16-bit sample");
      pieces++;
      bytes += chunk.length;
    }
    return { text: heard(pieces, bytes, String(args.format)) };
  },
};
