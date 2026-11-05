// How a session's log records reach clients (spec §5.4 `conversation.read`, §6.4, §8.5). Owner: lane D.
//
// The host's records are its own vocabulary (contracts/session-host.ts); clients read events. Each record projects
// onto at most one event, with the inherited envelope (`seq`, `sessionId`, `ts`) and the lease epoch:
//
// | Record                                   | Event                                                          |
// | :--------------------------------------- | :------------------------------------------------------------- |
// | the user's input                         | the inherited `user_message`, with `device` and `sentAt`       |
// | another bot's message                    | `bot_message`                                                  |
// | an agent's message                       | `agent_message`                                                |
// | a task notification                      | `agent_finished`                                               |
// | a routine's input in a bot's conversation| `routine_result` (its short result, §7)                        |
// | a routine's input in a side thread       | `note` from the core, labelled with the routine's name (the run's instructions) |
// | a plugin's message                       | `plugin_message`                                               |
// | a note                                   | `note`                                                         |
// | a turn starting / ending                 | the inherited `turn_started` / `turn_completed`                |
// | a status change                          | none: it reaches clients as `session_changed`                  |
// | the runtime's own event                  | itself, when it is a `SessionEvent` or a Clover session event  |
//
// Runtime events of other types are the runtime's private bookkeeping (`turn_usage`, which the usage counter reads)
// and never leave the daemon. For a plugin reader (`conversation.read`), the sealed parts of approval and elicitation
// events are left out (§5.4: "sealed card fields never reach it").
import { CloverSessionEvent, SessionEvent, type SessionKind } from "@waifucave/clover-protocol";
import type { SessionRecord, TurnEnd } from "../contracts/session-host";

export type WireEvent = { type: string; seq: number; sessionId: string; ts: number; [key: string]: unknown };

/** The `type`s a runtime event may have to reach clients. */
export const WIRE_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...SessionEvent.options.map((o) => o.shape.type.value as string),
  ...CloverSessionEvent.options.map((o) => o.shape.type.value as string),
]);

/** The parts of a card a plugin never reads, by event type. */
const SEALED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  approval_requested: ["summary", "reviewerReason", "options"],
  elicitation_requested: ["message", "host", "origin", "serverName"],
};

export interface ProjectOptions {
  /** The session's kind decides what a routine's input is. */
  kind: SessionKind;
  /** A plugin reads it: sealed card parts are left out. */
  forPlugin?: boolean;
}

function turnCompletedStopReason(reason: TurnEnd["reason"]): "end_turn" | "aborted" | "error" {
  switch (reason) {
    case "end_turn":
    case "refusal":
      return "end_turn";
    case "failed":
      return "error";
    default:
      return "aborted";
  }
}

export function projectRecord(record: SessionRecord, opts: ProjectOptions): WireEvent | undefined {
  const envelope = {
    seq: record.seq,
    sessionId: record.sessionId,
    ts: record.ts,
    ...(record.epoch === undefined ? {} : { epoch: record.epoch }),
  };
  const threadId = record.sessionId;
  switch (record.type) {
    case "input": {
      const input = record.input;
      switch (input.from) {
        case "user":
          return {
            type: "user_message", ...envelope, threadId, text: input.text,
            // The inherited event names the client; Clover's user input carries the device it came from instead.
            clientName: input.device, device: input.device, sentAt: input.sentAt,
            ...(input.images !== undefined && input.images.length > 0 ? { images: input.images } : {}),
            ...(input.files !== undefined && input.files.length > 0 ? { files: input.files } : {}),
          };
        case "bot":
          return { type: "bot_message", ...envelope, from: input.bot, fromSession: input.session, text: input.text };
        case "agent":
          return { type: "agent_message", ...envelope, agent: input.agent, text: input.text };
        case "task-notification":
          return {
            type: "agent_finished", ...envelope, agent: input.agent, backend: input.backend, stopReason: input.stopReason,
            text: input.text, transcript: input.transcript, ...(input.usage === undefined ? {} : { usage: input.usage }),
          };
        case "routine":
          if (opts.kind === "side-thread") {
            return { type: "note", ...envelope, from: { kind: "core" }, label: input.name.slice(0, 120), text: input.text };
          }
          return { type: "routine_result", ...envelope, routine: input.routine, name: input.name, sideThread: input.sideThread, text: input.text };
        case "plugin":
          return {
            type: "plugin_message", ...envelope, from: { kind: "plugin", pluginId: input.pluginId }, text: input.text,
            ...(input.app === undefined ? {} : { app: input.app }),
          };
        case "note":
          return { type: "note", ...envelope, from: input.by, label: input.label, text: input.text };
      }
      return undefined;
    }
    case "turn_started":
      return { type: "turn_started", ...envelope, threadId };
    case "turn_ended":
      return {
        type: "turn_completed", ...envelope, threadId, stopReason: turnCompletedStopReason(record.end.reason),
        inputTokens: record.end.usage?.inputTokens ?? 0, outputTokens: record.end.usage?.outputTokens ?? 0,
      };
    case "status":
      return undefined;
    case "driver": {
      const event = record.event;
      if (!WIRE_EVENT_TYPES.has(event.type)) return undefined;
      const out: WireEvent = { ...structuredClone(event), ...envelope, ...(typeof event.threadId === "string" ? {} : { threadId }) };
      if (opts.forPlugin) for (const field of SEALED_FIELDS[event.type] ?? []) delete out[field];
      return out;
    }
  }
}

/** The events of some records, in order; records with no event are left out. */
export function projectRecords(records: readonly SessionRecord[], opts: ProjectOptions): WireEvent[] {
  const out: WireEvent[] = [];
  for (const r of records) {
    const e = projectRecord(r, opts);
    if (e !== undefined) out.push(e);
  }
  return out;
}
