// A plugin process's way to the network (B-M2's 2g; spec §5.3 as changed here: host code is held to its `network:`
// list too). Every process that runs a plugin's code is fenced to one loopback port (`plugin-fence.ts`'s `proxyPort`),
// this proxy's, and gets `HTTPS_PROXY`/`HTTP_PROXY` naming it (Bun's fetch takes them; its WebSocket takes a `proxy`
// option). The proxy lets through only the hosts the plugin's OK granted (`network:<host>`, `network:*.<domain>`,
// `network:<host>:<port>`), resolving names itself: the fence denies the plugin direct DNS.
//
// * `CONNECT host:port` (https, wss, any TLS): a tunnel when the host is listed for that port (443 or 80 when the entry
//   names none).
// * A plain-HTTP request in absolute form (`GET http://host/path`): forwarded when the host is listed for its port, the
//   request line rewritten to origin form, one request per connection (`Connection: close`, so a kept-alive client's
//   next request, which may name another host, comes on a new connection and is checked).
// * A raw IP address only when the list names that address.
// * A listed name is resolved here and connected to by the address it resolved to (no second lookup to rebind). A name
//   that resolves to a loopback or private address is refused (a plugin's own DNS record could otherwise point its
//   listed host at this computer's or the LAN's services), unless the name says so itself (`localhost`, `*.local`).
// * Anything else: `403 Forbidden`, and the connection closes. A refusal names the host in the proxy's log.
// * Each proxy has its own random token, in the URL its processes get (`http://clover:<token>@127.0.0.1:<port>`), and a
//   request without it is `407`: a plugin granted `localhost` can't use another plugin's proxy by its port. macOS lets a
//   process read the environment of any other process of the same user (`KERN_PROCARGS2`, which Seatbelt's
//   `process-info` denials don't cover; measured), so this stops a borrowed port, not a plugin that reads another's env.
// * Limits: connections in all and per proxy, a request head's time, resolve and connect time, idle time, and the
//   bytes held for a slow side (it's paused past them, so backpressure reaches the sender).
//
// What it doesn't judge: only the CONNECT line's host is checked, so inside a granted host's TLS a client can name any
// server that host serves (SNI or a Host header: domain fronting through a CDN the plugin was granted). A grant takes
// effect at each new connection: a tunnel already open survives a revoke until it closes (idle, or 5 minutes without
// a byte either way). Names are matched as ASCII, lowercased: a manifest's `network:` host is ASCII only (its check
// takes no Unicode name), so an internationalised name is granted in punycode (`xn--`), the form a client sends.
import type { Socket, TCPSocketListener } from "bun";
import { lookup } from "node:dns/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { ipAddressClass } from "../agent/tools/web";

/** One `network:` entry as the proxy reads it. */
interface HostRule {
  host: string;
  /** `*.` entries match every subdomain (never the domain itself). */
  wildcard: boolean;
  ports: readonly number[];
}

/** The rules of a plugin's `network:` capabilities (`network:api.example.com`, `network:*.example.com`,
 *  `network:api.example.com:8443`, `network:[::1]:8080`). */
export function hostRules(capabilities: readonly string[]): HostRule[] {
  const out: HostRule[] = [];
  for (const c of capabilities) {
    if (!c.startsWith("network:")) continue;
    let rest = c.slice("network:".length).trim().toLowerCase();
    if (rest === "") continue;
    let port: number | undefined;
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
    if (bracket !== null) {
      rest = bracket[1]!;
      port = bracket[2] !== undefined ? Number(bracket[2]) : undefined;
    } else {
      const m = /^(.*):(\d+)$/.exec(rest);
      if (m !== null && !rest.includes("::")) {
        rest = m[1]!;
        port = Number(m[2]);
      }
    }
    const wildcard = rest.startsWith("*.");
    out.push({ host: wildcard ? rest.slice(2) : rest, wildcard, ports: port !== undefined ? [port] : [443, 80] });
  }
  return out;
}

/** Whether `host:port` is on a plugin's list. A raw address matches only an entry naming that address. */
export function hostAllowed(rules: readonly HostRule[], host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const ip = isIP(h) !== 0;
  return rules.some((r) => r.ports.includes(port) && (ip ? !r.wildcard && r.host === h : r.wildcard ? h.endsWith(`.${r.host}`) : r.host === h));
}

