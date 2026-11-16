// Turns (spec §5.4 "Turns"): the one-at-a-time queues the platform runs, one per name, in the daemon, so both halves of
// every plugin see the same queue.
//
// * First come, first served; one holder per name. A take waits its turn; when it comes, its listener hears it.
// * The platform ends a turn when its holder says done, when its limit passes (default 60 s, at most 10 minutes from
//   the grant with extensions), and when its holder goes: the take's own watch ends (its frame is gone, its host
//   process exited, the app quit), or its plugin stops. A take still waiting leaves the queue the same ways.
// * Every grant, end and loss is one line in the daemon's log; so is a waiting take that leaves.
// * Who may take which name is the API's (`./api.ts`); this file only keeps the queues.
import { TURN_LIMIT_DEFAULT_MS, TURN_LIMIT_MAX_MS, type TurnEvent, type TurnLoss, type TurnState } from "@waifucave/moss-plugin-sdk";
import type { HostProcess } from "@waifucave/moss-protocol";
import { randomUUID } from "node:crypto";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { Clock, TimerHandle } from "../contracts/clock";

/** A plugin's takes of one name, held and waiting together, at most. */
export const TURN_TAKES_PER_NAME = 64;
/** A plugin's takes over all names, at most. */
export const TURN_TAKES_PER_PLUGIN = 256;
/** Every plugin's takes on this computer, at most. */
export const TURN_TAKES_ALL = 4_096;

/** A take's note as the log and `state` carry it: control characters (C0, DEL, C1), line and paragraph separators and
 *  bidirectional overrides out, each run of them one space, trimmed. */
