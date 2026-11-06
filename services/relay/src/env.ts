import type { MailboxDO } from "./mailbox-do";
import type { RoomDO } from "./room-do";

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDO>;
  MAIL: DurableObjectNamespace<MailboxDO>;
  /** Room sockets opened, per client address (IPv6 by /64). */
  CONNECT_RATE: RateLimit;
  /** API requests, per client address. */
  API_RATE: RateLimit;
  /** Where devices reach this relay: ticket URLs are built from it. */
  RELAY_ORIGIN: string;
  /** Secret: the user's access key (PROTOCOL.md, "Who may use it"). Rotating it ends every ticket made with the old. */
  RELAY_KEY: string;
  /** How long a room ticket lasts, in hours (24 by default). */
  TICKET_HOURS?: string;
}
