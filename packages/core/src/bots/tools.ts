// The bots' messaging tools (spec §6.7, §9.3): `SendMessage`, to another bot or any running session, folding into
// its turn (§6.4), and `ListAgents`, every running session with its status. Owner: lane D. Lane A's runtime registers
// them as core tools for bots' sessions (a bot's own conversation and its side threads), in the same neutral shape as
// lane K's `Agent` and `TaskStop`: a name, a description that stands on its own, a JSON Schema and a `run`. Background
// agents message their bot through the bridge's own `SendMessage` (lane K), which lands as an `agent` message.
//
// * **Who sends** is the calling session (`DurableSessionHost.callerOf`): the message reaches its target as a bot's
//   message (`from: "bot"`), naming the bot and the session it came from, so it folds in like any bot's message
//   and never counts as the user's.
// * **Where it goes:** a bot, by id or name, means its main conversation, wherever that runs (`BotService.deliverTo`
//   relays it to the computer running the bot); a session id means that session, here. A session can't message
//   itself, and an ended one takes nothing.
import { type SessionView } from "@waifucave/clover-protocol";
import { isContractError } from "../contracts/common";
import type { Disposition } from "../contracts/session-host";
import type { DurableSessionHost } from "../sessions/durable-host";
import { plainText, type BotService } from "./service";

/** A core tool in the neutral shape the runtime registers (lane K's `CoreToolDef`). */
export interface CoreToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: unknown): Promise<{ text: string; isError: boolean }>;
}

/** The longest message `SendMessage` takes. */
export const SEND_MESSAGE_MAX_CHARS = 100_000;
/** The most sessions `ListAgents` lists. */
export const LIST_AGENTS_MAX = 200;

export interface BotToolsDeps {
  host: Pick<DurableSessionHost, "get" | "list" | "deliver" | "callerOf">;
  bots: Pick<BotService, "list" | "has" | "mainSession" | "deliverTo">;
}

const isEnded = (v: SessionView) => v.status === "stopped" || v.status === "failed";

function fail(text: string): { text: string; isError: true } {
  return { text, isError: true };
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return isContractError(err) ? `${msg} (${err.code})` : msg;
}

