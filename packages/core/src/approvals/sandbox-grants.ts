// What a bot's shell commands were given beyond its level's sandbox (§9.1, stage 2; the controller's ruling on
// `RequestAccess`): folders they may write to, each granted on a card. A grant holds for
// the conversation it was asked in; a folder the user answered "Always allow" for holds for every conversation of
// that bot, kept in `<home>/rules/sandbox-grants.json` (inside the fenced rules folder, owner-only), so no bot can
// write itself one.
//
// A folder is kept as the real path it had when granted: at each look it must still be that real path (a folder
// swapped for a link since is dropped, never followed) and still an ordinary folder of the user's (`isOrdinary`, read
// at each look, so a folder that went onto the PATH, say, stops being given), and still a folder.
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The most folders and hosts one conversation (or one bot, kept) holds. */
export const GRANTS_MAX = 64;
/** The most conversations whose grants are held in memory; the one used longest ago goes first. */
export const GRANT_SESSIONS_MAX = 500;

interface KeptGrant {
  bot: string;
  folder: string;
  savedAt: number;
}

export interface SandboxGrantsOptions {
  /** Clover's home: kept grants are saved under its rules folder. Without it they last as long as the daemon. */
  home?: string;
  /** Whether a folder is (still) one shell commands may be given: R1's ordinary class. */
  isOrdinary: (folder: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export function sandboxGrantsFile(home: string): string {
  return join(home, "rules", "sandbox-grants.json");
}

export class SandboxGrants {
  readonly #o: SandboxGrantsOptions;
  readonly #sessions = new Map<string, { folders: string[] }>();
  #kept: KeptGrant[] = [];

  constructor(o: SandboxGrantsOptions) {
    this.#o = o;
    if (o.home !== undefined) {
      try {
        const raw = JSON.parse(readFileSync(sandboxGrantsFile(o.home), "utf8")) as unknown;
        const list = Array.isArray((raw as { grants?: unknown }).grants) ? (raw as { grants: unknown[] }).grants : [];
        this.#kept = list.filter((g): g is KeptGrant => typeof (g as KeptGrant).bot === "string" && typeof (g as KeptGrant).folder === "string" && typeof (g as KeptGrant).savedAt === "number").slice(0, GRANTS_MAX * 64);
      } catch (err) {
        // A fixed line: the parse error could quote the file.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") o.log?.("[approvals] the shell grants file is unreadable; starting with none kept");
      }
    }
  }

  #session(sessionId: string): { folders: string[] } {
    let s = this.#sessions.get(sessionId);
    if (s !== undefined) this.#sessions.delete(sessionId);
    this.#sessions.set(sessionId, (s ??= { folders: [] }));
    while (this.#sessions.size > GRANT_SESSIONS_MAX) this.#sessions.delete(this.#sessions.keys().next().value!);
    return s;
  }

  /** A folder still as it was granted: its real path unchanged, and still ordinary. */
  #holds(folder: string): boolean {
    let real: string;
    try { real = realpathSync.native(folder); } catch { return false; }
    try { if (!lstatSync(folder).isDirectory()) return false; } catch { return false; }
    return real === folder && this.#o.isOrdinary(folder);
  }

  /** The folders a session's shell commands may write to beyond its level's: its own grants and its bot's kept ones. */
  folders(sessionId: string, bot: string): string[] {
    const own = this.#sessions.get(sessionId)?.folders ?? [];
    const kept = this.#kept.filter((g) => g.bot === bot).map((g) => g.folder);
    return [...new Set([...own, ...kept])].filter((f) => this.#holds(f));
  }

  /** Whether `folder` (a real path) is already given to the session. */
  has(sessionId: string, bot: string, folder: string): boolean {
    return this.folders(sessionId, bot).includes(folder);
  }

  grantFolder(sessionId: string, bot: string, folder: string, keep: boolean): void {
    const s = this.#session(sessionId);
    if (!s.folders.includes(folder)) s.folders = [...s.folders, folder].slice(-GRANTS_MAX);
    if (!keep || this.#kept.some((g) => g.bot === bot && g.folder === folder)) return;
    this.#kept = [...this.#kept, { bot, folder, savedAt: this.#o.now?.() ?? Date.now() }];
    // At most GRANTS_MAX kept for one bot: its oldest go first.
    const mine = this.#kept.filter((g) => g.bot === bot);
    if (mine.length > GRANTS_MAX) {
      const drop = new Set(mine.slice(0, mine.length - GRANTS_MAX));
      this.#kept = this.#kept.filter((g) => !drop.has(g));
    }
    this.#save();
  }

  /** A bot that is gone: its kept grants go with it. */
  forgetBot(bot: string): void {
    const before = this.#kept.length;
    this.#kept = this.#kept.filter((g) => g.bot !== bot);
    if (this.#kept.length !== before) this.#save();
  }

  forgetSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  #save(): void {
    if (this.#o.home === undefined) return;
    const file = sandboxGrantsFile(this.#o.home);
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ grants: this.#kept }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch {
      // A fixed line: the error could name the file.
      this.#o.log?.("[approvals] saving a kept shell grant failed; it holds until the daemon restarts");
    }
  }
}