export interface PluginProxy {
  readonly port: number;
  /** The env a process gets to use it (the URL carries the proxy's token). */
  readonly env: Record<string, string>;
  close(): void;
}

/** The proxies' limits (tests pass smaller ones). */
export interface ProxyLimits {
  /** Connections open at once across every proxy, and per proxy (each proxy is one plugin tree's). */
  maxConnections: number;
  maxPerProxy: number;
  /** A request head must arrive within this. */
  headMs: number;
  /** Resolving and connecting to the upstream, together. */
  connectMs: number;
  /** A connection with no byte either way for this long is closed. */
  idleMs: number;
  /** Bytes held for a side that can't take them yet; past it the other side is paused. */
  bufferBytes: number;
}
export const PROXY_LIMITS: ProxyLimits = { maxConnections: 256, maxPerProxy: 64, headMs: 10_000, connectMs: 30_000, idleMs: 5 * 60_000, bufferBytes: 1024 * 1024 };

const HEAD_MAX = 16 * 1024;
/** Connections open across every proxy in this process. */
let liveConnections = 0;

/** A side's writes, held while it can't take them (`write` took less than given); `drain` sends the rest. */
interface Outbox {
  write(data: Uint8Array): number;
  queue: Uint8Array[];
  bytes: number;
}
const send = (out: Outbox, data: Uint8Array) => {
  if (out.queue.length === 0) {
    const n = out.write(data);
    if (n >= data.length) return;
    data = data.subarray(Math.max(0, n));
  }
  out.queue.push(data);
  out.bytes += data.length;
};
const flush = (out: Outbox) => {
  while (out.queue.length > 0) {
    const b = out.queue[0]!;
    const n = out.write(b);
    if (n < b.length) {
      out.queue[0] = b.subarray(Math.max(0, n));
      out.bytes -= Math.max(0, n);
      return;
    }
    out.queue.shift();
    out.bytes -= b.length;
  }
};

type Upstream = Socket<undefined>;
interface ConnState {
  head: Buffer | undefined;
  upstream?: Upstream;
  /** Bytes from the client before the upstream was open, and later bytes the upstream couldn't take yet. */
  toUpstream: Outbox;
  /** Bytes from the upstream the client couldn't take yet. */
  toClient: Outbox;
  done: boolean;
  lastActive: number;
  headTimer?: ReturnType<typeof setTimeout>;
}

/** The addresses a name resolves to (the system's resolver). */
export type ResolveHost = (host: string) => Promise<string[]>;
const systemResolve: ResolveHost = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
/** A name that says it's on this computer or the local network, so a private address is what it declares. */
const localName = (host: string) => /(^|\.)(localhost|local)\.?$/i.test(host);

const within = <T>(ms: number, p: Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });

/** Starts one plugin tree's proxy on 127.0.0.1. `capabilities` is read at each connection, so a grant or a revocation
 *  applies to the next one. */
