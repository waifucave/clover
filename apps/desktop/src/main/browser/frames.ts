// The newest picture of a tab that draws offscreen (design B). Painted frames arrive as CPU bitmaps of the changed
// area plus the whole frame (`paint`'s image is always the full frame in Electron's bitmap path), so the newest one is
// a ready screenshot: about 5–7 ms as a JPEG against `capturePage`'s one frame of wait (S7 §7.1).
import type { NativeImage } from "electron";

export interface Frame {
  image: NativeImage;
  at: number;
  width: number;
  height: number;
}

export class FrameStore {
  private newest: Frame | undefined;
  private waiters: ((frame: Frame) => void)[] = [];

  put(image: NativeImage, at: number): void {
    if (image.isEmpty()) return;
    const { width, height } = image.getSize();
    this.newest = { image, at, width, height };
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(this.newest);
  }

  get(): Frame | undefined {
    return this.newest;
  }

  /** The next frame painted after now, or undefined after `ms`. */
  next(ms: number): Promise<Frame | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(undefined);
      }, ms);
      const done = (frame: Frame): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push(done);
    });
  }

  clear(): void {
    this.newest = undefined;
  }
}
