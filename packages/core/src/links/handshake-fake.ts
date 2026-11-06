// A stand-in for the waifucave handshake service (services/handshake/PROTOCOL.md v1), for lane H's tests until lane
// I's service (I-M2) runs locally: the pair and group scopes, the statements and signed requests with their replay
// rule, records, messages, the inbox, the socket with tickets, the group's lease, and the account channel's lease. It checks what the format says
// a service checks, so a client that passes here speaks the format; it keeps everything in memory.
//
// Groups also follow lane I's "Group recovery" proposal as lane H reads it (H-M2; the service builds it once agreed):
// * a member votes from its join when a quorum of voters admitted it (the founder too), else after `voteAfterMs`;
// * removing a member other than yourself takes the removes of a quorum of the voters other than it, not counting the
//   keys it admitted in the last `rollbackMs` (403 `no_quorum` short of one); removing yourself takes only you;
// * a quorum's removal undoes the changes the removed member signed in the last `rollbackMs`: the keys it admitted go
//   (and theirs in turn), the members it removed come back; the keys the quorum's removes name as kept stay;
// * a member that doesn't vote yet can't take the lease over (403 `not_voter`).
import { createHash } from "node:crypto";
import { fromBase64Url, randomBytes, toBase64Url } from "../identity/bytes";
import { verifyEd25519 } from "../identity/keys";
import {
  admitStatement, groupStatement, joinStatement, pairStatement, quorumOf, removeStatement, requestStatement, ROLLBACK_MS, VOTE_AFTER_MS,
  type HandshakeKind, type LeaseRecord,
} from "./handshake";

const KINDS: Record<HandshakeKind, { maxTtl: number; defTtl: number; maxBox: number; record: boolean }> = {
  addr: { maxTtl: 3600, defTtl: 900, maxBox: 4096, record: true },
  dial: { maxTtl: 60, defTtl: 30, maxBox: 4096, record: false },
  signal: { maxTtl: 120, defTtl: 60, maxBox: 8192, record: false },
};

interface Rec { from: string; kind: HandshakeKind; gen: number; expiresAt: number; box: string }
interface Msg { id: string; from: string; to: string; kind: HandshakeKind; at: number; expiresAt: number; box: string }
interface Pair { keys: [string, string]; records: Rec[]; messages: Msg[]; last: Map<string, number> }
interface Member { joinedAt: number; votesFrom: number | null; admittedBy: string[] }
interface Change { kind: "admit" | "remove"; target: string; signers: string[]; at: number; member?: Member }
interface Group { members: Map<string, Member>; removed: Map<string, number>; last: Map<string, number>; lease: LeaseRecord; changes: Change[] }
interface Sock { send(text: string): void; close(code: number, reason: string): void }

export interface FakeHandshake {
  url: string;
  /** The service's clock offset, to test `t` bounds. */
  skewMs: number;
  readonly pairs: ReadonlyMap<string, { keys: [string, string] }>;
  readonly ended: ReadonlySet<string>;
  readonly groups: ReadonlyMap<string, { members: ReadonlyMap<string, { joinedAt: number; votesFrom: number | null; admittedBy: string[] }>; lease: LeaseRecord }>;
  /** The account channel's leases, by account. */
  readonly accountLeases: ReadonlyMap<string, LeaseRecord>;
  /** The account channel's records addressed to a device, as the service holds them (sealed). */
  accountRecordsFor(device: string): { from: string; kind: string; gen: number; box: string }[];
  /** Requests answered, by `METHOD path-pattern`. */
  readonly log: string[];
  stop(): void;
}

export interface FakeHandshakeOptions {
  registrationsPerMinute?: number;
  /** The service's clock (a test's FakeClock); the wall clock by default. */
  now?: () => number;
  /** The account channel: who an account token is (`sub`, `dev`), as the service checks it against the JWKS; without
   *  it the channel answers 401. */
  accountOf?: (token: string) => { sub: string; dev: string } | undefined;
  /** Group recovery's timings (the proposal's 72 hours and 7 days by default). */
  voteAfterMs?: number;
  rollbackMs?: number;
}

