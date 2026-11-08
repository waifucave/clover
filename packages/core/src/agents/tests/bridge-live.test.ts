// The bridge's methods on lane C's Clover server check, on every request, that the connection is still the one K's
// `accept` let in for its session's live token: a re-mint (a reattach) leaves the session a token, but not the old
// connection's, and the revoke's close may not have reached that connection yet.
import { describe, expect, test } from "bun:test";
import { CLOVER_ERR, CLOVER_PROTOCOL_VERSION } from "@waifucave/clover-protocol";
import { CloverTokens } from "../../auth/clover-tokens";
import { SessionProcesses } from "../../auth/clover-caller";
import { createCloverServer, type CloverConn } from "../../ipc/clover";
import type { PeerFacts } from "../../platform/caller-probe";
import { bridgeCloverParts } from "../bridge/handlers";
import { BridgeTokens } from "../bridge/tokens";

const AGENT_PID = 500;
const BRIDGE_PID = 501;
const peer: PeerFacts = { pid: BRIDGE_PID, ancestors: [AGENT_PID, 1], probe: { sandboxedMac: false, inHostNamespacesLinux: true, tokenRestrictedWin: false, appContainerWin: false }, floor: "outside-floor" };

function boot() {
  const tokens = new BridgeTokens({ bindWaitMs: 50 });
  const calls: string[] = [];
  const parts = bridgeCloverParts(tokens, {
    sessionInfo: () => ({ bot: "alpha" }),
    tools: async (id) => { calls.push(`tools ${id}`); return { tools: [], instructions: "hi" }; },
    call: async (id) => { calls.push(`call ${id}`); return { content: [], isError: false }; },
    sendMessage: async (id) => { calls.push(`send ${id}`); },
    glossary: async (id) => { calls.push(`glossary ${id}`); return { results: [], loaded: [] }; },
  });
  const clover = createCloverServer({
    tokens: new CloverTokens({ verifyCli: async () => false }), processes: new SessionProcesses(), serverVersion: "test",
    deviceId: "d".repeat(32), probe: () => peer, bridge: parts.bridge, handlers: parts.handlers,
  });
  let connId = 0;
  // No `end`: the revoke's close never reaches these connections, so what refuses them is the per-request check.
  const hello = async (token: string): Promise<CloverConn> => {
    const socket = {};
    const h = await clover.hello(socket, ++connId, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "bridge", token, agentSessionId: "s1", clientName: "bridge" }, () => {});
    return h.conn;
  };
  const mint = () => {
    const token = tokens.mint("s1");
    tokens.bind("s1", AGENT_PID, (pid) => pid === BRIDGE_PID);
    return token;
  };
  const code = (p: Promise<unknown>) => p.then(() => "ran", (e: unknown) => (e as { code?: number }).code);
  return { tokens, clover, calls, hello, mint, code };
}

describe("the bridge's live connection on C's server", () => {
  test("a re-mint refuses the old connection's next request, on every method; the new token's connection works", async () => {
    const b = boot();
    const old = await b.hello(b.mint());
    expect(old.bridgeConnection).toBeNumber();
    expect(await b.clover.handle(old, "bridge.tools", {})).toEqual({ tools: [], instructions: "hi" });
    const fresh = b.mint(); // the reattach: the session has a token again, but not the old connection's
    expect(b.tokens.has("s1")).toBe(true);
    expect(await b.code(b.clover.handle(old, "bridge.tools", {}))).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect(await b.code(b.clover.handle(old, "bridge.call", { callId: "c1", tool: "Render", input: {} }))).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect(await b.code(b.clover.handle(old, "bridge.sendMessage", { text: "still here" }))).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect(await b.code(b.clover.handle(old, "glossary.query", { query: "pdf" }))).toBe(CLOVER_ERR.ROLE_REFUSED);
    const now = await b.hello(fresh);
    expect(now.bridgeConnection).not.toBe(old.bridgeConnection);
    expect(await b.clover.handle(now, "bridge.sendMessage", { text: "done" })).toEqual({ ok: true });
    expect(await b.code(b.clover.handle(old, "bridge.tools", {}))).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect(b.calls).toEqual(["tools s1", "send s1"]);
    b.clover.dispose();
  });

  test("a revoke with no new token, and a closed connection whose number is given back, are refused too", async () => {
    const b = boot();
    const first = await b.hello(b.mint());
    b.clover.closed(first, {}); // released: the token may be used again from the tree
    expect(await b.code(b.clover.handle(first, "bridge.tools", {}))).toBe(CLOVER_ERR.ROLE_REFUSED);
    const token = b.mint();
    const second = await b.hello(token);
    expect(await b.clover.handle(second, "bridge.tools", {})).toEqual({ tools: [], instructions: "hi" });
    b.tokens.revoke("s1");
    expect(await b.code(b.clover.handle(second, "bridge.tools", {}))).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect(b.calls).toEqual(["tools s1"]);
    b.clover.dispose();
  });

  test("a bridge-role request with no bridge connection behind it is refused while the session's token is live", async () => {
    const b = boot();
    const live = await b.hello(b.mint());
    const asBridge = { caller: { kind: "session" as const, sessionId: "s1", sessionKind: "agent" as const, bot: "alpha" }, role: "bridge" as const };
    expect(await b.code(b.clover.dispatch("bridge.tools", {}, asBridge))).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect(await b.code(b.clover.dispatch("bridge.sendMessage", { text: "hi" }, asBridge))).toBe(CLOVER_ERR.ROLE_REFUSED);
    expect(await b.clover.handle(live, "bridge.tools", {})).toEqual({ tools: [], instructions: "hi" });
    expect(b.calls).toEqual(["tools s1"]);
    b.clover.dispose();
  });
});
