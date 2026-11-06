// A stand-in for the waifucave handshake service (services/handshake/PROTOCOL.md v1), for lane H's tests until lane
// I's service (I-M2) runs locally: the pair and group scopes, the statements and signed requests with their replay
// rule, records, messages, the inbox, the socket with tickets, and the group's lease. It checks what the format says
// a service checks, so a client that passes here speaks the format; it keeps everything in memory.
import { createHash } from "node:crypto";
import { fromBase64Url, randomBytes, toBase64Url } from "../identity/bytes";
import { verifyEd25519 } from "../identity/keys";
import {
  admitStatement, groupStatement, joinStatement, pairStatement, requestStatement, type HandshakeKind, type LeaseRecord,
} from "./handshake";

const KINDS: Record<HandshakeKind, { maxTtl: number; defTtl: number; maxBox: number; record: boolean }> = {
  addr: { maxTtl: 3600, defTtl: 900, maxBox: 4096, record: true },
  dial: { maxTtl: 60, defTtl: 30, maxBox: 4096, record: false },
  signal: { maxTtl: 120, defTtl: 60, maxBox: 8192, record: false },
};

interface Rec { from: string; kind: HandshakeKind; gen: number; expiresAt: number; box: string }
interface Msg { id: string; from: string; to: string; kind: HandshakeKind; at: number; expiresAt: number; box: string }
interface Pair { keys: [string, string]; records: Rec[]; messages: Msg[]; last: Map<string, number> }
interface Group { members: Map<string, number>; removed: Map<string, number>; last: Map<string, number>; lease: LeaseRecord }
interface Sock { send(text: string): void; close(code: number, reason: string): void }

export interface FakeHandshake {
  url: string;
  /** The service's clock offset, to test `t` bounds. */
  skewMs: number;
  readonly pairs: ReadonlyMap<string, { keys: [string, string] }>;
  readonly ended: ReadonlySet<string>;
  readonly groups: ReadonlyMap<string, { members: ReadonlyMap<string, number>; lease: LeaseRecord }>;
  /** Requests answered, by `METHOD path-pattern`. */
  readonly log: string[];
  stop(): void;
}

