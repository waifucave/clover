// The engine's ReleaseHome (contracts/release-home.ts; spec §3.1 "One release for everything" and "Where the copies are
// found"). RL's. The apps' records are files in `<home>/apps/`; the installed copy is `<home>/bin/` and its marker; an
// install runs under `ENGINE_INSTALL_LOCK`.
//
// WHO MAY WRITE `<home>/apps/<program>.json`, AND WHAT A FORGED ONE COULD MAKE THE ENGINE RUN (decided here):
//   * Writers: the app itself at every start (before any engine runs, through `writeAppRecord`), and the engine for a
//     connected `app` (`release.record`, whose program must be the connection's own surface). No runner writes there:
//     `<home>` is default-deny for every bot, agent and plugin (fence.ts's home rule; `test/update/release-fence.test.ts`).
//   * A forged record could name a `bundlePath` of the forger's choosing. The engine runs something from a record's path
//     in two places only: the host (HS starts it from `hostSource()`'s bundle) and an engine copy `release.bring` swaps
//     in. Both go through `copyAcceptable` (engine-copy.ts) first: on macOS the code requirement of that very path (the
//     product's identifiers, Apple's chain, the team, Developer ID), elsewhere only a path some app recorded. A record
//     cannot name a file inside the bundle: the engine and the tree are found at fixed places under it, and a link out of
//     the bundle is refused.
//   * Reads are bounded (a record is at most `MAX_RECORD_BYTES`), strict (the zod shape, the file's name is its program),
//     and a record that fails either is ignored, never half-used. A record whose path is gone is deleted.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AppInstallRecord, APP_RECORDS_DIR, ENGINE_INSTALL_LOCK, MOSS_PROGRAMS as PROGRAMS, RELEASE_DOOR_METHODS, compareReleases, releaseStanding, type Program } from "@waifucave/moss-protocol";
import type { Clock } from "../contracts/clock";
import type { EngineCopy, ReleaseHome, ReleaseJudgment } from "../contracts/release-home";
import { tryFileLock } from "../lock";
import { isNewerCopy, isSameCopy, readEngineMarker } from "./engine-copy";

/** The most a record file may be: a record is a few hundred bytes; more is not one. */
export const MAX_RECORD_BYTES = 8 * 1024;

export interface EngineReleaseHomeOptions {
  /** The MOSS home (`~/.moss`). */
  home: string;
  /** The running engine's release. */
  engine: string;
  clock: Clock;
  /** Puts a copy under `<home>/bin/` (`placeEngine`), synchronously, under the install lock. Throws on failure. */
  place(copy: EngineCopy): void;
  /** Whether the set under `<home>/bin/daemon/` is whole (engine and sidecars present and passing their checks: `installedSetProblem`).
   *  Asked only when the installed copy is the very copy being installed, which is then placed again when it says false: the repair
   *  of a copy a failed or older install left without its sidecars. Absent: the set is taken as whole. */
  intact?(): boolean;
  /** Whether a bundle path still exists (default: the disk). */
  exists?(path: string): boolean;
  /** Test seam: time an install holds the lock, on the clock. */
  hold?(): Promise<void>;
  /** How long an install waits for another process's lock, and how often it asks (on the clock). */
  lockWaitMs?: number;
  lockPollMs?: number;
  /** How long a record's bundle may be missing before the record is deleted (default 30 s): an app being updated has no bundle for a moment. */
  missGraceMs?: number;
  /** Test seam: the lock itself (default: the OS lock on `ENGINE_INSTALL_LOCK`). */
  lock?(path: string): { release(): void } | undefined;
  log?(line: string): void;
}

/** The record file of a program under a home. */
export function appRecordPath(home: string, program: Program): string {
  return join(home, APP_RECORDS_DIR, `${program}.json`);
}

/** Writes an app's record: whole, through a rename, for the user alone. Used by the app at every start (before any engine
 *  runs) and by the engine for `release.record`. Throws when the path isn't absolute. */
