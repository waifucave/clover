// The recorder for push-to-talk, in the main window's `clover` shell document (spec §6.6: the app records and hands the audio to
// the bot's voice plugin, so no plugin needs the microphone). Main tells the shell when to record (`{ type: "listen" }`, only after
// the user's own press reached it) and takes the audio back as `voice.listen` pieces: base64 `pcm16-16k` (16-bit little-endian
// signed mono at 16 kHz, no header), the last piece `final`.
//
// Two seams keep the real microphone out of every test and every acceptance run:
//   * `PcmSource`: what yields the audio. The real one wraps getUserMedia (`micSource`); a test hands the recorder a fake that
//     yields a generated clip. A test or acceptance build of the app (a compile-time mark, folded away in a release) takes the
//     generated clip (`clipSource`) and never constructs the real one, so no run opens a microphone or raises a system prompt.
//   * `send`: where the pieces go (the shell's `core.call("voice.listen", …)`).
//
// The recorder is plain classes and functions: the audio is cut into pieces here (`splitPieces`), sent one at a time (the core
// opens an utterance on piece 0 and takes the rest in order), and a recording ends however it ends with its last piece.

/** The format the core takes from the app (`voice.listen`'s `pcm16-16k`). */
export const LISTEN_RATE = 16_000;
/** About half a second of audio goes in each piece while the user is still talking, so a streaming listener starts early. */
export const FLUSH_BYTES = 16_000;
/** The most bytes one piece carries: `voice.listen`'s 2,000,000 base64 characters, a whole number of 16-bit samples. */
export const PIECE_BYTES = 1_500_000;

declare const __CLOVER_TEST_BUILD__: string | false | undefined;
declare const __CLOVER_ACCEPTANCE_BUILD__: string | false | undefined;

/** Cuts `bytes` into pieces of at most `max` bytes, each a whole number of 16-bit samples, in order. */
export function splitPieces(bytes: Uint8Array, max: number = PIECE_BYTES): Uint8Array[] {
  const size = Math.max(2, max - (max % 2));
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, Math.min(at + size, bytes.length)));
  return out;
}

/** Base64 of bytes, in blocks (a spread of a big array overflows the call stack). */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

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

/** Takes the microphone's samples at the audio context's own rate down to 16 kHz: each output sample is the mean of the input
 *  samples that fall in its slot (a box filter, enough for speech), and the position carries across calls so no piece
 *  boundary clicks. At 16 kHz already it passes through. */
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

/** Where the audio comes from: it calls `chunk` with 16 kHz 16-bit mono PCM (whole samples) as it has it, and `end` if it stops
 *  by itself (the device went away). The promise is the open source, which `stop` closes; it rejects when it can't open. */
export interface PcmSink {
  chunk(pcm: Uint8Array): void;
  end(): void;
}
export interface PcmHandle {
  stop(): void;
}
export type PcmSource = (sink: PcmSink) => Promise<PcmHandle>;

export interface RecorderDeps {
  source: PcmSource;
  /** One piece to the core, through main: the audio and whether it is the last. `problem`: the source could not open. */
  send(piece: { audio: string; final: boolean; problem?: true }): Promise<unknown>;
  /** The recording stops itself at this length (main's own cap is the one that counts). */
  maxMs: number;
  /** Bytes gathered before a piece goes while the user is still talking. */
  flushBytes?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Said when something went wrong that the user's note will not carry (a failed send). */
  warn?: (what: string) => void;
}

/** One recording: `start` opens the source, `stop` closes it and sends what is left as the last piece. */
export class Recorder {
  readonly #d: RecorderDeps;
  #handle: PcmHandle | undefined;
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #stopped = false;
  #timer: unknown;
  #finished: Promise<void> | undefined;
  /** Pieces and bytes handed to `send`, for the counters a test build shows. */
  pieces = 0;
  bytes = 0;

  constructor(deps: RecorderDeps) {
    this.#d = deps;
  }

  /** Opens the source. A source that can't open ends the recording with a last piece that says so. */
  async start(): Promise<void> {
    const set = this.#d.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#timer = set(() => void this.stop(), this.#d.maxMs);
    try {
      const handle = await this.#d.source({
        chunk: (pcm) => this.#chunk(pcm),
        end: () => void this.stop(),
      });
      // Let go before the source was open: close it at once.
      if (this.#stopped) handle.stop();
      else this.#handle = handle;
    } catch {
      this.#stopped = true;
      this.#clear();
      this.#enqueue({ audio: "", final: true, problem: true });
      await this.#tail;
    }
  }

  #clear(): void {
    if (this.#timer !== undefined) (this.#d.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.#timer);
    this.#timer = undefined;
  }

  #chunk(pcm: Uint8Array): void {
    if (this.#stopped || pcm.length === 0) return;
    this.#pending.push(pcm);
    this.#pendingBytes += pcm.length;
    if (this.#pendingBytes >= (this.#d.flushBytes ?? FLUSH_BYTES)) this.#flush(false);
  }

  /** Everything gathered so far goes out, cut to the piece size; the last of them is `final` when this is the end. */
  #flush(final: boolean): void {
    const all = new Uint8Array(this.#pendingBytes);
    let at = 0;
    for (const c of this.#pending) {
      all.set(c, at);
      at += c.length;
    }
    this.#pending = [];
    this.#pendingBytes = 0;
    const parts = splitPieces(all);
    if (parts.length === 0) {
      if (final) this.#enqueue({ audio: "", final: true });
      return;
    }
    parts.forEach((p, i) => this.#enqueue({ audio: toBase64(p), final: final && i === parts.length - 1 }, p.length));
  }

  #enqueue(piece: { audio: string; final: boolean; problem?: true }, bytes = 0): void {
    this.pieces++;
    this.bytes += bytes;
    // One at a time, in order: the core opens an utterance on its first piece and takes the rest after it. A piece that fails
    // doesn't stop the ones behind it from trying; main has already ended a recording it refused.
    this.#tail = this.#tail.then(() => this.#d.send(piece)).catch((err: unknown) => this.#d.warn?.(`a piece wasn't taken: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Closes the source and sends the rest as the last piece. Safe to call twice, or before `start` finished. */
  stop(): Promise<void> {
    if (this.#finished !== undefined) return this.#finished;
    this.#finished = (async () => {
      const wasStopped = this.#stopped;
      this.#stopped = true;
      this.#clear();
      this.#handle?.stop();
      this.#handle = undefined;
      if (!wasStopped) this.#flush(true);
      await this.#tail;
    })();
    return this.#finished;
  }
}

/** The real microphone: getUserMedia into a ScriptProcessor (an AudioWorklet's module would need a script origin the layer's
 *  policy doesn't give), downsampled to 16 kHz in `Downsampler`. Main answers the permission only while the user's press has a
 *  recording open in this window; the tracks stop and the context closes when the recording ends. Not used in a test or
 *  acceptance build. */
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

/** A generated clip for tests and acceptance: `seconds` of a 220 Hz tone at 16 kHz, in chunks of `chunkMs`, yielded one chunk
 *  every `everyMs` once the source is open, whatever the hold's length (so a run is deterministic), then silence until stopped.
 *  Nothing in it is the owner's audio, and it never touches a device. */
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

/** The source a recording uses: the generated clip in a test or acceptance build (compile-time marks, folded away in a real
 *  build, where this is only the microphone), else the real microphone. */
export function defaultSource(): PcmSource {
  if (typeof __CLOVER_ACCEPTANCE_BUILD__ === "string" || typeof __CLOVER_TEST_BUILD__ === "string") return clipSource();
  return micSource();
}
