// Quit (spec §3.1, revision 13): the menu bar's or tray's Quit and the app's own (⌘Q) stop both halves. On a
// computer running bots, routines or agents, Quit first says what will stop and offers Hand over and quit, which
// releases the lease at once so another computer takes the bots (§6.4); with no other computer to take them, it says
// they stay offline until this one is back. Pure: the question is data, which the main process shows as a native
// dialog and the tests read. The strings move to `clover.` keys in E-M2.
import { PairStatus } from "@waifucave/clover-protocol";

export type QuitChoice = "quit" | "handover" | "cancel";

export interface QuitQuestion {
  /** Nothing would stop: quit without asking. */
  ask: boolean;
  message: string;
  detail: string;
  /** In the order they show; the first is the default. */
  buttons: readonly { id: QuitChoice; label: string }[];
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function names(bots: readonly string[]): string {
  if (bots.length <= 3) return bots.join(", ");
  return `${bots.slice(0, 3).join(", ")} and ${bots.length - 3} more`;
}

/** What Quit asks, from `pair.status` as the daemon sent it. With no status (the daemon is down) there is nothing to
 *  ask, and a status that isn't one (lane B's `PairStatus`) falls back to a plain Quit. */
export function quitQuestion(raw: unknown): QuitQuestion {
  const parsed = raw === undefined ? undefined : PairStatus.safeParse(raw);
  const status = parsed?.success === true ? parsed.data : undefined;
  if (status === undefined || (status.bots.length === 0 && status.routines === 0 && status.agents === 0)) {
    return { ask: false, message: "", detail: "", buttons: [{ id: "quit", label: "Quit" }] };
  }
  const running: string[] = [];
  if (status.bots.length > 0) running.push(`${count(status.bots.length, "bot", "bots")} (${names(status.bots)})`);
  if (status.routines > 0) running.push(count(status.routines, "routine", "routines"));
  if (status.agents > 0) running.push(count(status.agents, "agent", "agents"));
  const list = running.length === 1 ? running[0]! : `${running.slice(0, -1).join(", ")} and ${running[running.length - 1]}`;
  const lines = [`This computer is running ${list}. Quitting stops them here.`];
  if (status.bots.length > 0) {
    lines.push(status.canHandOver
      ? "Hand over and quit lets another of your computers take the bots right away."
      : "No other computer can take the bots, so they stay offline until this one is back.");
  }
  const buttons: { id: QuitChoice; label: string }[] = [];
  if (status.bots.length > 0 && status.canHandOver) buttons.push({ id: "handover", label: "Hand over and quit" });
  buttons.push({ id: "quit", label: "Quit" }, { id: "cancel", label: "Cancel" });
  return { ask: true, message: "Quit Clover?", detail: lines.join("\n\n"), buttons };
}
