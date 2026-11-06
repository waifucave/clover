// A rate limiter for the services' tests, in place of the runtime's binding. The runtime's windows follow the wall
// clock's minutes, so a test that counts toward a real limit depends on when it starts and how fast the runner is.
// This one has no clock at all: a window lasts until the test calls nextWindow(), and the limit is the test's own.

export class StepLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly perWindow: number) {}

  async limit(options: { key: string }): Promise<{ success: boolean }> {
    const n = (this.counts.get(options.key) ?? 0) + 1;
    this.counts.set(options.key, n);
    return { success: n <= this.perWindow };
  }

  /** How many calls a key has made in this window. */
  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** The keys counted in this window. */
  keys(): string[] {
    return [...this.counts.keys()];
  }

  /** Starts the next window: every key's count goes back to zero. */
  nextWindow(): void {
    this.counts.clear();
  }
}
