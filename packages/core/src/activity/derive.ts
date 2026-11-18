// The engine's reading of the sessions into the activity feed (spec revision 19, §3.6, G4). It reads the session host's own
// views and records and writes `ActivityView`s, which hold a state, a name and a tool's wire name and nothing else: what
// was said, a tool's arguments and a card's words are never read into a value that is kept.
//
// * A code session (a coding session or a background agent) is a subject of kind `sessions`; its `name` is its TITLE, which
//   can come from the conversation (the session's first message names it), so a reader of code sessions reads that much of
//   what was said. A bot is a subject of kind `bots`: all its sessions (its main conversation, its side threads) and its
//   coding tasks as one, named by the bot's own name.
// * The states: `asking` (a card or a question waits for the person), `stuck` (the session failed), `working` (a tool is
//   running; its wire name goes with it), `thinking` (a turn is running with no tool), `done` (a turn just ended, for
//   DONE_MS), `idle`. `listening` and `asleep` have no tie in the session records (the voice plugin's microphone and a
//   computer that is not connected are not session state), so the engine does not set them yet.
// * A tool's name is the runtime's own (`mcp__<namespace>__<Tool>`) or an ACP agent's `kind` (read, edit, execute…); an
//   ACP tool's `title`, which is free text, is never read.
import type { ActivityState, ActivitySubject, SessionView } from "@waifucave/moss-protocol";
import { dataKindOfSession } from "@waifucave/moss-protocol";
import type { SessionHost, SessionRecord } from "../contracts/session-host";
import type { Unsubscribe } from "../contracts/common";
import type { EngineActivityFeed } from "./feed";

/** How long a finished turn shows as `done` before the subject is `idle` again. */
export const DONE_MS = 30_000;

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

interface Tracked {
  view: SessionView;
  running: Map<string, string | undefined>;
  inTurn: boolean;
  doneAt: number | undefined;
  /** The session's last state was heard, and it left the feed: nothing more is published for it. */
  left?: boolean;
  off: Unsubscribe;
}

export interface ActivityTrackerOptions {
  host: Pick<SessionHost, "list" | "get" | "watch" | "subscribe">;
  feed: EngineActivityFeed;
  now(): number;
  /** A bot's name (its own, never anything said); undefined for a bot that isn't there. */
  botName(id: string): string | undefined;
  /** A session stopped or failed: its pictures end with it. */
  onSessionEnded?(id: string): void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

export class ActivityTracker {
  readonly #o: ActivityTrackerOptions;
  readonly #sessions = new Map<string, Tracked>();
  readonly #timers = new Map<string, unknown>();
  #off: Unsubscribe | undefined;

  constructor(o: ActivityTrackerOptions) {
    this.#o = o;
  }

