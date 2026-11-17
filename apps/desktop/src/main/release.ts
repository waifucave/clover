// The app's side of one release for everything (spec §3.1; RL): what the app writes under the home at every start, what it
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
import { dirname, join } from "node:path";
import { AppInstallRecord, MOSS_ERR, SemverVersion, type Program } from "@waifucave/moss-protocol";

export type ReleaseNotice =
  | { kind: "updating"; phase: "checking" | "downloading" | "installing"; needs: string }
  | { kind: "offline"; needs: string }
  | { kind: "cannot"; needs: string }
  | { kind: "waiting"; incoming: string; turns: number; agents: number }
  | { kind: "switching"; incoming: string };

/** What an update check found (updater.ts's `checkNow`). */
export type UpdateOutcome =
  | { kind: "ready"; version: string }
  | { kind: "none" }
  | { kind: "offline" }
  | { kind: "failed"; why: string }
  | { kind: "unavailable" };

/** The app's release: its version, or a test build's stamp (`MOSS_TEST_APP_RELEASE`, read only by a test-marked build). */
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

/** Writes this app's record under the home; false (and a line in the log) when it couldn't. */
export function writeOwnRecord(home: string, o: { program: Program; bundlePath: string; release: string; build?: string; now?: number }, log: (line: string) => void): boolean {
  try {
    const record = AppInstallRecord.parse({
      record: 1, program: o.program, bundlePath: o.bundlePath, release: o.release, ...(o.build !== undefined ? { build: o.build } : {}),
      carries: { engine: true, host: true }, seenAt: o.now ?? Date.now(),
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
  log(line: string): void;
}

export const CATCH_UP_RETRY_MS = 30_000;

/** The app that is behind: updates itself before it connects. */
export class ReleaseCatchUp {
  #running = false;
  #needs: string | undefined;
  constructor(private readonly d: CatchUpDeps) {}

  get active(): boolean { return this.#running; }

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
        this.d.notice(r.kind === "offline" ? { kind: "offline", needs } : { kind: "cannot", needs });
      }
      await new Promise<void>((resolve) => this.d.after(this.d.retryMs ?? CATCH_UP_RETRY_MS, resolve));
    }
  }
}

export interface BringDeps {
  /** `release.bring` on the door connection. */
  bring(p: { release: string; bundlePath: string; now?: boolean }): Promise<{ state: "waiting" | "switching" }>;
  notice(n: ReleaseNotice | undefined): void;
  log(line: string): void;
}

/** The app that is ahead: asks for its engine to be brought in, and says what it waits for. */
export class BringWatch {
  #incoming: { release: string; bundlePath: string } | undefined;
  constructor(private readonly d: BringDeps) {}

  get active(): boolean { return this.#incoming !== undefined; }

  async start(release: string, bundlePath: string): Promise<void> {
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
      if (r.state === "switching") this.d.notice({ kind: "switching", incoming: i.release });
    } catch (err) {
      this.d.log(`release: the engine did not take release.bring: ${err instanceof Error ? err.message : String(err)}`);
      this.d.notice({ kind: "cannot", needs: i.release });
    }
  }

  /** A `release_changed` event (areas: `release`), already parsed. */
  event(e: { state: string; incoming?: string; waitingFor?: { turns: number; agents: number } }): void {
    if (this.#incoming === undefined) return;
    if (e.state === "waiting") this.d.notice({ kind: "waiting", incoming: this.#incoming.release, turns: e.waitingFor?.turns ?? 0, agents: e.waitingFor?.agents ?? 0 });
    else if (e.state === "switching") this.d.notice({ kind: "switching", incoming: this.#incoming.release });
    else if (e.state === "current") this.d.notice({ kind: "cannot", needs: this.#incoming.release });
  }

  /** The engine is the app's release now (the connection came back served): nothing waits. */
  done(): void {
    this.#incoming = undefined;
    this.d.notice(undefined);
  }
}
