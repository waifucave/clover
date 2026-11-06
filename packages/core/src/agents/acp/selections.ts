// The user's own choices that a delegation's choice overwrites (spike S5 edit 11, review 10): Cursor saves the model
// a session sets as the user's own selection, so Clover keeps one record per backend and option of what the user had,
// and sets it back when the last delegation that changed it ends.
//
// * One record per (backend, option), captured by the first delegation that changes the option while no other one
//   holds it. A second delegation running at the same time captures nothing: the value it would read is the first
//   one's choice, not the user's.
// * The record outlives a crash or a daemon restart (a file in the daemon's run folder, which the fence denies to
//   every bot and agent). When the last holder ends without a live session to set it back through (its process
//   crashed), the record stays, and the next delegation that ends sets it back.
// * A record left by a crash gives way to a newer choice of the user's: when the next delegation finds the option at
//   a value Clover didn't set, the user changed it since, and that value is captured instead.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface SelectionRecord {
  /** What the user had before a delegation changed it. */
  user: string;
  /** The last value a delegation set, to tell a later change of the user's from Clover's own. */
  ours?: string;
}

export class UserSelections {
  readonly #dir: string | undefined;
  readonly #memory = new Map<string, SelectionRecord>();
  readonly #holders = new Map<string, Set<object>>();

  /** `dir`: where the records live (`<home>/run/agents/selections`); in memory only without one (tests). */
  constructor(dir?: string) {
    this.#dir = dir;
  }

  /** Before `holder` first changes the option: `current` is the agent's value as the session opened. */
  begin(backend: string, option: string, holder: object, current: string | undefined): void {
    const key = keyOf(backend, option);
    const holders = this.#holders.get(key) ?? new Set();
    if (holders.size === 0) {
      const left = this.#read(key);
      // A record left behind stands while the value is still Clover's; a value the user set since replaces it.
      if (current !== undefined && (left === undefined || left.ours !== current)) this.#write(key, { user: current });
    }
    holders.add(holder);
    this.#holders.set(key, holders);
  }

  /** `holder` set the option to `value`. */
  set(backend: string, option: string, value: string): void {
    const key = keyOf(backend, option);
    const r = this.#read(key);
    if (r) this.#write(key, { ...r, ours: value });
  }

  /** `holder` ends. When it was the last one, the user's value to set back; `canRestore` false (its process is gone)
   *  keeps the record for the next delegation. */
  end(backend: string, option: string, holder: object, canRestore: boolean): string | undefined {
    const key = keyOf(backend, option);
    const holders = this.#holders.get(key);
    if (!holders?.delete(holder)) return undefined;
    if (holders.size > 0 || !canRestore) return undefined;
    this.#holders.delete(key);
    return this.#read(key)?.user;
  }

  /** The user's value was set back: the record goes. */
  restored(backend: string, option: string): void {
    const key = keyOf(backend, option);
    if ((this.#holders.get(key)?.size ?? 0) > 0) return;
    this.#memory.delete(key);
    if (this.#dir) rmSync(join(this.#dir, `${key}.json`), { force: true });
  }

  /** The record, for tests and the doctor. */
  record(backend: string, option: string): { user: string; ours?: string } | undefined {
    return this.#read(keyOf(backend, option));
  }

  #read(key: string): SelectionRecord | undefined {
    if (!this.#dir) return this.#memory.get(key);
    try {
      const r = JSON.parse(readFileSync(join(this.#dir, `${key}.json`), "utf8")) as Partial<SelectionRecord>;
      return typeof r.user === "string" ? { user: r.user, ...(typeof r.ours === "string" ? { ours: r.ours } : {}) } : undefined;
    } catch {
      return undefined;
    }
  }

  #write(key: string, r: SelectionRecord): void {
    if (!this.#dir) {
      this.#memory.set(key, r);
      return;
    }
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const path = join(this.#dir, `${key}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
    renameSync(tmp, path);
  }
}

function keyOf(backend: string, option: string): string {
  return `${backend}.${option}`.replace(/[^A-Za-z0-9._-]/g, "_");
}
