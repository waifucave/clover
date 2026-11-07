// The images each client off this computer staged, per session (§6.6 "attachments"): the only images such a client
// may name in a message. Owner: lane D. Kept in `<home>/transcripts/staged-images.json`, so a phone's staged images
// still go after the daemon restarts; read and written whole each time, so every connection's methods agree.
// A list is a device's latest `STAGED_KEPT_PER_DEVICE` paths in one session; a path whose file is gone is dropped.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { transcriptsDir } from "../sessions/ids";

export const STAGED_KEPT_PER_DEVICE = 64;
/** Sessions with staged lists kept at most; the oldest-touched go first. */
export const STAGED_SESSIONS_KEPT = 1_000;

interface Entry {
  paths: string[];
  at: number;
}

export class StagedImages {
  readonly #file: string;

  constructor(home: string, readonly now: () => number = Date.now) {
    this.#file = join(transcriptsDir(home), "staged-images.json");
  }

  static key(session: string, client: string, device: string): string {
    return `${session}\n${client}\n${device}`;
  }

  #read(): Record<string, Entry> {
    const raw = readJson(this.#file) as Record<string, Entry> | undefined;
    return raw !== null && typeof raw === "object" ? raw : {};
  }

  /** The paths this key staged that still exist. */
  of(key: string): string[] {
    return (this.#read()[key]?.paths ?? []).filter((p) => existsSync(p));
  }

  /** Every path still named for a session, by any device (a bot conversation's prune keeps them). */
  forSession(session: string): string[] {
    return Object.entries(this.#read()).filter(([k]) => k.startsWith(`${session}\n`)).flatMap(([, e]) => e.paths);
  }

  add(key: string, path: string): void {
    const all = this.#read();
    const paths = [...(all[key]?.paths ?? []).filter((p) => existsSync(p)), path].slice(-STAGED_KEPT_PER_DEVICE);
    all[key] = { paths, at: this.now() };
    const kept = Object.entries(all).sort((a, b) => a[1].at - b[1].at).slice(-STAGED_SESSIONS_KEPT);
    writeJsonAtomic(this.#file, Object.fromEntries(kept));
  }
}
