// The acceptance voice's host half: `voice.speak` yields a 220 Hz tone as pcm16-24k (16-bit little-endian mono at
// 24 kHz), in three pieces of 0.2 s each, whatever the text. No key, no network: what the run asserts is that a reply
// became speech the app played, not what it said.

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
};
