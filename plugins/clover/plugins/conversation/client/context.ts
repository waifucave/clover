import type { ConversationActions, ConversationFormat, DeviceRef, SharedTime } from "./types";

/** What every message is drawn with besides its own item: data and the host's callbacks only, as a
 *  spot's props must be (spec §5.5). */
export interface MessageContext {
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
