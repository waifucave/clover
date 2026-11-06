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

/** Splits incoming chunks into frames. A length past `max` throws `invalid`; the caller resets the stream. A frame's
 *  body is gathered into one buffer sized from its length, so a large frame arriving in many chunks is copied once,
 *  not once per chunk. */
export class FrameReader {
  readonly #max: number;
  /** The length prefix while it is incomplete. */
  #head = new Uint8Array(4);
  #headLen = 0;
  /** The current frame's body and how much of it has come. */
  #body: Uint8Array | undefined;
  #bodyLen = 0;

  constructor(max = MAX_FRAME) {
    this.#max = max;
  }

  /** The complete frames this chunk finishes, in order. */
  push(chunk: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    let at = 0;
    while (at < chunk.byteLength) {
      if (this.#body === undefined) {
        const take = Math.min(4 - this.#headLen, chunk.byteLength - at);
        this.#head.set(chunk.subarray(at, at + take), this.#headLen);
        this.#headLen += take;
        at += take;
        if (this.#headLen < 4) break;
        const len = new DataView(this.#head.buffer).getUint32(0, false);
        if (len > this.#max) throw new ContractError("invalid", "a frame is longer than the link allows");
        this.#headLen = 0;
        this.#body = new Uint8Array(len);
        this.#bodyLen = 0;
        if (len === 0) {
          out.push(this.#body);
          this.#body = undefined;
          continue;
        }
      }
      const body = this.#body;
      const take = Math.min(body.byteLength - this.#bodyLen, chunk.byteLength - at);
      body.set(chunk.subarray(at, at + take), this.#bodyLen);
      this.#bodyLen += take;
      at += take;
      if (this.#bodyLen === body.byteLength) {
        out.push(body);
        this.#body = undefined;
      }
    }
    return out;
  }

  /** Bytes held for a frame not yet complete. */
  get pending(): number {
    return this.#headLen + (this.#body === undefined ? 0 : this.#bodyLen + 4);
  }
}
