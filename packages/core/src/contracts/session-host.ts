// Contract: SessionHost (spec §6.3, §6.4 "Messages, interrupts and the main computer", §7 side threads, §9.3 background
// agents; spike S5 §8). Owners: lane D (sessions and bots) and lane A (the embedded runtime that drives their turns),
// with lane K's sign-off for agents.
//
// A session is any running conversation: a bot's main conversation, a side thread (a routine run), a background
// agent, or a coding session the user started. The host keeps every session's state and log and routes input to it;
// a driver runs its turns: lane A's embedded runtime for bots and side threads, lane K's ACP client for agents.
//
// The routing rules the contract pins (and the fake keeps):
// * The user's message to a bot's main conversation interrupts the current step at once and starts a new step with
//   it (§6.4): the model's answer is cancelled, a running tool call is recorded interrupted, and the step's pending
//   cards are withdrawn. It never touches side threads or background agents.
// * To an agent or a coding session, the user's message is its next prompt, queued while a turn runs, since ACP has no
//   standard mid-turn input (S5 §8).
// * Messages from other bots, agents, routines, plugins and task notifications fold into a running turn after its next
//   tool call where the driver can fold (the embedded runtime), are queued where it can't (ACP agents), and start a
//   turn when the session is idle. A note never starts a turn (§5.4 `conversation.post`, §6.1).
// * When a background agent's turn ends with nothing queued, its bot's main conversation gets a task notification
//   with the final text unchanged, the stop reason, usage when given and the transcript path (§9.3, S5 §8).
// * A session that stops has its pending cards cancelled; one the user interrupts has them withdrawn.
// * The user can message a bot only while connected to the computer running it (§6.4): otherwise `bot_asleep`.
// * Messages keep send order on the shared clock; one whose stamp falls before output the model already produced is
//   placed after that output, keeping its real send time (§6.4 "Late arrivals"). The user's messages waiting together
//   run in `(sentAt, device)` order (`compareStamps`), whatever order they arrived in from their devices. The host
//   clamps every `sentAt` to its receive time plus or minus `SENT_AT_WINDOW_MS` (`clampSentAt`, review N5) before it
//   orders or records the message, so a skewed or hostile stamp can't jump the queue or backdate the transcript.
// * A user's message another computer relays (`peer.session.send`) is the user's turn only with the sending device's
//   good signature (`verifyUserMessage`, review N3): over the session, the message id, the message's hash and its
//   own `sentAt`, by a device that may answer cards, its `sentAt` inside the window. Otherwise it still reaches the
//   session, but its turn's origin is `peer`, never `user`: its cards expire and nothing it asks counts as the user's.
//
// The log records are the host's own vocabulary. Lane D projects them onto the wire: the user's `input` is the
// inherited `user_message` with `UserMessageStamp`, from a bot `bot_message`, from an agent `agent_message`, a task
// notification `agent_finished`, a routine `routine_result`, a plugin's message `plugin_message`, a note `note`; turns
// map to `turn_started` and `turn_completed`; `driver` records are the runtime's own events (tool calls, text,
// thinking). A session's view carries its needs-you counts (`SessionView.needsYou`): its pending cards and its
// unanswered questions.
import {
  SENT_AT_WINDOW_MS, type SessionFailure, type SessionKind, type SessionStatus, type SessionView, type TurnOrigin, type UserMessageInput,
  userMessageHashInput, userMessageSigningInput,
} from "@waifucave/clover-protocol";
import { fromBase64, type Unsubscribe } from "./common";
import { mayAnswerCards, type DeviceRegistry } from "./device-registry";

export type AgentStopReason = "end_turn" | "refusal" | "cancelled" | "stopped" | "stalled" | "sign-in" | "crashed" | "error";

export type UserInput = {
  from: "user";
  text: string;
  /** The device it came from and its send time on the shared clock (§6.4, §9.1). */
  device: string;
  sentAt: number;
  clientMessageId: string;
  images?: { n: number; path: string }[];
  /** Other attachments, as folder-tree paths (§8.5). */
  files?: { n: number; path: string }[];
  /** Set when another computer relayed it (`peer.session.send`): the relaying computer's device, and whether the
   *  sending device's signature held (`verifyUserMessage`). Unsigned, its turn's origin is `peer` (review N3). */
  relayed?: { by: string; signed: boolean };
};

export type DeliveredInput =
  | { from: "bot"; bot: string; session: string; text: string }
  | { from: "agent"; agent: string; text: string }
  | { from: "task-notification"; agent: string; backend: string; stopReason: AgentStopReason; text: string; transcript: string; usage?: { inputTokens: number; outputTokens: number } }
  | { from: "routine"; routine: string; name: string; sideThread: string; text: string }
  /** A plugin's `conversation.send`, or an MCP Apps page's `ui/message` (`app`), which is never the user's (§5.5). */
  | { from: "plugin"; pluginId: string; text: string; app?: { callId: string } }
  | { from: "note"; label: string; text: string; by: { kind: "plugin"; pluginId: string } | { kind: "hook"; pluginId: string; hook: string } | { kind: "core" } };

export type TurnInput = UserInput | DeliveredInput;