export function cleanTurnNote(note: string): string {
  return note.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** Where a take came from: a component ("ui"), or a host half in a process the core started. */
export type TurnSide = HostProcess | "ui";

/** Why the platform ended a turn (or a waiting take): the log's words, and the `lost` the holder hears. */
export type TurnEnd =
  | { kind: "done" }
  | { kind: "limit" }
  | { kind: "gone" }
  | { kind: "plugin"; why: string }
  | { kind: "closed" };

interface Take {
  id: string;
  name: string;
  pluginId: string;
  side: TurnSide;
  note?: string;
  limitMs: number;
  takenAt: number;
  listener: (event: TurnEvent) => void;
  grantedAt?: number;
  until?: number;
  timer?: TimerHandle;
}

interface Queue {
  holder?: Take;
  waiting: Take[];
  watchers: Listeners<TurnState>;
}

export interface TurnQueuesOptions {
  clock: Clock;
  log?(line: string): void;
}

export class TurnQueues {
  readonly #o: TurnQueuesOptions;
  readonly #queues = new Map<string, Queue>();
  readonly #takes = new Map<string, Take>();

  constructor(o: TurnQueuesOptions) {
    this.#o = o;
  }

  /** Joins `name`'s queue; `listener` hears the take's events. The returned function is the take's watch ending: it
   *  leaves the queue, or ends a held turn as gone (its holder went), and is a no-op once the take is over. */
  take(name: string, who: { pluginId: string; side: TurnSide }, opts: { limitMs?: number; note?: string }, listener: (event: TurnEvent) => void): { id: string; leave: () => void } {
    // The caps (held and waiting takes together): far above what a real plugin queues, so only a runaway one meets them.
    const mine = [...this.#takes.values()].filter((x) => x.pluginId === who.pluginId);
    if (mine.filter((x) => x.name === name).length >= TURN_TAKES_PER_NAME) {
      throw new ContractError("refused", `${who.pluginId} already has ${TURN_TAKES_PER_NAME} takes of ${name} held or waiting; one must end before another joins`);
    }
    if (mine.length >= TURN_TAKES_PER_PLUGIN) throw new ContractError("refused", `${who.pluginId} already has ${TURN_TAKES_PER_PLUGIN} takes held or waiting; one must end before another joins`);
    if (this.#takes.size >= TURN_TAKES_ALL) throw new ContractError("refused", `${TURN_TAKES_ALL} takes are held or waiting on this computer; one must end before another joins`);
    const note = opts.note === undefined ? "" : cleanTurnNote(opts.note);
    const t: Take = {
      id: `turn_${randomUUID()}`, name, pluginId: who.pluginId, side: who.side, limitMs: opts.limitMs ?? TURN_LIMIT_DEFAULT_MS, takenAt: this.#o.clock.now(), listener,
      ...(note !== "" ? { note } : {}),
    };
    const q = this.#queue(name);
    this.#takes.set(t.id, t);
    q.waiting.push(t);
    if (q.holder === undefined) this.#grantNext(name, q);
    else {
      this.#tell(t, { type: "waiting", ahead: q.waiting.length });
      this.#changed(name, q);
    }
    return { id: t.id, leave: () => this.#end(t.id, { kind: "gone" }) };
  }

  /** The caller ends its own turn, or takes its waiting take out of the queue. An id already over is a no-op; another
   *  plugin's is `not_found`. */
  done(id: string, pluginId: string): void {
    const t = this.#takes.get(id);
    if (t === undefined) return;
    if (t.pluginId !== pluginId) throw new ContractError("not_found", `no turn ${id} of ${pluginId}'s`);
    this.#end(id, { kind: "done" });
  }

  /** Moves a held turn's `until` on by `ms`, never past TURN_LIMIT_MAX_MS from its grant. The new `until`. */
  extend(id: string, pluginId: string, ms: number): number {
    const t = this.#takes.get(id);
    if (t === undefined || t.pluginId !== pluginId) throw new ContractError("not_found", `no turn ${id} of ${pluginId}'s`);
    if (t.grantedAt === undefined || t.until === undefined) throw new ContractError("refused", `${t.name}: the take is still waiting; only a held turn extends`);
    const until = Math.min(t.until + ms, t.grantedAt + TURN_LIMIT_MAX_MS);
    if (until !== t.until) {
      t.until = until;
      this.#arm(t);
      this.#tell(t, { type: "extended", until });
      this.#changed(t.name, this.#queue(t.name));
    }
    return until;
  }

  state(name: string): TurnState {
    const q = this.#queues.get(name);
    const h = q?.holder;
    return {
      name,
      ...(h !== undefined ? { holder: { plugin: h.pluginId, ...(h.note !== undefined ? { note: h.note } : {}), since: h.grantedAt!, until: h.until! } } : {}),
      waiting: q?.waiting.length ?? 0,
    };
  }

  /** Hears each change of `name`'s queue, from now on. */
  watch(name: string, listener: (state: TurnState) => void): Unsubscribe {
    const q = this.#queue(name);
    const off = q.watchers.add(listener);
    return () => {
      off();
      this.#tidy(name);
    };
  }

  /** A plugin stopped (turned off, removed, crashed, stopped): its turns end and its waiting takes leave, from every
   *  side, or only from `side`'s (its host process's, when only that went). */
  endPlugin(pluginId: string, why: string, side?: (s: TurnSide) => boolean): void {
    for (const t of [...this.#takes.values()]) if (t.pluginId === pluginId && (side === undefined || side(t.side))) this.#end(t.id, { kind: "plugin", why });
  }

  /** The daemon closes: every turn ends, every waiting take leaves. */
  close(): void {
    for (const t of [...this.#takes.values()]) this.#end(t.id, { kind: "closed" });
  }

  /** Takes held or waiting, for tests and status. */
  get size(): number {
    return this.#takes.size;
  }

  #queue(name: string): Queue {
    let q = this.#queues.get(name);
    if (q === undefined) this.#queues.set(name, (q = { waiting: [], watchers: new Listeners<TurnState>() }));
    return q;
  }

  #grantNext(name: string, q: Queue): void {
    const t = q.waiting.shift();
    if (t === undefined) {
      this.#changed(name, q);
      return;
    }
    const now = this.#o.clock.now();
    t.grantedAt = now;
    t.until = now + Math.min(t.limitMs, TURN_LIMIT_MAX_MS);
    q.holder = t;
    this.#arm(t);
    this.#o.log?.(`turns: ${name} granted to ${t.pluginId} (${sideText(t.side)}${t.note !== undefined ? `, "${t.note}"` : ""}) after ${now - t.takenAt} ms waiting; its limit ${seconds(t.until - now)}`);
    this.#tell(t, { type: "granted", id: t.id, until: t.until });
    q.waiting.forEach((w, i) => this.#tell(w, { type: "waiting", ahead: i + 1 }));
    this.#changed(name, q);
  }

  /** The holder's limit, from its `until`. */
  #arm(t: Take): void {
    if (t.timer !== undefined) this.#o.clock.clearTimeout(t.timer);
    t.timer = this.#o.clock.setTimeout(() => {
      t.timer = undefined;
      this.#end(t.id, { kind: "limit" });
    }, Math.max(0, t.until! - this.#o.clock.now()));
  }

  #end(id: string, end: TurnEnd): void {
    const t = this.#takes.get(id);
    if (t === undefined) return;
    this.#takes.delete(id);
    if (t.timer !== undefined) this.#o.clock.clearTimeout(t.timer);
    const q = this.#queue(t.name);
    const loss: TurnLoss | undefined = end.kind === "done" ? undefined : end.kind === "limit" ? "limit" : "stopped";
    if (q.holder === t) {
      q.holder = undefined;
      const held = this.#o.clock.now() - t.grantedAt!;
      this.#o.log?.(end.kind === "done"
        ? `turns: ${t.name} ended by ${t.pluginId} (done) after ${held} ms`
        : `turns: ${t.name} taken from ${t.pluginId} (${endText(end, t)}) after ${held} ms`);
      this.#tell(t, { type: "ended", reason: loss ?? "done" });
      this.#grantNext(t.name, q);
      this.#tidy(t.name);
      return;
    }
    const at = q.waiting.indexOf(t);
    if (at >= 0) q.waiting.splice(at, 1);
    this.#o.log?.(`turns: ${t.pluginId}'s take of ${t.name} left the queue (${end.kind === "done" ? "done before its turn" : endText(end, t)})`);
    this.#tell(t, { type: "ended", reason: loss ?? "done" });
    q.waiting.forEach((w, i) => i >= at && this.#tell(w, { type: "waiting", ahead: i + (q.holder !== undefined ? 1 : 0) }));
    this.#changed(t.name, q);
    this.#tidy(t.name);
  }

  #tell(t: Take, event: TurnEvent): void {
    try {
      t.listener(event);
    } catch {
      // the taker's listener is its own
    }
  }

  #changed(name: string, q: Queue): void {
    if (q.watchers.size === 0) return;
    q.watchers.emit(this.state(name));
  }

  /** A queue with no holder, no waiting take and no watcher is forgotten. */
  #tidy(name: string): void {
    const q = this.#queues.get(name);
    if (q !== undefined && q.holder === undefined && q.waiting.length === 0 && q.watchers.size === 0) this.#queues.delete(name);
  }
}

const sideText = (s: TurnSide): string => (s === "ui" ? "a component" : `its host half, process ${s}`);
const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

function endText(end: TurnEnd, t: Take): string {
  switch (end.kind) {
    case "limit":
      return `its limit of ${seconds(t.until! - t.grantedAt!)} passed`;
    case "gone":
      return t.side === "ui" ? "its taker went: its frame is gone, or the app quit" : "its taker went: its host process exited";
    case "plugin":
      return end.why;
    case "closed":
      return "MOSS's plugins closed";
    case "done":
      return "done";
  }
}