export function startFakeHandshake(opts: FakeHandshakeOptions = {}): FakeHandshake {
  const pairs = new Map<string, Pair>();
  const ended = new Set<string>();
  const groups = new Map<string, Group>();
  const sockets = new Map<string, Sock>();
  const tickets = new Map<string, { scope: string; key: string; expiresAt: number }>();
  const registrations: number[] = [];
  const log: string[] = [];
  const state = { skewMs: 0 };
  const clock = opts.now ?? Date.now;
  const now = () => clock() + state.skewMs;
  const accountLeases = new Map<string, LeaseRecord>();
  /** The account channel's records (`<sub>|<to>` → by sender and kind) and queued messages (by `<sub>|<to>`). */
  const accountRecords = new Map<string, Rec[]>();
  const accountMessages = new Map<string, Msg[]>();
  const limit = opts.registrationsPerMinute ?? 10;
  const voteAfterMs = opts.voteAfterMs ?? VOTE_AFTER_MS;
  const rollbackMs = opts.rollbackMs ?? ROLLBACK_MS;
  const votes = (m: Member | undefined): boolean => m !== undefined && m.votesFrom !== null && m.votesFrom <= now();
  const memberList = (g: Group) => [...g.members].map(([key, m]) => ({ key, joinedAt: m.joinedAt, votesFrom: m.votesFrom, admittedBy: [...m.admittedBy] }));
  /** Undoes what `gone` signed in the last `rollbackMs`: the keys it admitted (and theirs), the members it removed. */
  const rollBack = (g: Group, gone: string, keeps: ReadonlySet<string>, seen = new Set<string>()): void => {
    if (seen.has(gone)) return;
    seen.add(gone);
    const since = now() - rollbackMs;
    for (const c of g.changes.filter((x) => x.at >= since && x.signers.includes(gone))) {
      if (c.kind === "admit" && keeps.has(c.target)) continue;
      if (c.kind === "admit" && g.members.has(c.target)) {
        g.members.delete(c.target);
        g.removed.set(c.target, now());
        if (g.lease.holder === c.target) g.lease = { holder: null, epoch: g.lease.epoch, expiresAt: null };
        rollBack(g, c.target, keeps, seen);
      } else if (c.kind === "remove" && c.member && !g.members.has(c.target)) {
        g.members.set(c.target, c.member);
        g.removed.delete(c.target);
      }
    }
  };

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

  /** One lease operation (PROTOCOL.md's table): the new record, or the 409 `held` refusal with the current one. */
  const leaseOp = (l: LeaseRecord, who: string, b: Record<string, unknown> | undefined): LeaseRecord | Response => {
    const op = b?.op;
    const epoch = typeof b?.epoch === "number" ? b.epoch : -1;
    const ttl = Math.min(Math.max(typeof b?.ttl === "number" ? b.ttl : 60, 10), 300);
    const lapsed = l.holder === null || (l.expiresAt ?? 0) <= now();
    const held = () => err(409, "held", { lease: l });
    if (op === "acquire") {
      if (!lapsed && l.holder !== who) return held();
      return { holder: who, epoch: l.holder === who && !lapsed ? l.epoch : l.epoch + 1, expiresAt: now() + ttl * 1000 };
    }
    if (op === "renew") {
      if (l.holder !== who || l.epoch !== epoch || lapsed) return held();
      return { ...l, expiresAt: now() + ttl * 1000 };
    }
    if (op === "release") {
      if (l.holder !== who || l.epoch !== epoch) return held();
      return { holder: null, epoch: l.epoch, expiresAt: null };
    }
    if (op === "takeover") return { holder: who, epoch: l.epoch + 1, expiresAt: now() + ttl * 1000 };
    return err(400, "bad_request");
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
        } else if (kind === "account") {
          const lease = accountLeases.get(scopeId) ?? { holder: null, epoch: 0, expiresAt: null };
          const online = [...sockets.keys()].filter((k) => k.startsWith(`account:${scopeId}|`)).map((k) => k.slice(`account:${scopeId}|`.length)).filter((d) => d !== ws.data.key);
          ws.send(JSON.stringify({ t: "hello", v: 1, scope: "account", online, lease }));
          const queued = (accountMessages.get(`${scopeId}|${ws.data.key}`) ?? []).filter((m) => m.expiresAt > now());
          accountMessages.delete(`${scopeId}|${ws.data.key}`);
          for (const m of queued) ws.send(JSON.stringify({ t: "message", id: m.id, from: m.from, kind: m.kind, at: m.at, expiresAt: m.expiresAt, box: m.box }));
          for (const r of (accountRecords.get(`${scopeId}|${ws.data.key}`) ?? []).filter((x) => x.expiresAt > now())) ws.send(JSON.stringify({ t: "record", ...r }));
          for (const k of sockets.keys()) if (k.startsWith(`account:${scopeId}|`) && k !== id) sockets.get(k)!.send(JSON.stringify({ t: "presence", device: ws.data.key, online: true }));
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
        } else if (kind === "account") {
          for (const k of sockets.keys()) if (k.startsWith(`account:${scopeId}|`)) sockets.get(k)!.send(JSON.stringify({ t: "presence", device: ws.data.key, online: false }));
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

      // ---- the account channel ----
      if (parts[1] === "accounts" && parts[2] === "self") {
        const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
        const who = m ? opts.accountOf?.(m[1]!) : undefined;
        if (!who) return err(401, "unauthorized");
        const lease = accountLeases.get(who.sub) ?? { holder: null, epoch: 0, expiresAt: null };
        const scope = `account:${who.sub}`;
        const mine = `${who.sub}|${who.dev}`;
        const live = <T extends { expiresAt: number }>(xs: T[]) => xs.filter((x) => x.expiresAt > now());
        if (parts.length === 3 && req.method === "GET") {
          const online = [...sockets.keys()].filter((k) => k.startsWith(`${scope}|`)).map((k) => k.slice(scope.length + 1)).filter((d) => d !== who.dev);
          return Response.json({ online, records: live(accountRecords.get(mine) ?? []), lease });
        }
        if (parts[3] === "records" && parts[4] && parts[5] && req.method === "PUT") {
          const kind = parts[4] as HandshakeKind;
          const spec = KINDS[kind];
          if (!spec?.record) return err(400, "bad_kind");
          const b = body();
          if (!b || typeof b.gen !== "number" || typeof b.box !== "string") return err(400, "bad_request");
          const to = decodeURIComponent(parts[5]);
          const key = `${who.sub}|${to}`;
          const list = live(accountRecords.get(key) ?? []);
          const current = list.find((r) => r.from === who.dev && r.kind === kind);
          if (current && b.gen <= current.gen) return err(409, "stale");
          const ttl = Math.min(typeof b.ttl === "number" ? b.ttl : spec.defTtl, spec.maxTtl);
          const rec: Rec = { from: who.dev, kind, gen: b.gen, expiresAt: now() + ttl * 1000, box: b.box };
          accountRecords.set(key, [...list.filter((r) => !(r.from === who.dev && r.kind === kind)), rec]);
          push(scope, to, { t: "record", ...rec });
          return new Response(null, { status: 204 });
        }
        if (parts[3] === "messages" && req.method === "POST") {
          const b = body();
          const kind = b?.kind as HandshakeKind;
          const spec = KINDS[kind];
          if (!b || !spec || spec.record || typeof b.to !== "string" || typeof b.box !== "string") return err(400, "bad_kind");
          const ttl = Math.min(typeof b.ttl === "number" ? b.ttl : spec.defTtl, spec.maxTtl);
          const msg: Msg = { id: toBase64Url(randomBytes(9)), from: who.dev, to: b.to, kind, at: now(), expiresAt: now() + ttl * 1000, box: b.box };
          const sock = sockets.get(`${scope}|${b.to}`);
          if (sock) {
            sock.send(JSON.stringify({ t: "message", id: msg.id, from: msg.from, kind: msg.kind, at: msg.at, expiresAt: msg.expiresAt, box: msg.box }));
            return Response.json({ id: msg.id, delivered: true }, { status: 202 });
          }
          const key = `${who.sub}|${b.to}`;
          accountMessages.set(key, [...live(accountMessages.get(key) ?? []), msg].slice(-16));
          return Response.json({ id: msg.id, delivered: false }, { status: 202 });
        }
        if (parts[3] === "inbox" && req.method === "POST") {
          const queued = live(accountMessages.get(mine) ?? []);
          accountMessages.delete(mine);
          return Response.json({ messages: queued.map(({ to: _to, ...m }) => m) });
        }
        if (parts[3] === "tickets" && req.method === "POST") {
          const ticket = toBase64Url(randomBytes(18));
          tickets.set(ticket, { scope, key: who.dev, expiresAt: now() + 60_000 });
          return Response.json({ url: `ws://127.0.0.1:${srv.port}/v1/socket?ticket=${ticket}`, expiresAt: now() + 60_000 });
        }
        if (parts[3] === "lease" && parts.length === 4 && req.method === "POST") {
          const r = leaseOp(lease, who.dev, body());
          if (r instanceof Response) return r;
          accountLeases.set(who.sub, r);
          for (const k of sockets.keys()) if (k.startsWith(`${scope}|`)) sockets.get(k)!.send(JSON.stringify({ t: "lease", lease: r }));
          return Response.json({ lease: r });
        }
        if (parts[3] === "devices" && parts[4] && req.method === "DELETE") {
          if (lease.holder === decodeURIComponent(parts[4])) accountLeases.set(who.sub, { holder: null, epoch: lease.epoch, expiresAt: null });
          return new Response(null, { status: 204 });
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
        groups.set(b.group, {
          members: new Map([[b.key, { joinedAt: now(), votesFrom: now(), admittedBy: [] }]]), removed: new Map(), last: new Map(),
          lease: { holder: null, epoch: 0, expiresAt: null }, changes: [],
        });
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
          const admits: { by: string; sig: string }[] = Array.isArray(b?.admits)
            ? (b.admits as unknown[]).filter((x): x is { by: string; sig: string } => typeof (x as { by?: unknown })?.by === "string" && typeof (x as { sig?: unknown })?.sig === "string")
            : typeof b?.by === "string" && typeof b?.bysig === "string" ? [{ by: b.by, sig: b.bysig }] : [];
          if (!b || typeof b.key !== "string" || typeof b.t !== "number" || typeof b.sig !== "string" || admits.length === 0) return err(400, "bad_request");
          if (Math.abs(b.t - now()) > 600_000) return err(401, "unauthorized");
          const [newKey, t] = [b.key, b.t];
          if (!sigOk(newKey, joinStatement(id, newKey, t), b.sig) || admits.some((a) => !sigOk(a.by, admitStatement(id, newKey, t), a.sig))) return err(401, "unauthorized");
          if (admits.some((a) => !g.members.has(a.by))) return err(403, "not_member");
          if ((g.removed.get(b.key) ?? -1) >= b.t) return err(403, "revoked");
          if (g.members.has(b.key)) return Response.json({}, { status: 200 });
          if (g.members.size >= 32) return err(409, "full");
          // A quorum of voters admitting it makes it a voter at once; fewer, after `voteAfterMs`.
          const by = [...new Set(admits.map((a) => a.by))];
          const voters = [...g.members].filter(([, m]) => votes(m)).length;
          const voting = by.filter((k) => votes(g.members.get(k))).length;
          let votesFrom = voting >= quorumOf(voters) ? now() : now() + voteAfterMs;
          // A key moving from another group (a merge, a recovery invite) keeps its vote, or its wait for one, and leaves
          // that group in the same step.
          const fromGroup = typeof b.from === "string" ? groups.get(b.from) : undefined;
          const before = fromGroup?.members.get(newKey);
          if (fromGroup && before && b.from !== id) {
            votesFrom = Math.min(votesFrom, before.votesFrom ?? votesFrom);
            fromGroup.members.delete(newKey);
            fromGroup.removed.set(newKey, now());
            if (fromGroup.lease.holder === newKey) fromGroup.lease = { holder: null, epoch: fromGroup.lease.epoch, expiresAt: null };
            if (fromGroup.members.size === 0) groups.delete(b.from as string);
            else for (const k of fromGroup.members.keys()) push(`group:${b.from as string}`, k, { t: "members", members: memberList(fromGroup) });
          }
          g.members.set(newKey, { joinedAt: now(), votesFrom, admittedBy: by });
          g.changes.push({ kind: "admit", target: newKey, signers: by, at: now() });
          for (const k of g.members.keys()) push(scope, k, { t: "members", members: memberList(g) });
          return Response.json({}, { status: 201 });
        }
        const who = await authorize(req, url, bytes, (k) => g.members.has(k), g.last);
        if (who instanceof Response) return who;
        if (parts.length === 3 && req.method === "GET") {
          return Response.json({ group: id, members: memberList(g), lease: g.lease });
        }
        if (parts[3] === "rollback" && parts[4] && req.method === "GET") {
          // What a quorum's removal of the target would undo, without doing it.
          const copy: Group = { ...g, members: new Map(g.members), removed: new Map(g.removed), changes: [...g.changes], lease: { ...g.lease } };
          const before = new Set(copy.members.keys());
          rollBack(copy, parts[4], new Set([who]));
          return Response.json({
            restores: [...copy.members.keys()].filter((k) => !before.has(k)),
            drops: [...before].filter((k) => k !== parts[4] && !copy.members.has(k)),
          });
        }
        if (parts[3] === "members" && parts[4] && req.method === "DELETE") {
          const gone = parts[4];
          const member = g.members.get(gone);
          if (!member) return new Response(null, { status: 204 });
          let signers: string[] = [gone];
          let keeps = new Set<string>();
          if (gone !== who) {
            // Another member: a quorum of the voters other than it, leaving out the keys it admitted lately.
            const b = body() as { t?: unknown; removes?: unknown; keep?: unknown } | undefined;
            const kept = Array.isArray(b?.keep) ? (b.keep as unknown[]).filter((k): k is string => typeof k === "string") : [];
            const since = now() - rollbackMs;
            // The keys it admitted lately, transitively.
            const its = new Set<string>();
            const walk = (k: string) => {
              for (const c of g.changes) if (c.kind === "admit" && c.at >= since && c.signers.includes(k) && !its.has(c.target) && c.target !== gone) (its.add(c.target), walk(c.target));
            };
            walk(gone);
            const eligible = new Set([...g.members].filter(([k, m]) => k !== gone && !its.has(k) && votes(m)).map(([k]) => k));
            const agreed = new Set<string>();
            if (eligible.has(who)) agreed.add(who);
            if (typeof b?.t === "number" && Array.isArray(b.removes)) {
              if (Math.abs(b.t - now()) > 600_000) return err(401, "unauthorized");
              if (b.t <= member.joinedAt) return err(409, "stale");
              for (const r of b.removes as { by?: unknown; sig?: unknown }[]) {
                if (typeof r?.by !== "string" || typeof r.sig !== "string") return err(400, "bad_request");
                // A signer that doesn't count is refused, as lane I's service does.
                if (!eligible.has(r.by)) return err(403, "not_voter");
                if (!sigOk(r.by, removeStatement(id, gone, b.t, kept), r.sig)) return err(401, "unauthorized");
                agreed.add(r.by);
              }
            }
            const need = quorumOf(eligible.size);
            if (eligible.size === 0 || agreed.size < need) return err(403, "no_quorum", { voters: eligible.size, needed: need });
            signers = [...agreed];
            // The quorum signed the kept keys again: the rollback leaves them.
            keeps = new Set(kept);
          }
          g.members.delete(gone);
          g.removed.set(gone, now());
          if (g.lease.holder === gone) g.lease = { holder: null, epoch: g.lease.epoch, expiresAt: null };
          if (gone !== who) {
            g.changes.push({ kind: "remove", target: gone, signers, at: now(), member });
            rollBack(g, gone, new Set([...keeps, who]));
          }
          g.changes = g.changes.filter((c) => c.at >= now() - rollbackMs);
          if (g.members.size === 0) groups.delete(id);
          else for (const k of g.members.keys()) push(scope, k, { t: "members", members: memberList(g) });
          return new Response(null, { status: 204 });
        }
        if (parts[3] === "lease" && req.method === "POST") {
          if ((body() as { op?: unknown } | undefined)?.op === "takeover" && !votes(g.members.get(who))) return err(403, "not_voter");
          const r = leaseOp(g.lease, who, body());
          if (r instanceof Response) return r;
          g.lease = r;
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
    accountLeases,
    accountRecordsFor: (device: string) => [...accountRecords].filter(([k]) => k.endsWith(`|${device}`)).flatMap(([, v]) => v.map((r) => ({ ...r }))),
    log,
    stop() {
      server.stop(true);
    },
  };
}

/** For tests: SHA-256, base64url. */
export const digestB64u = (data: Uint8Array): string => toBase64Url(new Uint8Array(createHash("sha256").update(data).digest()));