export function writeAppRecord(home: string, record: AppInstallRecord): void {
  const parsed = AppInstallRecord.parse(record);
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(parsed.bundlePath)) throw new Error("a record names an absolute path");
  const path = appRecordPath(home, parsed.program);
  mkdirSync(join(home, APP_RECORDS_DIR), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** One record file, read once through its handle and bounded; undefined when it isn't a regular file, is too big, doesn't
 *  parse, or names another program than its file does. */
function readRecordFile(home: string, program: Program): AppInstallRecord | undefined {
  const path = appRecordPath(home, program);
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return undefined;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (fstatSync(fd).size > MAX_RECORD_BYTES) return undefined;
    const buf = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_RECORD_BYTES) return undefined;
    const parsed = AppInstallRecord.safeParse(JSON.parse(buf.subarray(0, n).toString("utf8")));
    return parsed.success && parsed.data.program === program ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

export class EngineReleaseHome implements ReleaseHome {
  readonly engine: string;
  readonly #o: EngineReleaseHomeOptions;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #missing = new Map<Program, number>();

  constructor(o: EngineReleaseHomeOptions) {
    this.#o = o;
    this.engine = o.engine;
  }

  judge(client: string | undefined): ReleaseJudgment {
    if (client === undefined) return { kind: "served" };
    const standing = releaseStanding(this.engine, client);
    if (standing === "same") return { kind: "served", standing: "same" };
    if (standing === "ahead") return { kind: "door", standing: "ahead", engine: this.engine };
    return { kind: "refused", refusal: { standing: "behind", engine: this.engine, client, needs: this.engine } };
  }

  doorAllows(method: string): boolean {
    return (RELEASE_DOOR_METHODS as readonly string[]).includes(method);
  }

  record(app: Omit<AppInstallRecord, "record" | "seenAt">): AppInstallRecord {
    const r: AppInstallRecord = { record: 1, ...app, seenAt: this.#o.clock.now() };
    writeAppRecord(this.#o.home, r);
    return r;
  }

  apps(): AppInstallRecord[] {
    const exists = this.#o.exists ?? existsSync;
    const out: AppInstallRecord[] = [];
    let names: string[];
    try { names = readdirSync(join(this.#o.home, APP_RECORDS_DIR)); } catch { return out; }
    for (const program of PROGRAMS) {
      if (!names.includes(`${program}.json`)) continue;
      const r = readRecordFile(this.#o.home, program);
      if (r === undefined) continue;
      if (!exists(r.bundlePath)) {
        // Not listed while its bundle is missing, but deleted only once it has stayed missing past the grace: during an app's own
        // update its bundle is briefly absent, and the host's source (`hostSource`) must not vanish for good with it.
        const now = this.#o.clock.now();
        const first = this.#missing.get(program) ?? now;
        this.#missing.set(program, first);
        if (now - first >= (this.#o.missGraceMs ?? 30_000)) {
          this.#missing.delete(program);
          try { rmSync(appRecordPath(this.#o.home, program), { force: true }); } catch { /* raced */ }
        }
        continue;
      }
      this.#missing.delete(program);
      out.push(r);
    }
    return out;
  }

  hostSource(): AppInstallRecord | undefined {
    let best: AppInstallRecord | undefined;
    for (const r of this.apps()) {
      if (!r.carries.host) continue;
      const c = best === undefined ? 1 : compareReleases(r.release, best.release);
      if (best === undefined || c > 0 || (c === 0 && r.seenAt >= best.seenAt)) best = r;
    }
    return best;
  }

  installed(): EngineCopy | undefined {
    return readEngineMarker(this.#o.home);
  }

  /** In-process order first (a first come, first served queue), then the lock between processes. */
  install(copy: EngineCopy): Promise<{ installed: boolean; current: EngineCopy }> {
    const run = this.#queue.then(async () => {
      const lock = await this.#acquire();
      try {
        await this.#o.hold?.();
        const have = this.installed();
        // A newer copy replaces the installed one; the very same copy (release and build) replaces it only to repair it.
        const installed = isNewerCopy(copy, have) || (have !== undefined && isSameCopy(copy, have) && this.#o.intact?.() === false);
        if (installed) this.#o.place(copy);
        return { installed, current: this.installed() ?? { ...copy } };
      } finally {
        lock.release();
      }
    });
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** The lock file's folder is made first; a busy lock is asked again every `lockPollMs` (on the clock) up to `lockWaitMs`:
   *  its holder is another process installing, whose copy this one then finds in place and just connects. */
  async #acquire(): Promise<{ release(): void }> {
    const path = join(this.#o.home, ENGINE_INSTALL_LOCK);
    mkdirSync(join(this.#o.home, "bin"), { recursive: true });
    const take = this.#o.lock ?? ((p: string) => tryFileLock(p));
    const waitMs = this.#o.lockWaitMs ?? 60_000, pollMs = this.#o.lockPollMs ?? 50;
    let waited = 0;
    for (;;) {
      const held = take(path);
      if (held !== undefined) return held;
      if (waited >= waitMs) throw new Error("another install of the engine holds the install lock");
      await new Promise<void>((resolve) => this.#o.clock.setTimeout(resolve, pollMs));
      waited += pollMs;
    }
  }
}