export function startFakeHandshake(opts: { registrationsPerMinute?: number } = {}): FakeHandshake {
  const pairs = new Map<string, Pair>();
  const ended = new Set<string>();
  const groups = new Map<string, Group>();
  const sockets = new Map<string, Sock>();
  const tickets = new Map<string, { scope: string; key: string; expiresAt: number }>();
  const registrations: number[] = [];
  const log: string[] = [];
  const state = { skewMs: 0 };
  const now = () => Date.now() + state.skewMs;
  const limit = opts.registrationsPerMinute ?? 10;

  const err = (status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    Response.json({ error, ...extra }, { status, headers });
  const sigOk = (key: string, data: Uint8Array, sig: string) => {
    const k = fromBase64Url(key);
    const s = fromBase64Url(sig);
    return k !== null && s !== null && k.length === 32 && s.length === 64 && verifyEd25519(k, data, s);
  };
  const registrationLimited = (): boolean => {
    const t = now();
    while (registrations.length > 0 && registrations[0]! < t - 60_000) registrations.shift();
    if (registrations.length >= limit) return true;
    registrations.push(t);
    return false;
  };
  const push = (scope: string, key: string, frame: unknown) => sockets.get(`${scope}|${key}`)?.send(JSON.stringify(frame));
  const sweep = (p: Pair) => {
    const t = now();
    p.records = p.records.filter((r) => r.expiresAt > t);
    p.messages = p.messages.filter((m) => m.expiresAt > t);
  };

  /** Checks a signed request; returns the member key, or the refusal. */
  const authorize = async (req: Request, url: URL, bytes: Uint8Array, members: (key: string) => boolean, last: Map<string, number>): Promise<string | Response> => {
    const header = req.headers.get("authorization") ?? "";
    const m = /^Clover-Sig key=([A-Za-z0-9_-]+), t=(\d+), sig=([A-Za-z0-9_-]+)$/.exec(header);
    if (!m) return err(401, "unauthorized");
    const [, key, tText, sig] = m as unknown as [string, string, string, string];
    const t = Number(tText);
    if (Math.abs(t - now()) > 120_000) return err(401, "unauthorized");
    if (!sigOk(key, requestStatement(req.method, url.pathname + url.search, t, bytes), sig)) return err(401, "unauthorized");
    if (!members(key)) return err(403, "not_member");
    if (req.method !== "GET") {
      if (t <= (last.get(key) ?? 0)) return err(401, "replay");
      last.set(key, t);
    }
    return key;
  };

  const server = Bun.serve<{ scope: string; key: string }>({
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      open(ws) {
        const id = `${ws.data.scope}|${ws.data.key}`;
        sockets.get(id)?.close(4000, "replaced");
        const sock: Sock = { send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) };
        sockets.set(id, sock);
        const [kind, scopeId] = ws.data.scope.split(":") as [string, string];
        if (kind === "pair") {
          const p = pairs.get(scopeId);
          if (!p) return ws.close(4003, "ended");
          sweep(p);
          const peer = p.keys.find((k) => k !== ws.data.key)!;
          ws.send(JSON.stringify({ t: "hello", v: 1, scope: "pair", peer: { online: sockets.has(`pair:${scopeId}|${peer}`) } }));
          for (const msg of p.messages.filter((x) => x.to === ws.data.key)) ws.send(JSON.stringify({ t: "message", id: msg.id, from: msg.from, kind: msg.kind, at: msg.at, expiresAt: msg.expiresAt, box: msg.box }));
          p.messages = p.messages.filter((x) => x.to !== ws.data.key);
          for (const r of p.records.filter((x) => x.from !== ws.data.key)) ws.send(JSON.stringify({ t: "record", ...r }));
          push(`pair:${scopeId}`, peer, { t: "presence", online: true });
        } else {
          const g = groups.get(scopeId);
          if (!g) return ws.close(4003, "ended");
          ws.send(JSON.stringify({ t: "hello", v: 1, scope: "group", lease: g.lease }));
        }
      },
      message(ws, message) {
        if (message === "ping") ws.send("pong");
      },
      close(ws) {
        const id = `${ws.data.scope}|${ws.data.key}`;
        sockets.delete(id);
        const [kind, scopeId] = ws.data.scope.split(":") as [string, string];
        if (kind === "pair") {
          const p = pairs.get(scopeId);
          const peer = p?.keys.find((k) => k !== ws.data.key);
          if (peer) push(`pair:${scopeId}`, peer, { t: "presence", online: false });
        }
      },
    },
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").slice(1);
      const bytes = new Uint8Array(await req.arrayBuffer());
      const body = (): Record<string, unknown> | undefined => {
        try {
          return bytes.length === 0 ? {} : (JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>);
        } catch {
          return undefined;
        }
      };
      if (bytes.length > 16 * 1024) return err(413, "too_large");
      log.push(`${req.method} /${parts.map((p, i) => (i >= 2 && i % 2 === 0 ? ":id" : p)).join("/")}`);

      if (parts[0] === "v1" && parts[1] === "socket") {
        const ticket = tickets.get(url.searchParams.get("ticket") ?? "");
        if (!ticket || ticket.expiresAt < now()) return err(401, "unauthorized");
        tickets.delete(url.searchParams.get("ticket")!);
        return srv.upgrade(req, { data: { scope: ticket.scope, key: ticket.key } }) ? undefined : err(400, "bad_request");
      }
      if (parts[0] !== "v1") return err(404, "not_found");

      // ---- pairs ----
      if (parts[1] === "pairs" && parts.length === 2 && req.method === "POST") {
        if (registrationLimited()) return err(429, "rate_limited", {}, { "retry-after": "60" });
        const b = body();
        const keys = b?.keys as [string, string] | undefined;
        const sigs = b?.sigs as [string, string] | undefined;
        if (!b || typeof b.pair !== "string" || !Array.isArray(keys) || keys.length !== 2 || !Array.isArray(sigs) || sigs.length !== 2 || typeof b.t !== "number") return err(400, "bad_request");
        if (Math.abs(b.t - now()) > 600_000) return err(401, "unauthorized");
        const statement = pairStatement(b.pair, keys, b.t);
        if (!sigOk(keys[0], statement, sigs[0]) || !sigOk(keys[1], statement, sigs[1])) return err(401, "unauthorized");
        if (ended.has(b.pair)) return err(410, "ended");
        const existing = pairs.get(b.pair);
        if (existing) return existing.keys[0] === keys[0] && existing.keys[1] === keys[1] ? Response.json({}, { status: 200 }) : err(409, "conflict");
        pairs.set(b.pair, { keys: [keys[0], keys[1]], records: [], messages: [], last: new Map() });
        return Response.json({}, { status: 201 });
      }
      if (parts[1] === "pairs" && parts[2]) {
        const id = parts[2];
        if (ended.has(id)) return err(410, "ended");
        const p = pairs.get(id);
        if (!p) return err(404, "not_found");
        const who = await authorize(req, url, bytes, (k) => p.keys.includes(k), p.last);
        if (who instanceof Response) return who;
        const peer = p.keys.find((k) => k !== who)!;
        sweep(p);
        const scope = `pair:${id}`;
        if (parts.length === 3 && req.method === "GET") {
          return Response.json({ pair: id, keys: p.keys, peer: { online: sockets.has(`${scope}|${peer}`) }, records: p.records.filter((r) => r.from !== who) });
        }
        if (parts.length === 3 && req.method === "DELETE") {
          pairs.delete(id);
          ended.add(id);
          for (const k of p.keys) {
            sockets.get(`${scope}|${k}`)?.send(JSON.stringify({ t: "bye", reason: "ended" }));
            sockets.get(`${scope}|${k}`)?.close(4003, "ended");
          }
          return new Response(null, { status: 204 });
        }
        if (parts[3] === "records" && parts[4] && req.method === "PUT") {
          const kind = parts[4] as HandshakeKind;
          const spec = KINDS[kind];
          if (!spec?.record) return err(400, "bad_kind");
          const b = body();
          if (!b || typeof b.gen !== "number" || typeof b.box !== "string") return err(400, "bad_request");
          if ((fromBase64Url(b.box)?.length ?? Infinity) > spec.maxBox) return err(413, "too_large");
          const current = p.records.find((r) => r.from === who && r.kind === kind);
          if (current && b.gen <= current.gen) return err(409, "stale");
          const ttl = Math.min(typeof b.ttl === "number" ? b.ttl : spec.defTtl, spec.maxTtl);
          const rec: Rec = { from: who, kind, gen: b.gen, expiresAt: now() + ttl * 1000, box: b.box };
          p.records = [...p.records.filter((r) => !(r.from === who && r.kind === kind)), rec];
          push(scope, peer, { t: "record", ...rec });
          return new Response(null, { status: 204 });
        }
        if (parts[3] === "messages" && req.method === "POST") {
          const b = body();
          const kind = b?.kind as HandshakeKind;
          const spec = KINDS[kind];
          if (!b || !spec || spec.record) return err(400, "bad_kind");
          if (typeof b.box !== "string") return err(400, "bad_request");
          const ttl = Math.min(typeof b.ttl === "number" ? b.ttl : spec.defTtl, spec.maxTtl);
          const msg: Msg = { id: toBase64Url(randomBytes(9)), from: who, to: peer, kind, at: now(), expiresAt: now() + ttl * 1000, box: b.box };
          const sock = sockets.get(`${scope}|${peer}`);
          if (sock) {
            sock.send(JSON.stringify({ t: "message", id: msg.id, from: msg.from, kind: msg.kind, at: msg.at, expiresAt: msg.expiresAt, box: msg.box }));
            return Response.json({ id: msg.id, delivered: true }, { status: 202 });
          }
          p.messages.push(msg);
          const mine = p.messages.filter((m) => m.to === peer);
          if (mine.length > 16) p.messages.splice(p.messages.indexOf(mine[0]!), 1);
          return Response.json({ id: msg.id, delivered: false }, { status: 202 });
        }
        if (parts[3] === "inbox" && req.method === "POST") {
          const mine = p.messages.filter((m) => m.to === who);
          p.messages = p.messages.filter((m) => m.to !== who);
          return Response.json({ messages: mine.map(({ to: _to, ...m }) => m) });
        }
        if (parts[3] === "tickets" && req.method === "POST") {
          const ticket = toBase64Url(randomBytes(18));
          tickets.set(ticket, { scope, key: who, expiresAt: now() + 60_000 });
          return Response.json({ url: `ws://127.0.0.1:${srv.port}/v1/socket?ticket=${ticket}`, expiresAt: now() + 60_000 });
        }
        return err(404, "not_found");
      }

      // ---- groups ----
      if (parts[1] === "groups" && parts.length === 2 && req.method === "POST") {
        if (registrationLimited()) return err(429, "rate_limited", {}, { "retry-after": "60" });
        const b = body();
        if (!b || typeof b.group !== "string" || typeof b.key !== "string" || typeof b.t !== "number" || typeof b.sig !== "string") return err(400, "bad_request");
        if (Math.abs(b.t - now()) > 600_000 || !sigOk(b.key, groupStatement(b.group, b.key, b.t), b.sig)) return err(401, "unauthorized");
        const g = groups.get(b.group);
        if (g) return g.members.has(b.key) ? Response.json({}, { status: 200 }) : err(409, "conflict");
        groups.set(b.group, { members: new Map([[b.key, now()]]), removed: new Map(), last: new Map(), lease: { holder: null, epoch: 0, expiresAt: null } });
        return Response.json({}, { status: 201 });
      }
      if (parts[1] === "groups" && parts[2]) {
        const id = parts[2];
        const g = groups.get(id);
        if (!g) return err(404, "not_found");
        const scope = `group:${id}`;
        if (parts[3] === "members" && parts.length === 4 && req.method === "POST") {
          if (registrationLimited()) return err(429, "rate_limited", {}, { "retry-after": "60" });
          const b = body();
          if (!b || typeof b.key !== "string" || typeof b.t !== "number" || typeof b.sig !== "string" || typeof b.by !== "string" || typeof b.bysig !== "string") return err(400, "bad_request");
          if (Math.abs(b.t - now()) > 600_000) return err(401, "unauthorized");
          if (!sigOk(b.key, joinStatement(id, b.key, b.t), b.sig) || !sigOk(b.by, admitStatement(id, b.key, b.t), b.bysig)) return err(401, "unauthorized");
          if (!g.members.has(b.by)) return err(403, "not_member");
          if ((g.removed.get(b.key) ?? -1) >= b.t) return err(403, "revoked");
          if (g.members.has(b.key)) return Response.json({}, { status: 200 });
          if (g.members.size >= 32) return err(409, "full");
          g.members.set(b.key, now());
          for (const k of g.members.keys()) push(scope, k, { t: "members", members: [...g.members].map(([key, joinedAt]) => ({ key, joinedAt })) });
          return Response.json({}, { status: 201 });
        }
        const who = await authorize(req, url, bytes, (k) => g.members.has(k), g.last);
        if (who instanceof Response) return who;
        if (parts.length === 3 && req.method === "GET") {
          return Response.json({ group: id, members: [...g.members].map(([key, joinedAt]) => ({ key, joinedAt })), lease: g.lease });
        }
        if (parts[3] === "members" && parts[4] && req.method === "DELETE") {
          const gone = parts[4];
          g.members.delete(gone);
          g.removed.set(gone, now());
          if (g.lease.holder === gone) g.lease = { holder: null, epoch: g.lease.epoch, expiresAt: null };
          if (g.members.size === 0) groups.delete(id);
          return new Response(null, { status: 204 });
        }
        if (parts[3] === "lease" && req.method === "POST") {
          const b = body();
          const op = b?.op;
          const epoch = typeof b?.epoch === "number" ? b.epoch : -1;
          const ttl = Math.min(Math.max(typeof b?.ttl === "number" ? b.ttl : 60, 10), 300);
          const l = g.lease;
          const lapsed = l.holder === null || (l.expiresAt ?? 0) <= now();
          const held = () => err(409, "held", { lease: l });
          if (op === "acquire") {
            if (!lapsed && l.holder !== who) return held();
            g.lease = { holder: who, epoch: l.holder === who && !lapsed ? l.epoch : l.epoch + 1, expiresAt: now() + ttl * 1000 };
          } else if (op === "renew") {
            if (l.holder !== who || l.epoch !== epoch || lapsed) return held();
            g.lease = { ...l, expiresAt: now() + ttl * 1000 };
          } else if (op === "release") {
            if (l.holder !== who || l.epoch !== epoch) return held();
            g.lease = { holder: null, epoch: l.epoch, expiresAt: null };
          } else if (op === "takeover") {
            g.lease = { holder: who, epoch: l.epoch + 1, expiresAt: now() + ttl * 1000 };
          } else return err(400, "bad_request");
          for (const k of g.members.keys()) push(scope, k, { t: "lease", lease: g.lease });
          return Response.json({ lease: g.lease });
        }
        if (parts[3] === "tickets" && req.method === "POST") {
          const ticket = toBase64Url(randomBytes(18));
          tickets.set(ticket, { scope, key: who, expiresAt: now() + 60_000 });
          return Response.json({ url: `ws://127.0.0.1:${srv.port}/v1/socket?ticket=${ticket}`, expiresAt: now() + 60_000 });
        }
        return err(404, "not_found");
      }
      return err(404, "not_found");
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    get skewMs() {
      return state.skewMs;
    },
    set skewMs(v: number) {
      state.skewMs = v;
    },
    pairs,
    ended,
    groups,
    log,
    stop() {
      server.stop(true);
    },
  };
}

/** For tests: SHA-256, base64url. */
export const digestB64u = (data: Uint8Array): string => toBase64Url(new Uint8Array(createHash("sha256").update(data).digest()));
