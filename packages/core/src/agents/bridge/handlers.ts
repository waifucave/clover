// The bridge on the daemon's main socket (spec §9.3; lane C's `bridge` role, C-M1 #180): the bridge process says
// `protocol.hello` with role `bridge`, its token and its agent session on the same endpoint every client uses, and
// lane C's Clover server checks it with lane K's `BridgeTokens` and the kernel's pid for the caller (`LOCAL_PEERPID`,
// `SO_PEERCRED`, or the pipe's client pid on Windows, where the agent's job object is the check). After the hello the
// role may call only `bridge.tools`, `bridge.call`, `bridge.sendMessage` and `glossary.query`, bound to its session;
// the server validates their params, and a revoked token's connection is closed (`onRevoke`).
//
// `bridgeCloverParts` is what the daemon passes to `createCloverServer`: the gate and the session's bot for the hello,
// and the four methods, each refused unless the connection is still its session token's live one (review 5: the
// revoke's close may not have reached the connection yet; a re-mint leaves the session a token, but not this one).
import { CLOVER_ERR } from "@waifucave/clover-protocol";
import { bridgeMethodHandlers, CloverRpcError, type BridgeGate, type CloverConn, type CloverHandler } from "../../ipc/clover";
import type { BridgeTokens } from "./tokens";
import type { BridgeToolDef } from "./tools";

/** What the bridge's methods do, for one session; the agent manager provides it. */
export interface BridgeHandlers {
  /** The session's bot, for the hello's caller. */
  sessionInfo(sessionId: string): { bot?: string } | undefined;
  tools(sessionId: string): Promise<{ tools: BridgeToolDef[]; instructions: string }>;
  call(sessionId: string, call: { callId: string; tool: string; input: unknown }): Promise<{ content: unknown[]; isError: boolean }>;
  sendMessage(sessionId: string, m: { text: string; to?: string }): Promise<void>;
  glossary(sessionId: string, q: { query?: string | string[]; load?: string | string[] }): Promise<{ results: unknown[]; loaded: unknown[] }>;
}

/** The parts of `createCloverServer`'s deps the bridge needs: `bridge` and the role's `handlers`. */
export interface BridgeCloverParts {
  bridge: { gate: BridgeGate; sessionInfo(sessionId: string): { bot?: string } | undefined };
  handlers: Record<string, CloverHandler>;
}

export function bridgeCloverParts(tokens: BridgeTokens, h: BridgeHandlers): BridgeCloverParts {
  const methods = bridgeMethodHandlers({
    tools: (id) => h.tools(id),
    call: (id, c) => h.call(id, c),
    sendMessage: (id, m) => h.sendMessage(id, m),
    glossary: (id, q) => h.glossary(id, q),
  });
  // Each request checks that its connection is the one `accept` let in for the session's live token (K-M2 review 6):
  // a re-mint revokes the old token, and its connection is refused here even before the revoke's close reaches it.
  // A connection without both (a `peer.call` dispatch under the bridge role, say) is refused too.
  const handlers = Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, (conn: CloverConn, params: unknown) => {
    const sessionId = conn.caller.kind === "session" ? conn.caller.sessionId : undefined;
    if (sessionId === undefined || conn.bridgeConnection === undefined || !tokens.isLive(sessionId, conn.bridgeConnection)) {
      throw new CloverRpcError(CLOVER_ERR.ROLE_REFUSED, "this bridge's connection isn't its token's live one");
    }
    return fn(conn, params);
  }]));
  return { bridge: { gate: tokens, sessionInfo: (id) => h.sessionInfo(id) }, handlers };
}
