// DurableSessionHost: the core's `SessionHost` (contracts/session-host.ts), with every session's log on disk so a
// bot's one conversation survives restarts (spec §6.3, §6.4, §7, §8.5). Owner: lane D, with lane A, whose embedded
// runtime is the driver that runs bots' and side threads' turns (lane K's ACP client runs agents').
//
// It keeps the contract's routing rules exactly as the fake does (an interrupt from the user, folds, queues, task
// notifications, cards withdrawn or cancelled, `bot_asleep`, send order), and adds what a real host needs:
//
// * **The log is the truth.** Each session is two files under `<home>/transcripts/<bot>/` (ids.ts): its meta (who it
//   is) and its event log (event-log.ts). On start the host reads every meta and replays the log of every session that
//   hasn't ended, rebuilding its status, its queue of inputs still waiting for a turn, its pending notes, its open
//   questions and the client ids it has seen; an ended session's log is read only when asked for (a year of routine
//   runs is tens of thousands of side threads). A session it restores is dormant: it has no driver until `open` is
//   called again with the same id, which reattaches it and starts what waits. A meta written by a newer Clover stops
//   the start rather than be skipped; a log whose meta was lost is picked up again by `open`, never written over.
// * **A record is written before the state it changes.** If the disk refuses a record, the session is as it was: an
//   input that couldn't be recorded is an error to its sender, and a turn that couldn't be recorded as started stays
//   queued and is tried again shortly. An input too large for the log is refused to its sender; any other record
//   too large has its long fields cut (`shrinkRecord`).
// * **A restart interrupts.** A turn that was running when the daemon stopped is recorded `interrupted` (§3.1 "A
//   daemon restart … records running calls as interrupted"); what was queued behind it runs once the session's driver
//   is back.
// * **A bot's conversation never fails.** The contract ends a session whose turn fails, which is right for an agent's
//   backend; a bot's one conversation (§6.3) records the failed turn, with why, and goes on to the next input.
// * **Notes reach the model.** A note never starts a turn (§5.4 `conversation.post`), but the bot should still see it:
//   one that arrives while a turn runs folds into that turn after its next tool call, and one that arrives while the
//   session is idle waits and is folded into the next turn as it starts, before the driver's first model call.
// * **A routine's result posts** (§7 "posts a short result into the bot's main conversation"). Delivered to a bot's
//   main conversation, it folds into a running turn like any message, but when the bot is idle it waits like a note
//   instead of starting a turn, so a routine every 15 minutes doesn't run the main conversation every 15 minutes
//   (§6.4 "Background work never runs in the main conversation"). In a side thread, the routine's input starts the run.
// * **A resend is not a second message.** The user's `clientMessageId` is remembered (`session.send`).
// * **Needs-you counts.** Each view carries its pending cards (from the approval broker) and its unanswered
//   `AskUserQuestion`s (from the driver's `question_asked` and `question_resolved` events).
// * **Folds wait for the driver.** What folds into a turn (and the notes waiting for it) is held until the driver first
//   subscribes with `onFold`, so a driver that builds its prompt before subscribing misses nothing; what it never took
//   by the turn's end waits for the next turn.
// * **A hung driver can't hold anyone up.** Each call into a driver to interrupt or stop it has `INTERRUPT_GRACE_MS`;
//   past that the host goes on without it. After the user's interrupt, a driver that says it stopped but never ends
//   its turn has the turn ended for it after the same grace.
// * **Streaming never reaches the log.** A runtime event of one of the inherited transient types (`assistant_delta`,
//   `thinking_delta` …, `TRANSIENT_EVENT_TYPES`) is handed to `onTransient` listeners and never recorded, as today.
// * **A gate decides when turns start** (`mayStart`): the bot service closes it for a bot's conversation while this
//   computer doesn't run its bots (§6.4, the lease) and for bots and side threads while the pause switch is on (§9.2).
//   What arrives meanwhile is recorded and waits; `resume` starts it once the gate opens.
// * **Compaction** (§6.3): `compact` asks a driver that can (`CompactingDriver`) to compact while the session is idle.
//   A cache-timed one (`cache`, compaction.ts decides when) is dropped by the user's message or interrupt and tried
//   again later, since the cache is still warm; a forced one (`full`, or the user's `session.compact`) finishes first,
//   and what arrives meanwhile waits. A compaction the runtime forces inside a turn when the context fills (its
//   `compaction` events, `full`) finishes first too: the user's message waits for its end before it interrupts.
// * **Calls that never ended are recorded so.** Each turn's start names the computer running it (`on`). A restart
//   records each tool call of a turn this computer was running with an interrupted result, and ends the turn. A turn
//   another computer started and never ended (a log synced from the computer that ran the bot before) is left as it is
//   until this computer may start that session's turns itself (a takeover): then each such call gets a result saying it
//   may have run on that computer, and the turn ends (`catchUp`, §6.4 "Fencing the old main"). Neither runs a call
//   again.
// * **Every session's caller names its bot** (`callerOf`): a side thread and a background agent carry their bot,
//   from their own meta or their parent's.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  clampSentAt, pluginIdToSegment, SessionView as SessionViewSchema, TRANSIENT_EVENT_TYPES,
  type Caller, type SessionFailure, type SessionKind, type SessionStatus, type SessionView, type TurnOrigin,
} from "@waifucave/clover-protocol";
import type { ApprovalBroker } from "../contracts/approval-broker";
import { compareStamps, type Clock } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import {
  originOf,
  type AgentStopReason, type DeliveredInput, type Disposition, type SessionDriver, type SessionHost, type SessionRecord,
  type SessionRecordBody, type SessionSpec, type TurnControl, type TurnEnd, type TurnInput, type UserInput,
} from "../contracts/session-host";
import { readJson, writeJsonAtomic } from "./atomic-file";
import { MAX_RECORD_BYTES, RecordTooLargeError, SessionLogFile, shrinkRecord } from "./event-log";
import { mainSessionIdFor, mintSessionId, SESSION_ID_PREFIX, sessionLogPath, sessionMetaPath, transcriptsDir } from "./ids";

/** After the user's interrupt, how long a driver that said it stopped has to end its turn before the host ends it. */
export const INTERRUPT_GRACE_MS = 5_000;
/** How many of the user's client message ids a session remembers, newest kept: a resend comes within minutes. */
export const CLIENT_IDS_KEPT = 1_000;
/** After the disk refused a turn's start, when it is tried again. */
export const PUMP_RETRY_MS = 5_000;
/** How long the user's message waits for a compaction the runtime started inside a turn before it interrupts anyway:
 *  a runtime that said "started" and never "ended" can't hold the user back. */
export const COMPACTION_HOLD_MAX_MS = 120_000;
/** The meta format this host writes; a newer one stops the start. */
export const SESSION_META_VERSION = 1;
/** How far back from a log's end `catchUp` looks for the turn the computer before it never ended. */
export const CATCH_UP_SCAN_MAX = 20_000;

/** Why a session compacts (§6.3): `cache`, just before the cached prompt expires (compaction.ts); `full`, because the
 *  context window is full; `user`, the user's `session.compact`. */
export type CompactReason = "cache" | "full" | "user";
/** What a compaction came to. `dropped`: a cache-timed one the user's message or interrupt stopped; `skipped`: one not
 *  run, since a turn ran or something waited; `unsupported`: the driver can't compact (an ACP agent compacts itself). */
export type CompactOutcome = "compacted" | "dropped" | "failed" | "skipped" | "unsupported";

/** A driver that compacts its conversation on the host's word (lane A's embedded runtime). It summarizes the
 *  conversation so far, rebuilds the system prompt's harness blocks (§6.1: the MCP block and the bot's instructions
 *  change only at a compaction), and stops early when `signal` aborts, answering `compacted: false`. While a turn runs it
 *  may compact on its own when the context fills; it says so with `compaction` events (`{ type: "compaction", phase:
 *  "started" | "ended", reason: "full" }`) through `TurnControl.record`. */
export interface CompactingDriver extends SessionDriver {
  compact(req: { reason: CompactReason; signal: AbortSignal }): Promise<{ compacted: boolean }>;
}

export function canCompact(driver: SessionDriver): driver is CompactingDriver {
  return typeof (driver as Partial<CompactingDriver>).compact === "function";
}

/** What `deliver` takes: every input but the user's. */
export const DELIVERED_FROM: ReadonlySet<string> = new Set(["bot", "agent", "task-notification", "task", "routine", "plugin", "note"]);

/** Records only the core writes (`recordCore`): a driver's event of one of these types is dropped, so a runtime or
 *  an agent can't grant its own session anything (grants.ts). */
export const CORE_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(["session_grant", "session_grant_copied"]);

/** What a copied `session_grant` becomes in this computer's log (review N7, H-M3): a record of another computer's grant,
 *  which grants nothing here (`SessionGrants` reads only `session_grant`) and, core-only, is never sent to clients. */
export const COPIED_GRANT_EVENT_TYPE = "session_grant_copied";

/** The result a tool call gets when a restart or a takeover finds it with none (§3.1, §6.4). */
export function interruptedCallOutput(ranOn?: string): string {
  return ranOn === undefined
    ? "Interrupted: Clover stopped while this call ran. It was not run again; check its effects before you retry it."
    : `Interrupted: this call may have run on ${ranOn}, which stopped answering while it ran. It was not run again here; its real outcome is posted once ${ranOn} is reachable.`;
}

/** Who a session is, kept beside its log. */
/** A run of this computer's records set aside when its copy of a session forked from the computer running it (the
 *  controller's ruling: the main's log wins, nothing is deleted, and the set-aside records go to the main marked late). */
export interface EarlierLog {
  /** `e<at>` (with a suffix when two land in one millisecond); its file is `<log stem>.earlier-<id>.json` beside the log. */
  id: string;
  at: number;
  /** Where the fork began: the records were `fromSeq` up to `fromSeq + records` in this computer's log. */
  fromSeq: number;
  records: number;
  /** The device whose records replaced them. */
  from: string;
  /** When the computer running the session took them (`ackEarlier`). */
  delivered?: number;
}