/** What the host did with an input. `interrupted`: it stopped the running step and started a new one. */
export type Disposition = "turn" | "interrupted" | "folded" | "queued" | "note";

/** The origin of the turn an input starts (§5.5: only the user's own message makes its cards wait). */
export function originOf(input: TurnInput): TurnOrigin {
  switch (input.from) {
    case "user":
      return input.relayed && !input.relayed.signed ? "peer" : "user";
    case "bot":
      return "bot";
    case "agent":
      return "agent";
    case "task-notification":
      return "task-notification";
    case "routine":
      return "routine";
    case "plugin":
    case "note":
      return "plugin";
  }
}

/** How the computer running a bot checks a relayed user message (review N3): the sending device may answer cards, the
 *  message carries its own `sentAt` within `SENT_AT_WINDOW_MS` of `now`, and the device's answer key signed
 *  `userMessageSigningInput` over this session, the message id, the message's hash and that `sentAt`. */
export async function verifyUserMessage(
  m: { session: string; device: string; message: Pick<UserMessageInput, "text" | "images" | "files" | "clientMessageId" | "sentAt" | "signature"> },
  c: { now: number; sha256(text: string): string; devices: Pick<DeviceRegistry, "get" | "verifyAnswer"> },
): Promise<boolean> {
  const { message } = m;
  if (message.signature === undefined || message.sentAt === undefined) return false;
  if (Math.abs(message.sentAt - c.now) > SENT_AT_WINDOW_MS) return false;
  const device = c.devices.get(m.device);
  if (!device || !mayAnswerCards(device)) return false;
  const signature = fromBase64(message.signature);
  if (!signature) return false;
  const input = userMessageSigningInput({ session: m.session, clientMessageId: message.clientMessageId, hash: c.sha256(userMessageHashInput(message)), sentAt: message.sentAt });
  return c.devices.verifyAnswer(m.device, new TextEncoder().encode(input), signature);
}

export interface SessionSpec {
  id?: string;
  kind: SessionKind;
  bot?: string;
  /** A side thread's or a background agent's bot's main session, which gets its results. */
  parent?: string;
  /** The computer running it (§6.4). */
  computer: string;
  title?: string;
  backend?: string;
  model?: string;
  effort?: string;
  root?: string;
  routine?: string;
}

export interface TurnEnd {
  reason: "end_turn" | "refusal" | "interrupted" | "cancelled" | "stopped" | "failed";
  /** The final text, unchanged (S5 §8). */
  text?: string;
  usage?: { inputTokens: number; outputTokens: number };
  failure?: SessionFailure;
}

export interface TurnControl {
  readonly origin: TurnOrigin;
  /** Aborted when the user interrupts the step or the session stops. */
  readonly signal: AbortSignal;
  /** Input folded into this turn: the driver takes it after its next tool call. */
  onFold(fn: (input: TurnInput) => void): Unsubscribe;
  /** Adds the driver's own event to the session's log. */
  record(event: { type: string; [key: string]: unknown }): void;
}

/** Runs one session's turns. */
export interface SessionDriver {
  /** True where input can join a running turn after its next tool call (the embedded runtime); false for ACP agents. */
  readonly canFold: boolean;
  turn(input: TurnInput, ctl: TurnControl): Promise<TurnEnd>;
  /** Stops the current step; the turn then ends `interrupted`. */
  interrupt(): Promise<void>;
  /** Ends the session: for an agent, ACP's cancel, then the end of its process group (§9.3). */
  stop(): Promise<void>;
}

export type SessionRecordBody =
  | { type: "input"; input: TurnInput; disposition: Disposition }
  | { type: "turn_started"; origin: TurnOrigin }
  | { type: "turn_ended"; end: TurnEnd }
  | { type: "status"; status: SessionStatus; failure?: SessionFailure }
  | { type: "driver"; event: { type: string; [key: string]: unknown } };

export type SessionRecord = SessionRecordBody & {
  seq: number;
  sessionId: string;
  /** When it was recorded, on the shared clock. */
  ts: number;
  /** The lease epoch it was recorded under (§6.4 "Events carry their lease epoch"). */
  epoch?: number;
};

export interface SessionHost {
  open(spec: SessionSpec, driver: SessionDriver): SessionView;
  list(filter?: { bot?: string; kind?: SessionKind; parent?: string }): SessionView[];
  get(id: string): SessionView | undefined;
  /** The user's message. Its `sentAt` is clamped to the host's clock plus or minus `SENT_AT_WINDOW_MS` first (N5). */
  sendUser(id: string, input: Omit<UserInput, "from">): Promise<{ disposition: Disposition }>;
  deliver(id: string, input: DeliveredInput): Promise<{ disposition: Disposition }>;
  /** The user's interrupt of this session's current step. */
  interrupt(id: string): Promise<void>;
  /** `TaskStop`, or the session ending. */
  stop(id: string, reason?: string): Promise<void>;
  history(id: string, opts?: { afterSeq?: number; limit?: number }): SessionRecord[];
  subscribe(id: string, fn: (record: SessionRecord) => void): Unsubscribe;
  watch(fn: (view: SessionView) => void): Unsubscribe;
}
