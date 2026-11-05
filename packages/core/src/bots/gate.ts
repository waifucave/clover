// When bots may think on this computer (spec §6.4 "The main computer", §9.2 "A core switch pauses all bots and routines
// at once"). Owner: lane D.
//
// The durable host asks the gate before it starts a turn or a compaction (`DurableSessionHostOptions.mayStart`), and
// what arrives while the gate is shut is recorded and waits:
//
// | Session          | Shut while                                                                 |
// | :--------------- | :------------------------------------------------------------------------- |
// | a bot's own      | the pause switch is on; this computer isn't the runner (main-computer.ts); |
// |                  | it is handing the bots back to the main                                    |
// | a side thread    | the pause switch is on                                                      |
// | an agent, coding | never: background agents finish where they started (§6.4)                  |
//
// The pause switch outlives restarts: it is kept in `<home>/transcripts/paused.json`, with the core's other records of
// the bots, which only the core writes. The bot service moves it (`bots.pause`), interrupts what runs when it goes on,
// and starts what waits when it goes off.
import { join } from "node:path";
import type { SessionView } from "@waifucave/clover-protocol";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { transcriptsDir } from "../sessions/ids";
import type { MainComputer } from "./main-computer";

export function pausedFile(home: string): string {
  return join(transcriptsDir(home), "paused.json");
}

export class BotGate {
  readonly main: MainComputer;
  readonly #file: string;
  #paused: boolean;
  #handingBack = false;

  constructor(opts: { home: string; main: MainComputer }) {
    this.main = opts.main;
    this.#file = pausedFile(opts.home);
    const saved = readJson(this.#file) as { paused?: unknown } | undefined;
    this.#paused = saved?.paused === true;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Moves the pause switch; false when it was already there. Written before it takes effect. */
  setPaused(paused: boolean, at: number): boolean {
    if (paused === this.#paused) return false;
    writeJsonAtomic(this.#file, { paused, at });
    this.#paused = paused;
    return true;
  }

  get handingBack(): boolean {
    return this.#handingBack;
  }

  /** While this computer hands its bots back to the main: their turns don't start here. */
  setHandingBack(on: boolean): void {
    this.#handingBack = on;
  }

  /** Whether this computer runs the bots' conversations now, and may start their turns. */
  runsBots(): boolean {
    return this.main.runsHere() && !this.#handingBack;
  }

  /** The durable host's `mayStart`. */
  mayStart(view: Pick<SessionView, "kind">): boolean {
    if (view.kind === "bot") return !this.#paused && this.runsBots();
    if (view.kind === "side-thread") return !this.#paused;
    return true;
  }
}
