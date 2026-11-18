// An app's side of one release for everything (spec §3.1; RL; shared by MOSS and MOSS Code since lane PK): what the app writes under the home at every start, what it
// does when the engine says it is behind, and what it says while a newer app brings its engine.
//
//   * `writeOwnRecord`: `<home>/apps/<program>.json`, whole through a rename, for the user alone, at every start and before
//     any engine runs (the engine reads it when this app, ahead of it, asks `release.bring`). Never throws.
//   * `ReleaseCatchUp`: the app is BEHIND (the hello was refused, or `release_changed` said a newer one is coming): it shows
//     that it is updating, checks for its update, installs it as soon as it is downloaded (the engine already refuses this app,
//     so there is no work of this app's to wait for) and relaunches. Offline, it does not connect until it can: it says so
//     plainly and checks again. The dial itself stops meanwhile (`Pair.holdForUpdate`).
//   * `BringWatch`: the app is AHEAD (served the release door only): it asks `release.bring`, says it waits for work to finish,
//     and offers "Switch now" (`now: true`); the engine's `release_changed` events keep the counts current.
// The notice is data (`ReleaseNotice`); the root draws it (core/root.ts) from `registry.state`.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { AppInstallRecord, MOSS_ERR, SemverVersion, type Program } from "@waifucave/moss-protocol";

export type ReleaseNotice =
  | { kind: "updating"; phase: "checking" | "downloading" | "installing"; needs: string }
  | { kind: "offline"; needs: string }
  | { kind: "cannot"; needs: string; command?: string }
  | { kind: "waiting"; incoming: string; turns: number; agents: number }
  | { kind: "switching"; incoming: string }
  /** The switch went on and the new engine hasn't answered: said plainly, with a way to ask again (`BringWatch.retry`). */
  | { kind: "engine-down"; incoming: string };

/** What an update check found (updater.ts's `checkNow`). */
export type UpdateOutcome =
  | { kind: "ready"; version: string }
  | { kind: "none" }
  | { kind: "offline" }
  | { kind: "failed"; why: string }
  | { kind: "unavailable" };

/** The app's release: its version, or a test build's stamp (read by index.ts under the test-build define). */
export function appRelease(version: string, testStamp: string | undefined): string {
  return testStamp !== undefined && SemverVersion.safeParse(testStamp).success ? testStamp : version;
}

/** The folder, install path or AppImage an app runs from, which its record names: macOS `<name>.app` (three folders up from
 *  the executable), an AppImage's own file, otherwise the folder the executable is in. */
export function bundlePathOf(exe: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") {
    const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe);
    if (m !== null) return m[1]!;
  }
  if (platform === "linux" && typeof env.APPIMAGE === "string" && env.APPIMAGE !== "") return env.APPIMAGE;
  return dirname(exe);
}

export function recordPath(home: string, program: Program): string {
  return join(home, "apps", `${program}.json`);
}

/** The host helper an app bundle carries on macOS (`<App>.app/Contents/Frameworks/MOSS Host[ Dev].app`): the engine's own
 *  rule (packages/core/src/host/world.ts `hostHelperPath`; apps/moss's test holds the two equal). */
export function hostHelperIn(bundlePath: string, profile: "dist" | "dev"): string {
  // A macOS bundle path, joined with `/` on every OS, as the engine's own rule does.
  return posix.join(bundlePath, "Contents", "Frameworks", profile === "dev" ? "MOSS Host Dev.app" : "MOSS Host.app");
}

/** Writes this app's record under the home; false (and a line in the log) when it couldn't. `carries` says what this copy
 *  holds (default: both, as every packaged app does since lane PK): the engine starts the host only from a record that
 *  carries it. */
