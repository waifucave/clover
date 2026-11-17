// What the activity feed (lane AF, `contracts/activity-feed.ts`) reads of bots and their coding tasks (the controller's
// ruling 6 of 2026-11-17): a bot's background coding task is a code session (kind `sessions`) that carries its bot's id,
// so a reader of code sessions sees the task and a reader of bots sees the bot at work. Owner: lane BT; general (any
// reader of the feed, any session with a bot). The agent manager already opens a bot's delegation with its `bot`
// (agents/manager.ts), so this is a reading of the session views, nothing stored.
import type { ActivitySubject, SessionView } from "@waifucave/moss-protocol";

const running = (v: Pick<SessionView, "status">) => v.status === "prompting" || v.status === "starting" || v.status === "cancelling";

/** The feed's subject for a session: a code session (a coding agent's, the user's own or a bot's task, its bot named);
 *  a bot's conversation or side thread is its bot. */
export function activitySubjectOf(view: Pick<SessionView, "id" | "kind" | "bot">): ActivitySubject | undefined {
  if (view.kind === "agent" || view.kind === "coding") return { kind: "sessions", id: view.id, ...(view.bot === undefined ? {} : { bot: view.bot }) };
  if ((view.kind === "bot" || view.kind === "side-thread") && view.bot !== undefined) return { kind: "bots", id: view.bot };
  return undefined;
}

/** Whether a bot is at work on a coding task now: one of its code sessions runs a turn. */
export function botHasCodingWork(sessions: readonly Pick<SessionView, "kind" | "bot" | "status">[], bot: string): boolean {
  return sessions.some((v) => (v.kind === "agent" || v.kind === "coding") && v.bot === bot && running(v));
}
