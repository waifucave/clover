// Agents on other computers (spec §9.3 "which computer", "[P] Local placement: the daemon on the chosen computer starts
// the agent's ACP process there and streams its events back to the bot"; plan §4 K-M3, with lane J's link). A bot on
// one computer (A, the computer running it) delegates to an agent on another (B):
//
// * **The session lives on A.** A's host keeps the agent's session with a `RemoteAgentDriver`, so the task
//   notification, `ListAgents`, `TaskStop`, `SendMessage` into the bot, the live tab and the model picker work as for a
//   local agent. A writes the transcript under its own `bots/<bot>/agents/` (§6.5: it resolves to the computer running
//   the bot), from the lines B streams back, through the transcript's no-follow writer; B writes none.
// * **B runs the agent with its own manager:** its backends, its root (the root must be in B's home), its fence and
//   sandbox, its bridge (the token bound to the agent's process on B), its OKs, its level and its cards (the computer
//   where the act happens judges it, as the tree's R1). The bridge's `SendMessage` comes back to A, where it may reach
//   only the bot's own sessions. A level A sends for a routine counts only when it isn't above B's own (a raised level
//   never crosses on a peer's word), and a turn the user started on A is a `peer` turn on B.
// * **The pause (the controller's ruling):** A forwards its pause switch (`agent.pause`, and the state on every
//   `agent.open` and `agent.turn`); B holds an agent's tool calls while either switch says paused. A dropped link reads
//   as paused (fail closed), until A says otherwise again: the turn isn't cancelled, its tool calls wait, and what B
//   reports meanwhile waits in an ordered outbox. A's turn waits for the link up to `LINK_GRACE_MS`, then ends.
// * **Who may ask:** B serves only paired devices that run a core (`mayCall`), and only for an agent the asking device
//   opened. Another device (a new main after a takeover) drives it only by opening it again (`agent.open`), which
//   cancels the turn the old one had running.
// * **Every act carries the fencing token** (lane J's #237, `ActFence`), both ways, and the receiver judges it: a
//   computer whose view of the group's lease is behind can't drive an agent or reach a bot through one.
// * **Bounds:** A takes a streamed line only for an agent it opened on that device, up to `MAX_STREAM_LINE` per line
//   and `MAX_STREAM_TURN` per turn; past that, one record says so and the rest of the turn's lines are dropped.
//
// Wire (all `control`, so a turn's end never overtakes its events): A → B `agent.open`, `agent.turn` (answered at once),
// `agent.interrupt`, `agent.stop`, `agent.setModel` (requests) and `agent.pause` (a notice); B → A `agent.event`,
// `agent.transcript`, `agent.turnEnded` (notices) and `agent.message` (a request).
import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BotId, FencingToken, Level, levelAbove, SessionFailure as SessionFailureSchema, SessionId, TreePath, TurnOrigin, type FenceVerdict, type SessionFailure } from "@waifucave/clover-protocol";
import type { Clock } from "../contracts/clock";
import { ContractError, isContractError, type Unsubscribe } from "../contracts/common";
import type { LinkTransport } from "../contracts/link-transport";
import type { SessionDriver, TurnControl, TurnEnd, TurnInput } from "../contracts/session-host";
import type { AgentManager, AgentPauseGate, PeerHostedAgent, RemoteAgentEntry } from "./manager";

// -------------------------------------------------------------------------------------------------
// The fencing token (lane J's #237 `ActFence`, tree/fencing.ts)
// -------------------------------------------------------------------------------------------------

/** #237's `ActFence`: this computer's token for the acts it asks of another, and its guard for the acts asked of it. */
export interface AgentActFence {
  token(): FencingToken | undefined;
  check(token: FencingToken | undefined): FenceVerdict;
}

function fenceParam(f: AgentActFence | undefined): { fence?: FencingToken } {
  const t = f?.token();
  return t ? { fence: t } : {};
}

/** #237's `checkActFence`: refuses an act whose token this computer's lease doesn't take (`not_main`). */
function checkFence(f: AgentActFence | undefined, token: FencingToken | undefined, what: string): void {
  if (!f) return;
  const v = f.check(token);
  if (v === "ok") return;
  throw new ContractError("not_main", v === "missing"
    ? `${what} came without the group's fencing token`
    : (v as string) === "lapsed"
      ? `${what} can't run while the group's lease has lapsed: with no main computer, no computer acts`
      : `${what} came from a computer whose view of the lease is behind (a stale fencing token)`, { fence: v });
}

// -------------------------------------------------------------------------------------------------
// Bounds and schemas
// -------------------------------------------------------------------------------------------------

/** The most one streamed transcript line may carry, and one turn's lines together. */
export const MAX_STREAM_LINE = 1024 * 1024;
export const MAX_STREAM_TURN = 64 * 1024 * 1024;
/** The most one streamed log event may carry, as JSON. */
export const MAX_STREAM_EVENT = 256 * 1024;
/** A prompt's text and its images together. */
const MAX_PROMPT = 32 * 1024 * 1024;
/** What B keeps for one device while its link is down. */
export const OUTBOX_BYTES = 16 * 1024 * 1024;
/** How long A's turn waits for a dropped link to come back before it ends: the stall watchdog's window. */
export const LINK_GRACE_MS = 10 * 60_000;
/** The longest wait between asks for a device's state after its link came back. */
const RESYNC_MAX_MS = 30_000;
/** How long one ask for a device's state waits for its answer: a half-open connection can't hold the next ask back. */
export const STATE_TIMEOUT_MS = 10_000;

const Fence = { fence: FencingToken.optional() };
/** An agent's session id, as the manager makes them (`agent_` and base64url). */
const AgentId = SessionId.regex(/^agent_[A-Za-z0-9_-]{6,64}$/);
const Model = z.string().min(1).max(256);
const Prompt = z.object({
  text: z.string().max(MAX_PROMPT),
  images: z.array(z.object({ mimeType: z.string().min(1).max(128), data: z.string().max(MAX_PROMPT) })).max(64).optional(),
}).refine((p) => p.text.length + (p.images ?? []).reduce((n, i) => n + i.data.length, 0) <= MAX_PROMPT, "the prompt is too large");

