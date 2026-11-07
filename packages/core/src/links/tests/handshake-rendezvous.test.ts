// The core's rendezvous client (handshake-rendezvous.ts) against a stand-in that keeps services/handshake's rules
// (PROTOCOL.md, "Rendezvous"): a slot is create-only, a retry with the same token and box answers as the first, and
// only the token removes a slot early.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { isContractError } from "../../contracts/common";
import { HandshakeRendezvous, RENDEZVOUS_MAX_TTL } from "../handshake-rendezvous";

interface Seen { method: string; path: string; body?: Record<string, unknown>; auth?: string | null }

function service() {
  const slots = new Map<string, { box: string; tokenHash: string; ttl: number }>();
  const seen: Seen[] = [];
  let down = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (down) return Response.json({ error: "unavailable" }, { status: 503 });
      const url = new URL(req.url);
      const slot = url.pathname.replace(/^\/v1\/rendezvous\//, "");
      const body = req.method === "PUT" ? ((await req.json()) as Record<string, unknown>) : undefined;
      seen.push({ method: req.method, path: url.pathname, ...(body ? { body } : {}), auth: req.headers.get("authorization") });
      const held = slots.get(slot);
      if (req.method === "PUT") {
        const hash = createHash("sha256").update(String(body!.token)).digest("hex");
        if (held) return held.tokenHash === hash && held.box === body!.box ? Response.json({ slot }, { status: 200 }) : Response.json({ error: "taken" }, { status: 409 });
        slots.set(slot, { box: String(body!.box), tokenHash: hash, ttl: Number(body!.ttl) });
        return Response.json({ slot }, { status: 201 });
      }
      if (req.method === "GET") return held ? Response.json({ box: held.box }) : Response.json({ error: "not_found" }, { status: 404 });
      if (req.method === "DELETE") {
        if (!held) return Response.json({ error: "not_found" }, { status: 404 });
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        if (createHash("sha256").update(token).digest("hex") !== held.tokenHash) return Response.json({ error: "forbidden" }, { status: 403 });
        slots.delete(slot);
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, slots, seen, setDown: (d: boolean) => (down = d) };
}

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

describe("the handshake's rendezvous", () => {
  test("publish, lookup and remove a slot; the token goes out only to remove it", async () => {
    const s = service();
    const host = new HandshakeRendezvous({ baseUrl: `${s.url}/` });
    await host.publish("AbCdEfg", "the-box", 900);
    expect(s.slots.get("AbCdEfg")?.ttl).toBe(RENDEZVOUS_MAX_TTL);
    const put = s.seen[0]!;
    expect(put.method).toBe("PUT");
    expect(put.path).toBe("/v1/rendezvous/AbCdEfg");
    expect(Object.keys(put.body!).sort()).toEqual(["box", "token", "ttl"]);
    expect(String(put.body!.token)).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const joiner = new HandshakeRendezvous({ baseUrl: s.url });
    expect(await joiner.lookup("AbCdEfg")).toBe("the-box");
    expect(s.seen[1]!.auth).toBeNull();
    // A joiner never published it: its remove is nothing.
    await joiner.remove("AbCdEfg");
    expect(s.slots.has("AbCdEfg")).toBe(true);
    await host.remove("AbCdEfg");
    expect(s.seen.at(-1)!.auth).toBe(`Bearer ${put.body!.token}`);
    expect(s.slots.has("AbCdEfg")).toBe(false);
    expect(await joiner.lookup("AbCdEfg")).toBeUndefined();
    // Removing again is fine.
    await host.remove("AbCdEfg");
  });

  test("a taken slot is a conflict, as with the stand-in; the same box again is a safe retry", async () => {
    const s = service();
    const host = new HandshakeRendezvous({ baseUrl: s.url });
    await host.publish("Slot123", "box-a", 600);
    await host.publish("Slot123", "box-a", 600);
    const other = new HandshakeRendezvous({ baseUrl: s.url });
    const err = await other.publish("Slot123", "box-b", 600).then(() => null, (e: unknown) => e);
    expect(isContractError(err) && err.code === "conflict").toBe(true);
    expect(s.slots.get("Slot123")?.box).toBe("box-a");
    // The loser kept no token: its remove leaves the host's slot alone.
    await other.remove("Slot123");
    expect(s.slots.has("Slot123")).toBe(true);
  });

  test("an unreachable or failing service is offline; nothing else is", async () => {
    const s = service();
    const r = new HandshakeRendezvous({ baseUrl: s.url });
    s.setDown(true);
    const down = await r.lookup("Slot123").then(() => null, (e: unknown) => e);
    expect(isContractError(down) && down.code === "offline").toBe(true);
    const gone = new HandshakeRendezvous({ baseUrl: "http://127.0.0.1:1", timeoutMs: 2_000 });
    const unreachable = await gone.lookup("Slot123").then(() => null, (e: unknown) => e);
    expect(isContractError(unreachable) && unreachable.code === "offline").toBe(true);
  });
});