function str(input: unknown, key: string): string | undefined {
  const v = (input as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "string" ? v : undefined;
}

function what(disposition: Disposition): string {
  switch (disposition) {
    case "folded":
      return "it joins their running turn after its next tool call";
    case "turn":
      return "it starts their next turn now";
    case "queued":
      return "it waits for their next turn";
    case "interrupted":
      return "it interrupted their turn";
    case "note":
      return "it was added as a note";
  }
}

/** One line of `ListAgents`. */
export function describeSession(v: SessionView, botName: (id: string) => string | undefined, self: string): string {
  const parts = [v.id, v.kind];
  if (v.bot !== undefined) parts.push(`bot ${botName(v.bot) ?? v.bot}${botName(v.bot) !== undefined && botName(v.bot) !== v.bot ? ` (${v.bot})` : ""}`);
  parts.push(v.status + (v.failure ? ` (${v.failure})` : ""));
  parts.push(`on ${v.computer}`);
  if (v.backend) parts.push(`backend ${v.backend}`);
  if (v.model) parts.push(`model ${v.model}`);
  if (v.root) parts.push(`in ${v.root}`);
  if (v.routine) parts.push(`routine ${v.routine}`);
  if (v.title && v.kind !== "bot") parts.push(`"${v.title}"`);
  if (v.parent) parts.push(`for ${v.parent}`);
  return `- ${parts.join(" · ")}${v.id === self ? " · (this conversation)" : ""}`;
}

/** `SendMessage` and `ListAgents` for one bot session (`sessionId`: a bot's main conversation or a side thread). */
export function botToolDefs(deps: BotToolsDeps, sessionId: string): CoreToolDef[] {
  const { host, bots } = deps;
  const botNames = () => new Map(bots.list().map((b) => [b.id, plainText(b.name)]));
  return [
    {
      name: "SendMessage",
      description: [
        "Send a message to another bot or to any running session: a bot's conversation, a side thread, a background",
        "agent or a coding session the user started. Name a bot by its id or name to reach its main conversation, or",
        "give a session id from ListAgents. The message joins the target's running turn after its next tool call, or",
        "starts its next turn when it is idle; a background agent gets it as its next prompt. It reaches them as a",
        "message from you, never as the user's. Use it to hand over work, report back or ask another bot something;",
        "their answer, if any, comes back to you the same way.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "A bot's id or name, or a session id from ListAgents." },
          message: { type: "string", description: "What to say. Write it to stand on its own: they see nothing else of this conversation." },
        },
        required: ["to", "message"],
        additionalProperties: false,
      },
      run: async (input) => {
        const to = str(input, "to")?.trim();
        const message = str(input, "message");
        if (!to) return fail("SendMessage needs `to`: a bot's id or name, or a session id.");
        if (message === undefined || message.trim() === "") return fail("SendMessage needs a message.");
        if (message.length > SEND_MESSAGE_MAX_CHARS) return fail(`The message is ${message.length} characters; SendMessage takes at most ${SEND_MESSAGE_MAX_CHARS}.`);
        const caller = host.callerOf(sessionId);
        if (caller.bot === undefined) return fail("SendMessage is a bot's tool; this session has no bot.");
        const names = botNames();
        const byName = [...names].filter(([, name]) => name.toLowerCase() === to.toLowerCase()).map(([id]) => id);
        const bot = bots.has(to) ? to : byName.length === 1 ? byName[0]! : undefined;
        if (byName.length > 1 && !bots.has(to)) return fail(`More than one bot is called "${to}" (${byName.join(", ")}); name one by its id.`);
        const target = bot !== undefined ? bots.mainSession(bot) : to;
        if (target === sessionId) return fail("That is this conversation; SendMessage reaches another one.");
        const input2 = { from: "bot" as const, bot: caller.bot, session: sessionId, text: message };
        try {
          if (bot !== undefined) {
            const { disposition } = await bots.deliverTo(bot, input2);
            return { text: `Sent to ${names.get(bot) ?? bot} (${target}): ${what(disposition)}.`, isError: false };
          }
          const view = host.get(target);
          if (view === undefined) return fail(`No bot or session "${to}". ListAgents shows who is running.`);
          if (isEnded(view)) return fail(`The session ${target} has ended (${view.status}); it takes no messages.`);
          const { disposition } = await host.deliver(target, input2);
          return { text: `Sent to ${target} (${view.kind}${view.bot === undefined ? "" : ` of ${names.get(view.bot) ?? view.bot}`}): ${what(disposition)}.`, isError: false };
        } catch (err) {
          return fail(`The message wasn't sent: ${errorText(err)}`);
        }
      },
    },
    {
      name: "ListAgents",
      description: [
        "List every running session, with its status: each bot's main conversation, side threads (routine runs),",
        "background agents and the user's own coding sessions. Your own background agents and side threads come",
        "first. Use the ids with SendMessage, and an agent's with TaskStop.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["bot", "side-thread", "agent", "coding"], description: "Only sessions of this kind." },
          bot: { type: "string", description: "Only this bot's sessions (its id)." },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const kind = str(input, "kind");
        const bot = str(input, "bot");
        const caller = host.callerOf(sessionId);
        const own = caller.bot === undefined ? undefined : bots.has(caller.bot) ? bots.mainSession(caller.bot) : undefined;
        const names = botNames();
        const rank = (v: SessionView) => {
          if ((v.parent !== undefined && (v.parent === sessionId || v.parent === own)) && v.kind !== "bot") return 0;
          return { bot: 1, "side-thread": 2, agent: 3, coding: 4 }[v.kind];
        };
        const all = host.list()
          .filter((v) => !isEnded(v))
          .filter((v) => kind === undefined || v.kind === kind)
          .filter((v) => bot === undefined || v.bot === bot)
          .filter((v) => v.kind !== "bot" || (v.bot !== undefined && bots.has(v.bot)))
          .sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt);
        if (all.length === 0) return { text: "No running sessions match.", isError: false };
        const shown = all.slice(0, LIST_AGENTS_MAX).map((v) => describeSession(v, (id) => names.get(id), sessionId));
        if (all.length > LIST_AGENTS_MAX) shown.push(`… and ${all.length - LIST_AGENTS_MAX} more; narrow it with kind or bot.`);
        return { text: shown.join("\n"), isError: false };
      },
    },
  ];
}
