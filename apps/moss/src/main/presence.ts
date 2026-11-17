// MOSS's presence (spec §3.5, G2, ruling A; the reviewer's list for lane MA, item 1): MOSS's main process reads from the
// OS and its own state whether its window is focused and visible and which bot it shows, and reports it to the engine's
// router (`presence.report`) on every change and at least every `PRESENCE_REFRESH_MS` while the window lives, and again
// on every new connection (after an engine restart the router has no reports and sends cards to the island until one
// comes). The window's page never reports it: it only says which bot or page it shows, which main checks against the
// bots it knows.
import { PRESENCE_REFRESH_MS, type PresenceReport, type Showing } from "@waifucave/moss-protocol";
import { MAIN_WINDOW_ID } from "./identity";

export interface WindowReading {
  focused: boolean;
  visible: boolean;
  showing: Showing | null;
}

export interface PresenceClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export class PresenceReporter {
  private reading: WindowReading | undefined;
  private lastSent: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private client: PresenceClient | undefined;
  private refusalSaid = false;

  constructor(private readonly log: (line: string) => void = () => {}, private readonly every = PRESENCE_REFRESH_MS) {}

  /** The report for the current reading: MOSS's one window, or none when it is closed. */
  report(): PresenceReport {
    return { windows: this.reading === undefined ? [] : [{ window: MAIN_WINDOW_ID, ...this.reading }] };
  }

  /** A new connection: report at once, then on the beat. */
  connected(client: PresenceClient): void {
    this.client = client;
    this.lastSent = undefined;
    this.refusalSaid = false;
    this.send(true);
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.send(true), this.every);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  disconnected(): void {
    this.client = undefined;
  }

  /** The window's reading changed (or is the same: then nothing is sent off the beat). */
  update(reading: WindowReading | undefined): void {
    this.reading = reading;
    this.send(false);
  }

  private send(beat: boolean): void {
    const client = this.client;
    if (client === undefined) return;
    const report = this.report();
    const text = JSON.stringify(report);
    if (!beat && text === this.lastSent) return;
    this.lastSent = text;
    void client.request("presence.report", report, 5_000).catch((err: unknown) => {
      // "Not served yet" from an engine whose router isn't in: said once per connection.
      if (this.refusalSaid) return;
      this.refusalSaid = true;
      this.log(`presence: not taken (${err instanceof Error ? err.message.slice(0, 120) : "refused"})`);
    });
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
