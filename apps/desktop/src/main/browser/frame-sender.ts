// A tab's pictures to the engine (spec revision 19, §12.1, item 111; the controller's ruling on `host.tab.frame`; lane
// HS). The browser's own tab streamer (`stream.ts`, the jpeg mode the engine asks for with `codecs: ["jpeg"]`) hands its
// chunks here; each whole JPEG picture goes to the engine as one `host.tab.frame`, at most one in flight per stream and
// only the newest waiting, so a slow engine drops pictures, never queues them. The picture's size is read from its own
// header, as the engine checks it.
//
// The program that runs the browser's pages sends these: today MOSS Code's window, the background host once it runs
// them. The engine takes them only from that one connection (`packages/core/src/host/tab-frames.ts`, `pagesOwner`).
import type { StreamChunk } from "./contract";

export interface HostTabFrameParams {
  stream: string;
  seq: number;
  format: "jpeg";
  width: number;
  height: number;
  data: string;
  at: number;
}

/** A JPEG's size from its first SOF marker, or undefined when the bytes aren't a JPEG this reader knows. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) return i + 8 < b.length ? { width: u16(i + 7), height: u16(i + 5) } : undefined;
    i += 2 + u16(i + 2);
  }
  return undefined;
}

interface StreamState { jpeg: boolean; seq: number; busy: boolean; pending?: HostTabFrameParams }

export class TabFrameSender {
  readonly #streams = new Map<string, StreamState>();

  constructor(private readonly send: (params: HostTabFrameParams) => Promise<unknown>, private readonly now: () => number = Date.now, private readonly log: (line: string) => void = () => {}) {}

  /** One chunk of a tab stream; only a jpeg stream's pictures go on (video chunks are the other devices' stream). */
  chunk(stream: string, chunk: StreamChunk): void {
    if (chunk.kind === "config") {
      this.#streams.set(stream, { jpeg: chunk.codec === "jpeg", seq: 0, busy: false });
      this.log(`browser: a tab's stream ${stream} started (${chunk.codec})`);
      return;
    }
    if (chunk.kind === "ended") {
      this.#streams.delete(stream);
      return;
    }
    const s = this.#streams.get(stream);
    if (s === undefined || !s.jpeg) return;
    const size = jpegSize(chunk.data);
    if (size === undefined) return;
    const frame: HostTabFrameParams = { stream, seq: ++s.seq, format: "jpeg", ...size, data: Buffer.from(chunk.data).toString("base64"), at: this.now() };
    if (s.busy) { s.pending = frame; return; }
    this.#go(s, frame);
  }

  #go(s: StreamState, frame: HostTabFrameParams): void {
    s.busy = true;
    void this.send(frame).catch((e: unknown) => { if (s.seq <= 3) this.log(`browser: the engine refused a tab's picture (${frame.width}x${frame.height}): ${(e as Error).message}`); }).finally(() => {
      s.busy = false;
      const next = s.pending;
      s.pending = undefined;
      if (next !== undefined && this.#streams.get(frame.stream) === s) this.#go(s, next);
    });
  }
}
