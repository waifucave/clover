// The app's own log: the main process's lines (`[clover-app] …`: the pair, the layers' refusals and part crashes, the
// sealed path) also go to `<home>/logs/app.log`, so a packaged app that shows a dead button leaves a trace beside the
// daemon's `daemon.log`. Size-capped (it keeps the last file and the one before it), appended a line at a time, and
// holding only what the app wrote about itself: no key, and no message content (the lines name methods and reasons,
// never a call's params).
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const APP_LOG_MAX_BYTES = 1_000_000;
export const APP_LOG_LINE_MAX = 300;

/** A line as it may reach the disk: a URL keeps no query or fragment, and a long run of token-like characters is a
 *  secret until shown otherwise, so it is blanked. */
export function cleanLogLine(line: string): string {
  return line
    .replace(/[\r\n]+/g, " ")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#"')]*)[?#][^\s"')]*/gi, "$1")
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, "[x]")
    .slice(0, APP_LOG_LINE_MAX);
}

export const appLogPath = (home: string): string => join(home, "logs", "app.log");

export class AppLog {
  private size: number | undefined;

  constructor(private readonly file: string, private readonly max = APP_LOG_MAX_BYTES) {}

  /** Appends a line; never throws (a log that can't be written is no reason to stop the app). */
  write(line: string, now: Date = new Date()): void {
    try {
      const text = `${now.toISOString()} ${cleanLogLine(line)}\n`;
      if (this.size === undefined) {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        try { this.size = statSync(this.file).size; } catch { this.size = 0; }
        // A log that already exists, and the one before it, are the owner's alone.
        for (const f of [this.file, `${this.file}.1`]) { try { chmodSync(f, 0o600); } catch { /* not there yet */ } }
      }
      if (this.size + text.length > this.max) {
        renameSync(this.file, `${this.file}.1`);
        try { chmodSync(`${this.file}.1`, 0o600); } catch { /* best effort */ }
        this.size = 0;
      }
      appendFileSync(this.file, text, { mode: 0o600 });
      this.size += text.length;
    } catch { /* the log is best effort */ }
  }
}
