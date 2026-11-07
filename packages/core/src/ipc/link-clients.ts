// Remote clients over links on the Clover server (C-M3 item 3; lane H's `mountRemoteClients`, links/remote-clients.ts).
// A paired phone (`remote`) or browser (`web`) speaks the Clover protocol on a stream of its link. The link proved
// the device, so there is no local process to probe: the hello goes to the server's `linkHello`, which takes only
// the token the core minted for that device and role, and makes the caller the user on that device. Every request
// after it runs through the role's allow list and `userOnly` as on the socket, and its core events are routed by
// the server's own sender (`coreEvent`), so the door gets no `coreEvents` of its own (no event is sent twice).
// The device and its role come from the door, never from the hello: the device from the socket object the door made,
// the role from the registry's record of that device (a phone is `remote`, a browser `web`), as the door decides it.
// Each minted token is spent by its hello (`linkHello`); revoking a device drops any token still minted for it and
// closes its connections.
import { mountRemoteClients, type RemoteClientsOptions, type RemoteRpcServer, type RemoteTokens } from "../links/remote-clients";
import type { Unsubscribe } from "../contracts/common";
import { CloverRpcError, type CloverConn, type CloverServer } from "./clover";
import type { CloverBinding, CloverTokens } from "../auth/clover-tokens";
import type { DeviceChange, DeviceRecord } from "../contracts/device-registry";
import { CLOVER_ERR } from "@waifucave/clover-protocol";

/** Link connections are numbered far above the socket's, so the two never meet in the server's table. */
export const LINK_CONN_ID_BASE = 2 ** 40;

/** The client role a paired, unrevoked device's link carries, as the door decides it. */
export function linkRoleOf(d: Pick<DeviceRecord, "kind" | "revokedAt"> | undefined): "remote" | "web" | undefined {
  if (d === undefined || d.revokedAt !== undefined) return undefined;
  return d.kind === "phone" ? "remote" : d.kind === "browser" ? "web" : undefined;
}

type LinkServer = Pick<CloverServer, "linkHello" | "handle" | "closed" | "response">;
type Devices = { get(id: string): Pick<DeviceRecord, "kind" | "revokedAt"> | undefined };

/** The door's server over the Clover server: the device from the socket object the door made, its role from the
 *  registry. */
export function linkClientServer(server: LinkServer, registry: Devices, spend?: (token: string) => void): RemoteRpcServer {
  return {
    async hello(socket, connId, params, write, end) {
      const device = (socket as { device?: unknown; link?: unknown }).link === true ? (socket as { device?: unknown }).device : undefined;
      const role = typeof device === "string" ? linkRoleOf(registry.get(device)) : undefined;
      if (typeof device !== "string" || role === undefined) {
        // Refused before `linkHello` spends it: the token the door minted for this hello is spent here.
        const token = (params as { token?: unknown } | null | undefined)?.token;
        if (typeof token === "string") spend?.(token);
        throw new CloverRpcError(CLOVER_ERR.ROLE_REFUSED, "not a client's link");
      }
      return server.linkHello(connId, params, { device, role, stillLinked: () => linkRoleOf(registry.get(device)) === role }, write, end);
    },
    handle: (conn, method, params) => server.handle(conn as CloverConn, method, params),
    closed: (conn, socket) => server.closed(conn as CloverConn | null, socket),
    response: (conn, msg) => server.response(conn as CloverConn, msg),
  };
}

export type CloverRemoteClientsOptions = Omit<RemoteClientsOptions, "server" | "coreEvents" | "nextConnId" | "registry" | "tokens"> & {
  server: LinkServer & Pick<CloverServer, "endConnections">;
  registry: RemoteClientsOptions["registry"] & { watch(fn: (change: DeviceChange) => void): Unsubscribe };
  tokens: RemoteTokens & Pick<CloverTokens, "revokeWhere" | "revoke">;
};

/** Mounts the client door on the daemon's Clover server. */
export function mountCloverRemoteClients(o: CloverRemoteClientsOptions): Unsubscribe {
  let next = LINK_CONN_ID_BASE;
  const offRevoked = o.registry.watch((change) => {
    if (change.type !== "revoked") return;
    o.tokens.revokeWhere((b: CloverBinding) => "device" in b && b.device === change.id);
    o.server.endConnections((c) => c.caller.kind === "user" && c.caller.device === change.id);
  });
  const offDoor = mountRemoteClients({ ...o, server: linkClientServer(o.server, o.registry, (t) => o.tokens.revoke(t)), nextConnId: () => ++next });
  return () => { offDoor(); offRevoked(); };
}


