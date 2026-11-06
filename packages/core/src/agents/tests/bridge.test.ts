// The bridge as processes: the kernel's pid for a socket's caller, the real bridge process speaking MCP on stdio and
// Clover's protocol to the endpoint, and a stolen token refused (spike S5 edit 4).
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcError, RpcPeer } from "../acp/jsonrpc";
import { BridgeEndpoint, type BridgeHandlers } from "../bridge/endpoint";
import { BRIDGE_MAIN_PATH } from "../bridge/main";
import { peerPidOf } from "../bridge/peer";
import { BRIDGE_ENV } from "../bridge/server";
import { BridgeTokens } from "../bridge/tokens";
import { BRIDGE_OWN_TOOLS } from "../bridge/tools";
import { waitFor } from "./world";

// Real processes: generous on a loaded CI runner.
setDefaultTimeout(60_000);

const root = realpathSync(mkdtempSync(join(tmpdir(), "clover-k-br-")));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});
const posix = process.platform !== "win32";

function sockPath(name: string): string {
  const p = join(root, name);
  return p.length < 100 ? p : join("/tmp", `ck-${process.pid}-${name}`);
}

function endpointWith(handlers: Partial<BridgeHandlers>, tokens: BridgeTokens, name: string) {
  const sent: { sessionId: string; text: string; to?: string }[] = [];
  const full: BridgeHandlers = {
    sessionInfo: () => ({ bot: "alpha" }),
    tools: async () => ({ tools: [...BRIDGE_OWN_TOOLS], instructions: "Use SendMessage to report." }),
    call: async (_s, c) => ({ content: [{ type: "text", text: `ran ${c.tool}` }], isError: false }),
    sendMessage: async (sessionId, m) => {
      sent.push({ sessionId, ...m });
    },
    glossary: async () => ({ results: [{ name: "pdf", kind: "skill", description: "Read PDFs" }], loaded: [] }),
    ...handlers,
  };
  const ep = new BridgeEndpoint({ socketPath: sockPath(name), tokens, handlers: full, device: "d".repeat(16), serverVersion: "test" });
  ep.listen();
  return { ep, sent };
}

/** Starts the real bridge as an agent would: under a parent process standing in for the agent. */
function agentWithBridge(env: Record<string, string>, opts: { direct?: boolean } = {}) {
  const base = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env };
  const child = opts.direct
    ? spawn(process.execPath, [BRIDGE_MAIN_PATH], { env: base, stdio: ["pipe", "pipe", "pipe"] })
    : spawn("/bin/sh", ["-c", `"${process.execPath}" "${BRIDGE_MAIN_PATH}"; :`], { env: base, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (c: string) => (stderr += c));
  const mcp = new RpcPeer({ write: (l) => child.stdin!.write(l) });
  child.stdout!.on("data", (c: Buffer) => mcp.feed(c));
  return { child, mcp, stderr: () => stderr };
}

describe.skipIf(!posix)("the kernel names a socket's caller", () => {
  test("peerPidOf gives the connecting process's pid", async () => {
    const path = sockPath("peer.sock");
    let seen: number | null = -1;
    const server = Bun.listen({ unix: path, socket: { open: (s) => void (seen = peerPidOf((s as unknown as { fd: number }).fd)), data() {} } });
    const child = spawn(process.execPath, ["-e", `await Bun.connect({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); setTimeout(() => process.exit(0), 300)`], { stdio: "ignore" });
    children.push(child);
    await waitFor(() => seen !== -1, "a connection");
    expect(seen).toBe(child.pid!);
    server.stop(true);
  });
});