  /** Reads every session now and follows the host from here. */
  start(): void {
    if (this.#off !== undefined) return;
    this.#off = this.#o.host.watch((view) => this.#see(view));
    for (const view of this.#o.host.list()) this.#see(view);
  }

  stop(): void {
    this.#off?.();
    this.#off = undefined;
    for (const t of this.#sessions.values()) t.off();
    this.#sessions.clear();
    const clear = this.#o.clearTimeout ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    for (const t of this.#timers.values()) clear(t);
    this.#timers.clear();
  }

  #see(view: SessionView): void {
    let t = this.#sessions.get(view.id);
    if (t === undefined) {
      const tracked: Tracked = { view, running: new Map(), inTurn: false, doneAt: undefined, off: () => {} };
      tracked.off = this.#o.host.subscribe(view.id, (record) => this.#record(view.id, record));
      this.#sessions.set(view.id, tracked);
      t = tracked;
    }
    const wasEnded = t.view.status === "stopped" || t.view.status === "failed";
    t.view = view;
    const ended = view.status === "stopped" || view.status === "failed";
    if (ended) {
      t.running.clear();
      t.inTurn = false;
    }
    if (ended && wasEnded) return;
    this.#publish(view);
    if (ended) {
      // A session that ended is heard once, in its last state, and then leaves the feed (a bot's own state goes on without it).
      if (dataKindOfSession(view) === "sessions") this.#o.feed.remove({ kind: "sessions", id: view.id });
      this.#o.onSessionEnded?.(view.id);
    }
  }

  #record(id: string, record: SessionRecord): void {
    const t = this.#sessions.get(id);
    if (t === undefined) return;
    if (record.type === "turn_started") {
      t.inTurn = true;
      t.doneAt = undefined;
    } else if (record.type === "turn_ended") {
      t.inTurn = false;
      t.running.clear();
      t.doneAt = this.#o.now();
      this.#doneTimer(t.view);
    } else if (record.type === "driver") {
      const e = record.event;
      const callId = typeof e["callId"] === "string" ? e["callId"] : typeof e["id"] === "string" ? e["id"] : undefined;
      if (callId === undefined) return;
      if (e.type === "tool_call") t.running.set(callId, typeof e["name"] === "string" && TOOL_NAME.test(e["name"]) ? e["name"] : undefined);
      else if (e.type === "agent_tool_call") t.running.set(callId, typeof e["kind"] === "string" && TOOL_NAME.test(e["kind"]) ? e["kind"] : undefined);
      else if (e.type === "tool_result") t.running.delete(callId);
      else if (e.type === "agent_tool_call_update" && (e["status"] === "completed" || e["status"] === "failed")) t.running.delete(callId);
    } else return;
    this.#publish(t.view);
  }

  #doneTimer(view: SessionView): void {
    const set = this.#o.setTimeout ?? ((fn: () => void, ms: number) => { const h = setTimeout(fn, ms); (h as { unref?: () => void }).unref?.(); return h; });
    const clear = this.#o.clearTimeout ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    const old = this.#timers.get(view.id);
    if (old !== undefined) clear(old);
    this.#timers.set(view.id, set(() => {
      this.#timers.delete(view.id);
      const t = this.#sessions.get(view.id);
      if (t !== undefined) {
        t.doneAt = undefined;
        this.#publish(t.view);
      }
    }, DONE_MS));
  }

  /** A session's own state and the tool it is using. */
  #stateOf(t: Tracked): { state: ActivityState; tool?: string } {
    const v = t.view;
    if ((v.needsYou?.cards ?? 0) + (v.needsYou?.questions ?? 0) > 0) return { state: "asking" };
    // A session that failed (ended), or whose last turn failed and which stays open (a coding session): stuck until a turn ends well.
    if (v.status === "failed" || (v.failure !== undefined && v.status === "idle")) return { state: "stuck" };
    if (v.status === "stopped") return { state: "done" };
    const tool = [...t.running.values()].find((n) => n !== undefined);
    if (t.running.size > 0) return { state: "working", ...(tool !== undefined ? { tool } : {}) };
    if (t.inTurn || v.status === "prompting" || v.status === "cancelling") return { state: "thinking" };
    if (t.doneAt !== undefined) return { state: "done" };
    return { state: "idle" };
  }

  #publish(view: SessionView): void {
    const t = this.#sessions.get(view.id);
    if (t === undefined) return;
    const now = this.#o.now();
    const over = view.status === "stopped" || view.status === "failed";
    if (dataKindOfSession(view) === "sessions" && (!over || !t.left)) {
      t.left = over;
      const { state, tool } = this.#stateOf(t);
      const subject: ActivitySubject = { kind: "sessions", id: view.id, ...(view.bot !== undefined ? { bot: view.bot } : {}) };
      this.#o.feed.set({ subject, state, ...(view.title !== undefined && view.title !== "" ? { name: view.title.slice(0, 200) } : {}), ...(tool !== undefined ? { tool } : {}), since: now });
    }
    // A bot's own state is every session it has (its conversation, its side threads, its coding tasks) as one.
    if (view.bot !== undefined) this.#publishBot(view.bot, now);
  }

  #publishBot(bot: string, now: number): void {
    const rank: Record<ActivityState, number> = { asking: 6, stuck: 5, working: 4, thinking: 3, done: 2, idle: 1, listening: 0, asleep: 0 };
    let best: { state: ActivityState; tool?: string } = { state: "idle" };
    for (const t of this.#sessions.values()) {
      if (t.view.bot !== bot) continue;
      const s = this.#stateOf(t);
      // A bot's stopped side thread or finished task is not the bot being done; only a turn that just ended is.
      const state = t.view.status === "stopped" ? ({ state: "idle" } as const) : s;
      if (rank[state.state] > rank[best.state]) best = state;
    }
    const name = this.#o.botName(bot);
    this.#o.feed.set({ subject: { kind: "bots", id: bot }, state: best.state, ...(name !== undefined ? { name: name.slice(0, 200) } : {}), ...(best.tool !== undefined ? { tool: best.tool } : {}), since: now });
  }
}
