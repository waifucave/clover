// A keyframe that is always over the wire cap would be dropped, and asked for again, forever. This counts the frames
// dropped in a row for one stream: after 3, the stream shrinks (a JPEG stream sends half-size, lower-quality pictures;
// a video stream asks the encoder for half the bitrate and a keyframe); if frames still don't fit after 3 more, the
// stream ends as `failed`. Any frame that fits starts the count again.
export const OVER_CAP_DROPS = 3;

export type OverCapStep = "ok" | "shrink" | "fail";

export class OverCap {
  #drops = 0;
  #shrunk = false;

  get shrunk(): boolean {
    return this.#shrunk;
  }

  /** `over`: this frame is over the cap and was dropped. What the stream does about it. */
  note(over: boolean): OverCapStep {
    if (!over) {
      this.#drops = 0;
      return "ok";
    }
    this.#drops++;
    if (this.#drops < OVER_CAP_DROPS) return "ok";
    this.#drops = 0;
    if (this.#shrunk) return "fail";
    this.#shrunk = true;
    return "shrink";
  }
}