describe.skipIf(!posix)("the bridge process", () => {
  test("MCP's legacy handshake, server/discover refused, the daemon's tools, and SendMessage reaching the daemon", async () => {
    const tokens = new BridgeTokens();
    const { ep, sent } = endpointWith({}, tokens, "b1.sock");
    const token = tokens.mint("agent_one");
    const { child, mcp } = agentWithBridge({ [BRIDGE_ENV.token]: token, [BRIDGE_ENV.session]: "agent_one", [BRIDGE_ENV.socket]: ep.socketPath });
    tokens.bind("agent_one", child.pid!);
    const discover = await mcp.request("server/discover", { protocolVersion: "2026-07-28" }).catch((e: unknown) => e);
    expect((discover as RpcError).code).toBe(-32601);
    const init = (await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })) as Record<string, unknown>;
    expect(init["protocolVersion"]).toBe("2025-06-18");
    expect(init["serverInfo"]).toEqual({ name: "clover", version: "0.0.0" });
    expect(init["instructions"]).toBe("Use SendMessage to report.");
    const list = (await mcp.request("tools/list", {})) as { tools: { name: string; description: string }[] };
    expect(list.tools.map((t) => t.name)).toEqual(["SendMessage", "Glossary"]);
    expect(list.tools.every((t) => t.description.length > 40)).toBe(true);
    expect(await mcp.request("tools/call", { name: "SendMessage", arguments: { message: "halfway" } })).toEqual({ content: [{ type: "text", text: "Sent." }], isError: false });
    expect(sent).toEqual([{ sessionId: "agent_one", text: "halfway" }]);
    const glossary = (await mcp.request("tools/call", { name: "Glossary", arguments: { query: "pdf" } })) as { content: { text: string }[] };
    expect(glossary.content[0]!.text).toContain("Read PDFs");
    expect(await mcp.request("tools/call", { name: "Render", arguments: {} })).toEqual({ content: [{ type: "text", text: "ran Render" }], isError: false });
    // Revoking the token (TaskStop) closes the bridge's link; its next call says so.
    tokens.revoke("agent_one");
    const after = (await waitFor(async () => {
      const r = (await mcp.request("tools/call", { name: "SendMessage", arguments: { message: "again" } })) as { isError: boolean; content: { text: string }[] };
      return r.isError ? r : undefined;
    }, "the revoked bridge to fail")) as { content: { text: string }[] };
    expect(after.content[0]!.text).toContain("went away");
    ep.close();
  });

  test("the token from outside the agent's tree is refused, and never shows in what the bridge says", async () => {
    const tokens = new BridgeTokens();
    const { ep, sent } = endpointWith({}, tokens, "b2.sock");
    const token = tokens.mint("agent_two");
    // The real agent: a process whose tree the bridge is not in.
    const agent = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    children.push(agent);
    tokens.bind("agent_two", agent.pid!);
    const thief = agentWithBridge({ [BRIDGE_ENV.token]: token, [BRIDGE_ENV.session]: "agent_two", [BRIDGE_ENV.socket]: ep.socketPath }, { direct: true });
    const r = (await thief.mcp.request("tools/call", { name: "SendMessage", arguments: { message: "as the agent" } })) as { isError: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("not-the-agent");
    expect(sent).toEqual([]);
    await waitFor(() => thief.stderr().includes("not connected"), "the bridge's diagnostic");
    expect(thief.stderr()).not.toContain(token);
    expect(r.content[0]!.text).not.toContain(token);
    ep.close();
  });

  test("a connection that skips the hello, or names another role, gets nothing", async () => {
    const tokens = new BridgeTokens();
    const { ep } = endpointWith({}, tokens, "b3.sock");
    const conn = async () => {
      let peer!: RpcPeer;
      const sock = await Bun.connect({ unix: ep.socketPath, socket: { data: (_s, c) => peer.feed(c) } });
      peer = new RpcPeer({ write: (l) => void sock.write(l) });
      return { peer, sock };
    };
    const a = await conn();
    const early = await a.peer.request("bridge.tools", {}).catch((e: unknown) => e);
    expect((early as RpcError).code).toBe(-32010);
    const b = await conn();
    const wrong = await b.peer.request("protocol.hello", { protocolVersion: 1, role: "app", token: "x".repeat(20), clientName: "t" }).catch((e: unknown) => e);
    expect((wrong as RpcError).message).toContain("only the bridge role");
    a.sock.end();
    b.sock.end();
    ep.close();
  });
});
