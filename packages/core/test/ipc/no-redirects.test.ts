// The daemon's own clients to waifucave's services never follow a redirect (the reviewer's N1 on #304): a 307 or 308
// sends the request's body again, so the handshake's signed bodies, short codes' boxes and removal tokens, and the
// sign-in's password or refresh token, would go to whatever origin the answer names. Each client is pointed at a server
// that answers every request with a 307 (and one with a 308) to another server, which must never see a request.
import { afterEach, describe, expect, test } from "bun:test";
import { SystemClock } from "../../src/clock/system-clock";
import { MemorySecretStore } from "../../src/contracts/fakes/secret-store";
import { Secret } from "../../src/contracts/secret-store";
import { AccountClient } from "../../src/identity/account";
import { DeviceKey } from "../../src/identity/device-key";
import { HandshakeClient } from "../../src/links/handshake";
import { HandshakeRendezvous } from "../../src/links/handshake-rendezvous";

const clock = new SystemClock();
let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** A server that sends everything elsewhere (`status`), and the elsewhere, which records whatever reaches it. */
function redirecting(status: 307 | 308) {
  const reached: { method: string; path: string; body: string }[] = [];
  const elsewhere = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      reached.push({ method: req.method, path: new URL(req.url).pathname, body: await req.text() });
      return Response.json({ ok: true });
    },
  });
  const asked: string[] = [];
  const origin = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const u = new URL(req.url);
      asked.push(`${req.method} ${u.pathname}`);
      return new Response(null, { status, headers: { location: `http://127.0.0.1:${elsewhere.port}${u.pathname}${u.search}` } });
    },
  });
  stops.push(() => origin.stop(true), () => elsewhere.stop(true));
  return { url: `http://127.0.0.1:${origin.port}`, reached, asked };
}

describe("no client of waifucave's services follows a redirect", () => {
  for (const status of [307, 308] as const) {
    test(`the handshake (${status}): a signed registration is refused, never sent on`, async () => {
      const s = redirecting(status);
      const client = new HandshakeClient({ baseUrl: s.url, clock });
      const err = await client.registerPair({ pair: "p".repeat(43), keys: ["a".repeat(43), "b".repeat(43)], t: Date.now(), sigs: ["s".repeat(86), "s".repeat(86)] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(s.asked).toHaveLength(1);
      expect(s.reached).toEqual([]);
    });

    test(`the rendezvous (${status}): a short code's box and its removal token are refused, never sent on`, async () => {
      const s = redirecting(status);
      const rv = new HandshakeRendezvous({ baseUrl: s.url });
      expect(await rv.publish("slot1", "box-sealed", 60).catch((e: unknown) => e)).toBeInstanceOf(Error);
      expect(s.asked).toHaveLength(1);
      expect(s.reached).toEqual([]);
    });

    test(`the account (${status}): a sign-in's password is refused, never sent on`, async () => {
      const s = redirecting(status);
      const store = new MemorySecretStore();
      const device = await DeviceKey.loadOrCreate(store);
      const account = new AccountClient({ config: { authUrl: s.url, anonKey: "anon", serviceUrl: s.url }, store, device, clock });
      stops.push(() => account.close());
      expect(await account.signInWithPassword("someone@example.invalid", new Secret("correct horse")).catch((e: unknown) => e)).toBeInstanceOf(Error);
      expect(s.asked).toHaveLength(1);
      expect(s.reached).toEqual([]);
    });
  }
});