export function writeOwnRecord(home: string, o: { program: Program; bundlePath: string; release: string; build?: string; now?: number; carries?: { engine: boolean; host: boolean } }, log: (line: string) => void): boolean {
  try {
    const record = AppInstallRecord.parse({
      record: 1, program: o.program, bundlePath: o.bundlePath, release: o.release, ...(o.build !== undefined ? { build: o.build } : {}),
      carries: o.carries ?? { engine: true, host: true }, seenAt: o.now ?? Date.now(),
    });
    const path = recordPath(home, o.program);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch (err) {
    log(`release: this app's record was not written: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** What a refused hello carried (`ReleaseRefusal`), or undefined when the error is another one. */
export function behindFrom(err: unknown): { engine: string; client: string; needs: string } | undefined {
  const e = err as { code?: unknown; data?: unknown } | null;
  if (e === null || typeof e !== "object" || e.code !== MOSS_ERR.RELEASE_REFUSED) return undefined;
  const d = e.data as { engine?: unknown; client?: unknown; needs?: unknown } | undefined;
  return typeof d?.needs === "string" && typeof d.engine === "string" && typeof d.client === "string" ? { engine: d.engine, client: d.client, needs: d.needs } : undefined;
}

export interface CatchUpDeps {
  /** The updater's check and download (`Updater.checkNow`). */
  check(): Promise<UpdateOutcome>;
  /** Installs the downloaded update now and relaunches (`Updater.install(true)`); false when it couldn't start. */
  install(): boolean;
  notice(n: ReleaseNotice | undefined): void;
  /** Runs `fn` after `ms`. */
  after(ms: number, fn: () => void): void;
  /** How long before the next check when the last found nothing, was offline, or failed. */
  retryMs?: number;
  /** The command that takes the home's engine out so this app installs its own (`moss-core engine reset`): the way out the notice names. */
  resetCommand?(): string | undefined;
  log(line: string): void;
}

export const CATCH_UP_RETRY_MS = 30_000;

/** The app that is behind: updates itself before it connects. */
export class ReleaseCatchUp {
  #running = false;
  #needs: string | undefined;
  constructor(private readonly d: CatchUpDeps) {}

  get active(): boolean { return this.#running; }

  #way(): { command?: string } {
    const c = this.d.resetCommand?.();
    return c === undefined ? {} : { command: c };
  }

  /** Starts (or, if one runs for an older `needs`, follows) the catch-up. Idempotent. */
  start(needs: string): void {
    this.#needs = needs;
    if (this.#running) return;
    this.#running = true;
    void this.#loop();
  }

  async #loop(): Promise<void> {
    for (;;) {
      const needs = this.#needs!;
      this.d.notice({ kind: "updating", phase: "checking", needs });
      let r: UpdateOutcome;
      try { r = await this.d.check(); } catch (err) { r = { kind: "failed", why: err instanceof Error ? err.message : String(err) }; }
      if (r.kind === "ready") {
        this.d.notice({ kind: "updating", phase: "installing", needs });
        if (this.d.install()) return; // the app quits and the new one starts; this notice stays until then
        this.d.log("release: the update downloaded but did not start installing; checking again later");
      } else {
        this.d.log(`release: looking for release ${needs}: ${r.kind}${r.kind === "failed" ? ` (${r.why.slice(0, 160)})` : ""}`);
        // Offline: says so plainly and does not connect. Anything else: this build can't reach it.
        this.d.notice(r.kind === "offline" ? { kind: "offline", needs } : { kind: "cannot", needs, ...this.#way() });
      }
      await new Promise<void>((resolve) => this.d.after(this.d.retryMs ?? CATCH_UP_RETRY_MS, resolve));
    }
  }
}

/** A switch's new engine has not answered after this long: the app starts it through the OS itself (S2). */
export const SWITCH_START_MS = 8_000;
/** ... and after this long it says so, with a way to try again. */
export const SWITCH_GIVE_UP_MS = 45_000;

export interface BringDeps {
  /** Runs `fn` after `ms`; returns the cancel (default: a timer). */
  after?(ms: number, fn: () => void): () => void;
  /** Starts the engine through the OS, registering the login item first when there is none (login.ts `startEngineThroughOs`). */
  startEngine?(): Promise<unknown>;
  /** `release.bring` on the door connection. */
  bring(p: { release: string; bundlePath: string; now?: boolean }): Promise<{ state: "waiting" | "switching" }>;
  notice(n: ReleaseNotice | undefined): void;
  resetCommand?(): string | undefined;
  log(line: string): void;
}

/** The app that is ahead: asks for its engine to be brought in, and says what it waits for. */
export class BringWatch {
  #incoming: { release: string; bundlePath: string } | undefined;
  /** The engine said it is switching: from then until the new one answers, a lost connection is expected and then watched. */
  #switching = false;
  #cancels: (() => void)[] = [];
  constructor(private readonly d: BringDeps) {}

  get active(): boolean { return this.#incoming !== undefined; }

  async start(release: string, bundlePath: string): Promise<void> {
    this.#clear();
    this.#switching = false;
    this.#incoming = { release, bundlePath };
    this.d.notice({ kind: "waiting", incoming: release, turns: 0, agents: 0 });
    await this.#ask(false);
  }

  /** The person's "Switch now". */
  async switchNow(): Promise<void> {
    if (this.#incoming !== undefined) await this.#ask(true);
  }

  async #ask(now: boolean): Promise<void> {
    const i = this.#incoming!;
    try {
      const r = await this.d.bring({ release: i.release, bundlePath: i.bundlePath, ...(now ? { now: true } : {}) });
      if (r.state === "switching") this.#switch();
    } catch (err) {
      this.d.log(`release: the engine did not take release.bring: ${err instanceof Error ? err.message : String(err)}`);
      this.d.notice({ kind: "cannot", needs: i.release, ...(this.d.resetCommand?.() !== undefined ? { command: this.d.resetCommand() } : {}) });
    }
  }

  /** A `release_changed` event (areas: `release`), already parsed. */
  event(e: { state: string; incoming?: string; waitingFor?: { turns: number; agents: number } }): void {
    if (this.#incoming === undefined) return;
    if (e.state === "waiting") this.d.notice({ kind: "waiting", incoming: this.#incoming.release, turns: e.waitingFor?.turns ?? 0, agents: e.waitingFor?.agents ?? 0 });
    else if (e.state === "switching") this.#switch();
    else if (e.state === "current") this.d.notice({ kind: "cannot", needs: this.#incoming.release, ...(this.d.resetCommand?.() !== undefined ? { command: this.d.resetCommand() } : {}) });
  }

  #switch(): void {
    this.#switching = true;
    this.d.notice({ kind: "switching", incoming: this.#incoming!.release });
  }

  /** The connection's state, from the pair: through a switch the engine goes away and the new one comes up (S2, S3). The notice stays
   *  up the whole time and clears only when the new connection says `same` (`done`). If no engine answers within `SWITCH_START_MS` the
   *  app starts it through the OS itself (an engine nothing supervises is not restarted by its own exit); within `SWITCH_GIVE_UP_MS`
   *  the notice says it is not answering and offers "Try again" (`retry`). */
  connection(up: boolean): void {
    if (this.#incoming === undefined || !this.#switching) return;
    if (up) this.#clear();
    else if (this.#cancels.length === 0) this.#arm(SWITCH_START_MS);
  }

  /** The person's "Try again" after the notice said the new engine did not answer. */
  async retry(): Promise<void> {
    if (this.#incoming === undefined || !this.#switching) return;
    this.#clear();
    this.d.notice({ kind: "switching", incoming: this.#incoming.release });
    this.#arm(0);
  }

  #arm(startAfterMs: number): void {
    const after = this.d.after ?? ((ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    const incoming = this.#incoming!.release;
    this.#cancels.push(after(startAfterMs, () => {
      this.d.log("release: no engine answers after the switch; starting it through the OS");
      void Promise.resolve(this.d.startEngine?.()).catch((err: unknown) => this.d.log(`release: starting the engine failed: ${err instanceof Error ? err.message : String(err)}`));
    }));
    this.#cancels.push(after(SWITCH_GIVE_UP_MS, () => { if (this.#incoming !== undefined) this.d.notice({ kind: "engine-down", incoming }); }));
  }

  #clear(): void {
    for (const c of this.#cancels.splice(0)) c();
  }

  /** The engine is the app's release now (the connection came back served): nothing waits. */
  done(): void {
    this.#clear();
    this.#switching = false;
    this.#incoming = undefined;
    this.d.notice(undefined);
  }
}

/** A test build's stand-in for the update server (read by index.ts under the test-build define: offline, none, failed, ready:<version>): no real
 *  update is ever fetched. Read only by a test-marked build (the caller passes `env` only then). */
export function testUpdateOutcome(v: string | undefined): UpdateOutcome | undefined {
  if (v === undefined) return undefined;
  if (v.startsWith("ready:")) return { kind: "ready", version: v.slice(6) };
  return v === "offline" || v === "none" ? { kind: v } : { kind: "failed", why: "a test's stand-in" };
}

export interface ReleaseDeps {
  /** A test build's stand-ins (index.ts reads them under the test-build define, so a release build holds none): the update
   *  server's outcome and the wait between looks. Undefined in a release build. */
  stand?: { outcome?: string | undefined; retryMs?: string | undefined };
  updater(): { checkNow(): Promise<UpdateOutcome>; install(now: boolean): boolean } | undefined;
  /** The command that takes the home's engine out so this app installs its own (`moss-core engine reset`). */
  resetCommand?(): string | undefined;
  /** Starts the engine through the OS (a switch whose new engine hasn't answered). */
  startEngine?(): Promise<unknown>;
  /** A timer (tests drive it). */
  after?(ms: number, fn: () => void): () => void;
  /** `release.bring` on the pair's connection. */
  bring(p: { release: string; bundlePath: string; now?: boolean }): Promise<{ state: "waiting" | "switching" }>;
  /** The notice changed: the window and the tray say it. */
  changed(n: ReleaseNotice | undefined): void;
  log(line: string): void;
}

/** What the app holds of its release: the notice, the catch-up of an app that is behind, the watch of one that is ahead. */
export function createRelease(d: ReleaseDeps): { catchUp: ReleaseCatchUp; bringWatch: BringWatch; notice(): ReleaseNotice | undefined } {
  let current: ReleaseNotice | undefined;
  const notice = (n: ReleaseNotice | undefined): void => {
    current = n;
    d.log(`release: ${n === undefined ? "no notice" : `notice ${n.kind}${"phase" in n ? ` (${n.phase})` : ""}`}`);
    d.changed(n);
  };
  const stand = testUpdateOutcome(d.stand?.outcome);
  const retry = Number(d.stand?.retryMs);
  const catchUp = new ReleaseCatchUp({
    check: async () => stand ?? (await d.updater()?.checkNow()) ?? { kind: "unavailable" },
    install: () => {
      if (stand !== undefined) { d.log("release: a test build's stand-in update installs here (nothing is installed)"); return true; }
      return d.updater()?.install(true) ?? false;
    },
    notice,
    after: (ms, fn) => { setTimeout(fn, retry > 0 ? retry : ms); },
    ...(d.resetCommand ? { resetCommand: d.resetCommand } : {}),
    log: d.log,
  });
  const bringWatch = new BringWatch({ bring: d.bring, notice, ...(d.startEngine ? { startEngine: d.startEngine } : {}), ...(d.after ? { after: d.after } : {}), ...(d.resetCommand ? { resetCommand: d.resetCommand } : {}), log: d.log });
  return { catchUp, bringWatch, notice: () => current };
}
