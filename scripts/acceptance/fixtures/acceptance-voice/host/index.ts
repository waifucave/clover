// The acceptance voice's host half: `speak` (its entry on MOSS Voice's providers point, `moss.voice.providers`,
// answering `points.stream` with bytes) makes a 220 Hz tone as pcm16-24k (16-bit little-endian mono at 24 kHz), in three
// pieces of 0.2 s each, whatever the text; the voice `long` in five pieces of 0.5 s (a reply that sounds long enough for
// the run to do something while it plays). No key, no network: what the run asserts is that a reply became speech MOSS
// Voice's player played, not what it said.
//
// `listen` (the same entry's) is push-to-talk's other end: MOSS Voice hands it the whole recording its talk button
// streamed (`{ audio, format }`), and it answers with fixed words that say what reached it: how many bytes and in what
// format, so the run proves the recording crossed whole. No key, no network, nothing of anyone's voice.

export const SAMPLE_RATE = 24_000;
export const TONE_HZ = 220;
export const PIECES = 3;
export const PIECE_SECONDS = 0.2;
/** The voice `long`: five pieces of half a second. */
export const LONG = { pieces: 5, seconds: 0.5 };

/** One piece of the tone: `seconds` of samples from sample `start`, at three quarters of full scale. */
export function tone(start: number, seconds: number): Uint8Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * TONE_HZ * (start + i)) / SAMPLE_RATE) * 0.75 * 32767), true);
  return out;
}

/** The words `listen` answers with, for a recording of `bytes` bytes. */
export const heard = (bytes: number, format: string): string => `heard ${bytes} bytes of ${format}`;

/** The `moss.voice.providers` entry's `speak`: the tone, as bytes, a piece at a time. */
export async function speak(args: { text?: unknown; voice?: unknown; format?: unknown }): Promise<AsyncIterable<Uint8Array>> {
  if (args.format !== undefined && args.format !== "pcm16-24k") throw new Error(`the acceptance voice speaks pcm16-24k, not ${String(args.format)}`);
  const [pieces, seconds] = args.voice === "long" ? [LONG.pieces, LONG.seconds] : [PIECES, PIECE_SECONDS];
  return (async function* () {
    for (let p = 0; p < pieces; p++) yield tone(p * seconds * SAMPLE_RATE, seconds);
  })();
}

/** The `moss.voice.providers` entry's `listen`: the whole recording, written down as what reached it. */
export async function listen(args: { audio?: unknown; format?: unknown }): Promise<{ text: string }> {
  if (!(args.audio instanceof Uint8Array)) throw new Error("the acceptance voice writes down a recording: its audio, as bytes");
  if (args.audio.length % 2 !== 0) throw new Error("a recording ends on a whole 16-bit sample");
  return { text: heard(args.audio.length, String(args.format)) };
}
