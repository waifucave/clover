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
// |                                          | the host doesn't project itself (`HOST_EVENT_TYPES`)           |
// | an ACP agent's record (lane K's driver)  | the inherited event it reads as (`ACP_RECORDS`), so an agent's |
// |                                          | live tab reads like a code session's (item 90)                 |
//
// Runtime events of other types are the runtime's private bookkeeping (`turn_usage`, which the usage counter reads)
// and never leave the daemon. For any reader but the user's own app and devices (a plugin's `conversation.read`, a
// session, the CLI a bot can run), the sealed parts of approval and elicitation events are left out (§5.4: "sealed card
// fields never reach it"), and of the streaming events only the reply's text is sent.
import { CloverSessionEvent, SessionEvent, type Caller, type SessionKind } from "@waifucave/clover-protocol";
import type { SessionRecord, TurnEnd } from "../contracts/session-host";
import { contextTokensOf } from "./compaction";

export type WireEvent = { type: string; seq: number; sessionId: string; ts: number; [key: string]: unknown };

/** The `type`s a runtime event may have to reach clients. */
export const WIRE_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...SessionEvent.options.map((o) => o.shape.type.value as string),
  ...CloverSessionEvent.options.map((o) => o.shape.type.value as string),
]);

/** The types the host projects from its own records. A runtime event of one of them is an echo (or a forgery: a
 *  driver's `user_message` would read as the user's) and never reaches clients. */
export const HOST_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user_message", "turn_started", "turn_completed", "bot_message", "agent_message", "agent_finished", "routine_result",
  "note", "plugin_message",
]);

/** How lane K's ACP driver's records read on the wire (item 90's live tab): its text as the assistant's message, a
 *  tool call as a tool call, a call's end as its result. Thoughts and usage stay in the daemon. */
export function acpRecordEvent(event: { type: string; [key: string]: unknown }): { type: string; [key: string]: unknown } | undefined {
  const s = (k: string) => (typeof event[k] === "string" ? (event[k] as string) : undefined);
  switch (event.type) {
    case "agent_text":
      return s("text") === undefined ? undefined : { type: "assistant_message", text: s("text") };
    case "agent_tool_call": {
      const id = s("id");
      const name = s("title") || s("kind");
      if (!id || !name) return undefined;
      let argsJson = "{}";
      try {
        argsJson = JSON.stringify(event["rawInput"] ?? {}) ?? "{}";
      } catch {
        // A raw input that doesn't serialize shows as none.
      }
      return { type: "tool_call", callId: id, name, argsJson };
    }
    case "agent_tool_call_update": {
      const id = s("id");
      const status = s("status");
      if (!id || (status !== "completed" && status !== "failed")) return undefined;
      const output = status === "completed" ? "" : event["refused"] === true ? "Refused." : "Failed.";
      return { type: "tool_result", callId: id, output, isError: status === "failed" };
    }
    default:
      return undefined;
  }
}

/** The parts of a card only the user's own app and devices read, by event type. */
const SEALED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  approval_requested: ["summary", "reviewerReason", "options"],
  elicitation_requested: ["message", "host", "origin", "serverName"],
};

export interface ProjectOptions {
  /** The session's kind decides what a routine's input is. */
  kind: SessionKind;
  /** A reader other than the user's own app or devices (a plugin, a session, the CLI a bot can run): sealed card parts
   *  are left out. */
  sealed?: boolean;
}

/** Whether a caller reads sealed card parts: only the user, through the app, a phone or the web, never the CLI. */
export function readsSealed(caller: Caller): boolean {
  return caller.kind === "user" && caller.client !== "cli";
}

/** The streaming events a caller gets: everything for the user's own clients, only the reply's text otherwise. */
export function transientFor(caller: Caller, type: string): boolean {
  return readsSealed(caller) || type === "assistant_delta";
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
          return { type: "routine_result", ...envelope, routine: input.routine, name: input.name, sideThread: input.sideThread, text: input.text, failed: input.failed ?? false };
        case "plugin":
          return {
            type: "plugin_message", ...envelope, from: { kind: "plugin", pluginId: input.pluginId }, text: input.text,
            ...(input.app === undefined ? {} : { app: input.app }),
          };
        case "note":
          return { type: "note", ...envelope, from: input.by, label: input.label, text: input.text };
        case "task":
          return { type: "note", ...envelope, from: { kind: "core" }, label: input.status === "event" ? "Background task event" : `Background task ${input.status}`, text: input.text };
      }
      return undefined;
    }
    case "turn_started":
      return { type: "turn_started", ...envelope, threadId };
    case "turn_ended":
      return {
        type: "turn_completed", ...envelope, threadId, stopReason: turnCompletedStopReason(record.end.reason),
        inputTokens: record.end.usage?.inputTokens ?? 0, outputTokens: record.end.usage?.outputTokens ?? 0,
        ...(contextTokensOf(record.end.usage) === undefined ? {} : { contextTokens: contextTokensOf(record.end.usage) }),
      };
    case "status":
      return undefined;
    case "driver": {
      const acp = opts.kind === "agent" || opts.kind === "coding" ? acpRecordEvent(record.event) : undefined;
      const event = acp ?? record.event;
      if (!WIRE_EVENT_TYPES.has(event.type) || HOST_EVENT_TYPES.has(event.type)) return undefined;
      const out: WireEvent = { ...structuredClone(event), ...envelope, ...(typeof event.threadId === "string" ? {} : { threadId }) };
      if (opts.sealed) for (const field of SEALED_FIELDS[event.type] ?? []) delete out[field];
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
