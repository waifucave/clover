// FakeReleaseHome: the release rules in memory. Its drivers: `bundles`, the bundle paths that exist on disk; `slowInstall`,
// how long an install holds the lock (on the clock), so two installs overlap.
import { compareReleases, RELEASE_DOOR_METHODS, releaseStanding, type AppInstallRecord } from "@waifucave/moss-protocol";
import type { Clock } from "../clock";
import type { EngineCopy, ReleaseHome, ReleaseJudgment } from "../release-home";

export class FakeReleaseHome implements ReleaseHome {
  readonly engine: string;
  readonly #clock: Clock;
  readonly #records = new Map<string, AppInstallRecord>();
  /** Bundle paths that exist. */
  readonly bundles = new Set<string>();
  #installed: EngineCopy | undefined;
  #lock: Promise<void> = Promise.resolve();
  slowInstallMs = 0;

  constructor(opts: { clock: Clock; engine: string; installed?: EngineCopy }) {
    this.#clock = opts.clock;
    this.engine = opts.engine;
    this.#installed = opts.installed;
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
    const r: AppInstallRecord = { record: 1, ...app, seenAt: this.#clock.now() };
    this.#records.set(app.program, r);
    return r;
  }

  apps(): AppInstallRecord[] {
    for (const [p, r] of this.#records) if (!this.bundles.has(r.bundlePath)) this.#records.delete(p);
    return [...this.#records.values()];
  }

  hostSource(): AppInstallRecord | undefined {
    let best: AppInstallRecord | undefined;
    for (const r of this.apps()) {
      if (!r.carries.host) continue;
      if (!best || compareReleases(r.release, best.release) > 0 || (compareReleases(r.release, best.release) === 0 && r.seenAt >= best.seenAt)) best = r;
    }
    return best;
  }

  #newer(a: EngineCopy, b: EngineCopy | undefined): boolean {
    if (!b) return true;
    const c = compareReleases(a.release, b.release);
    if (c !== 0) return c > 0;
    return a.build !== undefined && b.build !== undefined && a.build.localeCompare(b.build, "en", { numeric: true }) > 0;
  }

  install(copy: EngineCopy): Promise<{ installed: boolean; current: EngineCopy }> {
    const run = this.#lock.then(async () => {
      if (this.slowInstallMs > 0) await new Promise<void>((resolve) => this.#clock.setTimeout(resolve, this.slowInstallMs));
      const installed = this.#newer(copy, this.#installed);
      if (installed) this.#installed = { ...copy };
      return { installed, current: { ...this.#installed! } };
    });
    this.#lock = run.then(() => undefined, () => undefined);
    return run;
  }

  installed(): EngineCopy | undefined {
    return this.#installed ? { ...this.#installed } : undefined;
  }
}
