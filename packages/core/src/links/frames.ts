// Length-prefixed frames on a byte stream: a 4-byte big-endian length, then that many bytes. The link's message lanes
// carry one CBOR value per frame; a LinkStream carries its header frame, then one frame per chunk written.
import { ContractError } from "../contracts/common";
import { concat, u32 } from "../identity/bytes";

/** The largest frame a link accepts: a message, or one chunk of a stream. */
export const MAX_FRAME = 16 * 1024 * 1024;

export function frame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_FRAME) throw new ContractError("refused", `a frame is at most ${MAX_FRAME} bytes`);
  return concat(u32(payload.byteLength), payload);
}

/** Splits incoming chunks into frames. A length past `max` throws `invalid`; the caller resets the stream. */
export class FrameReader {
  #buf: Uint8Array = new Uint8Array(0);
  readonly #max: number;

  constructor(max = MAX_FRAME) {
    this.#max = max;
  }

  /** The complete frames this chunk finishes, in order. */
  push(chunk: Uint8Array): Uint8Array[] {
    this.#buf = this.#buf.byteLength === 0 ? chunk : concat(this.#buf, chunk);
    const out: Uint8Array[] = [];
    let at = 0;
    for (;;) {
      if (this.#buf.byteLength - at < 4) break;
      const len = new DataView(this.#buf.buffer, this.#buf.byteOffset + at, 4).getUint32(0, false);
      if (len > this.#max) throw new ContractError("invalid", "a frame is longer than the link allows");
      if (this.#buf.byteLength - at - 4 < len) break;
      out.push(this.#buf.slice(at + 4, at + 4 + len));
      at += 4 + len;
    }
    this.#buf = at === 0 ? this.#buf : this.#buf.slice(at);
    return out;
  }

  /** Bytes held for a frame not yet complete. */
  get pending(): number {
    return this.#buf.byteLength;
  }
}
