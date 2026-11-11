import type { ConversationActions, ConversationFormat, DeviceRef, MessageAction, SharedTime } from "./types";

/** What every message is drawn with besides its own item: data and the host's callbacks only, as a
 *  spot's props must be (spec §5.5). */
/** A background agent this bot started, as the sessions area and its own messages tell it. */
export interface AgentLive {
  id: string;
  /** The definition's id after its plugin: `study-buddy`. */
  name: string;
  backend?: string;
  status: string;
  /** Its latest message to the bot, one line. */
  line?: string;
}

export interface MessageContext {
  /** Agents started from this session, newest last (live). */
  agents?: readonly AgentLive[];
  botId: string;
  botName: string;
  /** The session this conversation is, for `<AppView call>` (a call id is unique only within it). */
  session: string;
  now: SharedTime;
  format: ConversationFormat;
  /** The device this view is on, so a message from another one says where it came from. */
  device?: DeviceRef;
  /** The bot's main conversation has a turn running. */
  turnLive: boolean;
  /** The bot's voice is speaking now (any reply): a speak button the user pressed shows it until it ends. */
  speaking?: boolean;
  /** Plugins' small buttons for a message's row of actions (`conversation.message.action`). */
  messageActions?: readonly MessageAction[];
  actions: ConversationActions;
}

/** What each `conversation.message` entry gets (lane B's catalog, B-M0): the bot, the session, the item
 *  (under the `tool` key, a run of calls) and the context. */
export interface MessageSpotProps<T> {
  bot: { id: string; name: string };
  session: string;
  item: T;
  ctx: MessageContext;
}
