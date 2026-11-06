// A ResizeObserver the tests drive by hand: happy-dom lays nothing out, so a test says what size the frame is.
import { act } from "@testing-library/react";

interface Entry {
  target: Element;
  contentRect: { width: number; height: number };
}

class FakeResizeObserver {
  static readonly live = new Set<FakeResizeObserver>();
  private target: Element | null = null;
  constructor(private readonly callback: (entries: Entry[], observer: FakeResizeObserver) => void) {}
  observe(target: Element) {
    this.target = target;
    FakeResizeObserver.live.add(this);
  }
  unobserve() {
    this.disconnect();
  }
  disconnect() {
    this.target = null;
    FakeResizeObserver.live.delete(this);
  }
  fire(width: number, height: number) {
    if (this.target) this.callback([{ target: this.target, contentRect: { width, height } }], this);
  }
}

export function installResizeObserver(): void {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
}

/** How many elements are being observed right now. */
export const observing = () => FakeResizeObserver.live.size;

/** Tells the frame's observer that the frame is now `width` x `height` CSS pixels (the panel observes only its frame). */
export async function resize(width: number, height: number): Promise<void> {
  await act(async () => {
    for (const o of FakeResizeObserver.live) o.fire(width, height);
  });
}
