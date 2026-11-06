// One Clover call from a short-lived client (the CLI's `autostart disable --stop`, `remove`): connect,
// say hello at protocol version 1 with a role and its token, make one request, close. Works over the
// Unix socket and the Windows pipe alike.
import { CLOVER_PROTOCOL_VERSION, encodeLine, LineDecoder, METHODS, type CloverRole } from "@waifucave/clover-protocol";

export async function cloverCall(
  endpoint: string,
  hello: { role: CloverRole; token: string; clientName: string },
  method: string, params: unknown, timeoutMs = 5_000,
): Promise<unknown> {
  const decoder = new LineDecoder();
  const pending = new Map<number, { ok(v: unknown): void; fail(e: Error): void }>();
  const socket = await Bun.connect({ unix: endpoint, socket: {
    data(_s, chunk) {
      for (const line of decoder.push(chunk)) {
        const m = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { code: number; message: string } };
        const p = typeof m.id === "number" ? pending.get(m.id) : undefined;
        if (!p) continue;
        pending.delete(m.id as number);
        if (m.error) p.fail(Object.assign(new Error(m.error.message), { code: m.error.code })); else p.ok(m.result);
      }
    },
    close() { for (const p of pending.values()) p.fail(new Error("the daemon closed the connection")); pending.clear(); },
  } });
  let next = 1;
  const request = (m: string, p: unknown) => new Promise<unknown>((ok, fail) => {
    const id = next++;
    pending.set(id, { ok, fail });
    socket.write(encodeLine({ jsonrpc: "2.0", id, method: m, params: p }));
  });
  const timer = setTimeout(() => socket.end(), timeoutMs);
  try {
    await request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, ...hello });
    return await request(method, params);
  } finally {
    clearTimeout(timer);
    socket.end();
  }
}
