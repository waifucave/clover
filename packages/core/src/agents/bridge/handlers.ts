// The bridge on the daemon's main socket (spec §9.3; lane C's `bridge` role, C-M1 #180): the bridge process says
// `protocol.hello` with role `bridge`, its token and its agent session on the same endpoint every client uses, and
// lane C's Clover server checks it with lane K's `BridgeTokens` and the kernel's pid for the caller (`LOCAL_PEERPID`,
// `SO_PEERCRED`, or the pipe's client pid on Windows, where the agent's job object is the check). After the hello the
// role may call only `bridge.tools`, `bridge.call`, `bridge.sendMessage` and `glossary.query`, bound to its session;
// the server validates their params, and a revoked token's connection is closed (`onRevoke`).
//
// `bridgeCloverParts` is what the daemon passes to `createCloverServer`: the gate and the session's bot for the hello,
// and the four methods, each refused once the session's token is gone (review 5: the revoke's close may not have
// reached the connection yet).
import { CLOVER_ERR } from "@waifucave/clover-protocol";
import { bridgeMethodHandlers, CloverRpcError, type BridgeGate, type CloverHandler } from "../../ipc/clover";
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
  const live = (sessionId: string) => {
    if (!tokens.has(sessionId)) throw new CloverRpcError(CLOVER_ERR.ROLE_REFUSED, "this bridge's token was revoked");
  };
  return {
    bridge: { gate: tokens, sessionInfo: (id) => h.sessionInfo(id) },
    handlers: bridgeMethodHandlers({
      tools: async (id) => (live(id), h.tools(id)),
      call: async (id, c) => (live(id), h.call(id, c)),
      sendMessage: async (id, m) => (live(id), h.sendMessage(id, m)),
      glossary: async (id, q) => (live(id), h.glossary(id, q)),
    }),
  };
}
