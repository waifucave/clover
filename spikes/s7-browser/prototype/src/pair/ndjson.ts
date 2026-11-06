// JSON-RPC-ish NDJSON over a socket (the pair's control channel). Works in Bun and in Electron's Node.
import { connect, type Socket } from "node:net";

/** Split complete lines out of a buffer. Pure. */
export function splitLines(buf: string): { lines: string[]; rest: string } {
  const parts = buf.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim() !== ""), rest };
}

export type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: string };

export class Conn {
  private buf = "";
  private nextId = 1;
  private readonly waiting = new Map<number, (m: Msg) => void>();
  onMessage?: (m: Msg) => void;
  onClose?: () => void;
  closed = false;

  constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      const { lines, rest } = splitLines(this.buf + d);
      this.buf = rest;
      for (const l of lines) {
        let m: Msg;
        try { m = JSON.parse(l) as Msg; } catch { continue; }
        if (m.id !== undefined && m.method === undefined && this.waiting.has(m.id)) {
          const w = this.waiting.get(m.id)!;
          this.waiting.delete(m.id);
          w(m);
        } else {
          this.onMessage?.(m);
        }
      }
    });
    const done = (): void => {
      if (this.closed) return;
      this.closed = true;
      for (const w of this.waiting.values()) w({ error: "closed" });
      this.waiting.clear();
      this.onClose?.();
    };
    socket.on("close", done);
    socket.on("error", done);
  }

  send(m: Msg): void {
    if (!this.closed) this.socket.write(`${JSON.stringify(m)}\n`);
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<Msg> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.waiting.delete(id); resolve({ error: "timeout" }); }, timeoutMs);
      this.waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.send({ id, method, params });
    });
  }

  reply(to: Msg, result: unknown): void {
    if (to.id !== undefined) this.send({ id: to.id, result });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

/** Connect to the daemon; undefined when nothing listens. */
export function dial(path: string, timeoutMs = 1000): Promise<Conn | undefined> {
  return new Promise((resolve) => {
    const s = connect(path);
    const t = setTimeout(() => { s.destroy(); resolve(undefined); }, timeoutMs);
    s.once("connect", () => { clearTimeout(t); resolve(new Conn(s)); });
    s.once("error", () => { clearTimeout(t); resolve(undefined); });
  });
}
