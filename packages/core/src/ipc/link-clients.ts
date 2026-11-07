// Remote clients over links on the Clover server (C-M3 item 3; lane H's `mountRemoteClients`, links/remote-clients.ts).
// A paired phone (`remote`) or browser (`web`) speaks the Clover protocol on a stream of its link. The link proved
// the device, so there is no local process to probe: the hello goes to the server's `linkHello`, which takes only
// the token the core minted for that device and role, and makes the caller the user on that device. Every request
// after it runs through the role's allow list and `userOnly` as on the socket, and its core events are routed by
// the server's own sender (`coreEvent`), so the door gets no `coreEvents` of its own (no event is sent twice).
import { mountRemoteClients, type RemoteClientsOptions, type RemoteRpcServer } from "../links/remote-clients";
import type { Unsubscribe } from "../contracts/common";
import { CloverRpcError, type CloverConn, type CloverServer } from "./clover";
import { CLOVER_ERR } from "@waifucave/clover-protocol";

/** Link connections are numbered far above the socket's, so the two never meet in the server's table. */
export const LINK_CONN_ID_BASE = 2 ** 40;

/** The door's server over the Clover server: a link's hello names its device on the socket object the door made. */
export function linkClientServer(server: Pick<CloverServer, "linkHello" | "handle" | "closed" | "response">): RemoteRpcServer {
  return {
    async hello(socket, connId, params, write, end) {
      const device = (socket as { device?: unknown; link?: unknown }).link === true ? (socket as { device?: unknown }).device : undefined;
      const role = (params as { role?: unknown } | undefined)?.role;
      if (typeof device !== "string" || (role !== "remote" && role !== "web")) throw new CloverRpcError(CLOVER_ERR.ROLE_REFUSED, "not a client's link");
      return server.linkHello(connId, params, { device, role }, write, end);
    },
    handle: (conn, method, params) => server.handle(conn as CloverConn, method, params),
    closed: (conn, socket) => server.closed(conn as CloverConn | null, socket),
    response: (conn, msg) => server.response(conn as CloverConn, msg),
  };
}

export type CloverRemoteClientsOptions = Omit<RemoteClientsOptions, "server" | "coreEvents" | "nextConnId"> & {
  server: Pick<CloverServer, "linkHello" | "handle" | "closed" | "response">;
};

/** Mounts the client door on the daemon's Clover server. */
export function mountCloverRemoteClients(o: CloverRemoteClientsOptions): Unsubscribe {
  let next = LINK_CONN_ID_BASE;
  return mountRemoteClients({ ...o, server: linkClientServer(o.server), nextConnId: () => ++next });
}


