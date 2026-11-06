// A room: two peers of one device pair, and the link frames between them (PROTOCOL.md, "Rooms"). Nothing is stored:
// frames go straight from one socket to the other, and a frame for a peer that is away is dropped. Sockets use the
// hibernation API, so an idle room costs nothing, and keep-alives never wake it.

import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";

export const CLOSE_REPLACED = 4000;
export const CLOSE_PROTOCOL = 4008;
const PING = "ping";
const PONG = "pong";
const MAX_FRAME_BYTES = 1024 * 1024;

const tag = (peer: string) => `p:${peer}`;

export class RoomDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private open(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private peerOf(ws: WebSocket): string | null {
    return (ws.deserializeAttachment() as { peer?: string } | null)?.peer ?? null;
  }

  private others(peer: string): WebSocket[] {
    return this.open().filter((ws) => this.peerOf(ws) !== peer);
  }

  /** A peer's socket, forwarded by the Worker once it has checked the ticket. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket", { status: 426 });
    const peer = request.headers.get("x-relay-peer") ?? "";
    if (!peer) return new Response("no peer", { status: 400 });
    // Two peers to a room: a third is refused while both are there.
    const present = new Set(this.open().map((ws) => this.peerOf(ws)).filter((p): p is string => p !== null && p !== peer));
    if (present.size >= 2) return Response.json({ error: "full" }, { status: 409 });
    const hadSocket = this.open().some((ws) => this.peerOf(ws) === peer);
    for (const old of this.ctx.getWebSockets(tag(peer))) {
      try {
        old.send(JSON.stringify({ t: "bye", reason: "replaced" }));
        old.close(CLOSE_REPLACED, "replaced");
      } catch {
        // Already closed.
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [tag(peer)]);
    server.serializeAttachment({ peer });
    const others = this.others(peer).filter((ws) => ws !== server);
    server.send(JSON.stringify({ t: "hello", v: 1, peer: { online: others.length > 0 } }));
    if (!hadSocket) for (const ws of others) this.sendText(ws, JSON.stringify({ t: "presence", online: true }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") {
      if (message === PING) ws.send(PONG);
      else ws.close(CLOSE_PROTOCOL, "protocol");
      return;
    }
    if (message.byteLength > MAX_FRAME_BYTES) {
      ws.close(CLOSE_PROTOCOL, "protocol");
      return;
    }
    const peer = this.peerOf(ws);
    if (peer === null) return;
    for (const other of this.others(peer)) {
      try {
        other.send(message);
      } catch {
        // The other peer just went away: the frame is dropped, as it would be had it been away already.
      }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const peer = this.peerOf(ws);
    if (peer === null) return;
    if (this.open().some((other) => other !== ws && this.peerOf(other) === peer)) return;
    for (const other of this.others(peer)) if (other !== ws) this.sendText(other, JSON.stringify({ t: "presence", online: false }));
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private sendText(ws: WebSocket, text: string): void {
    try {
      ws.send(text);
    } catch {
      // Closing already.
    }
  }
}
