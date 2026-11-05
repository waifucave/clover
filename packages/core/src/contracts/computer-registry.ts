// Contract: ComputerRegistry (spec §5.4 `computers.read` and `computers.control`, §5.5 "A click counts only while …",
// §9.1 computers and levels, §9.2 cloud computers and "Sharing rules"). Owner: lane J.
//
// A computer is any device running clover-core that the user connected. The registry keeps each one's name, OS,
// display, installed ACP agents and approval level, and, for computer use, its holds, the user-working mark, whether
// an action is running, and where Clover's own windows are. Holds and the mark are the core's; plugins with
// `computers.control` take and release them through the plugin API.
//
// What it promises:
// * Names are unique, letters, digits and hyphens; a renamed computer keeps its old name as an alias (§9.1).
// * A computer's level changes only through this registry; raising it is a sealed card, which the caller (the IPC
//   layer) shows before calling `setLevel` with the card's id. Lowering needs none (§5.5, §9.1).
// * Holds (the inherited computer-use code's held apps): an app hold and a window hold of that app conflict across
//   sessions, as do two holds of one window; a session taking what it already holds gets its hold back. A hold is
//   refused `held` (naming the holder), `user_working` while the user's mark is on that app, or `computer_offline`.
//   Every session lets go at its turn end (`releaseSession`).
// * The user-working mark lifts only on the user's message or a card answer, never on a release (as computer-use
//   helper 1.22.0 does).
// * While an action runs on a computer, a click on a sealed card there doesn't count (§5.5).
import type { CloverWindow, ComputerView, HoldTarget, HoldView, Level } from "@waifucave/clover-protocol";
import type { Unsubscribe } from "./common";

export type ComputerChange =
  | { type: "computer"; computer: ComputerView }
  | { type: "removed"; name: string }
  | { type: "holds"; computer: string; holds: HoldView[] }
  | { type: "user-working"; computer: string; apps: string[] }
  | { type: "action-running"; computer: string; running: boolean };

export interface HoldRequest {
  computer: string;
  target: HoldTarget;
  /** The session acting. */
  session?: string;
  /** The plugin taking the hold for it. */
  pluginId: string;
}

export interface ComputerRegistry {
  /** This computer. */
  self(): ComputerView;
  list(): ComputerView[];
  /** By name or by an old name. */
  get(nameOrAlias: string): ComputerView | undefined;
  /** Raising takes the answered card's id; lowering doesn't. Rejects `refused` for a raise without one. */
  setLevel(name: string, level: Level, card?: string): Promise<void>;
  /** Rejects `conflict` when the name is taken, `invalid` when it isn't letters, digits and hyphens. */
  rename(name: string, newName: string): Promise<void>;

  holds(computer?: string): HoldView[];
  takeHold(req: HoldRequest): HoldView;
  releaseHold(id: string): void;
  /** At a session's turn end, it lets go of everything it holds. How many holds that was. */
  releaseSession(session: string): number;
  /** A computer-use plugin saw the user working in an app (their typing or click, never the helper's own input). */
  markUserWorking(computer: string, app: string): void;
  /** The user's message, or their answer to a card or question, lifts the mark on every app of that computer. */
  liftUserWorking(computer: string): void;
  userWorking(computer: string): string[];
  setActionRunning(computer: string, running: boolean): void;
  isActionRunning(computer: string): boolean;
  /** The app reports where Clover's windows are; a computer-use plugin must not act on them (§5.5). */
  setCloverWindows(computer: string, windows: CloverWindow[]): void;
  cloverWindows(computer: string): CloverWindow[];
  watch(fn: (change: ComputerChange) => void): Unsubscribe;
}

/** Whether two hold targets overlap: the same app, unless they are two different windows of it. */
export function holdsOverlap(a: HoldTarget, b: HoldTarget): boolean {
  if (a.app !== b.app) return false;
  if (a.kind === "window" && b.kind === "window") return a.window === b.window;
  return true;
}
