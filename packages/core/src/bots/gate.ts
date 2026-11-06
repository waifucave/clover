// When sessions may think and act on this computer (spec §6.4 "The main computer", §9.2 "A core switch pauses all bots
// and routines at once"; the owner's decision of November 6: the pause switch pauses everything). Owner: lane D.
//
// Two questions, asked of every session:
//
// * **`mayStart`:** may it start a turn or a compaction now? The durable host asks before each one
//   (`DurableSessionHostOptions.mayStart`); what arrives while the answer is no is recorded and waits.
// * **`mayAct`:** may a running turn make its next tool call or memory write now? Lane A's runtime and lane K's agents
//   ask before each one, and while the answer is no they hold there (`whenMayAct`) until it turns yes: nothing is
//   cut off mid-call.
//
// | Session                         | `mayStart` is no while                                  | `mayAct` is no while              |
// | :------------------------------ | :------------------------------------------------------ | :-------------------------------- |
// | a bot's main conversation       | paused; this computer isn't the runner; handing back    | paused; this computer isn't the runner |
// | a side thread (a routine's run) | paused                                                  | paused                            |
// | a background agent              | paused                                                  | paused                            |
// | the user's own coding session   | never                                                   | never                             |
//
// A hand-back (`BotService.handBack`) stops new turns only: the running one goes on acting until it ends where it is
// (review S4).
//
// **The pause switch** is one of the core's settings, kept in `<home>/settings/bots.json` with the others, in the
// fenced set (§9.1), so no bot can unpause itself. It outlives restarts, and it fails closed: a file that is there
// but can't be read as the switch reads as paused (review S3). The bot service moves it (`bots.pause`).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionKind } from "@waifucave/clover-protocol";
import { Listeners, type Unsubscribe } from "../contracts/common";
import { writeJsonAtomic } from "../sessions/atomic-file";
import type { MainComputer } from "./main-computer";

/** The core's settings folder, in the fenced set (lane C's layout names it `settings`). */
export function settingsDir(home: string): string {
  return join(home, "settings");
}

export function pausedFile(home: string): string {
  return join(settingsDir(home), "bots.json");
}

/** The switch as the file says: missing, off; there but unreadable or not the switch, on. */
export function readPaused(file: string): { paused: boolean; unreadable?: true } {
  if (!existsSync(file)) return { paused: false };
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { paused?: unknown };
    if (v !== null && typeof v === "object" && typeof v.paused === "boolean") return { paused: v.paused };
  } catch {
    // Read as paused below.
  }
  return { paused: true, unreadable: true };
}

export class BotGate {
  readonly main: MainComputer;
  readonly #file: string;
  #paused: boolean;
  #handingBack = false;
  readonly #changes = new Listeners<void>();
  readonly #offMain: Unsubscribe;

  constructor(opts: { home: string; main: MainComputer; warn?: (message: string) => void }) {
    this.main = opts.main;
    this.#file = pausedFile(opts.home);
    const read = readPaused(this.#file);
    this.#paused = read.paused;
    if (read.unreadable) opts.warn?.(`${this.#file} can't be read as the pause switch; the bots stay paused until the user resumes them`);
    this.#offMain = opts.main.watch(() => this.#changes.emit());
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Moves the pause switch; false when it was already there. Written before it takes effect. */
  setPaused(paused: boolean, at: number): boolean {
    if (paused === this.#paused) return false;
    writeJsonAtomic(this.#file, { paused, at });
    this.#paused = paused;
    this.#changes.emit();
    return true;
  }

  get handingBack(): boolean {
    return this.#handingBack;
  }

  /** While this computer hands its bots back to the main: their new turns don't start here. */
  setHandingBack(on: boolean): void {
    if (on === this.#handingBack) return;
    this.#handingBack = on;
    this.#changes.emit();
  }

  /** Whether this computer runs the bots' conversations now, and may start their turns. */
  runsBots(): boolean {
    return this.main.runsHere() && !this.#handingBack;
  }

  /** The durable host's `mayStart`. */
  mayStart(view: { kind: SessionKind }): boolean {
    if (view.kind === "coding") return true;
    if (this.#paused) return false;
    return view.kind !== "bot" || this.runsBots();
  }

  /** Whether a running turn may make its next tool call or memory write. */
  mayAct(view: { kind: SessionKind }): boolean {
    if (view.kind === "coding") return true;
    if (this.#paused) return false;
    return view.kind !== "bot" || this.main.runsHere();
  }

  /** Resolves once `mayAct` says yes (at once if it does), or rejects when `signal` aborts: a held turn waits here. */
  whenMayAct(view: { kind: SessionKind }, signal?: AbortSignal): Promise<void> {
    if (this.mayAct(view)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        off();
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        done();
        reject(signal?.reason ?? new Error("aborted"));
      };
      const off = this.#changes.add(() => {
        if (!this.mayAct(view)) return;
        done();
        resolve();
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Tells `fn` whenever the answers may have changed (the switch, a hand-back, the lease). */
  watch(fn: () => void): Unsubscribe {
    return this.#changes.add(fn);
  }

  close(): void {
    this.#offMain();
  }
}