const OpenParams = z.object({
  id: AgentId, backend: z.string().min(1).max(128), root: TreePath,
  bot: BotId.optional(), parent: SessionId.optional(), level: Level.optional(),
  model: Model.optional(), effort: Model.optional(), reattach: z.string().min(1).max(256).optional(),
  /** On a re-open: the plugin whose backend ran it, which must still be the one (#233's review). */
  pluginId: z.string().min(1).max(256).optional(),
  paused: z.boolean(), epoch: z.string().min(1).max(64), ...Fence,
});
export type PeerOpen = Omit<z.infer<typeof OpenParams>, "paused" | "epoch" | "fence">;
const TurnParams = z.object({ id: AgentId, turn: z.number().int().positive(), prompt: Prompt, origin: TurnOrigin, paused: z.boolean(), epoch: z.string().min(1).max(64), ...Fence });
const IdParams = z.object({ id: AgentId, ...Fence });
const IdParamsLoose = z.object({ ...Fence });
/** `closed`: the opener already ended this turn on its side (at the link's grace), so nothing more of it may run. */
const InterruptParams = z.object({ id: AgentId, turn: z.number().int().positive().optional(), closed: z.boolean().optional(), ...Fence });
const TruncatedParams = z.object({ id: AgentId, turn: z.number().int().positive(), ...Fence });
const ModelParams = z.object({ id: AgentId, model: Model, effort: Model.optional(), ...Fence });
const PauseParams = z.object({ paused: z.boolean(), epoch: z.string().min(1).max(64), ...Fence });
const StateReply = z.object({ paused: z.boolean(), epoch: z.string().min(1).max(64) });
const EventParams = z.object({ id: AgentId, turn: z.number().int().positive(), event: z.record(z.string(), z.unknown()), ...Fence });
const TranscriptParams = z.object({ id: AgentId, turn: z.number().int().positive(), file: z.string().min(1).max(64), text: z.string(), ...Fence });
const TurnEndSchema = z.object({
  reason: z.enum(["end_turn", "refusal", "interrupted", "cancelled", "stopped", "failed"]),
  text: z.string().max(4 * 1024 * 1024).optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), contextTokens: z.number().int().nonnegative().optional() }).optional(),
  failure: SessionFailureSchema.optional(),
});
const TurnEndedParams = z.object({ id: AgentId, turn: z.number().int().positive(), end: TurnEndSchema, ...Fence });
const MessageParams = z.object({ id: AgentId, text: z.string().min(1).max(MAX_STREAM_LINE), to: SessionId.optional(), ...Fence });

function parse<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const p = schema.safeParse(raw);
  if (!p.success) throw new ContractError("invalid", `${what}: ${p.error.issues[0]?.message ?? "bad params"}`);
  return p.data;
}

/** What B's driver is handed for a turn: the prompt A built from the turn's input (its images read on A). */
interface PeerPromptInput {
  from: "peer-prompt";
  prompt: { text: string; images?: { mimeType: string; data: string }[] };
}

/** The prompt of a turn A sent, or undefined for any other input (the manager's `promptOf` then applies). */
export function peerPromptOf(input: TurnInput): { text: string; images?: { mimeType: string; data: string }[] } | undefined {
  const i = input as unknown as Partial<PeerPromptInput>;
  return i.from === "peer-prompt" && i.prompt !== undefined ? i.prompt : undefined;
}

/** A turn A's user started is a `peer` turn on B: B can't check that the user sent it. */
function originOnPeer(origin: TurnOrigin): TurnOrigin {
  return origin === "user" ? "peer" : origin;
}

/** The level an agent B runs for A is judged at: A's routine level only when it isn't above B's own. */
export function peerLevel(asked: Level | undefined, own: Level): Level {
  return asked === undefined || levelAbove(asked, own) ? own : asked;
}

// -------------------------------------------------------------------------------------------------
// The link
// -------------------------------------------------------------------------------------------------

export interface AgentPeersOptions {
  transport: LinkTransport;
  /** A computer's device and whether its link is up (lane J's registry). */
  computer(name: string): { device: string; online: boolean } | undefined;
  /** Paired devices that run a core (lane J's node's `mayCall`). */
  mayCall(device: string): boolean;
  /** This computer's lease fence (#237); left out, nothing is carried or judged. */
  fence?: AgentActFence;
  /** This computer's pause switch, forwarded to the computers running its bots' agents. */
  pause?: AgentPauseGate;
  clock: Pick<Clock, "now">;
  /** The Clover home: its fenced run folder keeps the boot counter the link epoch's base orders by. */
  home: string;
  /** How long a turn waits for a dropped link (`LINK_GRACE_MS`); tests shorten it. */
  linkGraceMs?: number;
  /** The first delay before asking a device for its state again (1 s, doubling to `RESYNC_MAX_MS`); tests shorten it. */
  resyncBaseMs?: number;
  /** What the outbox keeps for one device (`OUTBOX_BYTES`); tests shrink it. */
  outboxBytes?: number;
  log?: (line: string) => void;
}

interface RunningTurn {
  turn: number;
  device: string;
  abort: AbortController;
  /** The opener ended this turn on its side (at the link's grace) or lost it: nothing more of it is sent. */
  closed: boolean;
  /** Its reports overflowed the outbox: it was interrupted, and nothing more of it is queued but its end. */
  overflowed: boolean;
  /** How it ends when this side ended it (its opener away past the grace), in place of the driver's `interrupted`. */
  endAs?: TurnEnd;
}

/** Both sides of agents on other computers, for one daemon: A's drivers for the agents it placed elsewhere, and B's
 *  service for the agents other computers placed here. */
