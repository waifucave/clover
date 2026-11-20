// `release.status`, `release.bring` and `release.record` (protocol release.ts; spec §3.1 "One release for everything", "The
// engine and the host, precisely"). RL's.
//
// A newer app brings its engine:
//   release.bring → `waiting` (the engine between turns and no agent running: the update gate's idle verdict; the person's
//   "switch now" is `now: true`) → `switching`: the gate closes and commits, the host is asked to stop (`stop("update")`),
//   the newer copy is placed under the install lock (its binary at `<home>/bin/daemon`, its tree at `<home>/bin/plugins`),
//   and the engine restarts into it (`restart`: exit UPDATE_RESTART_EXIT_CODE, which `moss-core supervise` answers by
//   starting the installed binary). The host starts again from the newest app that carries it (HS: `hostSource`). A swap
//   that fails reopens the gate, asks the host to boot again, and says `current` again.
// Every state change is one `release_changed` event: the apps open at the time see `incoming` and the older one updates itself.
//
// WHICH BINARY: only a copy that (1) the calling app recorded for itself (its record file, written before it connected, with
// the release and the bundle path the call names), (2) `copyAcceptable` takes, and (3) says on its own `--version` that it
// is the release named and, on macOS, meets the engine's code requirement (`verifyStagedEngine`, on the staged file).
import { compareReleases, type AppInstallRecord, type MossHelloResult, type ReleaseState } from "@waifucave/moss-protocol";
import type { HostExitReason } from "@waifucave/moss-protocol";
import type { Surface } from "@waifucave/moss-protocol";
import type { ReleaseHome } from "../contracts/release-home";
import type { UpdateGate } from "./gate";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyAcceptable, locateEngineIn, placeEngine, verifyBundleEngine, verifyStagedEngine, verifyStagedSidecar, type CopyPolicy } from "./engine-copy";

/** How long the gate stays closed for a swap before it would reopen by itself (a swap that never finishes). */
export const SWAP_MS = 5 * 60_000;

export class ReleaseRefused extends Error {
  constructor(message: string, readonly code: "not-newer" | "not-recorded" | "not-acceptable" | "not-an-app" | "busy" | "loop") { super(message); }
}

export interface ReleaseEventBody {
  type: "release_changed";
  state: ReleaseState;
  engine: string;
  incoming?: string;
  waitingFor?: { turns: number; agents: number };
}

export interface ReleaseServiceDeps {
  readonly home: ReleaseHome;
  readonly engine: { release: string; build?: string; path: string };
  readonly gate: UpdateGate;
  /** The background host (HS's supervisor): stopped before the swap, started again if the swap fails. */
  readonly host: { stop(reason: HostExitReason): void; boot?(): Promise<unknown> };
  /** `release_changed` to the connections that subscribed to `release`. */
  emit(event: ReleaseEventBody): void;
  /** Ends this engine so the supervisor starts the installed one (exit UPDATE_RESTART_EXIT_CODE after the drain). */
  restart(): void | Promise<void>;
  readonly policy: CopyPolicy;
  /** Places the copy `from` names: the engine and tree of an app bundle. Default: `placeEngine` from `locateEngineIn`. */
  place?(copy: { release: string; build?: string; from: string }): void;
  /** Stages and checks the copy `from` names, throwing the refusal (default: `verifyBundleEngine`). Run at `bring`, before any wait. */
  verify?(copy: { release: string; from: string }): void;
  readonly homeDir: string;
  /** How often the wait asks the gate (ms). */
  pollMs?: number;
  sleep?(ms: number): Promise<void>;
  log?(line: string): void;
}

/** What the wait names to the person: the turns (the sessions' `turns` and the bots' `bot-turns`, as `host/engine.ts`'s midWorkOf
 *  counts them) and the agents (`agents` and `workflows`), each source's count added up. */
function waitingFor(busy: readonly string[]): { turns: number; agents: number } {
  const sum = (names: readonly string[]): number => busy.reduce((total, b) => {
    const at = b.lastIndexOf(":");
    if (at < 0 || !names.includes(b.slice(0, at))) return total;
    const v = Number(b.slice(at + 1));
    return total + (Number.isFinite(v) ? v : 1);
  }, 0);
  return { turns: sum(["turns", "bot-turns"]), agents: sum(["agents", "workflows"]) };
}

export class ReleaseService {
  #state: ReleaseState = "current";
  #incoming: { release: string; bundlePath: string; build?: string } | undefined;
  #now = false;
  #lastWaiting = "";
  /** A `bring` is being checked (its copy staged and verified): another one meanwhile only waits. */
  #checking = false;

