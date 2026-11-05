// Who is calling the tool, and whose tabs that means.
//
// Ruling R7: an `api.browser` call this plugin makes while serving a tool call acts as the session that made the tool
// call. The core binds that session from the tool call's own context, which the plugin host carries (lane B, B-M1 and
// B-M2), and never from anything the plugin says; so the core holds each session to its own tabs whatever this tool
// does. The tool still needs to know whose tabs to list and open, and checks the owner again itself.
//
// Until the plugin host carries the context, the tool reads it where the core, as the MCP client, puts it: the
// request's `params._meta` under `clover/caller`, shaped like the protocol's `Caller`. The model's words land in
// `params.arguments`, and anything that looks like a caller there is ignored. This file is the one place that reads it,
// so moving to the host's context touches only it.
import type { Caller, ClientKind, SessionKind, TabOwner } from "./types";

export const CALLER_META_KEY = "clover/caller";

/** A bot's id is its plugin's id, a child's included (`luna`, `pack/luna`); each part 2–40 characters. */
const BOT_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\/[a-z][a-z0-9]*(-[a-z0-9]+)*)?$/;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DEVICE_ID_RE = /^[a-z0-9]{16,64}$/;
const SESSION_KINDS: readonly SessionKind[] = ["bot", "side-thread", "agent", "coding"];
const CLIENT_KINDS: readonly ClientKind[] = ["app", "cli", "ios", "web"];

export function isBotId(bot: unknown): bot is string {
  if (typeof bot !== "string" || bot.length > 81 || !BOT_ID_RE.test(bot)) return false;
  return bot.split("/").every((part) => part.length >= 2 && part.length <= 40);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The caller the core put on a request (`params._meta["clover/caller"]`), or undefined when there is none or it isn't
 *  shaped like a `Caller`. A malformed one is never guessed at. */
export function callerFromRequest(params: unknown): Caller | undefined {
  if (!isRecord(params) || !isRecord(params._meta)) return undefined;
  return parseCaller(params._meta[CALLER_META_KEY]);
}

export function parseCaller(raw: unknown): Caller | undefined {
  if (!isRecord(raw)) return undefined;
  const bot = raw.bot;
  if (bot !== undefined && !isBotId(bot)) return undefined;
  switch (raw.kind) {
    case "session": {
      if (typeof raw.sessionId !== "string" || !SESSION_ID_RE.test(raw.sessionId)) return undefined;
      if (!SESSION_KINDS.includes(raw.sessionKind as SessionKind)) return undefined;
      return { kind: "session", sessionId: raw.sessionId, sessionKind: raw.sessionKind as SessionKind, ...(bot === undefined ? {} : { bot }) };
    }
    case "peer": {
      if (typeof raw.device !== "string" || !DEVICE_ID_RE.test(raw.device)) return undefined;
      const sessionId = raw.sessionId;
      if (sessionId !== undefined && (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId))) return undefined;
      return { kind: "peer", device: raw.device, ...(sessionId === undefined ? {} : { sessionId }), ...(bot === undefined ? {} : { bot }) };
    }
    case "user": {
      if (!CLIENT_KINDS.includes(raw.client as ClientKind)) return undefined;
      return { kind: "user", client: raw.client as ClientKind };
    }
    case "plugin":
      return typeof raw.pluginId === "string" ? { kind: "plugin", pluginId: raw.pluginId } : undefined;
    case "core":
      return { kind: "core" };
    default:
      return undefined;
  }
}

/** Whose tabs a call uses, and the key its "last tab" is remembered under. */
export interface Acting {
  owner: TabOwner;
  /** One per session where there is one, so two sessions of the same bot don't steal each other's current tab. */
  key: string;
}

/** A session with a bot uses that bot's tabs; one without (a coding session) uses its own (R10: the person's own
 *  browser needs their OK for that session, which the core checks). A session on another computer (`peer`) follows
 *  the same rule. The person calling directly uses their own. A plugin or the core has no tabs of its own here, so it
 *  gets a plain refusal. */
export function actingFor(caller: Caller | undefined): Acting | { refused: string } {
  if (caller === undefined) {
    return { refused: "The browser tool can't tell which session is calling, so it won't touch any tab. (The core should say who is calling with each request.)" };
  }
  switch (caller.kind) {
    case "session":
      return caller.bot !== undefined
        ? { owner: { kind: "bot", bot: caller.bot }, key: `session:${caller.sessionId}` }
        : { owner: { kind: "session", session: caller.sessionId }, key: `session:${caller.sessionId}` };
    case "peer": {
      const key = caller.sessionId !== undefined ? `session:${caller.sessionId}` : `peer:${caller.device}`;
      if (caller.bot !== undefined) return { owner: { kind: "bot", bot: caller.bot }, key };
      if (caller.sessionId !== undefined) return { owner: { kind: "session", session: caller.sessionId }, key };
      return { refused: "The browser tool can't tell which session on the other computer is calling, so it won't touch any tab." };
    }
    case "user":
      return { owner: { kind: "user" }, key: "user" };
    case "plugin":
    case "core":
      return { refused: "The browser tool works for a session's tabs; a plugin or the core calling it has none here." };
  }
}

export function ownerLabel(owner: TabOwner): string {
  return owner.kind === "bot" ? `${owner.bot}'s` : owner.kind === "session" ? "this session's" : "the person's";
}