export interface SessionMeta {
  meta: 1;
  id: string;
  kind: SessionKind;
  bot?: string;
  parent?: string;
  computer: string;
  title?: string;
  backend?: string;
  model?: string;
  effort?: string;
  root?: string;
  routine?: string;
  startedAt: number;
  /** This computer's records set aside when its copy forked from the computer running the session (`setAside`). */
  earlier?: EarlierLog[];
  /** Set when the session ends, so a start needn't read its log. */
  ended?: { status: "stopped" | "failed"; at: number; failure?: SessionFailure };
}

/** The fields `update` and a reattaching `open` may change; who the session is (kind, bot, parent) never changes.
 *  `undefined` leaves a field as it is, and `null` clears it (the session's `computer` can't be cleared). */
export type SessionSpecPatch = { computer?: string } & {
  [K in "title" | "backend" | "model" | "effort" | "root" | "routine"]?: string | null;
};

export interface DurableSessionHostOptions {
  /** The Clover home: `~/.clover`, `~/.clover-dev`, or a test's temp home. */
  home: string;
  clock: Clock;
  /** Withdraws and cancels a session's cards; with `pending` and `watch`, also counts them for the needs-you marks. */
  approvals?: Pick<ApprovalBroker, "withdrawSession" | "cancelSession"> & Partial<Pick<ApprovalBroker, "pending" | "watch">>;
  /** The lease epoch every record carries once lane H's lease exists (§6.4). */
  epoch?: () => number | undefined;
  /** Whether a session may start a turn or a compaction now; inputs wait while it says no, until `resume` (the lease
   *  and the pause switch, through the bot service). Open when left out. */
  mayStart?: (view: SessionView) => boolean;
  /** This computer's name: each turn's start names it, so a turn another computer left open is told from one a
   *  restart here cut off. */
  computer?: string;
  /** Whether this computer runs a bot's main conversation now (the lease). An input for one it doesn't run never lands
   *  in the local copy: `deliver` hands it to `forward` (the computer running it), and `sendUser` refuses it
   *  (review S1). Every session is run here when left out. */
  runsHere?: (view: SessionView) => boolean;
  /** Delivers to the computer running a bot's main conversation (lane H's link, `peer.session.deliver`); without it,
   *  such an input is refused `bot_asleep`. */
  forward?: (view: SessionView, input: DeliveredInput) => Promise<{ disposition: Disposition; seq: number }>;
  warn?: (message: string) => void;
}

/** An input waiting for a turn, or to be folded into one, with the seq of the record that brought it. */
interface QueueItem {
  seq: number;
  input: TurnInput;
}

/** What folds into a running turn, held until the driver first subscribes. */
class FoldChannel {
  readonly #listeners = new Listeners<TurnInput>();
  #held: QueueItem[] | undefined = [];

  subscribe(fn: (input: TurnInput) => void): Unsubscribe {
    const off = this.#listeners.add(fn);
    const held = this.#held;
    if (held !== undefined) {
      this.#held = undefined;
      for (const item of held) fn(structuredClone(item.input));
    }
    return off;
  }

  emit(item: QueueItem): void {
    if (this.#held !== undefined) this.#held.push(structuredClone(item));
    else this.#listeners.emit(structuredClone(item.input));
  }

  /** What no subscriber ever took. */
  unclaimed(): QueueItem[] {
    return this.#held ?? [];
  }
}

interface Running {
  origin: TurnOrigin;
  abort: AbortController;
  folds: FoldChannel;
}

interface Hosted {
  meta: SessionMeta;
  view: SessionView;
  /** Undefined for an ended session restored without reading its log: `#logOf` reads it when asked. */
  log: SessionLogFile | undefined;
  driver?: SessionDriver;
  subscribers: Listeners<SessionRecord>;
  transient: Listeners<{ type: string; [key: string]: unknown }>;
  /** Inputs waiting for a turn of their own, in the order they will run. */
  queue: QueueItem[];
  /** Notes and posted routine results that arrived while no turn ran: folded into the next turn as it starts. */
  pending: QueueItem[];
  running?: Running;
  /** `stop` has begun: nothing starts, and the turn it ends is recorded without anything else following. */
  stopping: boolean;
  /** `release` is detaching the driver: nothing starts. */
  releasing: boolean;
  asleep: boolean;
  clientIds: Map<string, { seq: number; disposition: Disposition }>;
  questions: Set<string>;
  cards: number;
  /** A turn's start the disk refused, to be tried again. */
  retry?: ReturnType<Clock["setTimeout"]>;
  /** A compaction `compact` started while the session was idle. */
  compacting?: { reason: CompactReason; abort: AbortController; done: Promise<CompactOutcome> };
  /** Compactions asked for while a turn ran (`full`, `user`): they run when it ends, before what waits. */
  deferredCompact: { reason: CompactReason; resolve: (outcome: CompactOutcome) => void }[];
  /** The runtime is compacting inside the running turn because the context filled (its `compaction` events). */
  turnCompaction: boolean;
  /** The user's message arrived during that compaction: the step is interrupted when it ends. */
  interruptAfterCompaction: boolean;
  /** A turn another computer started and the log never ended: caught up before this computer starts one. */
  foreignTurn?: { on: string };
  /** Which other computers' late records (and runs' notes) `appendLate` has appended, by where they first came from
   *  (read from the log once). */
  late?: { seen: Set<string> };
}

/** Where a late record first came from (`appendLate`): the device and computer, its place and time there; a note
 *  that opens a run of them names the run instead (`note`, its place -1). */
interface LateFrom {
  device: string;
  computer: string;
  seq: number;
  ts: number;
  epoch?: number;
  note?: string;
}

type LateRecord = SessionRecord & { late: true; copiedFrom?: string; lateFrom: LateFrom };

const lateKey = (from: LateFrom) => (from.note !== undefined ? `${from.device}\u0000note\u0000${from.note}` : `${from.device}\u0000${from.seq}`);

/** How many records a full read of a log takes at a time. */
const RESTATE_PAGE = 1_000;

const isEnded = (status: SessionStatus) => status === "stopped" || status === "failed";

/** Puts an input in line. The user's waiting messages keep send order on the shared clock, ties by device (§6.4,
 *  `compareStamps`), whatever order they arrived in; one that interrupted goes ahead of everything else waiting. */
function enqueue(queue: QueueItem[], item: QueueItem, aheadOfOthers: boolean): void {
  const input = item.input;
  if (input.from !== "user") {
    queue.push(item);
    return;
  }
  const stamp = { t: input.sentAt, device: input.device };
  const at = queue.findIndex((q) => (q.input.from === "user" ? compareStamps(stamp, { t: q.input.sentAt, device: q.input.device }) < 0 : aheadOfOthers));
  queue.splice(at < 0 ? queue.length : at, 0, item);
}

/** The `turn_started` record names the input it started by its seq, so a replay takes that one out of line, even when
 *  a record before it was lost. (Lane D's addition to the contract's record; a request to lane B.) */
type TurnStartedBody = Extract<SessionRecordBody, { type: "turn_started" }> & { inputSeq: number; on?: string };

function rememberClientId(map: Hosted["clientIds"], id: string, entry: { seq: number; disposition: Disposition }): void {
  map.delete(id);
  map.set(id, entry);
  while (map.size > CLIENT_IDS_KEPT) map.delete(map.keys().next().value as string);
}

/** Tracks the open `AskUserQuestion`s a driver's events show; true when the set changed. */
function trackQuestion(questions: Set<string>, event: { type: string; [key: string]: unknown }): boolean {
  const callId = typeof event.callId === "string" ? event.callId : undefined;
  if (callId === undefined) return false;
  if (event.type === "question_asked") {
    if (questions.has(callId)) return false;
    questions.add(callId);
    return true;
  }
  if (event.type === "question_resolved") return questions.delete(callId);
  return false;
}

/** What replaying a log rebuilds. */
class Replay {
  running = false;
  /** The computer running the running turn, as its start says. */
  runningOn: string | undefined;
  /** The running turn's tool calls with no result yet. */
  readonly openCalls = new Map<string, string>();
  queue: QueueItem[] = [];
  pending: QueueItem[] = [];
  status: SessionStatus = "ready";
  failure: SessionFailure | undefined;
  updatedAt: number | undefined;
  readonly clientIds: Hosted["clientIds"] = new Map();
  readonly questions = new Set<string>();

