// For lane K's tests: lane C's real Clover server (`createCloverServer`, ipc/clover.ts) on a Unix socket, with lane
// K's bridge parts mounted as the daemon mounts them (`bridgeCloverParts`). The daemon's own IPC server
// (`startIpcServer`) also serves the inherited protocol and needs a session store and the token authority; this
// pump serves only Clover connections, so the agent suite can run the real bridge process against C's hello, its
// caller check with the kernel's pid, its allow list and its params schemas, and nothing else.
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { CloverTokens } from "../../auth/clover-tokens";
import { SessionProcesses } from "../../auth/clover-caller";
import { CloverRpcError, createCloverServer, type CloverConn } from "../../ipc/clover";
import type { BridgeCloverParts } from "../bridge/handlers";

type Sock = { write(b: string | Uint8Array): number; end(): void; data: { buf: string; conn: CloverConn | null; id: number; ready: Promise<unknown> } };

export interface TestCloverEndpoint {
  readonly socketPath: string;
  close(): void;
}

export function serveClover(socketPath: string, parts: BridgeCloverParts): TestCloverEndpoint {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const clover = createCloverServer({
    tokens: new CloverTokens({ verifyCli: async () => false }),
    processes: new SessionProcesses(),
    serverVersion: "test",
    deviceId: "d".repeat(32),
    bridge: parts.bridge,
    handlers: parts.handlers,
  });
  let seq = 0;
  const reply = (s: Sock, id: unknown, body: { result?: unknown; error?: unknown }) => {
    try {
      s.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
    } catch {
      // Closed.
    }
  };
  const onLine = async (s: Sock, line: string) => {
    let msg: { id?: unknown; method?: string; params?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.method !== "string") return;
    try {
      let result: unknown;
      if (s.data.conn) result = await clover.handle(s.data.conn, msg.method, msg.params);
      else if (msg.method === "protocol.hello" && clover.isCloverHello(msg.params)) {
        const h = await clover.hello(s, s.data.id, msg.params, (b) => void s.write(b), () => s.end());
        s.data.conn = h.conn;
        result = h.result;
      } else throw new CloverRpcError(-32010, "say protocol.hello first");
      if (msg.id !== undefined) reply(s, msg.id, { result });
    } catch (err) {
      const e = err as { code?: number; message?: string; data?: unknown };
      if (msg.id !== undefined) reply(s, msg.id, { error: { code: e.code ?? -32603, message: e.message ?? String(err), ...(e.data === undefined ? {} : { data: e.data }) } });
    }
  };
  const listener = Bun.listen<Sock["data"]>({
    unix: socketPath,
    socket: {
      open: (s) => {
        s.data = { buf: "", conn: null, id: ++seq, ready: Promise.resolve() };
      },
      data: (s, chunk) => {
        const sock = s as unknown as Sock;
        sock.data.buf += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = sock.data.buf.indexOf("\n")) >= 0) {
          const line = sock.data.buf.slice(0, nl);
          sock.data.buf = sock.data.buf.slice(nl + 1);
          if (!line.trim()) continue;
          // A hello runs before anything after it; other requests run side by side, as the daemon's do.
          const run = sock.data.ready.then(() => onLine(sock, line));
          if (/"method"\s*:\s*"protocol\.hello"/.test(line)) sock.data.ready = run.catch(() => {});
        }
      },
      close: (s) => clover.closed(s.data.conn, s),
    },
  });
  return {
    socketPath,
    close: () => {
      clover.dispose();
      listener.stop(true);
      rmSync(socketPath, { force: true });
    },
  };
}
