import type { ConversationActions, ConversationFormat, SharedTime } from "./types";

/** What every message is drawn with besides its own item: data and the host's callbacks only, as a
 *  spot's props must be (spec §5.5). */
export interface MessageContext {
  botName: string;
  now: SharedTime;
  format: ConversationFormat;
  /** The device this view is on, so a message from another one says where it came from. */
  device?: string;
  /** The bot's main conversation has a turn running. */
  turnLive: boolean;
  actions: ConversationActions;
}