export class AgentPeers {
  readonly #o: AgentPeersOptions;
  readonly #manager: AgentManager;
  readonly #offs: Unsubscribe[] = [];
  /** B: the pause state each asking device last sent; a dropped link reads as paused. */
  readonly #peerPaused = new Map<string, boolean>();
  readonly #pauseWatchers = new Set<(device: string) => void>();
  /** B: the turn running for each agent, and when its last turn has wound down. */
  readonly #running = new Map<string, RunningTurn>();
  readonly #settled = new Map<string, Promise<void>>();
  /** A: each remote agent's driver. */
  readonly #drivers = new Map<string, RemoteAgentDriver>();
  /** A: the link epoch's base and each device's count; B: each device's last epoch, and the one in force at its drop. */
  readonly #epochBase: string;
  readonly #epochN = new Map<string, number>();
  readonly #lastEpoch = new Map<string, string>();
  readonly #staleEpoch = new Map<string, string>();
  /** B: each device's highest-ranked base seen. A direct reply can take over with an older-ranked base; the bases it
   *  replaced, up to this one, stay retired for messages. */
  readonly #highBase = new Map<string, string>();
  /** B: devices whose state it has taken since their link last came back, and those it is asking again. */
  readonly #accepted = new Set<string>();
  readonly #resyncing = new Set<string>();
  /** B: each device's link generation, one up at each drop: a reply counts as direct only on the generation it was
   *  asked on. */
  readonly #linkGen = new Map<string, number>();
  readonly #asking = new Set<string>();
  #closed = false;
  /** Devices whose link is down, and each device's notices waiting for it. */
  readonly #down = new Set<string>();
  /** B: devices whose link came back but which haven't said their state yet: their notices wait, so a turn they
   *  closed meanwhile (`agent.interrupt`, closed) is taken out before anything of it goes. */
  readonly #awaitingState = new Set<string>();
  readonly #outbox = new Map<string, { items: { method: string; params: Record<string, unknown>; size: number }[]; bytes: number; sending: boolean }>();
  /** B: a device whose link is down past the grace has its agents' turns ended. */
  readonly #downTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Serves the link's `agent.*` methods and hands the manager this side (`attachPeers`). */
  constructor(manager: AgentManager, o: AgentPeersOptions) {
    this.#o = o;
    this.#manager = manager;
    // This daemon's base, from the boot counter in its home, before any link comes up.
    this.#epochBase = nextBootBase(o.home);
    const t = o.transport;
    const guard = (from: string) => {
      if (!o.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
    };
    // ---- B: agents other computers place here ----
    this.#offs.push(t.handle("agent.open", async (raw, from) => {
      guard(from);
      const p = parse(OpenParams, raw, "agent.open");
      checkFence(o.fence, p.fence, "agent.open");
      this.#heard(from);
      // Another device opening an agent it didn't open is a takeover: a current token proves only that its view of the
      // lease is current, so it must also be the lease's holder by this computer's own lease (the controller's ruling).
      const have = this.#manager.peerHosted(p.id);
      if (have && have.peer.device !== from && this.#o.fence?.token()?.holder !== from) {
        throw new ContractError("refused", "only the main computer may take over an agent another computer opened");
      }
      // A running turn never outlives a fresh open from its own opener (the controller's ruling): an opener opens only
      // from a new driver (a restart, a crash, a graceful close) or after `not_found`, so it has no turn running here,
      // and one still running is one it lost, its closing interrupt included. It ends closed, before the open's state
      // can let it go on.
      if (have) this.#abortTurn(p.id, true);
      this.#stateFrom(from, p.epoch, p.paused);
      const { paused: _paused, epoch: _epoch, fence: _fence, ...open } = p;
      const { rebound, pluginId } = this.#manager.openForPeer(open, from);
      // The old opener's turn ends here, and nothing more of it is sent; a hold looks at the new opener's switch.
      if (rebound) {
        this.#abortTurn(p.id, true);
        for (const fn of this.#pauseWatchers) fn(from);
      }
      return { ok: true, pluginId };
    }));
    this.#offs.push(t.handle("agent.turn", (raw, from) => {
      guard(from);
      const p = parse(TurnParams, raw, "agent.turn");
      checkFence(o.fence, p.fence, "agent.turn");
      this.#heard(from);
      const e = this.#own(p.id, from);
      this.#stateFrom(from, p.epoch, p.paused);
      if (this.#running.has(p.id)) throw new ContractError("conflict", "this agent is already running a turn");
      const abort = new AbortController();
      const run: RunningTurn = { turn: p.turn, device: from, abort, closed: false, overflowed: false };
      this.#running.set(p.id, run);
      const ctl: TurnControl = {
        origin: originOnPeer(p.origin),
        signal: abort.signal,
        onFold: () => () => {},
        record: (event) => this.#report(p.id, run, "agent.event", { id: p.id, turn: p.turn, event }),
      };
      const input: PeerPromptInput = { from: "peer-prompt", prompt: p.prompt };
      // A turn starts only once the one before it has wound down (an interrupted turn's cancel may still be running).
      const before = this.#settled.get(p.id) ?? Promise.resolve();
      const settled = before
        .then(() => (abort.signal.aborted ? ({ reason: "interrupted" } as TurnEnd) : e.driver.turn(input as unknown as TurnInput, ctl)))
        .catch((err): TurnEnd => ({ reason: "failed", failure: "error", text: err instanceof Error ? err.message : String(err) }))
        .then((end) => {
          if (this.#running.get(p.id) === run) this.#running.delete(p.id);
          // A turn its opener closed, or another device took over, ends here; nobody is left to tell.
          if (!run.closed && e.peer.device === from) this.#notify(from, "agent.turnEnded", { id: p.id, turn: p.turn, end: run.endAs ?? end });
        });
      this.#settled.set(p.id, settled);
      void settled.then(() => { if (this.#settled.get(p.id) === settled) this.#settled.delete(p.id); });
      return { accepted: true };
    }));
    this.#offs.push(t.handle("agent.interrupt", async (raw, from) => {
      guard(from);
      const p = parse(InterruptParams, raw, "agent.interrupt");
      checkFence(o.fence, p.fence, "agent.interrupt");
      this.#heard(from);
      this.#own(p.id, from);
      const run = this.#running.get(p.id);
      // A turn the opener already ended (at the link's grace) never goes on: it ends here, unreported.
      if (run && (p.turn === undefined || run.turn <= p.turn)) this.#abortTurn(p.id, p.closed === true);
      return { ok: true };
    }));
    this.#offs.push(t.handle("agent.stop", async (raw, from) => {
      guard(from);
      const p = parse(IdParams, raw, "agent.stop");
      checkFence(o.fence, p.fence, "agent.stop");
      this.#heard(from);
      const e = this.#manager.peerHosted(p.id);
      // Stopping one that is already gone is done.
      if (!e) return { ok: true };
      if (e.peer.device !== from) throw new ContractError("refused", "only the computer that opened this agent may stop it");
      await e.driver.stop();
      return { ok: true };
    }));
    this.#offs.push(t.handle("agent.setModel", async (raw, from) => {
      guard(from);
      const p = parse(ModelParams, raw, "agent.setModel");
      checkFence(o.fence, p.fence, "agent.setModel");
      this.#heard(from);
      this.#own(p.id, from);
      await this.#manager.setModel(p.id, p.model, p.effort);
      return { ok: true };
    }));
    this.#offs.push(t.onNotify("agent.pause", (raw, from) => {
      if (!o.mayCall(from)) return;
      const p = PauseParams.safeParse(raw);
      if (!p.success || !this.#fenceOk(p.data.fence, "agent.pause")) return;
      this.#heard(from);
      this.#stateFrom(from, p.data.epoch, p.data.paused);
    }));
    // A: another computer running this one's agents asks for its state after its link came back (it may have seen a
    // drop this side didn't): a new epoch, and the state as it is now.
    this.#offs.push(t.handle("agent.state", (raw, from) => {
      guard(from);
      const p = parse(IdParamsLoose, raw, "agent.state");
      checkFence(o.fence, p.fence, "agent.state");
      this.#heard(from);
      this.#bumpEpoch(from);
      return { paused: this.#pausedFor(from), epoch: this.epochFor(from) };
    }));
    // ---- A: agents this computer placed elsewhere ----
    this.#offs.push(t.handle("agent.message", async (raw, from) => {
      guard(from);
      const p = parse(MessageParams, raw, "agent.message");
      checkFence(o.fence, p.fence, "agent.message");
      this.#heard(from);
      const d = this.#driverFrom(p.id, from);
      if (!d) throw new ContractError("refused", "no agent this computer placed on yours has that id");
      await this.#manager.remoteMessage(p.id, p.text, p.to);
      return { ok: true };
    }));
    this.#offs.push(t.onNotify("agent.event", (raw, from) => {
      if (!o.mayCall(from)) return;
      const p = EventParams.safeParse(raw);
      if (!p.success || !this.#fenceOk(p.data.fence, "agent.event")) return;
      this.#heard(from);
      this.#driverFrom(p.data.id, from)?.event(p.data.turn, p.data.event);
    }));
    this.#offs.push(t.onNotify("agent.transcript", (raw, from) => {
      if (!o.mayCall(from)) return;
      const p = TranscriptParams.safeParse(raw);
      if (!p.success || !this.#fenceOk(p.data.fence, "agent.transcript")) return;
      this.#heard(from);
      this.#driverFrom(p.data.id, from)?.transcriptLine(p.data.turn, p.data.file, p.data.text);
    }));
    this.#offs.push(t.onNotify("agent.turnEnded", (raw, from) => {
      if (!o.mayCall(from)) return;
      const p = TurnEndedParams.safeParse(raw);
      if (!p.success || !this.#fenceOk(p.data.fence, "agent.turnEnded")) return;
      this.#heard(from);
      this.#driverFrom(p.data.id, from)?.ended(p.data.turn, p.data.end as TurnEnd);
    }));
    this.#offs.push(t.onNotify("agent.truncated", (raw, from) => {
      if (!o.mayCall(from)) return;
      const p = TruncatedParams.safeParse(raw);
      if (!p.success || !this.#fenceOk(p.data.fence, "agent.truncated")) return;
      this.#heard(from);
      this.#driverFrom(p.data.id, from)?.truncatedThere(p.data.turn);
    }));
    // ---- Both: the link to a device went down or came back ----
    this.#offs.push(t.watch((view) => {
      if (view.up) {
        this.#up(view.peer);
        return;
      }
      if (this.#down.has(view.peer)) return;
      this.#down.add(view.peer);
      this.#linkGen.set(view.peer, (this.#linkGen.get(view.peer) ?? 0) + 1);
      // B: the epoch in force now is the old link's; nothing carrying it counts after this, and its state is asked for
      // again at the next link-up.
      this.#accepted.delete(view.peer);
      const last = this.#lastEpoch.get(view.peer);
      if (last !== undefined) this.#staleEpoch.set(view.peer, last);
      // B: the agents that computer opened are held, as if paused (fail closed), until it says again; their turns
      // stay, and what they report waits in the outbox. Past the grace, their turns end.
      this.#setPeerPaused(view.peer, true);
      const device = view.peer;
      this.#downTimers.set(device, setTimeout(() => {
        this.#downTimers.delete(device);
        // Ended, not closed: its end waits in the outbox, so the opener's turn ends when the link is back.
        for (const [id, r] of [...this.#running]) {
          if (r.device !== device) continue;
          // Cancelled, not failed: a failed session takes no more turns, and this one should go on once both are back.
          r.endAs = { reason: "cancelled", text: "The bot's computer was out of reach for too long, so this turn was stopped; message the agent to go on." };
          this.#abortTurn(id);
        }
      }, this.linkGraceMs));
      // A: a turn running there waits for the link, up to the grace.
      for (const d of this.#drivers.values()) if (d.device === view.peer) d.linkDown();
    }));
    // A: the pause switch moving reaches every computer running its agents.
    const off = o.pause?.watch?.(() => {
      for (const device of new Set([...this.#drivers.values()].map((d) => d.device))) this.#notify(device, "agent.pause", { paused: this.#pausedFor(device) });
    });
    if (off) this.#offs.push(off);
    manager.attachPeers(this);
  }

  /** The link to `device` is back: by the transport's word, or by an authenticated message from it that came first. */
  #up(device: string): void {
    if (!this.#down.delete(device)) return;
    const timer = this.#downTimers.get(device);
    if (timer !== undefined) clearTimeout(timer);
    this.#downTimers.delete(device);
    // B: what it kept while the link was down goes once that computer has said its state (its closing interrupts come
    // first), in order.
    if ((this.#outbox.get(device)?.items.length ?? 0) > 0) this.#awaitingState.add(device);
    // A: a turn it ended at the grace is interrupted there first, then its pause state goes again, which lets the
    // agents there go on.
    const drivers = [...this.#drivers.values()].filter((d) => d.device === device);
    if (drivers.length > 0) {
      // A new link epoch: what this side says from now on is told apart from anything the old link still delivers.
      this.#bumpEpoch(device);
      // A failed closing interrupt sends no state: that computer stays held (fail closed), and the next link-up, or
      // the agent's next turn, tries it again.
      void Promise.all(drivers.map((d) => d.linkUp())).then((ok) => {
        if (ok.every(Boolean)) this.#notify(device, "agent.pause", { paused: this.#pausedFor(device) });
      });
    }
    // B: it asks the computer that opened agents here for its state as it is now, in case that side saw no drop.
    if (this.#manager.peerHostedBy(device)) void this.#resync(device);
  }

  /** B: asks `device` for its state until it takes one (1 s, doubling to 30 s), while it still holds that device's
   *  agents; it stops when the link goes down again, and starts over at the next link-up. */
  async #resync(device: string): Promise<void> {
    if (this.#resyncing.has(device)) return;
    this.#resyncing.add(device);
    let delay = this.#o.resyncBaseMs ?? 1_000;
    const go = () => !this.#closed && !this.#down.has(device) && !this.#accepted.has(device) && this.#manager.peerHostedBy(device);
    try {
      while (go()) {
        try {
          if (await this.#askState(device)) return;
        } catch {
          // Asked again after the delay.
        }
        if (!go()) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, RESYNC_MAX_MS);
      }
    } finally {
      this.#resyncing.delete(device);
    }
  }

  /** B: asks `device` for its state on the link as it is now; its direct reply, if the link didn't drop meanwhile,
   *  takes over even when its base ranks older (the daemon there holds the lock and answers on the live link; a late
   *  message of an earlier daemon can't be a reply). True when a state was taken. */
  async #askState(device: string): Promise<boolean> {
    if (this.#asking.has(device)) return false;
    this.#asking.add(device);
    try {
      const gen = this.#linkGen.get(device) ?? 0;
      const r = StateReply.safeParse(await this.request<unknown>(device, "agent.state", {}, undefined, STATE_TIMEOUT_MS));
      if (!r.success || this.#down.has(device) || (this.#linkGen.get(device) ?? 0) !== gen) return false;
      return this.#stateFrom(device, r.data.epoch, r.data.paused, "direct");
    } finally {
      this.#asking.delete(device);
    }
  }

  // ---- The link epoch (the controller's ruling on #240's reconnect race) ----

  /** A: this computer's link epoch toward a device, on every message that carries its state: a base per daemon (its
   *  boot counter and 64 random bits, so bases order by daemon start whatever the wall clock does, and a restart never
   *  repeats one) and a count of this side's link-ups to that device. */
  epochFor(device: string): string {
    return `${this.#epochBase}:${this.#epochN.get(device) ?? 0}`;
  }

  #bumpEpoch(device: string): void {
    this.#epochN.set(device, (this.#epochN.get(device) ?? 0) + 1);
  }

  /** B: a state from `device` counts only when it is newer than anything of the old link: in the same daemon's base, a
   *  count past the one in force when the link last dropped and not below the last one seen; a base older than the
   *  last one seen (an earlier daemon's, seen before or not) never counts on a message, nor does one ranked at or
   *  below the highest base seen once a direct reply took over with an older-ranked one (the daemons it replaced are
   *  retired: a late, reordered message of theirs never ends the live daemon's turns). A newer base is a new daemon there (a
   *  restart or a crash): no turn of the old one goes on, so they end, closed, before its state applies (a running
   *  turn never outlives a fresh opener). A state never lifts a hold while the link is down (`#setPeerPaused`).
   *  True when it was taken. */
  #stateFrom(device: string, epoch: string, paused: boolean, how: "message" | "direct" = "message"): boolean {
    const e = parseEpoch(epoch);
    if (!e) return false;
    const last = parseEpoch(this.#lastEpoch.get(device));
    const stale = parseEpoch(this.#staleEpoch.get(device));
    const high = this.#highBase.get(device);
    const older = last !== undefined && last.base !== e.base && (compareBases(e.base, last.base) < 0 || (high !== undefined && compareBases(e.base, high) <= 0));
    if (older && how !== "direct") {
      // An older base on a message: an earlier daemon's late message, or a daemon whose counter went back. Only the
      // direct reply to this side's own question on the live link tells them apart (only the lock holder answers).
      if (!this.#down.has(device)) void this.#askState(device).catch(() => {});
      return false;
    }
    if (last && last.base === e.base && e.n < last.n) return false;
    if (stale && stale.base === e.base && e.n <= stale.n) return false;
    if (last && last.base !== e.base) {
      for (const [id, r] of [...this.#running]) if (r.device === device) this.#abortTurn(id, true);
    }
    this.#staleEpoch.delete(device);
    this.#lastEpoch.set(device, epoch);
    if (high === undefined || compareBases(e.base, high) > 0) this.#highBase.set(device, e.base);
    this.#accepted.add(device);
    this.#setPeerPaused(device, paused);
    return true;
  }

  /** An authenticated message from `device` (paired, its token judged): when this side still has its link down, the
   *  link-up steps run before anything the message says is applied, but only if the transport says the link is up
   *  right now (the controller's ruling): a message taken before a drop and handled after it proves nothing, so its
   *  content is still handled but the hold and the grace stay. */
  #heard(device: string): void {
    if (!this.#down.has(device)) return;
    if (this.#o.transport.links().some((l) => l.peer === device && l.up)) this.#up(device);
  }

  close(): void {
    this.#closed = true;
    for (const off of this.#offs.splice(0)) off();
    for (const r of this.#running.values()) r.abort.abort();
    this.#running.clear();
    for (const t of this.#downTimers.values()) clearTimeout(t);
    this.#downTimers.clear();
  }

  // ---- B ----

  /** Whether the computer that opened an agent here has its bots paused (a dropped link counts as paused). */
  peerPaused(device: string): boolean {
    return this.#peerPaused.get(device) ?? true;
  }

  /** Called when a device's forwarded pause state may have moved. */
  watchPeerPause(fn: (device: string) => void): Unsubscribe {
    this.#pauseWatchers.add(fn);
    return () => this.#pauseWatchers.delete(fn);
  }

  /** A: this computer's state, as a notice to a device. */
  sendState(device: string): void {
    this.#notify(device, "agent.pause", { paused: this.#pausedFor(device) });
  }

  /** B → A: one line of an agent's transcript (its secrets already replaced), only while a turn of that device runs
   *  and isn't closed. */
  sendTranscript(device: string, id: string, file: string, text: string): void {
    const run = this.#running.get(id);
    if (!run || run.device !== device) return;
    this.#report(id, run, "agent.transcript", { id, turn: run.turn, file, text });
  }

  /** B → A: an agent's `SendMessage`, to its bot's computer, which checks where it may go. */
  async sendMessage(device: string, id: string, text: string, to?: string): Promise<void> {
    const link = await this.#o.transport.connect(device);
    await link.request("agent.message", { id, text, ...(to === undefined ? {} : { to }), ...fenceParam(this.#o.fence) });
  }

  #setPeerPaused(device: string, paused: boolean): void {
    // A state that arrived on a request the link has since dropped never lifts the hold: a dropped link reads as
    // paused until that computer says otherwise over the link that's back.
    if (!paused && this.#down.has(device)) return;
    // The opener said its state: what waited for it goes now.
    if (this.#awaitingState.delete(device)) this.#flush(device);
    if (this.#peerPaused.get(device) === paused) return;
    this.#peerPaused.set(device, paused);
    for (const fn of this.#pauseWatchers) fn(device);
  }

  #own(id: string, from: string): PeerHostedAgent {
    const e = this.#manager.peerHosted(id);
    if (!e) throw new ContractError("not_found", `no agent ${id} here; open it again`);
    if (e.peer.device !== from) throw new ContractError("refused", "only the computer that opened this agent may drive it; another one opens it again first");
    return e;
  }

  /** Interrupts an agent's running turn; `close`: its opener has ended it, so nothing more of it is sent. */
  #abortTurn(id: string, close = false): void {
    const r = this.#running.get(id);
    if (!r) return;
    if (close) {
      r.closed = true;
      // What it reported that hasn't gone yet never goes.
      const box = this.#outbox.get(r.device);
      if (box) {
        const keep = box.items.filter((m) => !(m.params["id"] === id && m.params["turn"] === r.turn && m.method !== "agent.turnEnded"));
        box.bytes = keep.reduce((n, m) => n + m.size, 0);
        box.items = keep;
      }
    }
    this.#running.delete(id);
    r.abort.abort();
  }

  /** B → A: a running turn's event or transcript line. Past the outbox's bound it fails closed: the turn is
   *  interrupted, one marker goes in its place, in order, and nothing more of it is queued but its end. */
  #report(id: string, run: RunningTurn, method: string, params: Record<string, unknown>): void {
    if (run.closed || run.overflowed) return;
    const size = sizeOf(params);
    const box = this.#box(run.device);
    if (box.bytes + size > (this.#o.outboxBytes ?? OUTBOX_BYTES)) {
      run.overflowed = true;
      this.#notify(run.device, "agent.truncated", { id, turn: run.turn });
      if (this.#running.get(id) === run) run.abort.abort();
      return;
    }
    this.#notify(run.device, method, params);
  }

  // ---- A ----

  /** A remote agent's driver, made once per session. */
  driver(entry: RemoteAgentEntry): RemoteAgentDriver {
    let d = this.#drivers.get(entry.id);
    if (!d) {
      d = new RemoteAgentDriver(this, entry);
      this.#drivers.set(entry.id, d);
    }
    return d;
  }

  forget(id: string): void {
    this.#drivers.delete(id);
  }

  /** The device a computer is on, or offline. */
  deviceOf(computer: string): string {
    const c = this.#o.computer(computer);
    if (!c) throw new ContractError("not_found", `no computer ${computer}`);
    if (!c.online) throw new ContractError("computer_offline", `${computer} is offline`, { computer });
    return c.device;
  }

  /** This computer's pause switch: true while its bots and their agents are paused. */
  #paused(): boolean {
    return this.#o.pause ? !this.#o.pause.mayAct() : false;
  }

  /** The state this computer tells a device: paused while its switch is, and while a turn it closed there hasn't
   *  been interrupted yet (fail closed). */
  #pausedFor(device: string): boolean {
    return this.#paused() || [...this.#drivers.values()].some((d) => d.device === device && d.interruptOutstanding);
  }

  pauseGate(): AgentPauseGate | undefined {
    return this.#o.pause;
  }

  get linkGraceMs(): number {
    return this.#o.linkGraceMs ?? LINK_GRACE_MS;
  }

  async request<R>(device: string, method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<R> {
    const link = await this.#o.transport.connect(device, signal ? { signal } : {});
    const state = method === "agent.open" || method === "agent.turn" ? { paused: this.#pausedFor(device), epoch: this.epochFor(device) } : {};
    return link.request<R>(method, { ...params, ...state, ...fenceParam(this.#o.fence) }, { ...(signal ? { signal } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  }

  #driverFrom(id: string, from: string): RemoteAgentDriver | undefined {
    const d = this.#drivers.get(id);
    return d && d.device === from ? d : undefined;
  }

  // ---- Both ----

  #box(device: string) {
    let box = this.#outbox.get(device);
    if (!box) {
      box = { items: [], bytes: 0, sending: false };
      this.#outbox.set(device, box);
    }
    return box;
  }

  /** Notices to one device go in order through its outbox, kept while the link is down and sent when it is back.
   *  Nothing is dropped here: a turn's reports are bounded before they come in (`#report`), and the pause, a turn's
   *  end and the truncation marker are small and always kept. */
  #notify(device: string, method: string, params: Record<string, unknown>): void {
    const box = this.#box(device);
    // Only the latest pause state is worth sending, with this side's link epoch as it is now.
    if (method === "agent.pause") {
      params = { ...params, epoch: this.epochFor(device) };
      const keep = box.items.filter((m) => m.method !== "agent.pause");
      if (keep.length !== box.items.length) {
        box.items = keep;
        box.bytes = keep.reduce((n, m) => n + m.size, 0);
      }
    }
    const size = sizeOf(params);
    box.items.push({ method, params, size });
    box.bytes += size;
    this.#flush(device);
  }

  #flush(device: string): void {
    const box = this.#outbox.get(device);
    if (!box || box.sending || box.items.length === 0 || this.#down.has(device)) return;
    box.sending = true;
    void (async () => {
      try {
        const link = await this.#o.transport.connect(device);
        while (!this.#down.has(device)) {
          // While that computer hasn't said its state, only this one's own pause state goes (it is what the other
          // side waits for); reports wait.
          const i = this.#awaitingState.has(device) ? box.items.findIndex((m) => m.method === "agent.pause") : box.items.length > 0 ? 0 : -1;
          if (i < 0) break;
          const m = box.items[i]!;
          link.notify(m.method, { ...m.params, ...fenceParam(this.#o.fence) });
          // Taken off only once the link took it.
          box.items.splice(i, 1);
          box.bytes -= m.size;
        }
      } catch {
        // Offline: the rest waits for the link to come back.
      } finally {
        box.sending = false;
      }
    })();
  }

  #fenceOk(token: FencingToken | undefined, what: string): boolean {
    try {
      checkFence(this.#o.fence, token, what);
      return true;
    } catch (err) {
      this.#o.log?.(`agents: dropped ${what}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  log(line: string): void {
    this.#o.log?.(line);
  }
}

// -------------------------------------------------------------------------------------------------
// A's driver for an agent on another computer
// -------------------------------------------------------------------------------------------------

interface ActiveTurn {
  turn: number;
  ctl: TurnControl;
  resolve(end: TurnEnd): void;
  /** Bytes of transcript streamed this turn. */
  streamed: number;
  truncated: boolean;
}

export class RemoteAgentDriver implements SessionDriver {
  readonly canFold = false;
  readonly #peers: AgentPeers;
  readonly #e: RemoteAgentEntry;
  #opened = false;
  #turn = 0;
  #active: ActiveTurn | undefined;
  #stopped = false;
  device: string;

  constructor(peers: AgentPeers, entry: RemoteAgentEntry) {
    this.#peers = peers;
    this.#e = entry;
    this.device = entry.device;
  }

  /** Opens the agent on its computer (`agent.open`): a refused backend or root fails here, before any turn. */
  async open(): Promise<void> {
    const e = this.#e;
    this.device = this.#peers.deviceOf(e.computer);
    e.device = this.device;
    // A fresh driver says its state, with this daemon's epoch, before its first open.
    this.#peers.sendState(this.device);
    const reply = await this.#peers.request<{ pluginId?: unknown }>(this.device, "agent.open", {
      id: e.id, backend: e.backend, root: e.root,
      ...(e.bot === undefined ? {} : { bot: e.bot }), ...(e.parent === undefined ? {} : { parent: e.parent }),
      ...(e.level === undefined ? {} : { level: e.level }),
      ...(e.model === undefined ? {} : { model: e.model }), ...(e.effort === undefined ? {} : { effort: e.effort }),
      ...(e.daemon.agentSessionId === undefined ? {} : { reattach: e.daemon.agentSessionId }),
      ...(e.daemon.pluginId === undefined ? {} : { pluginId: e.daemon.pluginId }),
    });
    if (typeof reply?.pluginId === "string") e.pinned(reply.pluginId);
    this.#opened = true;
  }

  async turn(input: TurnInput, ctl: TurnControl): Promise<TurnEnd> {
    if (this.#stopped) return { reason: "stopped" };
    // This computer's pause holds the next prompt here too; B holds the calls of one already running.
    if (!(await holdWhilePaused(this.#peers.pauseGate(), ctl.signal))) return { reason: "interrupted" };
    let prompt: PeerPromptInput["prompt"];
    try {
      prompt = await this.#e.promptOf(input);
    } catch (err) {
      return { reason: "failed", failure: "error", text: err instanceof Error ? err.message : String(err) };
    }
    const turn = ++this.#turn;
    const done = new Promise<TurnEnd>((resolve) => {
      this.#active = { turn, ctl, resolve, streamed: 0, truncated: false };
    });
    const send = async () => {
      // A turn closed at the grace is interrupted there before anything else goes.
      if (!(await this.#closeEndedTurn())) throw new ContractError("offline", `${this.#e.computer} didn't take the interrupt of the turn that ended while it was away`);
      if (!this.#opened) await this.open();
      await this.#peers.request(this.device, "agent.turn", { id: this.#e.id, turn, prompt, origin: ctl.origin });
    };
    try {
      try {
        await send();
      } catch (err) {
        // The other computer restarted (or a new main took over there): open the agent again, resuming its session.
        if (!isContractError(err, "not_found")) throw err;
        this.#opened = false;
        await send();
      }
    } catch (err) {
      // An `agent.turn` whose answer the link lost may have been taken there: the turn is owed its closing interrupt
      // (sent at reconnect before the pause state, as for a turn ended at the grace), and the next turn opens the
      // agent again, which ends any turn still running there.
      if (isContractError(err, "offline") || isContractError(err, "computer_offline") || isContractError(err, "closed") || isContractError(err, "timeout")) {
        this.#endedAtGrace = turn;
        this.#opened = false;
      }
      this.#finish(turn, failedTurn(this.#e.computer, err));
      return done;
    }
    const onAbort = () => void this.#peers.request(this.device, "agent.interrupt", { id: this.#e.id }).catch(() => {});
    ctl.signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await done;
    } finally {
      ctl.signal.removeEventListener("abort", onAbort);
    }
  }

  /** An event of the running turn, recorded in the session's log; it counts toward the turn's budget too. */
  event(turn: number, event: Record<string, unknown>): void {
    const a = this.#active;
    if (!a || a.turn !== turn || typeof event["type"] !== "string" || a.truncated) return;
    const size = JSON.stringify(event).length;
    if (size > MAX_STREAM_EVENT) return;
    if (!this.#spend(a, size)) return;
    if (event["type"] === "agent_started" && typeof event["agentSessionId"] === "string" && event["agentSessionId"].length <= 256) {
      this.#e.started(event["agentSessionId"]);
    }
    a.ctl.record(event as { type: string });
  }

  /** A line of the agent's transcript: only for the turn running here, into one of the three logs, bounded per line
   *  and per turn. */
  transcriptLine(turn: number, file: string, text: string): void {
    const a = this.#active;
    if (!a || a.turn !== turn || a.truncated) return;
    const t = this.#e.transcript;
    if (text.length > MAX_STREAM_LINE) {
      t.call({ type: "stream-refused", file, why: "line too long", length: text.length });
      return;
    }
    if (!this.#spend(a, text.length)) return;
    t.appendFromPeer(file, text);
  }

  /** Counts toward the turn's budget; past it, one record says so and the rest of the turn is dropped. */
  #spend(a: ActiveTurn, size: number): boolean {
    if (a.streamed + size > MAX_STREAM_TURN) {
      this.#truncate(a, "budget");
      return false;
    }
    a.streamed += size;
    return true;
  }

  #truncate(a: ActiveTurn, by: "budget" | "outbox"): void {
    if (a.truncated) return;
    a.truncated = true;
    this.#e.transcript.call({ type: "stream-truncated", by, ...(by === "budget" ? { cap: MAX_STREAM_TURN } : {}) });
    a.ctl.record({ type: "agent_stream_truncated", by });
  }

  /** The other computer's outbox overflowed for this turn: it interrupted the turn, and its end follows. */
  truncatedThere(turn: number): void {
    const a = this.#active;
    if (a && a.turn === turn) this.#truncate(a, "outbox");
  }

  ended(turn: number, end: TurnEnd): void {
    this.#finish(turn, end);
  }

  #grace: ReturnType<typeof setTimeout> | undefined;
  /** A turn this side ended at the grace, which the other computer must not go on with. */
  #endedAtGrace: number | undefined;

  /** The link to the agent's computer dropped: the agent is held there (paused) and the turn waits for the link, up
   *  to the grace; past it the turn ends, and the agent's session stays there for the next one. */
  linkDown(): void {
    const a = this.#active;
    if (!a || this.#grace !== undefined) return;
    this.#grace = setTimeout(() => {
      this.#grace = undefined;
      if (this.#active !== a) return;
      this.#endedAtGrace = a.turn;
      // Cancelled, not failed: the session stays for the next message, which reaches the agent once the link is back.
      this.#finish(a.turn, { reason: "cancelled", text: `${this.#e.computer} went offline, so this turn ended; message the agent to go on once it is back.` });
    }, this.#peers.linkGraceMs);
  }

  /** The link is back: a turn ended at the grace is interrupted there, closed, before anything else goes. */
  async linkUp(): Promise<boolean> {
    this.#clearGrace();
    return this.#closeEndedTurn();
  }

  /** A turn this side ended at the grace still has to be interrupted there. */
  get interruptOutstanding(): boolean {
    return this.#endedAtGrace !== undefined;
  }

  /** Interrupts, closed, the turn this side ended at the grace; it stays owed until the other computer took it. */
  async #closeEndedTurn(): Promise<boolean> {
    const turn = this.#endedAtGrace;
    if (turn === undefined) return true;
    try {
      await this.#peers.request(this.device, "agent.interrupt", { id: this.#e.id, turn, closed: true });
    } catch (err) {
      // Still owed only while the other computer may yet run it: it couldn't be reached. No agent there (it restarted
      // or closed) means no turn to close, and a refusal means another device took the agent, whose fence decides.
      if (!isContractError(err, "not_found") && !isContractError(err, "refused")) return false;
    }
    if (this.#endedAtGrace === turn) this.#endedAtGrace = undefined;
    return true;
  }

  #clearGrace(): void {
    if (this.#grace !== undefined) clearTimeout(this.#grace);
    this.#grace = undefined;
  }

  #finish(turn: number, end: TurnEnd): void {
    const a = this.#active;
    if (!a || a.turn !== turn) return;
    this.#active = undefined;
    this.#clearGrace();
    a.resolve(end);
  }

  async interrupt(): Promise<void> {
    if (!this.#active) return;
    await this.#peers.request(this.device, "agent.interrupt", { id: this.#e.id }).catch(() => {});
  }

  async setModel(model: string, effort?: string): Promise<void> {
    await this.#peers.request(this.device, "agent.setModel", { id: this.#e.id, model, ...(effort === undefined ? {} : { effort }) });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const a = this.#active;
    if (a) this.#finish(a.turn, { reason: "stopped" });
    await this.#peers.request(this.device, "agent.stop", { id: this.#e.id }).catch((err) => {
      this.#peers.log(`agents: ${this.#e.id} on ${this.#e.computer} wasn't told to stop: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.#peers.forget(this.#e.id);
    this.#e.gone();
  }

  /** This daemon is closing: nothing is said to the other computer, which keeps the agent for the next one. */
  detach(): void {
    this.#stopped = true;
    const a = this.#active;
    if (a) this.#finish(a.turn, { reason: "stopped" });
    this.#peers.forget(this.#e.id);
  }
}

/** A link epoch, `<base>:<count>`. */
function parseEpoch(epoch: string | undefined): { base: string; n: number } | undefined {
  if (epoch === undefined) return undefined;
  const i = epoch.lastIndexOf(":");
  const n = Number(epoch.slice(i + 1));
  if (i <= 0 || !Number.isSafeInteger(n) || n < 0) return undefined;
  return { base: epoch.slice(0, i), n };
}

/** Orders two daemon bases (`<boot counter>-<random>`): by the counter, then by the random part; a base that names
 *  none sorts first. */
function compareBases(a: string, b: string): number {
  return (bootOf(a) ?? 0) - (bootOf(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
}

/** The highest boot counter (2^52): past it a counter reads as broken, and a new one stays at it. */
export const MAX_BOOT_COUNTER = 2 ** 52;

/** A counter as written: digits only, at most `MAX_BOOT_COUNTER`; anything else (empty, `1e15`, `0x10`, `-1`) is
 *  broken. */
function counterOf(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) && n <= MAX_BOOT_COUNTER ? n : undefined;
}

/** A base's boot counter (`<counter>-<random>`), or undefined when it names none. */
function bootOf(base: string): number | undefined {
  const i = base.indexOf("-");
  return i > 0 ? counterOf(base.slice(0, i)) : undefined;
}

/** The boot counter's file and the last base this home sent, in the fenced run folder. */
export function bootFiles(home: string): { counter: string; lastBase: string } {
  const dir = join(home, "run", "agents");
  return { counter: join(dir, "boot-counter"), lastBase: join(dir, "last-base") };
}

/** Writes a file so a crash leaves the old one or the new one, never part of either: a temp file written and
 *  flushed to disk, then renamed over it, then the folder flushed (macOS and Linux; Windows can't open a folder). */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    const buf = Buffer.from(text, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (process.platform !== "win32") {
    const dir = openSync(join(path, ".."), constants.O_RDONLY);
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
}

/** A daemon's base (the controller's ruling on #240): the home's boot counter, one up at every start, with 64 random
 *  bits. The counter, never the wall clock, orders daemons: a clock stepped back can't make a new daemon's base sort
 *  older. A counter that isn't digits only, or is past `MAX_BOOT_COUNTER`, is broken; a missing or broken one starts
 *  from the larger of the wall clock's seconds and one above the last base this home sent (a file of its own, so
 *  losing one file can't go backwards), and never below that. At `MAX_BOOT_COUNTER` it stays there. Both files are
 *  written durably (`writeAtomic`) before any link comes up. Where both are lost and the clock stepped back, the base
 *  can still rank older than one a peer saw; the peer then takes the direct reply to its own `agent.state` on the live
 *  link (`#askState`), so that is never a lockout.
 *
 *  One daemon per home: this relies on `run/core.lock` (`acquireLock`, src/lock.ts), so two daemons never read and
 *  bump the counter at once. When `createAgents` is wired into the daemon, `AgentPeers` (which calls this) must be
 *  built after `acquireLock` has succeeded. */
export function nextBootBase(home: string): string {
  const files = bootFiles(home);
  const readText = (path: string): string | undefined => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return undefined;
    }
  };
  const lastText = readText(files.lastBase);
  const lastSent = lastText === undefined ? undefined : bootOf(lastText);
  const counterText = readText(files.counter);
  const counter = counterText === undefined ? undefined : counterOf(counterText);
  const floor = lastSent === undefined ? 0 : lastSent + 1;
  const next = Math.min(MAX_BOOT_COUNTER, counter !== undefined
    ? Math.max(counter + 1, floor)
    : Math.max(Math.floor(Date.now() / 1000), floor));
  const base = `${next}-${randomBytes(8).toString("hex")}`;
  mkdirSync(join(home, "run", "agents"), { recursive: true, mode: 0o700 });
  writeAtomic(files.counter, `${next}\n`);
  writeAtomic(files.lastBase, `${base}\n`);
  return base;
}

/** A notice's size as it travels. */
function sizeOf(params: Record<string, unknown>): number {
  try {
    return JSON.stringify(params).length;
  } catch {
    return MAX_STREAM_LINE;
  }
}

function failedTurn(computer: string, err: unknown): TurnEnd {
  const text = err instanceof Error ? err.message : String(err);
  const failure: SessionFailure = "error";
  if (isContractError(err, "computer_offline") || isContractError(err, "offline")) {
    return { reason: "cancelled", text: `${computer} is offline, so the agent there didn't get this turn; message it again once ${computer} is back.` };
  }
  if (isContractError(err, "refused") || isContractError(err, "not_installed") || isContractError(err, "fenced")) return { reason: "refusal", text };
  return { reason: "failed", failure, text };
}

/** Waits while `gate` says paused; false when `signal` aborts first. */
async function holdWhilePaused(gate: AgentPauseGate | undefined, signal: AbortSignal): Promise<boolean> {
  if (!gate || gate.mayAct()) return !signal.aborted;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let off: (() => void) | undefined;
    const done = () => {
      if (timer !== undefined) clearInterval(timer);
      off?.();
      signal.removeEventListener("abort", done);
      resolve();
    };
    const check = () => { if (gate.mayAct()) done(); };
    signal.addEventListener("abort", done, { once: true });
    off = gate.watch?.(check);
    timer = setInterval(check, 1_000);
    check();
  });
  return !signal.aborted;
}