  apply(r: SessionRecord): void {
    // A late record (another lease's, or another computer's set aside) is history only: it never moves the status,
    // the line of inputs or a turn.
    if ((r as { late?: unknown }).late === true) return;
    switch (r.type) {
      case "input":
        if (r.input.from === "user") rememberClientId(this.clientIds, r.input.clientMessageId, { seq: r.seq, disposition: r.disposition });
        switch (r.disposition) {
          case "turn":
          case "queued":
            enqueue(this.queue, { seq: r.seq, input: r.input }, false);
            break;
          case "interrupted":
            enqueue(this.queue, { seq: r.seq, input: r.input }, true);
            break;
          case "note":
            // While a turn ran, a note folded into it (or, for a driver that can't fold, was only recorded).
            if (!this.running) this.pending.push({ seq: r.seq, input: r.input });
            break;
          case "folded":
            break;
        }
        break;
      case "turn_started": {
        // By the seq it names: an input whose record was lost is no longer in line, and nothing else is taken for it.
        const inputSeq = (r as Partial<TurnStartedBody>).inputSeq;
        if (typeof inputSeq !== "number") this.queue.shift();
        else {
          const at = this.queue.findIndex((q) => q.seq === inputSeq);
          if (at >= 0) this.queue.splice(at, 1);
        }
        this.pending = [];
        this.running = true;
        this.runningOn = typeof (r as Partial<TurnStartedBody>).on === "string" ? (r as Partial<TurnStartedBody>).on : undefined;
        this.openCalls.clear();
        break;
      }
      case "turn_ended":
        this.running = false;
        this.openCalls.clear();
        break;
      case "status":
        this.status = r.status;
        if (r.failure !== undefined) this.failure = r.failure;
        this.updatedAt = r.ts;
        if (isEnded(r.status)) {
          this.queue = [];
          this.pending = [];
        }
        break;
      case "driver":
        trackQuestion(this.questions, r.event);
        if (this.running) trackCall(this.openCalls, r.event);
        break;
    }
  }
}

/** Keeps a turn's tool calls that have no result yet (the runtime's `tool_call` and `tool_result` events). */
function trackCall(open: Map<string, string>, event: { type: string; [key: string]: unknown }): void {
  const callId = event["callId"];
  if (typeof callId !== "string" || callId === "") return;
  if (event.type === "tool_call") open.set(callId, typeof event["name"] === "string" ? event["name"] : "");
  else if (event.type === "tool_result") open.delete(callId);
}

/** A record as this computer keeps a copy of it: a grant renamed so it grants nothing here, marked late if so. */
function copied(r: SessionRecord, late: boolean, from: string): SessionRecord {
  let copy = structuredClone(r) as SessionRecord & { late?: true; copiedFrom?: string };
  if (copy.type === "driver" && copy.event.type === "session_grant") copy = { ...copy, event: { ...copy.event, type: COPIED_GRANT_EVENT_TYPE } };
  if (late) copy.late = true;
  // The record's first copy names where it came from; a copy of a copy keeps that (the usage counter skips both).
  copy.copiedFrom ??= from;
  return copy;
}

/** Whether a record is a copy from another computer (`ingest`, `appendLate`): its usage is counted where it ran. */
export function isCopiedRecord(r: SessionRecord): boolean {
  return typeof (r as { copiedFrom?: unknown }).copiedFrom === "string";
}

/** Whether a held record is the one copied again: alike but for the late mark and the copy's source (a resend can
 *  carry another of either). */
function sameRecord(held: SessionRecord, incoming: SessionRecord): boolean {
  const { late: _a, copiedFrom: _c, ...a } = held as SessionRecord & { late?: true; copiedFrom?: string };
  const { late: _b, copiedFrom: _d, ...b } = incoming as SessionRecord & { late?: true; copiedFrom?: string };
  return Bun.deepEquals(a, b);
}

function readMeta(path: string): SessionMeta | undefined {
  const v = readJson(path) as Partial<SessionMeta> | undefined;
  if (v !== undefined && typeof v.meta === "number" && v.meta > SESSION_META_VERSION) {
    throw new ContractError("conflict", `${path} was written by a newer Clover (meta ${v.meta}); start that version, since this one would lose what it can't read`);
  }
  if (v === undefined || v.meta !== SESSION_META_VERSION || typeof v.id !== "string" || typeof v.kind !== "string" || typeof v.computer !== "string" || typeof v.startedAt !== "number") return undefined;
  return v as SessionMeta;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class DurableSessionHost implements SessionHost {
  readonly #home: string;
  readonly #clock: Clock;
  readonly #approvals: DurableSessionHostOptions["approvals"];
  readonly #epoch: (() => number | undefined) | undefined;
  readonly #mayStart: ((view: SessionView) => boolean) | undefined;
  readonly #computer: string | undefined;
  readonly #runsHere: ((view: SessionView) => boolean) | undefined;
  readonly #forward: DurableSessionHostOptions["forward"];
  readonly #warn: (message: string) => void;
  readonly #sessions = new Map<string, Hosted>();
  readonly #watchers = new Listeners<SessionView>();
  readonly #taps = new Listeners<{ record: SessionRecord; view: SessionView }>();
  readonly #offApprovals: Unsubscribe | undefined;

  constructor(opts: DurableSessionHostOptions) {
    this.#home = opts.home;
    this.#clock = opts.clock;
    this.#approvals = opts.approvals;
    this.#epoch = opts.epoch;
    this.#mayStart = opts.mayStart;
    this.#computer = opts.computer;
    this.#runsHere = opts.runsHere;
    this.#forward = opts.forward;
    this.#warn = opts.warn ?? (() => {});
    this.#restore();
    this.#offApprovals = opts.approvals?.watch?.(() => this.#recountCards());
    this.#recountCards();
  }

  // -----------------------------------------------------------------------------------------------
  // The contract
  // -----------------------------------------------------------------------------------------------

  /** Opens a new session, or reattaches a restored one (the same id, kind, bot and parent) with this driver. */
  open(spec: SessionSpec, driver: SessionDriver): SessionView {
    const id = spec.id ?? mintSessionId(spec.kind);
    let existing = this.#sessions.get(id);
    if (!existing && existsSync(sessionLogPath(this.#home, spec.bot, id))) {
      // A log whose meta was lost or unreadable: it is this session's, so it is picked up, never written over.
      this.#warn(`session ${id}: its log had no readable meta; it is picked up again with a new one`);
      const meta: SessionMeta = { meta: SESSION_META_VERSION, id, kind: spec.kind, startedAt: this.#clock.now(), ...specPatchOf(spec) };
      if (spec.bot !== undefined) meta.bot = spec.bot;
      if (spec.parent !== undefined) meta.parent = spec.parent;
      writeJsonAtomic(sessionMetaPath(this.#home, meta.bot, id), meta);
      this.#load(meta);
      existing = this.#sessions.get(id);
    }
    if (existing) {
      if (existing.driver) throw new ContractError("conflict", `session ${id} is already open`);
      if (isEnded(existing.view.status)) throw new ContractError("conflict", `session ${id} has ended`);
      if (existing.meta.kind !== spec.kind || existing.meta.bot !== spec.bot || existing.meta.parent !== spec.parent) {
        throw new ContractError("conflict", `session ${id} is another ${existing.meta.kind} session`);
      }
      existing.driver = driver;
      if (!driver.canFold) existing.pending = [];
      this.#patchMeta(existing, specPatchOf(spec));
      this.#emitView(existing);
      this.#pump(existing);
      return this.#viewOf(existing);
    }
    const now = this.#clock.now();
    const meta: SessionMeta = { meta: SESSION_META_VERSION, id, kind: spec.kind, startedAt: now, ...specPatchOf(spec) };
    if (spec.bot !== undefined) meta.bot = spec.bot;
    if (spec.parent !== undefined) meta.parent = spec.parent;
    writeJsonAtomic(sessionMetaPath(this.#home, meta.bot, id), meta);
    const log = new SessionLogFile(sessionLogPath(this.#home, meta.bot, id), id, this.#warn);
    log.load();
    const s = this.#hosted(meta, log);
    s.driver = driver;
    this.#sessions.set(id, s);
    this.#record(s, { type: "status", status: "ready" });
    this.#emitView(s);
    return this.#viewOf(s);
  }

  list(filter: { bot?: string; kind?: SessionKind; parent?: string } = {}): SessionView[] {
    return [...this.#sessions.values()]
      .filter((s) => (filter.bot === undefined || s.meta.bot === filter.bot) && (filter.kind === undefined || s.meta.kind === filter.kind) && (filter.parent === undefined || s.meta.parent === filter.parent))
      .map((s) => this.#viewOf(s));
  }

  get(id: string): SessionView | undefined {
    const s = this.#sessions.get(id);
    return s ? this.#viewOf(s) : undefined;
  }

  /** The user's message. Also returns the record's `seq` (`session.send`'s result); a resend with a `clientMessageId`
   *  already seen returns the first one's disposition and seq, and records nothing. */
  async sendUser(id: string, input: Omit<UserInput, "from">): Promise<{ disposition: Disposition; seq: number }> {
    const s = this.#live(id);
    if (s.asleep) throw new ContractError("bot_asleep", "can't reach the computer running this bot; the draft is kept");
    if (s.meta.kind === "side-thread") throw new ContractError("refused", "a side thread takes no messages from the user");
    const seen = s.clientIds.get(input.clientMessageId);
    if (seen) return { ...seen };
    if (!this.#runHere(s)) throw new ContractError("not_main", `this computer doesn't run ${s.meta.bot ?? id}'s conversation now; the message goes to the computer that does`);
    // The stamp is held to this computer's clock plus or minus the window before it orders or records anything, so a
    // skewed or hostile one can't jump the queue or backdate the transcript (review N5).
    const full: UserInput = { from: "user", ...structuredClone(input), sentAt: clampSentAt(input.sentAt, this.#clock.now()) };
    if (s.running && s.meta.kind === "bot") {
      const record = this.#record(s, { type: "input", input: full, disposition: "interrupted" });
      rememberClientId(s.clientIds, full.clientMessageId, { seq: record.seq, disposition: "interrupted" });
      enqueue(s.queue, { seq: record.seq, input: full }, true);
      // A compaction the context forced finishes first (§6.3); the step is interrupted as it ends, or after
      // `COMPACTION_HOLD_MAX_MS` at most.
      if (s.turnCompaction) {
        if (!s.interruptAfterCompaction) {
          s.interruptAfterCompaction = true;
          const running = s.running;
          this.#clock.setTimeout(() => {
            if (s.running !== running || !s.interruptAfterCompaction) return;
            this.#warn(`session ${s.meta.id}: its driver's compaction didn't end within ${COMPACTION_HOLD_MAX_MS} ms; the user's message interrupts it`);
            s.interruptAfterCompaction = false;
            s.turnCompaction = false;
            void this.#interruptStep(s);
          }, COMPACTION_HOLD_MAX_MS);
        }
      } else await this.#interruptStep(s);
      this.#pump(s);
      return { disposition: "interrupted", seq: record.seq };
    }
    // The user's message drops a cache-timed compaction, which is tried again later (§6.3).
    if (s.compacting?.reason === "cache") s.compacting.abort.abort("the user's message");
    return this.#accept(s, full);
  }

  /** Another bot's, an agent's, a routine's or a plugin's message, a task notification, or a note. Also returns the
   *  record's `seq`. */
  async deliver(id: string, input: DeliveredInput): Promise<{ disposition: Disposition; seq: number }> {
    const s = this.#live(id);
    // Never the user's: their messages come only through `sendUser` (review S2).
    if (!DELIVERED_FROM.has((input as { from?: unknown }).from as string)) {
      throw new ContractError("invalid", `deliver takes another session's, a routine's or a plugin's input, not "${String((input as { from?: unknown }).from).slice(0, 40)}"`);
    }
    if (!this.#runHere(s)) {
      if (!this.#forward) throw new ContractError("bot_asleep", `can't reach the computer running ${s.meta.bot ?? id}'s conversation`);
      return this.#forward(this.#viewOf(s), structuredClone(input));
    }
    const copy = structuredClone(input);
    if (copy.from === "note" || (copy.from === "routine" && s.meta.kind === "bot")) return this.#post(s, copy);
    return this.#accept(s, copy);
  }

  async interrupt(id: string): Promise<void> {
    const s = this.#live(id);
    // The user's interrupt stops any compaction between turns, forced ones too (their message alone doesn't).
    s.compacting?.abort.abort("interrupted");
    if (s.running) await this.#interruptStep(s);
  }

  async stop(id: string, reason = "stopped"): Promise<void> {
    const s = this.#sessions.get(id);
    if (!s || isEnded(s.view.status) || s.stopping) return;
    s.stopping = true;
    s.queue = [];
    s.pending = [];
    s.compacting?.abort.abort(reason);
    const running = s.running;
    running?.abort.abort(reason);
    this.#approvals?.cancelSession(id);
    if (s.driver) await this.#bounded(s, s.driver, (d) => d.stop(), "stop");
    if (running && s.running === running) {
      this.#tryRecord(s, { type: "turn_ended", end: { reason: "stopped" } });
      delete s.running;
    }
    delete s.driver;
    this.#setStatus(s, "stopped");
    if (s.meta.kind === "agent") this.#notifyParent(s, "stopped", { reason: "stopped" });
  }

  history(id: string, opts: { afterSeq?: number; limit?: number } = {}): SessionRecord[] {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    const log = this.#logOf(s);
    const from = opts.afterSeq === undefined ? 0 : opts.afterSeq + 1;
    const to = opts.limit === undefined ? log.length : Math.min(log.length, from + opts.limit);
    return log.read(from, to);
  }

  subscribe(id: string, fn: (record: SessionRecord) => void): Unsubscribe {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    return s.subscribers.add(fn);
  }

  watch(fn: (view: SessionView) => void): Unsubscribe {
    return this.#watchers.add(fn);
  }

  // -----------------------------------------------------------------------------------------------
  // Beyond the contract: what the bot service, the usage counter and the methods need
  // -----------------------------------------------------------------------------------------------

  /** Detaches a session's driver and leaves the session dormant (a removed bot's conversation, a shutdown): a running
   *  turn is recorded `interrupted`, what waits stays queued, and `open` with the same id picks it all up again. */
  async release(id: string): Promise<void> {
    const s = this.#sessions.get(id);
    if (!s?.driver || s.stopping) return;
    s.releasing = true;
    s.compacting?.abort.abort("released");
    try {
      const running = s.running;
      if (running) {
        this.#setStatus(s, "cancelling");
        running.abort.abort("released");
        this.#approvals?.withdrawSession(id);
        await this.#bounded(s, s.driver, (d) => d.interrupt(), "interrupt");
        if (s.running === running) {
          this.#tryRecord(s, { type: "turn_ended", end: { reason: "interrupted" } });
          delete s.running;
        }
      }
      if (s.driver) await this.#bounded(s, s.driver, (d) => d.stop(), "stop");
    } catch (err) {
      this.#warn(`session ${id}: its driver failed to stop: ${errorText(err)}`);
    } finally {
      delete s.driver;
      s.releasing = false;
    }
    if (!isEnded(s.view.status) && s.view.status !== "ready") this.#setStatus(s, "idle");
  }

  /** Releases every attached session (a daemon shutdown) and stops counting cards. */
  async close(): Promise<void> {
    this.#offApprovals?.();
    for (const s of [...this.#sessions.values()]) if (s.driver) await this.release(s.meta.id);
  }

  /** Every record of every session as it is written, with the session's view: the usage counter and the wire. */
  tap(fn: (entry: { record: SessionRecord; view: SessionView }) => void): Unsubscribe {
    return this.#taps.add(fn);
  }

  /** A session's streaming events (deltas), which are never recorded: the wire sends them to attached clients. */
  onTransient(id: string, fn: (event: { type: string; [key: string]: unknown }) => void): Unsubscribe {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    return s.transient.add(fn);
  }

  /** Records an event the core itself makes in a session's log, in the runtime's vocabulary (a bot's greeting as its
   *  first `assistant_message`). */
  recordCore(id: string, event: { type: string; [key: string]: unknown }): SessionRecord {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    return this.#record(s, { type: "driver", event: structuredClone(event) });
  }

  /** Changes what a session's view says about it: its computer, title, model or effort (a bot's main conversation
   *  follows its bot's settings). */
  update(id: string, patch: SessionSpecPatch): SessionView {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    if (this.#patchMeta(s, patch)) this.#emitView(s);
    return this.#viewOf(s);
  }

  /** The device lost (or regained) its connection to the computer running this session (§6.4). */
  setAsleep(id: string, asleep: boolean): void {
    const s = this.#sessions.get(id);
    if (s) s.asleep = asleep;
  }

  isAsleep(id: string): boolean {
    return this.#sessions.get(id)?.asleep ?? false;
  }

  /** Whether a driver is attached (an open session) rather than dormant. */
  isAttached(id: string): boolean {
    return this.#sessions.get(id)?.driver !== undefined;
  }

  /** A copied session's view is checked as a client's would be, and must be what its id says: a `b_` id is its bot's
   *  main conversation and nothing else, and a minted id carries its kind's prefix. A view naming this computer as the
   *  one running it is refused, unless it is a bot's main conversation whose lease is elsewhere (review S1). */
  #checkCopiedView(view: SessionView): void {
    const parsed = SessionViewSchema.safeParse(view);
    if (!parsed.success) throw new ContractError("invalid", `a copied session's view doesn't parse: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    if (!view.id.startsWith(SESSION_ID_PREFIX[view.kind])) throw new ContractError("invalid", `session ${view.id} isn't a ${view.kind}'s id`);
    if (view.kind === "bot" && (view.bot === undefined || view.id !== mainSessionIdFor(view.bot))) {
      throw new ContractError("invalid", `session ${view.id} isn't ${view.bot === undefined ? "a bot" : view.bot}'s main conversation`);
    }
    if (this.#computer !== undefined && view.computer === this.#computer) {
      const leaseElsewhere = view.kind === "bot" && this.#runsHere !== undefined && !this.#runsHere(view);
      if (!leaseElsewhere) throw new ContractError("refused", `session ${view.id} names this computer as the one running it; its records aren't copied here`);
    }
  }

  /** Whether this computer runs the session now, so its log is the one others follow: it holds the driver, and the
   *  lease is here (a bot's main conversation) or a turn or a compaction of its runs here. */
  #runsLive(s: Hosted): boolean {
    return s.driver !== undefined && (s.running !== undefined || s.compacting !== undefined || this.#runHere(s));
  }

  /** On a computer that doesn't run the session, whose copy forked from the runner's at `fromSeq` (lane H's sync finds
   *  where): this computer's records from `fromSeq` on are kept aside in a file beside the log, never deleted, and
   *  listed by `earlier`; the log is cut back to `fromSeq`, so the runner's records go on from there; and what the
   *  session holds (status, the line of inputs, questions, a turn left open) is read again from what remains. The view
   *  says `rebasedAt`, so a client reads the history again. The set-aside records, which it returns, go to the
   *  computer running the session (`appendLate` there), which puts them after its own, marked late. */
  setAside(id: string, fromSeq: number, opts: { from: string }): SessionRecord[] {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    // Refused while this computer runs the session, a turn of its included: a turn still running here (the old main's,
    // as the lease leaves) would go on writing past the cut. Losing the lease interrupts that turn (the bot side), and
    // the sync tries again on its next exchange, when it has ended.
    if (this.#runsLive(s)) throw new ContractError("refused", `this computer runs session ${id}; its log is the one the others follow`);
    const log = this.#logOf(s);
    if (!Number.isInteger(fromSeq) || fromSeq < 0 || fromSeq > log.length) {
      throw new ContractError("invalid", `session ${id}: can't set aside from seq ${fromSeq} (this computer holds ${log.length} records)`);
    }
    if (fromSeq === log.length) return [];
    const records = log.read(fromSeq, log.length);
    const at = this.#clock.now();
    const taken = new Set((s.meta.earlier ?? []).map((e) => e.id));
    let earlierId = `e${at}`;
    for (let n = 2; taken.has(earlierId); n++) earlierId = `e${at}-${n}`;
    const entry: EarlierLog = { id: earlierId, at, fromSeq, records: records.length, from: opts.from };
    // The file first, then the meta that lists it, then the cut: a crash between them leaves the records in the log
    // (set aside again, which the runner's `appendLate` takes once) or in a kept file.
    writeJsonAtomic(this.#earlierPath(s, earlierId), { session: id, ...entry, list: records }, { mode: 0o600 });
    const meta: SessionMeta = { ...s.meta, earlier: [...(s.meta.earlier ?? []), entry] };
    writeJsonAtomic(sessionMetaPath(this.#home, meta.bot, meta.id), meta);
    s.meta = meta;
    log.cut(fromSeq);
    this.#restate(s, at);
    return records;
  }

  /** The runs of this computer's records `setAside` kept for the session, oldest first. */
  earlier(id: string): EarlierLog[] {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    return structuredClone(s.meta.earlier ?? []);
  }

  /** The records of one set-aside run, as they were in this computer's log ([] if its file is gone). */
  readEarlier(id: string, earlierId: string): SessionRecord[] {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    if (!(s.meta.earlier ?? []).some((e) => e.id === earlierId)) throw new ContractError("not_found", `session ${id} has no earlier records ${earlierId}`);
    const file = readJson(this.#earlierPath(s, earlierId)) as { list?: unknown } | undefined;
    return Array.isArray(file?.list) ? (file.list as SessionRecord[]) : [];
  }

  /** The computer running the session took a set-aside run (its `appendLate` answered): it isn't sent again. */
  ackEarlier(id: string, earlierId: string): void {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    const list = s.meta.earlier ?? [];
    const at = list.findIndex((e) => e.id === earlierId);
    if (at < 0) throw new ContractError("not_found", `session ${id} has no earlier records ${earlierId}`);
    if (list[at]!.delivered !== undefined) return;
    const meta: SessionMeta = { ...s.meta, earlier: list.map((e, i) => (i === at ? { ...e, delivered: this.#clock.now() } : e)) };
    writeJsonAtomic(sessionMetaPath(this.#home, meta.bot, meta.id), meta);
    s.meta = meta;
  }

  /** On the computer running the session: another computer's set-aside records (`setAside` there), put after this
   *  log's own with new seqs. Each keeps its time and epoch, is marked `late`, `copiedFrom` and `lateFrom` (its device,
   *  computer and place there; a record already late from a third computer keeps its own), and is history only:
   *  nothing runs, and the status, the line of inputs and the turn don't move. A grant is kept as a copied grant (it
   *  grants nothing here), and a status record is left out. A core note, "Earlier on <computer>", goes before each
   *  run a device sends, so every copy of the transcript shows where they came from: a run is named by `earlierId`
   *  (the sender's `EarlierLog` id) when given, else by the place of its first record (the first of `records`, so a
   *  run sent in pages needs `earlierId`). Taken once
   *  per original device and seq, so a resend adds nothing. Refused `busy` while one of this session's own turns or
   *  compactions runs (late records inside a running turn would end it early for a reader of the log): the sender
   *  tries again. How many records it appended (the notes not counted). */
  appendLate(id: string, records: SessionRecord[], opts: { from: string; computer: string; earlierId?: string }): number {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    if (!(s.driver !== undefined && this.#runHere(s))) {
      throw new ContractError("refused", `this computer doesn't run session ${id}; another computer's earlier records go to the one that does`);
    }
    if (s.running !== undefined || s.compacting !== undefined) {
      throw new ContractError("busy", `session ${id} is running a turn here; its earlier records from ${opts.computer} go in once it ends`);
    }
    for (const r of records) {
      if (r.sessionId !== id) throw new ContractError("invalid", `a record of ${r.sessionId} was sent as ${id}'s`);
      if (!Number.isInteger(r.seq) || r.seq < 0) throw new ContractError("invalid", `session ${id}: a late record with no place (seq ${String(r.seq)})`);
    }
    const late = this.#lateOf(s);
    const run = opts.earlierId !== undefined ? `e:${opts.earlierId}` : `s:${records[0]?.seq ?? 0}`;
    // Where each came from: its own first place when it is late already, else the sender's.
    const origin = (r: SessionRecord): LateFrom => {
      const own = (r as { lateFrom?: Partial<LateFrom> }).lateFrom;
      if (own !== undefined && typeof own.device === "string" && typeof own.seq === "number" && typeof own.computer === "string" && typeof own.ts === "number") {
        return { device: own.device, computer: own.computer, seq: own.seq, ts: own.ts, ...(typeof own.epoch === "number" ? { epoch: own.epoch } : {}), ...(typeof own.note === "string" ? { note: own.note } : {}) };
      }
      return { device: opts.from, computer: opts.computer, seq: r.seq, ts: r.ts, ...(r.epoch === undefined ? {} : { epoch: r.epoch }) };
    };
    const fresh = records.filter((r) => r.type !== "status" && !late.seen.has(lateKey(origin(r))));
    if (fresh.length === 0) return 0;
    const log = this.#logOf(s);
    const write = (record: LateRecord) => {
      log.append(record, { durable: true });
      late.seen.add(lateKey(record.lateFrom));
      s.subscribers.emit(structuredClone(record));
      if (this.#taps.size > 0) this.#taps.emit({ record: structuredClone(record), view: this.#viewOf(s) });
    };
    const note = (run: string) => {
      const from: LateFrom = { device: opts.from, computer: opts.computer, seq: -1, ts: this.#clock.now(), note: run };
      if (late.seen.has(lateKey(from))) return;
      const epoch = this.#epoch?.();
      write({
        type: "input", disposition: "note",
        input: {
          from: "note", by: { kind: "core" }, label: `Earlier on ${opts.computer}`.slice(0, 120),
          text: `What follows happened on ${opts.computer} before it followed this conversation here. It is kept after the rest, marked late.`,
        },
        seq: log.length, sessionId: id, ts: from.ts, ...(epoch === undefined ? {} : { epoch }), late: true, lateFrom: from,
      } as LateRecord);
    };
    for (const r of fresh) {
      const from = origin(r);
      // A record already late from elsewhere goes in as it is (its own note came with it); the sender's own open a run.
      if (from.device === opts.from && from.note === undefined) note(run);
      const { seq: _seq, sessionId: _id, ts: _ts, epoch: _epoch, late: _l, copiedFrom, lateFrom: _f, ...body } = structuredClone(r) as SessionRecord & {
        late?: true; copiedFrom?: string; lateFrom?: unknown;
      };
      let kept = body as SessionRecordBody;
      if (kept.type === "driver" && kept.event.type === "session_grant") kept = { ...kept, event: { ...kept.event, type: COPIED_GRANT_EVENT_TYPE } };
      write({
        ...kept, seq: log.length, sessionId: id, ts: r.ts, ...(r.epoch === undefined ? {} : { epoch: r.epoch }),
        late: true, copiedFrom: typeof copiedFrom === "string" ? copiedFrom : opts.from, lateFrom: from,
      } as unknown as LateRecord);
    }
    s.view = { ...s.view, updatedAt: this.#clock.now() };
    this.#emitView(s);
    return fresh.length;
  }

  /** The late records the session holds, by where they first came from (a run's note by its run); read from its log
   *  once. */
  #lateOf(s: Hosted): { seen: Set<string> } {
    if (s.late !== undefined) return s.late;
    const late = { seen: new Set<string>() };
    const log = this.#logOf(s);
    for (let from = 0; from < log.length; from += RESTATE_PAGE) {
      for (const r of log.read(from, from + RESTATE_PAGE)) {
        const lf = (r as { lateFrom?: Partial<LateFrom> }).lateFrom;
        if (typeof lf?.device !== "string" || typeof lf.seq !== "number") continue;
        late.seen.add(lateKey(lf as LateFrom));
      }
    }
    s.late = late;
    return late;
  }

  #earlierPath(s: Hosted, earlierId: string): string {
    return sessionLogPath(this.#home, s.meta.bot, s.meta.id).replace(/\.ndjson$/, `.earlier-${earlierId}.json`);
  }

  /** What the session holds, read again from its whole log (after `setAside` cut it back). */
  #restate(s: Hosted, at: number): void {
    const replay = new Replay();
    const log = this.#logOf(s);
    for (let from = 0; from < log.length; from += RESTATE_PAGE) for (const r of log.read(from, from + RESTATE_PAGE)) replay.apply(r);
    s.queue = replay.queue;
    s.pending = replay.pending;
    s.clientIds.clear();
    for (const [k, v] of replay.clientIds) s.clientIds.set(k, v);
    s.questions.clear();
    for (const q of replay.questions) s.questions.add(q);
    if (replay.running && replay.runningOn !== undefined && replay.runningOn !== this.#computer) s.foreignTurn = { on: replay.runningOn };
    else delete s.foreignTurn;
    s.late = undefined;
    s.view = { ...viewOfMeta(s.meta, replay.status, at, replay.failure) };
    this.#emitView(s);
  }

  /** The next seq the session's log expects (its length; 0 for a session this computer doesn't know): lane H's
   *  `SessionRecordSink.head`, where records copied from the computer running it go on. */
  head(id: string): number {
    const s = this.#sessions.get(id);
    return s === undefined ? 0 : this.#logOf(s).length;
  }

  /** Records copied from the computer running the session (lane H's `SessionRecordSync`), appended to this computer's
   *  log in seq order (`SessionRecordSink.ingest`):
   *  * a session not known here is opened dormant from `view`, with no driver and no record of its own;
   *  * a record already held (its seq below the head) is skipped when it is the same record, so a repeat is harmless;
   *    a different record at a held seq is a fork (two computers wrote that place) and refuses the batch `conflict`;
   *    one past the head is a gap and nothing is taken (the sync asks for the history first);
   *  * a copied `session_grant` is kept as `session_grant_copied`, which grants nothing here and never reaches clients;
   *  * `late` (from an earlier lease) marks each record it appends, and each is marked `copiedFrom` the sender (so
   *    the usage counter, which counts a turn where it ran, skips it);
   *  * no driver ever runs, and nothing is sent on (taps aren't told: the copy isn't this computer's to sync).
   *  A session this computer runs takes no copies: any session but a bot's main conversation, and that one while the
   *  lease is here or a turn of its still runs here. A bot's main conversation keeps its driver on every computer (the
   *  bot side opens it so) and takes copies while the lease is elsewhere; what they queue and a turn they leave open
   *  are kept as a restart would read them, so a takeover runs what waits and catches the open turn up. A known
   *  session's runner follows `view`. */
  ingest(view: SessionView, records: SessionRecord[], opts: { from: string; late: boolean }): void {
    this.#checkCopiedView(view);
    let s = this.#sessions.get(view.id);
    if (s !== undefined && (s.meta.kind !== view.kind || s.meta.bot !== view.bot || s.meta.parent !== view.parent)) {
      throw new ContractError("invalid", `session ${view.id} is a ${s.meta.kind} here; ${opts.from} sent it as a ${view.kind}`);
    }
    if (s !== undefined && this.#runsLive(s)) {
      throw new ContractError("refused", `this computer runs session ${view.id}; its records aren't copied here from ${opts.from}`);
    }
    const log = s === undefined ? undefined : this.#logOf(s);
    let next = log?.length ?? 0;
    // Checked whole before anything is written: a gap, a fork or another session's record takes nothing.
    for (const r of records) {
      if (r.sessionId !== view.id) throw new ContractError("invalid", `a record of ${r.sessionId} was copied as ${view.id}'s`);
      if (r.seq < next) {
        const held = log!.read(r.seq, r.seq + 1)[0];
        if (held === undefined || !sameRecord(held, copied(r, false, opts.from))) {
          throw new ContractError("conflict", `session ${view.id}: this computer holds another record at seq ${r.seq} than ${opts.from} sent; the two logs forked there`);
        }
        continue;
      }
      if (r.seq > next) throw new ContractError("invalid", `session ${view.id}: a gap before seq ${r.seq} (this computer holds up to ${next - 1}); the history comes first`);
      next++;
    }
    if (s === undefined) {
      const meta: SessionMeta = {
        meta: SESSION_META_VERSION, id: view.id, kind: view.kind, startedAt: view.startedAt, computer: view.computer,
        ...(view.bot === undefined ? {} : { bot: view.bot }), ...(view.parent === undefined ? {} : { parent: view.parent }),
      };
      for (const k of ["title", "backend", "model", "effort", "root", "routine"] as const) if (view[k] !== undefined) meta[k] = view[k];
      writeJsonAtomic(sessionMetaPath(this.#home, meta.bot, meta.id), meta);
      const file = new SessionLogFile(sessionLogPath(this.#home, meta.bot, meta.id), meta.id, this.#warn);
      file.load();
      s = this.#hosted(meta, file);
      this.#sessions.set(meta.id, s);
    } else if (view.computer !== s.meta.computer) {
      this.#patchMeta(s, { computer: view.computer });
      s.view = { ...s.view, computer: view.computer };
    }
    const hosted = s;
    const target = this.#logOf(hosted);
    // The copies replayed onto what the session holds now, as a restart would read the whole log.
    const replay = new Replay();
    replay.running = hosted.foreignTurn !== undefined;
    replay.runningOn = hosted.foreignTurn?.on;
    replay.queue = [...hosted.queue];
    replay.pending = [...hosted.pending];
    replay.status = hosted.view.status;
    replay.failure = hosted.view.failure;
    for (const [k, v] of hosted.clientIds) replay.clientIds.set(k, v);
    for (const q of hosted.questions) replay.questions.add(q);
    let appended = 0;
    for (const r of records) {
      if (r.seq < target.length) continue;
      const copy = copied(r, opts.late, opts.from);
      target.append(copy, { durable: copy.type !== "driver" });
      hosted.subscribers.emit(structuredClone(copy));
      replay.apply(copy);
      hosted.view = { ...hosted.view, updatedAt: copy.ts };
      appended++;
    }
    if (appended === 0) return;
    hosted.queue = replay.queue;
    hosted.pending = replay.pending;
    for (const [k, v] of replay.clientIds) hosted.clientIds.set(k, v);
    hosted.questions.clear();
    for (const q of replay.questions) hosted.questions.add(q);
    // A turn the runner has open is caught up only if this computer takes the session over.
    if (replay.running && replay.runningOn !== undefined && replay.runningOn !== this.#computer) hosted.foreignTurn = { on: replay.runningOn };
    else delete hosted.foreignTurn;
    hosted.view = { ...hosted.view, status: replay.status, ...(replay.failure === undefined ? {} : { failure: replay.failure }) };
    if (isEnded(hosted.view.status) && hosted.meta.ended === undefined) this.#markEnded(hosted);
    this.#emitView(hosted);
  }

  /** How many records the session's log holds. */
  length(id: string): number {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    return this.#logOf(s).length;
  }

  /** Starts what waits in every session the gate (`mayStart`) now lets through: call it when the gate opens. */
  resume(): void {
    for (const s of this.#sessions.values()) this.#pump(s);
  }

  /** Who a session is when it calls something (§5.4 "The caller"): a side thread and a background agent carry their
   *  bot, from their own meta or else their parent's. */
  callerOf(id: string): Extract<Caller, { kind: "session" }> {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    const bot = s.meta.bot ?? (s.meta.parent === undefined ? undefined : this.#sessions.get(s.meta.parent)?.meta.bot);
    return { kind: "session", sessionId: id, sessionKind: s.meta.kind, ...(bot === undefined ? {} : { bot }) };
  }

  /** What started the session's running turn, if one runs. */
  turnOrigin(id: string): TurnOrigin | undefined {
    return this.#sessions.get(id)?.running?.origin;
  }

  /** How many inputs wait for the session's next turn (held by the pause, the lease, the update gate, or a turn). */
  waiting(id: string): number {
    return this.#sessions.get(id)?.queue.length ?? 0;
  }

  /** Whether the session is compacting now: between turns (`compact`) or inside one (the runtime's own). */
  isCompacting(id: string): boolean {
    const s = this.#sessions.get(id);
    return s !== undefined && (s.compacting !== undefined || s.turnCompaction);
  }

  /** Compacts the session (§6.3). While it is idle, the driver compacts now and what arrives meanwhile waits; a
   *  cache-timed one gives way to the user's message or interrupt (`dropped`). While a turn runs, a cache-timed one is
   *  `skipped` (the turn refreshes the cache), and a forced one runs as the turn ends, before what waits. */
  async compact(id: string, reason: CompactReason): Promise<CompactOutcome> {
    const s = this.#live(id);
    const driver = s.driver;
    if (!driver || !canCompact(driver)) return "unsupported";
    if (s.compacting) return s.compacting.done;
    // Paused, or not this computer's to run: nothing compacts until it may start turns again.
    if (!this.#gateOpen(s)) return "skipped";
    if (s.running || s.releasing) {
      if (reason === "cache") return "skipped";
      return new Promise((resolve) => s.deferredCompact.push({ reason, resolve }));
    }
    // Something already waits for a turn: it runs first, and refreshes the cache as it does.
    if (reason === "cache" && s.queue.length > 0) return "skipped";
    return this.#runCompaction(s, driver, reason);
  }

  /** After this computer took a session over (§6.4 "Fencing the old main"): the turn another computer started and its
   *  log never ended is ended `interrupted`, and each of its tool calls with no result gets one saying the call may
   *  have run on that computer. Nothing is run again. The host does this itself before it starts the session's next
   *  turn here; the bot service calls it as the lease arrives, so clients see it at once. How many calls it marked. */
  catchUp(id: string): number {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    return this.#catchUp(s);
  }

  // -----------------------------------------------------------------------------------------------
  // Routing
  // -----------------------------------------------------------------------------------------------

  /** Whether this computer runs the session: always, but for a bot's main conversation the lease puts elsewhere. */
  #runHere(s: Hosted): boolean {
    return s.meta.kind !== "bot" || this.#runsHere === undefined || this.#runsHere(this.#viewOf(s));
  }

  #gateOpen(s: Hosted): boolean {
    return this.#mayStart === undefined || this.#mayStart(this.#viewOf(s));
  }

  #catchUp(s: Hosted): number {
    const foreign = s.foreignTurn;
    if (foreign === undefined || s.running || isEnded(s.view.status)) return 0;
    const log = this.#logOf(s);
    const tail = log.read(Math.max(0, log.length - CATCH_UP_SCAN_MAX), log.length);
    let start = -1;
    for (let i = tail.length - 1; i >= 0; i--) {
      if (tail[i]!.type === "turn_ended") break;
      if (tail[i]!.type === "turn_started") {
        start = i;
        break;
      }
    }
    const open = new Map<string, string>();
    if (start >= 0) for (const r of tail.slice(start + 1)) if (r.type === "driver") trackCall(open, r.event);
    for (const callId of open.keys()) {
      if (!this.#tryRecord(s, { type: "driver", event: { type: "tool_result", callId, output: interruptedCallOutput(foreign.on), isError: true } })) return 0;
    }
    if (!this.#tryRecord(s, { type: "turn_ended", end: { reason: "interrupted" } })) return 0;
    delete s.foreignTurn;
    // The status the other computer's turn left (copied with it) ends with that turn, as a restart's would.
    if (s.view.status === "prompting" || s.view.status === "cancelling" || s.view.status === "starting") this.#setStatus(s, "idle");
    return open.size;
  }

  /** Whether what arrives now waits behind a compaction: always behind a forced one, and behind a cache-timed one
   *  unless the user's message is dropping it. */
  #compactionHolds(s: Hosted): boolean {
    return s.compacting !== undefined && !(s.compacting.reason === "cache" && s.compacting.abort.signal.aborted);
  }

  #runCompaction(s: Hosted, driver: CompactingDriver, reason: CompactReason): Promise<CompactOutcome> {
    const abort = new AbortController();
    let settle!: (outcome: CompactOutcome) => void;
    const done = new Promise<CompactOutcome>((resolve) => {
      settle = resolve;
    });
    s.compacting = { reason, abort, done };
    this.#tryRecord(s, { type: "driver", event: { type: "compaction", phase: "started", reason } });
    this.#setStatus(s, "prompting");
    void Promise.resolve()
      .then(() => driver.compact({ reason, signal: abort.signal }))
      .then(
        (r): CompactOutcome => (r.compacted ? "compacted" : abort.signal.aborted ? "dropped" : "failed"),
        (err: unknown): CompactOutcome => {
          if (abort.signal.aborted) return "dropped";
          this.#warn(`session ${s.meta.id}: compacting failed: ${errorText(err)}`);
          return "failed";
        },
      )
      .then((outcome) => {
        if (s.compacting?.abort !== abort) return settle(outcome);
        delete s.compacting;
        this.#tryRecord(s, { type: "driver", event: { type: "compaction", phase: "ended", reason, outcome } });
        if (!s.stopping && !isEnded(s.view.status)) {
          if (!s.releasing) this.#setStatus(s, "idle");
          this.#pump(s);
        }
        settle(outcome);
      })
      .catch((err: unknown) => this.#warn(`session ${s.meta.id}: ending a compaction failed: ${errorText(err)}`));
    return done;
  }

  /** The runtime's own compaction inside a turn (§6.3): while it runs, the user's message waits to interrupt. */
  #trackTurnCompaction(s: Hosted, event: { type: string; [key: string]: unknown }): void {
    if (event.type !== "compaction") return;
    if (event["phase"] === "started" && event["reason"] === "full") s.turnCompaction = true;
    else if (event["phase"] === "ended" && s.turnCompaction) {
      s.turnCompaction = false;
      if (s.interruptAfterCompaction) {
        s.interruptAfterCompaction = false;
        void this.#interruptStep(s);
      }
    }
  }

  #live(id: string): Hosted {
    const s = this.#sessions.get(id);
    if (!s) throw new ContractError("not_found", `no session ${id}`);
    if (isEnded(s.view.status) || s.stopping) throw new ContractError("closed", `session ${id} has ended`);
    return s;
  }

  #accept(s: Hosted, input: TurnInput): { disposition: Disposition; seq: number } {
    if (!s.running) {
      const startsNow = s.driver !== undefined && !s.releasing && s.queue.length === 0 && this.#gateOpen(s) && !this.#compactionHolds(s);
      const disposition: Disposition = startsNow ? "turn" : "queued";
      const record = this.#record(s, { type: "input", input, disposition });
      if (input.from === "user") rememberClientId(s.clientIds, input.clientMessageId, { seq: record.seq, disposition });
      enqueue(s.queue, { seq: record.seq, input }, false);
      this.#pump(s);
      return { disposition, seq: record.seq };
    }
    if (input.from !== "user" && s.driver?.canFold) {
      const record = this.#record(s, { type: "input", input, disposition: "folded" });
      s.running.folds.emit({ seq: record.seq, input });
      return { disposition: "folded", seq: record.seq };
    }
    const record = this.#record(s, { type: "input", input, disposition: "queued" });
    if (input.from === "user") rememberClientId(s.clientIds, input.clientMessageId, { seq: record.seq, disposition: "queued" });
    enqueue(s.queue, { seq: record.seq, input }, false);
    return { disposition: "queued", seq: record.seq };
  }

  /** A note, or a routine's result in a bot's main conversation: it never starts a turn. */
  #post(s: Hosted, input: DeliveredInput): { disposition: Disposition; seq: number } {
    const running = s.running;
    if (running && s.driver?.canFold) {
      const disposition: Disposition = input.from === "note" ? "note" : "folded";
      const record = this.#record(s, { type: "input", input, disposition });
      running.folds.emit({ seq: record.seq, input });
      return { disposition, seq: record.seq };
    }
    const record = this.#record(s, { type: "input", input, disposition: "note" });
    if (!running) s.pending.push({ seq: record.seq, input });
    return { disposition: "note", seq: record.seq };
  }

  async #interruptStep(s: Hosted): Promise<void> {
    const running = s.running;
    if (!running) return;
    this.#setStatus(s, "cancelling");
    running.abort.abort("interrupted");
    this.#approvals?.withdrawSession(s.meta.id);
    if (s.driver) await this.#bounded(s, s.driver, (d) => d.interrupt(), "interrupt");
    // A driver ends its turn when it stops; one that never does is cut loose, and its late end is ignored.
    if (s.running === running) {
      this.#clock.setTimeout(() => {
        if (s.running !== running) return;
        this.#warn(`session ${s.meta.id}: its driver didn't end the interrupted turn; ending it`);
        this.#ended(s, running, { reason: "interrupted" });
      }, INTERRUPT_GRACE_MS);
    }
  }

  /** Starts the next queued turn when none runs and a driver is attached. */
  #pump(s: Hosted): void {
    const driver = s.driver;
    if (s.running || !driver || s.releasing || s.stopping || isEnded(s.view.status) || s.compacting !== undefined) return;
    if (!this.#gateOpen(s)) return;
    // A turn another computer left open is ended before this computer starts one (a takeover).
    if (s.foreignTurn !== undefined) {
      this.#catchUp(s);
      if (s.foreignTurn !== undefined) return;
    }
    // A compaction asked for while the last turn ran goes before what waits (a driver reattached since that can't
    // compact answers `unsupported`).
    for (let deferred = s.deferredCompact.shift(); deferred !== undefined; deferred = s.deferredCompact.shift()) {
      if (!canCompact(driver)) {
        deferred.resolve("unsupported");
        continue;
      }
      void this.#runCompaction(s, driver, deferred.reason).then(deferred.resolve);
      return;
    }
    if (s.queue.length === 0) return;
    const { seq: inputSeq, input } = s.queue[0]!;
    const origin = originOf(input);
    // The turn's start is recorded before anything changes: if the disk refuses it, the input stays first in line.
    const started: TurnStartedBody = { type: "turn_started", origin, inputSeq, ...(this.#computer === undefined ? {} : { on: this.#computer }) };
    if (!this.#tryRecord(s, started)) {
      if (s.retry === undefined && s.log?.broken === undefined) {
        s.retry = this.#clock.setTimeout(() => {
          delete s.retry;
          this.#pump(s);
        }, PUMP_RETRY_MS);
      }
      return;
    }
    s.queue.shift();
    s.turnCompaction = false;
    s.interruptAfterCompaction = false;
    const running: Running = { origin, abort: new AbortController(), folds: new FoldChannel() };
    s.running = running;
    const pending = driver.canFold ? s.pending : [];
    s.pending = [];
    for (const note of pending) running.folds.emit(note);
    this.#setStatus(s, "prompting");
    const ctl: TurnControl = {
      origin,
      signal: running.abort.signal,
      onFold: (fn) => running.folds.subscribe(fn),
      record: (event) => {
        if (TRANSIENT_EVENT_TYPES.has(event.type as never)) s.transient.emit(structuredClone(event));
        else if (CORE_ONLY_EVENT_TYPES.has(event.type)) this.#warn(`session ${s.meta.id}: its driver's ${event.type} event was dropped; only the core records those`);
        else {
          this.#tryRecord(s, { type: "driver", event: structuredClone(event) });
          if (s.running === running) this.#trackTurnCompaction(s, event);
        }
      },
    };
    void Promise.resolve()
      .then(() => driver.turn(structuredClone(input), ctl))
      .then(
        (end) => this.#ended(s, running, end),
        (err: unknown) => this.#ended(s, running, { reason: "failed", failure: "error", text: errorText(err) }),
      )
      .catch((err: unknown) => this.#warn(`session ${s.meta.id}: ending a turn failed: ${errorText(err)}`));
  }

  #ended(s: Hosted, running: Running, end: TurnEnd): void {
    if (s.running !== running) return;
    // What the driver never subscribed to take: notes wait for the next turn, and messages get a turn of their own.
    const unclaimed = running.folds.unclaimed();
    // Recorded first; if the disk refuses it, the turn has still ended, and a restart records it interrupted.
    this.#tryRecord(s, { type: "turn_ended", end });
    delete s.running;
    s.turnCompaction = false;
    s.interruptAfterCompaction = false;
    const waits = (i: QueueItem) => i.input.from === "note" || (i.input.from === "routine" && s.meta.kind === "bot");
    s.pending.unshift(...unclaimed.filter(waits));
    for (const item of unclaimed.filter((i) => !waits(i))) enqueue(s.queue, item, false);
    if (s.stopping || isEnded(s.view.status)) return;
    if (s.releasing) {
      this.#setStatus(s, "idle");
      return;
    }
    // A failed turn's cards have no turn left to answer (the broker's rule 7): they resolve cancelled.
    if (end.reason === "failed") this.#approvals?.cancelSession(s.meta.id);
    if (end.reason === "failed" && s.meta.kind === "bot") {
      // A bot's one conversation never ends (§6.3): the failed turn is recorded with why, and what waits runs next.
      this.#setStatus(s, "idle");
      this.#pump(s);
      return;
    }
    if (end.reason === "failed") {
      s.queue = [];
      s.pending = [];
      this.#setStatus(s, "failed", end.failure ?? "error");
      if (s.meta.kind === "agent") this.#notifyParent(s, stopReasonOf(end), end);
      return;
    }
    this.#setStatus(s, "idle");
    if (s.queue.length > 0 || s.deferredCompact.length > 0) {
      this.#pump(s);
      if (s.queue.length > 0 || s.running || s.compacting) return;
    }
    if (s.meta.kind === "agent" && end.reason !== "interrupted") this.#notifyParent(s, stopReasonOf(end), end);
  }

  /** A background agent's task notification to its bot's main conversation (§9.3, S5 §8). */
  #notifyParent(s: Hosted, stopReason: AgentStopReason, end: Partial<TurnEnd>): void {
    const parent = s.meta.parent ? this.#sessions.get(s.meta.parent) : undefined;
    if (!parent || isEnded(parent.view.status)) return;
    const bot = s.meta.bot ?? parent.meta.bot ?? "bot";
    this.deliver(parent.meta.id, {
      from: "task-notification",
      agent: s.meta.id,
      backend: s.meta.backend ?? "unknown",
      stopReason,
      text: end.text ?? "",
      transcript: `bots/${pluginIdToSegment(bot)}/agents/${s.meta.id}/acp.ndjson`,
      ...(end.usage === undefined ? {} : { usage: end.usage }),
    }).catch(() => {
      // The parent ended meanwhile; the agent's transcript keeps the result.
    });
  }

  // -----------------------------------------------------------------------------------------------
  // State, records and views
  // -----------------------------------------------------------------------------------------------

  #hosted(meta: SessionMeta, log: SessionLogFile | undefined): Hosted {
    return {
      meta,
      view: viewOfMeta(meta, "ready", meta.startedAt),
      log,
      subscribers: new Listeners(),
      transient: new Listeners(),
      queue: [],
      pending: [],
      stopping: false,
      releasing: false,
      asleep: false,
      clientIds: new Map(),
      questions: new Set(),
      cards: 0,
      deferredCompact: [],
      turnCompaction: false,
      interruptAfterCompaction: false,
    };
  }

  #restore(): void {
    const root = transcriptsDir(this.#home);
    if (!existsSync(root)) return;
    for (const folder of readdirSync(root, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      for (const file of readdirSync(join(root, folder.name))) {
        if (!file.endsWith(".meta.json")) continue;
        const path = join(root, folder.name, file);
        const meta = readMeta(path);
        if (!meta) {
          this.#warn(`skipped ${path}: not a session's meta`);
          continue;
        }
        if (sessionMetaPath(this.#home, meta.bot, meta.id) !== path) {
          this.#warn(`skipped ${path}: it names session ${meta.id}, whose files live elsewhere`);
          continue;
        }
        if (this.#sessions.has(meta.id)) continue;
        if (meta.ended !== undefined) {
          // Its log is read when someone asks for it.
          const s = this.#hosted(meta, undefined);
          s.view = viewOfMeta(meta, meta.ended.status, meta.ended.at, meta.ended.failure);
          this.#sessions.set(meta.id, s);
        } else this.#load(meta);
      }
    }
  }

  /** The session's log, read now if it wasn't at the start (an ended session). */
  #logOf(s: Hosted): SessionLogFile {
    if (s.log === undefined) {
      const log = new SessionLogFile(sessionLogPath(this.#home, s.meta.bot, s.meta.id), s.meta.id, this.#warn);
      log.load();
      s.log = log;
    }
    return s.log;
  }

  #load(meta: SessionMeta): void {
    const log = new SessionLogFile(sessionLogPath(this.#home, meta.bot, meta.id), meta.id, this.#warn);
    const replay = new Replay();
    log.load((r) => replay.apply(r));
    const s = this.#hosted(meta, log);
    s.view = viewOfMeta(meta, replay.status, replay.updatedAt ?? meta.startedAt, replay.failure);
    s.queue = replay.queue;
    s.pending = replay.pending;
    for (const [k, v] of replay.clientIds) s.clientIds.set(k, v);
    for (const q of replay.questions) s.questions.add(q);
    this.#sessions.set(meta.id, s);
    // A turn the daemon was running when it stopped is recorded interrupted, with each of its calls that has no
    // result (§3.1).
    if (replay.running && replay.runningOn !== undefined && this.#computer !== undefined && replay.runningOn !== this.#computer) {
      // Another computer's turn, synced here: it may still be running there, and is caught up only on a takeover.
      s.foreignTurn = { on: replay.runningOn };
    } else if (replay.running) {
      for (const callId of replay.openCalls.keys()) this.#tryRecord(s, { type: "driver", event: { type: "tool_result", callId, output: interruptedCallOutput(), isError: true } });
      this.#tryRecord(s, { type: "turn_ended", end: { reason: "interrupted" } });
    }
    if (s.view.status === "prompting" || s.view.status === "cancelling" || s.view.status === "starting") this.#setStatus(s, "idle");
    // Ended before its meta said so (a crash between the two writes, or an older home): the next start skips its log.
    if (isEnded(s.view.status) && meta.ended === undefined) this.#markEnded(s);
  }

  #record(s: Hosted, body: SessionRecordBody): SessionRecord {
    const log = this.#logOf(s);
    const epoch = this.#epoch?.();
    let record = {
      ...structuredClone(body),
      seq: log.length,
      sessionId: s.meta.id,
      ts: this.#clock.now(),
      ...(epoch === undefined ? {} : { epoch }),
    } as SessionRecord;
    const durable = { durable: body.type !== "driver" };
    try {
      log.append(record, durable);
    } catch (err) {
      if (!(err instanceof RecordTooLargeError)) throw err;
      // A message is refused back to its sender: cut in the log, its turn would run on text the log doesn't hold.
      if (body.type === "input") throw new ContractError("invalid", `the message is ${err.bytes} bytes as recorded, over the ${MAX_RECORD_BYTES} a conversation's log holds`);
      record = shrinkRecord(record, err.bytes) ?? record;
      this.#warn(`session ${s.meta.id}: a ${body.type} record of ${err.bytes} bytes had its long fields cut to fit the log`);
      log.append(record, durable);
    }
    s.subscribers.emit(structuredClone(record));
    if (body.type === "driver" && trackQuestion(s.questions, body.event)) this.#emitView(s);
    if (this.#taps.size > 0) this.#taps.emit({ record: structuredClone(record), view: this.#viewOf(s) });
    return record;
  }

  /** Writes a record, or says why it couldn't; true when it was written. */
  #tryRecord(s: Hosted, body: SessionRecordBody): boolean {
    try {
      this.#record(s, body);
      return true;
    } catch (err) {
      this.#warn(`session ${s.meta.id}: a ${body.type} record wasn't written: ${errorText(err)}`);
      return false;
    }
  }

  /** The status is recorded first; the view follows the session's real state even when the disk refused the record. */
  #setStatus(s: Hosted, status: SessionStatus, failure?: SessionFailure): void {
    if (s.view.status === status && failure === undefined) return;
    this.#tryRecord(s, { type: "status", status, ...(failure === undefined ? {} : { failure }) });
    s.view = { ...s.view, status, updatedAt: this.#clock.now(), ...(failure === undefined ? {} : { failure }) };
    if (isEnded(status)) this.#markEnded(s);
    this.#emitView(s);
  }

  /** Notes in the meta that the session ended, so a start needn't read its log. */
  #markEnded(s: Hosted): void {
    const status = s.view.status;
    if (status !== "stopped" && status !== "failed") return;
    const next: SessionMeta = { ...s.meta, ended: { status, at: s.view.updatedAt, ...(s.view.failure === undefined ? {} : { failure: s.view.failure }) } };
    try {
      writeJsonAtomic(sessionMetaPath(this.#home, next.bot, next.id), next);
      s.meta = next;
    } catch (err) {
      this.#warn(`session ${s.meta.id}: its meta wasn't marked ended: ${errorText(err)}`);
    }
  }

  /** A call into a driver to interrupt or stop it, given `INTERRUPT_GRACE_MS` before the host goes on without it. */
  async #bounded(s: Hosted, driver: SessionDriver, call: (d: SessionDriver) => Promise<void>, what: string): Promise<void> {
    let handle: ReturnType<Clock["setTimeout"]> | undefined;
    const late = new Promise<"late">((resolve) => {
      handle = this.#clock.setTimeout(() => resolve("late"), INTERRUPT_GRACE_MS);
    });
    try {
      const done = Promise.resolve().then(() => call(driver)).then(() => "done" as const);
      if ((await Promise.race([done, late])) === "late") {
        this.#warn(`session ${s.meta.id}: its driver didn't ${what} within ${INTERRUPT_GRACE_MS} ms; going on without it`);
      }
    } catch (err) {
      this.#warn(`session ${s.meta.id}: its driver failed to ${what}: ${errorText(err)}`);
    } finally {
      if (handle !== undefined) this.#clock.clearTimeout(handle);
    }
  }

  #patchMeta(s: Hosted, patch: SessionSpecPatch): boolean {
    let changed = false;
    const next: SessionMeta = { ...s.meta };
    for (const [k, v] of Object.entries(patch) as [keyof SessionSpecPatch, string | null | undefined][]) {
      if (v === undefined || next[k] === v) continue;
      if (v === null) {
        if (k === "computer" || next[k] === undefined) continue;
        delete next[k];
      } else next[k] = v;
      changed = true;
    }
    if (!changed) return false;
    writeJsonAtomic(sessionMetaPath(this.#home, next.bot, next.id), next);
    s.meta = next;
    s.view = { ...viewOfMeta(next, s.view.status, s.view.updatedAt, s.view.failure) };
    return true;
  }

  #recountCards(): void {
    const pending = this.#approvals?.pending?.();
    if (pending === undefined) return;
    const counts = new Map<string, number>();
    for (const card of pending) if (card.session !== undefined) counts.set(card.session, (counts.get(card.session) ?? 0) + 1);
    for (const s of this.#sessions.values()) {
      const n = counts.get(s.meta.id) ?? 0;
      if (n === s.cards) continue;
      s.cards = n;
      this.#emitView(s);
    }
  }

  #viewOf(s: Hosted): SessionView {
    return { ...structuredClone(s.view), needsYou: { cards: s.cards, questions: s.questions.size } };
  }

  #emitView(s: Hosted): void {
    this.#watchers.emit(this.#viewOf(s));
  }
}

function specPatchOf(spec: SessionSpec): Pick<SessionMeta, "computer"> & Partial<Pick<SessionMeta, "title" | "backend" | "model" | "effort" | "root" | "routine">> {
  const out: Pick<SessionMeta, "computer"> & Partial<Pick<SessionMeta, "title" | "backend" | "model" | "effort" | "root" | "routine">> = { computer: spec.computer };
  for (const k of ["title", "backend", "model", "effort", "root", "routine"] as const) if (spec[k] !== undefined) out[k] = spec[k];
  return out;
}

function viewOfMeta(meta: SessionMeta, status: SessionStatus, updatedAt: number, failure?: SessionFailure): SessionView {
  return {
    id: meta.id,
    kind: meta.kind,
    computer: meta.computer,
    status,
    startedAt: meta.startedAt,
    updatedAt,
    ...(failure === undefined ? {} : { failure }),
    ...(meta.bot === undefined ? {} : { bot: meta.bot }),
    ...(meta.parent === undefined ? {} : { parent: meta.parent }),
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.backend === undefined ? {} : { backend: meta.backend }),
    ...(meta.model === undefined ? {} : { model: meta.model }),
    ...(meta.effort === undefined ? {} : { effort: meta.effort }),
    ...(meta.root === undefined ? {} : { root: meta.root }),
    ...(meta.routine === undefined ? {} : { routine: meta.routine }),
    ...(meta.earlier === undefined || meta.earlier.length === 0 ? {} : { rebasedAt: meta.earlier[meta.earlier.length - 1]!.at }),
  };
}

function stopReasonOf(end: Partial<TurnEnd>): AgentStopReason {
  if (end.reason === "failed") return end.failure === "sign-in" ? "sign-in" : end.failure === "crashed" ? "crashed" : end.failure === "stalled" ? "stalled" : "error";
  if (end.reason === "refusal" || end.reason === "cancelled" || end.reason === "stopped") return end.reason;
  return "end_turn";
}