export function startPluginProxy(o: {
  pluginId: string;
  capabilities: () => readonly string[];
  log?: (line: string) => void;
  connect?: typeof Bun.connect;
  resolve?: ResolveHost;
  limits?: Partial<ProxyLimits>;
}): PluginProxy {
  const connect = o.connect ?? Bun.connect;
  const resolve = o.resolve ?? systemResolve;
  const limits: ProxyLimits = { ...PROXY_LIMITS, ...o.limits };
  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Basic ${Buffer.from(`clover:${token}`).toString("base64")}`);
  const authorized = (headers: readonly string[]) =>
    headers.some((h) => {
      const m = /^proxy-authorization:\s*(.*?)\s*$/i.exec(h);
      if (m === null) return false;
      const got = Buffer.from(m[1]!);
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
  // Every connection open here (for the idle sweep and the cap across all proxies), and those that showed this proxy's
  // token, which alone count toward its own cap (#377's review): another plugin's connections that never authenticate
  // can't fill it. Those are bounded by the cap across all proxies and the head's time instead.
  const conns = new Set<Socket<ConnState>>();
  const authed = new Set<Socket<ConnState>>();
  const reply = (sock: Socket<ConnState>, status: string, why: string, extra = "") => {
    sock.data.done = true;
    sock.write(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n${extra}Content-Length: ${Buffer.byteLength(why) + 1}\r\n\r\n${why}\n`);
    sock.end();
  };
  const refuse = (sock: Socket<ConnState>, why: string) => {
    o.log?.(`[net ${o.pluginId}] refused ${why}`);
    reply(sock, "403 Forbidden", why);
  };
  const fail = (sock: Socket<ConnState>, status: string, why: string) => {
    o.log?.(`[net ${o.pluginId}] ${why}`);
    reply(sock, status, why);
  };
  const open = async (sock: Socket<ConnState>, host: string, port: number, first: Buffer | undefined, tunnel: boolean) => {
    const st = sock.data;
    let upstream: Upstream;
    try {
      upstream = await within(limits.connectMs, (async () => {
        let address = host;
        if (isIP(host) === 0) {
          const addresses = await resolve(host);
          const inside = localName(host) ? undefined : addresses.find((a) => ipAddressClass(a) !== null);
          if (addresses.length === 0 || inside !== undefined) throw Object.assign(new Error(`${host}, which resolves to ${inside ?? "nothing"}, a private address`), { refused: true });
          address = addresses[0]!;
        }
        // The client may have gone while this resolved (#371's review): nothing is opened for it.
        if (st.done) throw Object.assign(new Error("gone"), { gone: true });
        const u = await connect({
          hostname: address, port,
          socket: {
            data: (_u, d) => {
              st.lastActive = Date.now();
              send(st.toClient, d);
              if (st.toClient.bytes > limits.bufferBytes) _u.pause();
            },
            drain: () => {
              flush(st.toUpstream);
              if (st.toUpstream.bytes <= limits.bufferBytes) sock.resume();
            },
            close: () => void sock.end(),
            error: () => void sock.end(),
          },
        });
        // Gone while it connected, or timed out meanwhile: the upstream is closed, never left open (#371's review).
        if (st.done) {
          u.end();
          throw Object.assign(new Error("gone"), { gone: true });
        }
        return u;
      })());
    } catch (err) {
      const e = err as Error & { refused?: boolean; gone?: boolean };
      if (e.gone || st.done) return;
      if (e.refused) return refuse(sock, e.message);
      return fail(sock, /within/.test(e.message) ? "504 Gateway Timeout" : "502 Bad Gateway", `${host}:${port} unreachable: ${e.message}`);
    }
    st.upstream = upstream;
    st.toUpstream.write = (d) => upstream.write(d);
    if (tunnel) sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const held = st.toUpstream.queue.splice(0);
    st.toUpstream.bytes = 0;
    if (first !== undefined && first.length > 0) send(st.toUpstream, first);
    for (const b of held) send(st.toUpstream, b);
    sock.resume();
  };
  const listener: TCPSocketListener<ConnState> = Bun.listen<ConnState>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(sock) {
        const toClient: Outbox = { write: (d) => sock.write(d), queue: [], bytes: 0 };
        const toUpstream: Outbox = { write: () => 0, queue: [], bytes: 0 };
        sock.data = { head: Buffer.alloc(0), toUpstream, toClient, done: false, lastActive: Date.now() };
        if (liveConnections >= limits.maxConnections) {
          return fail(sock, "503 Service Unavailable", `too many connections (${liveConnections} in all)`);
        }
        liveConnections++;
        conns.add(sock);
        sock.data.headTimer = setTimeout(() => {
          if (sock.data.head !== undefined && !sock.data.done) fail(sock, "408 Request Timeout", `no request head within ${limits.headMs / 1000} s`);
        }, limits.headMs);
      },
      drain(sock) {
        const st = sock.data;
        flush(st.toClient);
        if (st.toClient.bytes <= limits.bufferBytes) st.upstream?.resume();
      },
      data(sock, chunk) {
        const st = sock.data;
        if (st.done) return;
        st.lastActive = Date.now();
        if (st.head === undefined) {
          // A tunnel's or a request's body: to the upstream, or held until it's open; past the bound, the client waits.
          send(st.toUpstream, chunk);
          if (st.toUpstream.bytes > limits.bufferBytes) sock.pause();
          return;
        }
        st.head = Buffer.concat([st.head, chunk]);
        const end = st.head.indexOf("\r\n\r\n");
        if (end < 0) {
          if (st.head.length > HEAD_MAX) refuse(sock, "a request head over 16 KiB");
          return;
        }
        clearTimeout(st.headTimer);
        const head = st.head.subarray(0, end).toString("latin1");
        const rest = st.head.subarray(end + 4);
        st.head = undefined;
        const [line, ...headers] = head.split("\r\n");
        const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line ?? "");
        if (m === null) return refuse(sock, "a request the proxy doesn't read");
        if (!authorized(headers)) {
          o.log?.(`[net ${o.pluginId}] refused a request without this proxy's token`);
          return reply(sock, "407 Proxy Authentication Required", "this proxy's token is required", `Proxy-Authenticate: Basic realm="clover"\r\n`);
        }
        if (authed.size >= limits.maxPerProxy) return fail(sock, "503 Service Unavailable", `too many connections (${authed.size} on this proxy)`);
        authed.add(sock);
        const rules = hostRules(o.capabilities());
        if (m[1] === "CONNECT") {
          const t = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(m[2]!);
          if (t === null) return refuse(sock, `CONNECT ${m[2]}`);
          const host = t[1]!.replace(/^\[|\]$/g, "");
          const port = Number(t[2]);
          if (!hostAllowed(rules, host, port)) return refuse(sock, `${host}:${port}, which isn't on ${o.pluginId}'s network list`);
          if (rest.length > 0) send(st.toUpstream, rest);
          // Not paused while it connects: a client that leaves meanwhile must be seen (a paused socket reads no EOF);
          // what it sends is held up to the bound, past which it is paused.
          return void open(sock, host, port, undefined, true);
        }
        let url: URL;
        try {
          url = new URL(m[2]!);
        } catch {
          return refuse(sock, `${m[1]} ${m[2]!.slice(0, 200)} (only CONNECT, or a plain-HTTP request with its full URL)`);
        }
        if (url.protocol !== "http:") return refuse(sock, `${url.protocol} through a plain request`);
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const port = url.port === "" ? 80 : Number(url.port);
        if (!hostAllowed(rules, host, port)) return refuse(sock, `${host}:${port}, which isn't on ${o.pluginId}'s network list`);
        // One request per connection: a kept-alive one would carry the client's next request, to another host, down
        // this host's connection, unchecked.
        const rewritten = [`${m[1]} ${url.pathname}${url.search} HTTP/1.1`, ...headers.filter((h) => !/^(proxy-|connection:|keep-alive:)/i.test(h)), "Connection: close"].join("\r\n");
        void open(sock, host, port, Buffer.concat([Buffer.from(`${rewritten}\r\n\r\n`, "latin1"), rest]), false);
      },
      close(sock) {
        const st = sock.data;
        clearTimeout(st.headTimer);
        st.done = true;
        st.upstream?.end();
        authed.delete(sock);
        if (conns.delete(sock)) liveConnections--;
      },
      error(sock) {
        sock.data.upstream?.end();
      },
    },
  });
  // Idle connections, swept a few times per idle period.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const sock of conns) {
      if (now - sock.data.lastActive >= limits.idleMs) {
        o.log?.(`[net ${o.pluginId}] closed a connection idle for ${Math.round(limits.idleMs / 1000)} s`);
        sock.data.done = true;
        sock.data.upstream?.end();
        sock.end();
      }
    }
  }, Math.max(10, Math.min(30_000, limits.idleMs / 4)));
  sweep.unref?.();
  const url = `http://clover:${token}@127.0.0.1:${listener.port}`;
  return {
    port: listener.port,
    env: { HTTPS_PROXY: url, HTTP_PROXY: url, ALL_PROXY: url, https_proxy: url, http_proxy: url, all_proxy: url, NO_PROXY: "", no_proxy: "" },
    close: () => {
      clearInterval(sweep);
      listener.stop(true);
    },
  };
}