  constructor(private readonly d: ReleaseServiceDeps) {}

  get state(): ReleaseState { return this.#state; }

  status(): { engine: { release: string; build?: string; path: string }; apps: AppInstallRecord[]; state: ReleaseState; incoming?: string } {
    return {
      engine: { ...this.d.engine },
      apps: this.d.home.apps().slice(0, 3),
      state: this.#state,
      ...(this.#incoming !== undefined ? { incoming: this.#incoming.release } : {}),
    };
  }

  /** `release.record`: the connected app's own record, for the program its connection is. */
  record(surface: Surface | undefined, p: { program: Surface; bundlePath: string; release: string; build?: string; carries: { engine: boolean; host: boolean } }): void {
    if (surface === undefined) throw new ReleaseRefused("only an app records itself", "not-an-app");
    if (p.program !== surface) throw new ReleaseRefused("an app records its own program only", "not-an-app");
    this.d.home.record({ program: p.program, bundlePath: p.bundlePath, release: p.release, carries: p.carries, ...(p.build !== undefined ? { build: p.build } : {}) });
  }

  /** `release.bring` from a connected `app` whose hello was `ahead`. Returns at once with the state it is in. */
  async bring(surface: Surface | undefined, p: { release: string; bundlePath: string; now?: boolean }): Promise<{ state: "waiting" | "switching" }> {
    if (surface === undefined) throw new ReleaseRefused("only an app brings an engine", "not-an-app");
    if (this.#state === "switching") return { state: "switching" };
    if (this.#checking) return { state: "waiting" };
    if (this.#incoming !== undefined) {
      // One already waits. The person's "switch now" moves it on; another app's own request doesn't replace it.
      if (p.now === true && this.#incoming.bundlePath === p.bundlePath) this.#now = true;
      return { state: "waiting" };
    }
    if (compareReleases(p.release, this.d.engine.release) <= 0) throw new ReleaseRefused(`release ${p.release} isn't newer than the engine's ${this.d.engine.release}`, "not-newer");
    const mine = this.d.home.apps().find((r) => r.program === surface);
    if (mine === undefined || mine.bundlePath !== p.bundlePath || mine.release !== p.release) throw new ReleaseRefused("the app's own record doesn't name that path and release", "not-recorded");
    const ok = copyAcceptable(p.bundlePath, "engine", this.d.policy);
    if (!ok.ok) throw new ReleaseRefused(`the engine copy isn't taken: ${ok.reason}`, "not-acceptable");
    // One restart per release: if the engine already restarted into this release and is still below it, the installed copy is not
    // what `supervise` starts (it would restart for ever); say so instead of restarting again.
    if (this.#restartedInto() === p.release) {
      throw new ReleaseRefused(`the engine already restarted to switch to release ${p.release} and is still on ${this.d.engine.release}: the installed copy isn't the one that starts`, "loop");
    }
    // Stage and check the copy NOW, before anything waits or stops: a copy that would be refused is refused at once, never after
    // the person waited for idle or pressed "Switch now" and the work was interrupted.
    this.#checking = true;
    try {
      await (this.d.verify ?? ((c) => verifyBundleEngine(this.d.homeDir, c.from, c.release, this.d.policy)))({ release: p.release, from: p.bundlePath });
    } catch (err) {
      throw new ReleaseRefused(`the engine copy isn't taken: ${err instanceof Error ? err.message : String(err)}`, "not-acceptable");
    } finally {
      this.#checking = false;
    }
    if (this.#incoming !== undefined) return { state: (this.#state as ReleaseState) === "switching" ? "switching" : "waiting" };
    this.#incoming = { release: p.release, bundlePath: p.bundlePath, ...(mine.build !== undefined ? { build: mine.build } : {}) };
    this.#now = p.now === true;
    this.#set("waiting");
    void this.#run().catch((err) => this.#fail(err));
    return { state: "waiting" };
  }

  #emit(extra: { waitingFor?: { turns: number; agents: number } } = {}): void {
    this.d.emit({
      type: "release_changed", state: this.#state, engine: this.d.engine.release,
      ...(this.#incoming !== undefined ? { incoming: this.#incoming.release } : {}),
      ...(extra.waitingFor !== undefined ? { waitingFor: extra.waitingFor } : {}),
    });
  }

  #set(state: ReleaseState, extra: { waitingFor?: { turns: number; agents: number } } = {}): void {
    this.#state = state;
    this.#lastWaiting = JSON.stringify(extra.waitingFor ?? null);
    this.#emit(extra);
  }

  async #run(): Promise<void> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const incoming = this.#incoming!;
    // Waiting: nothing mid-work, or the person's "switch now".
    for (;;) {
      if (this.#now) { this.d.gate.close(SWAP_MS); break; }
      const v = this.d.gate.verdict();
      if (v.idle) {
        // Closes the gate (no new turn starts), runs the steps before a restart, and asks idle again.
        if (await this.d.gate.closeForRestart({ timeoutMs: 5_000, reopenAfterMs: SWAP_MS, ...(this.d.log ? { log: this.d.log } : {}) })) break;
        continue;
      }
      const w = waitingFor(v.busy);
      if (JSON.stringify(w) !== this.#lastWaiting) this.#set("waiting", { waitingFor: w });
      await sleep(this.d.pollMs ?? 1000);
    }
    this.#set("switching");
    this.d.host.stop("update");
    const copy = { release: incoming.release, from: incoming.bundlePath, ...(incoming.build !== undefined ? { build: incoming.build } : {}) };
    const r = await this.d.home.install(copy);
    if (!r.installed && compareReleases(r.current.release, incoming.release) < 0) throw new Error("the engine wasn't installed");
    // Nothing newer than this running engine is in place (another app's copy of the same release, or none): a restart would start the
    // same engine again.
    if (compareReleases(r.current.release, this.d.engine.release) <= 0) throw new Error(`the installed engine (release ${r.current.release}) isn't newer than the running one`);
    this.#markRestart(incoming.release);
    this.d.log?.(`release: engine ${incoming.release} is in place; restarting into it`);
    // Committed only now that the copy is in place: a failure before this leaves the gate to reopen.
    this.d.gate.commit();
    await this.d.restart();
  }

  /** The release this engine already restarted for (one-shot per incoming release), kept in a file so the next process sees it. */
  #restartFile(): string { return join(this.d.homeDir, "bin", ".restarted-into.json"); }
  #restartedInto(): string | undefined {
    try {
      const r = JSON.parse(readFileSync(this.#restartFile(), "utf8")) as { release?: unknown };
      // Stale once the engine has reached it.
      return typeof r.release === "string" && compareReleases(this.d.engine.release, r.release) < 0 ? r.release : undefined;
    } catch {
      return undefined;
    }
  }
  #markRestart(release: string): void {
    const f = this.#restartFile();
    mkdirSync(join(this.d.homeDir, "bin"), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ release })}\n`, { mode: 0o600 });
    renameSync(tmp, f);
  }

  #fail(err: unknown): void {
    this.d.log?.(`release: bringing the engine failed: ${err instanceof Error ? err.message : String(err)}`);
    this.#incoming = undefined;
    this.#now = false;
    this.d.gate.reopen();
    this.#set("current");
    void this.d.host.boot?.();
  }
}

/** The place an app's bundle carries its engine and the files beside it, for the default `place`. */
export function defaultPlace(home: string, policy: CopyPolicy): (copy: { release: string; build?: string; from: string }) => void {
  return (copy) => {
    const src = locateEngineIn(copy.from, policy.platform);
    if (src === undefined) throw new Error("no engine to find in that bundle");
    placeEngine(home, { ...src, root: copy.from }, copy, policy.platform, (staged) => verifyStagedEngine(staged, copy.release, policy), (staged, file) => verifyStagedSidecar(staged, file, policy));
  };
}

/** The hello result's `release` field, for the connections that were told about it. */
export type HelloReleaseField = NonNullable<MossHelloResult["release"]>;

/** The three `release.*` methods as MOSS handlers (`ipc/moss.ts`'s `MossHandler`): each runs for the connection's PROGRAM (the
 *  door's `programOf`: its signed identity where the OS has one), never the hello's word or a call's params.
 *  A refusal is an `INVALID_REQUEST` that says why in words, never a path's content. */
export function releaseHandlers(service: ReleaseService, rpc: { error(code: number, message: string): Error }): Record<string, (conn: { program?: Surface }, params: unknown) => unknown> {
  const wrap = <T>(fn: () => T): T => {
    try { return fn(); } catch (err) { if (err instanceof ReleaseRefused) throw rpc.error(-32600, err.message); throw err; }
  };
  return {
    "release.status": () => service.status(),
    "release.bring": async (conn, p) => { try { return await service.bring(conn.program, p as { release: string; bundlePath: string; now?: boolean }); } catch (err) { if (err instanceof ReleaseRefused) throw rpc.error(-32600, err.message); throw err; } },
    "release.record": (conn, p) => wrap(() => { service.record(conn.program, p as Parameters<ReleaseService["record"]>[1]); return { ok: true }; }),
  };
}
