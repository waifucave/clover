// The waifucave push notifier (clover/push), on the main computer: when the core has something for the user, it
// asks push.waifucave.com to wake the user's phones and browsers with a count, and nothing else (spec §10:
// "a content-free waifucave push"). Whatever the core hands it (a bot's name, a message, a card) stays here.
//
// A burst of notifications becomes one push after a short wait; a push that fails for a passing reason is
// tried again with backoff, carrying the newest count. A request that never answers is abandoned, and with no
// waifucave account signed in nothing is sent or retried until the next notification.

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Where the unseen count is kept, so it survives a restart and a change of main computer (the synced store). */
export interface CountStore {
  get(): Promise<number | undefined | null>;
  set(count: number): Promise<void>;
}

/** What the core hands a notifier. Only `unseen` is read; everything else is content and is never sent. */
export interface Notification {
  /** The user's unseen updates, when the core counts them; otherwise each notification adds one. */
  unseen?: number;
  [key: string]: unknown;
}

export interface PushNotifierOptions {
  /** https://push.waifucave.com, or a local emulator's origin. */
  origin: string;
  /**
   * The core's keyed fetch: it adds this computer's waifucave account token. With no account signed in it
   * rejects with an error whose `code` is "no_account".
   */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  store?: CountStore;
  clock?: Clock;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  debounceMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  /** How long one push request may take before it is abandoned and retried. */
  requestTimeoutMs?: number;
}

const MAX_BADGE = 99_999;

export class PushNotifier {
  private readonly clock: Clock;
  private readonly debounceMs: number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private count = 0;
  /** Whether "no account" has been logged since the last push that went through. */
  private signedOut = false;
  private loaded: Promise<void> | null = null;
  private timer: unknown = null;
  private dueAt = 0;
  private attempts = 0;
  private sending = false;
  private stopped = false;
  /** The count the service last accepted; nothing is sent when it has not changed. */
  private sentCount: number | null = null;

  constructor(private readonly options: PushNotifierOptions) {
    this.clock = options.clock ?? systemClock;
    this.debounceMs = options.debounceMs ?? 2_000;
    this.retryMinMs = options.retryMinMs ?? 5_000;
    this.retryMaxMs = options.retryMaxMs ?? 120_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  get unseen(): number {
    return this.count;
  }

  /** Something happened for the user: count it and schedule a push. */
  async notify(notification: Notification = {}): Promise<void> {
    await this.load();
    const given = notification.unseen;
    this.count = typeof given === "number" && Number.isInteger(given) && given >= 0 ? Math.min(given, MAX_BADGE) : Math.min(this.count + 1, MAX_BADGE);
    await this.options.store?.set(this.count);
    this.attempts = 0;
    this.schedule(this.debounceMs);
  }

  /** The user has caught up: the badge goes back to zero, promptly. */
  async clear(): Promise<void> {
    await this.load();
    this.count = 0;
    await this.options.store?.set(0);
    this.attempts = 0;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Sends the current count now (what the scheduled push does). */
  async flush(): Promise<void> {
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    await this.send();
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const stored = await this.options.store?.get();
      if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) this.count = Math.min(stored, MAX_BADGE);
    })();
    return this.loaded;
  }

  /** Runs a push in `ms`, unless one is already due sooner. */
  private schedule(ms: number): void {
    if (this.stopped) return;
    const at = this.clock.now() + ms;
    if (this.timer !== null && this.dueAt <= at) return;
    this.clock.clearTimeout(this.timer);
    this.dueAt = at;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.send();
    }, ms);
  }

  private async send(): Promise<void> {
    if (this.stopped || this.sending) return;
    const badge = this.count;
    if (badge === this.sentCount) return;
    this.sending = true;
    let retry = false;
    try {
      const response = await this.options.fetch(`${this.options.origin}/v1/notify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ badge }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (response.ok) {
        this.sentCount = badge;
        this.attempts = 0;
        this.signedOut = false;
      } else if (response.status === 429 || response.status >= 500) {
        retry = true;
      } else {
        this.log("error", `push refused (${response.status}); not retried`);
      }
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "no_account") {
        // Nothing to wake: the count is kept, and the next notification after a sign-in sends it.
        if (!this.signedOut) this.log("info", "no waifucave account is signed in; pushes wait until one is");
        this.signedOut = true;
      } else {
        retry = true;
        this.log("warn", `push failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.sending = false;
    }
    if (retry) {
      this.attempts += 1;
      if (this.attempts >= this.maxAttempts) {
        this.log("warn", `push gave up after ${this.attempts} tries; the next notification tries again`);
        this.attempts = 0;
        return;
      }
      this.schedule(Math.min(this.retryMaxMs, this.retryMinMs * 2 ** (this.attempts - 1)));
    } else if (this.count !== badge) {
      // The count moved while the push was in flight: send the newer one.
      this.schedule(this.debounceMs);
    }
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.options.log?.(level, message);
  }
}
