// What the talk button records from (spec §6.6, push-to-talk): 16 kHz 16-bit little-endian mono PCM, as it comes.
//
// * The real microphone (`micSource`): getUserMedia, which the app allows only for a frame of a plugin that holds the
//   `microphone` capability (P3); the system's own permission still applies. Downsampled to 16 kHz here.
// * A generated clip (`clipSource`) in a test or acceptance build: a compile-time mark, folded away in a release build,
//   chooses it, so no run ever opens a device or raises a system prompt (getUserMedia is never called).

/** The rate the voices write down from. */
export const LISTEN_RATE = 16_000;

declare const __MOSS_TEST_BUILD__: string | false | undefined;
declare const __MOSS_ACCEPTANCE_BUILD__: string | false | undefined;

/** Float samples (−1…1) to 16-bit little-endian PCM, clamped. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true);
  }
  return out;
}

/** Takes the microphone's samples at the audio context's own rate down to 16 kHz: each output sample is the mean of the
 *  input samples that fall in its slot (a box filter, enough for speech), and the position carries across calls so no
 *  chunk boundary clicks. At 16 kHz already it passes through. */
export class Downsampler {
  readonly #ratio: number;
  #acc = 0;
  #count = 0;
  #seen = 0;
  #made = 0;
  constructor(inputRate: number, readonly outputRate: number = LISTEN_RATE) {
    if (!(inputRate >= outputRate)) throw new Error("the microphone's rate is below 16 kHz");
    this.#ratio = inputRate / outputRate;
  }
  push(input: Float32Array): Float32Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      this.#acc += input[i]!;
      this.#count++;
      this.#seen++;
      if (this.#seen >= (this.#made + 1) * this.#ratio - 1e-9) {
        out.push(this.#acc / this.#count);
        this.#made++;
        this.#acc = 0;
        this.#count = 0;
      }
    }
    return Float32Array.from(out);
  }
}

/** Where the audio comes from: it calls `chunk` with PCM as it has it, and `end` if it stops by itself (the device went
 *  away). The promise is the open source, which `stop` closes; it rejects when it can't open. */
export interface PcmSink {
  chunk(pcm: Uint8Array): void;
  end(): void;
}
export interface PcmHandle {
  stop(): void;
}
export type PcmSource = (sink: PcmSink) => Promise<PcmHandle>;

/** The real microphone: getUserMedia into a ScriptProcessor, downsampled to 16 kHz. The tracks stop and the context
 *  closes when the recording ends. Not used in a test or acceptance build. */
export function micSource(): PcmSource {
  return async (sink) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    const ctx = new AudioContext();
    try {
      const down = new Downsampler(ctx.sampleRate);
      const node = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      proc.onaudioprocess = (e) => sink.chunk(floatToPcm16(down.push(e.inputBuffer.getChannelData(0))));
      node.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      for (const t of stream.getAudioTracks()) t.addEventListener("ended", () => sink.end(), { once: true });
      return {
        stop: () => {
          proc.onaudioprocess = null;
          node.disconnect();
          proc.disconnect();
          for (const t of stream.getTracks()) t.stop();
          void ctx.close().catch(() => undefined);
        },
      };
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      void ctx.close().catch(() => undefined);
      throw err;
    }
  };
}

/** A generated clip for tests and acceptance: `seconds` of a 220 Hz tone at 16 kHz, in chunks of `chunkMs`, one chunk every
 *  `everyMs` once the source is open, whatever the hold's length (so a run is deterministic), then nothing until stopped.
 *  It never touches a device. */
export function clipSource(o: { seconds?: number; chunkMs?: number; everyMs?: number } = {}): PcmSource {
  const seconds = o.seconds ?? 1.2;
  const chunkMs = o.chunkMs ?? 100;
  const everyMs = o.everyMs ?? 20;
  return async (sink) => {
    const perChunk = Math.round((LISTEN_RATE * chunkMs) / 1000);
    const total = Math.round(LISTEN_RATE * seconds);
    let made = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const step = (): void => {
      if (!live || made >= total) return;
      const n = Math.min(perChunk, total - made);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 220 * (made + i)) / LISTEN_RATE) * 0.75;
      made += n;
      sink.chunk(floatToPcm16(samples));
      timer = setTimeout(step, everyMs);
    };
    timer = setTimeout(step, everyMs);
    return { stop: () => { live = false; if (timer !== undefined) clearTimeout(timer); } };
  };
}

/** Whether this is a test or acceptance build: the app's own convention (a mark defined as a string, its label; `false`
 *  in a real build), the same test main makes, so the two never disagree. The moss tree's bundle gets both defines. */
export function testBuild(): boolean {
  return typeof __MOSS_ACCEPTANCE_BUILD__ === "string" || typeof __MOSS_TEST_BUILD__ === "string";
}

/** The source a recording uses: the generated clip in a test or acceptance build, else the real microphone. */
export function defaultSource(): PcmSource {
  return testBuild() ? clipSource() : micSource();
}
