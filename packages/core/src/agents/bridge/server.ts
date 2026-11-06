// The bridge MCP server (spec §9.3): the one stdio MCP server Clover hands each ACP agent at `session/new`. The agent
// starts it as a child; it speaks MCP to the agent on stdio and Clover's protocol to the daemon on a socket, with role
// `bridge`, bound to that one agent session by its token.
//
// * It reads its token, session and socket from its environment (`CLOVER_BRIDGE_TOKEN`, `CLOVER_BRIDGE_SESSION`,
//   `CLOVER_BRIDGE_SOCKET`) and deletes them from `process.env` at once, so nothing it might start inherits them. The
//   process's original environment block still holds them (`ps eww`, `/proc/<pid>/environ`), readable by the agent's
//   own processes: the defence is the token's binding to the agent's process tree, not the deletion.
// * It connects to the daemon as soon as it starts, before the agent asks anything, so the real bridge holds the
//   token's one live connection first (S5 edit 4).
// * MCP's two eras (S5 §2): Antigravity probes the 2026-07-28 `server/discover` before falling back to the
//   2025-11-25 `initialize`. The bridge answers `server/discover` with method-not-found, which S5 showed sends that
//   client to `initialize` on stdio, and serves the legacy handshake. A native modern answer comes when an agent the
//   suite runs needs one.
// * It never answers 401 and never asks for a sign-in: it is stdio only (S5 risk 8).
// * Tool descriptions come from the daemon (`bridge.tools`) and stand on their own; the instructions go out as the
//   server's own, and the essentials also travel in the agent's system prompt (S5 edit 3).
import { randomUUID } from "node:crypto";
import { CLOVER_PROTOCOL_VERSION } from "@waifucave/clover-protocol";
import { RPC_METHOD_NOT_FOUND, RpcError, RpcPeer } from "../acp/jsonrpc";
import type { BridgeToolDef } from "./tools";

export const BRIDGE_ENV = { token: "CLOVER_BRIDGE_TOKEN", session: "CLOVER_BRIDGE_SESSION", socket: "CLOVER_BRIDGE_SOCKET" } as const;

/** The MCP revisions the legacy handshake answers; the newest is offered when a client names one it doesn't know. */
export const MCP_LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface BridgeIo {
  /** Bytes from the agent (stdin). */
  onInput(fn: (chunk: Uint8Array) => void, end: () => void): void;
  /** A line to the agent (stdout). */
  output(line: string): void;
  /** A diagnostic line (stderr). Never holds the token. */
  log(line: string): void;
  /** Opens the daemon socket; resolves with a duplex. */
  connect(path: string, onData: (chunk: Uint8Array) => void, onClose: () => void): Promise<{ write(line: string): void; close(): void }>;
}

export interface BridgeRun {
  /** Settles once the daemon accepted the hello, or with the refusal. */
  ready: Promise<void>;
  /** Ends when the agent closes stdin. */
  done: Promise<void>;
}

const VERSION = "0.0.0";

export function runBridge(env: Record<string, string | undefined>, io: BridgeIo): BridgeRun {
  const token = env[BRIDGE_ENV.token];
  const sessionId = env[BRIDGE_ENV.session];
  const socket = env[BRIDGE_ENV.socket];
  for (const k of Object.values(BRIDGE_ENV)) delete env[k];

  let daemon: RpcPeer | undefined;
  let broken: string | undefined;
  let tools: { tools: BridgeToolDef[]; instructions: string } | undefined;

  const ready = (async () => {
    if (!token || !sessionId || !socket) {
      broken = "the bridge was started without its session";
      throw new Error(broken);
    }
    // Windows: when two clients connect to the pipe in the same instant, the daemon can't tell which pid is whose and
    // refuses the hello (`unverified-caller`); the bridge tries once more (lane C's note).
    for (let attempt = 1; ; attempt++) {
      let closed = false;
      const peer = new RpcPeer({ write: (line) => link.write(line) });
      const link = await io.connect(socket, (c) => peer.feed(c), () => {
        closed = true;
        if (daemon === peer) broken ??= "the Clover daemon went away";
        peer.close(new Error(broken ?? "the Clover daemon closed the connection"));
      });
      try {
        await peer.request("protocol.hello", { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "bridge", token, clientName: "clover-bridge", agentSessionId: sessionId }, { timeoutMs: 60_000 });
        daemon = peer;
        if (closed) broken ??= "the Clover daemon went away";
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        link.close();
        if (attempt === 1 && /unverified-caller/.test(msg)) continue;
        broken = msg;
        throw err;
      }
    }
  })();
  ready.catch((err: unknown) => io.log(`clover bridge: not connected: ${err instanceof Error ? err.message : String(err)}`));

  const fromDaemon = async (method: string, params: unknown): Promise<unknown> => {
    await ready.catch(() => {});
    if (!daemon || broken) throw new Error(broken ?? "the bridge isn't connected to Clover");
    return daemon.request(method, params);
  };
  const toolList = async () => (tools ??= (await fromDaemon("bridge.tools", {})) as { tools: BridgeToolDef[]; instructions: string });

  const textResult = (text: string, isError: boolean) => ({ content: [{ type: "text", text }], isError });

  const agent = new RpcPeer({
    write: (line) => io.output(line),
    onRequest: async (method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case "initialize": {
          const asked = typeof p["protocolVersion"] === "string" ? p["protocolVersion"] : undefined;
          const version = asked && (MCP_LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_LEGACY_VERSIONS[0];
          const instructions = await toolList().then((t) => t.instructions, () => "");
          return { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "clover", version: VERSION }, ...(instructions ? { instructions } : {}) };
        }
        case "ping":
          return {};
        case "tools/list": {
          const t = await toolList();
          return { tools: t.tools.map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema })) };
        }
        case "tools/call": {
          const name = String(p["name"] ?? "");
          const args = (p["arguments"] ?? {}) as Record<string, unknown>;
          try {
            if (name === "SendMessage") {
              const text = String(args["message"] ?? args["text"] ?? "");
              if (!text) return textResult("SendMessage needs a message.", true);
              await fromDaemon("bridge.sendMessage", { text, ...(typeof args["to"] === "string" && args["to"] ? { to: args["to"] } : {}) });
              return textResult("Sent.", false);
            }
            if (name === "Glossary") {
              const r = await fromDaemon("glossary.query", { ...(args["query"] === undefined ? {} : { query: args["query"] }), ...(args["load"] === undefined ? {} : { load: args["load"] }) });
              return textResult(JSON.stringify(r, null, 2), false);
            }
            const r = (await fromDaemon("bridge.call", { callId: randomUUID(), tool: name, input: args })) as { content: unknown[]; isError: boolean };
            return { content: r.content, isError: r.isError };
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        }
        case "resources/list":
          return { resources: [] };
        case "resources/templates/list":
          return { resourceTemplates: [] };
        case "prompts/list":
          return { prompts: [] };
        default:
          // `server/discover` included: the 2026-07-28 client falls back to `initialize` (S5 §2).
          throw new RpcError(RPC_METHOD_NOT_FOUND, `the Clover bridge doesn't serve ${method}`);
      }
    },
    onNotification: () => {},
  });

  const done = new Promise<void>((resolve) => {
    io.onInput((c) => agent.feed(c), () => {
      agent.close();
      resolve();
    });
  });
  return { ready, done };
}
