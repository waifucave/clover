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
import type { Socket, TCPSocketListener } from "bun";
import { lookup } from "node:dns/promises";
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
  /** The env a process gets to use it. */
  readonly env: Record<string, string>;
  close(): void;
}

const HEAD_MAX = 16 * 1024;
type Upstream = Socket<undefined>;
interface ConnState {
  head: Buffer;
  upstream?: Upstream;
  /** Bytes that arrived before the upstream was open. */
  pending: Buffer[];
  done: boolean;
}

/** Starts one plugin process's proxy on 127.0.0.1. `capabilities` is read at each connection, so a grant or a
 *  revocation applies to the next one. */
/** The addresses a name resolves to (the system's resolver). */
export type ResolveHost = (host: string) => Promise<string[]>;
const systemResolve: ResolveHost = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
/** A name that says it's on this computer or the local network, so a private address is what it declares. */
const localName = (host: string) => /(^|\.)(localhost|local)\.?$/i.test(host);

export function startPluginProxy(o: { pluginId: string; capabilities: () => readonly string[]; log?: (line: string) => void; connect?: typeof Bun.connect; resolve?: ResolveHost }): PluginProxy {
  const connect = o.connect ?? Bun.connect;
  const resolve = o.resolve ?? systemResolve;
  const refuse = (sock: Socket<ConnState>, why: string) => {
    o.log?.(`[net ${o.pluginId}] refused ${why}`);
    sock.data.done = true;
    sock.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(why) + 1}\r\n\r\n${why}\n`);
    sock.end();
  };
  const open = async (sock: Socket<ConnState>, host: string, port: number, first: Buffer | undefined, tunnel: boolean) => {
    let address = host;
    if (isIP(host) === 0) {
      let addresses: string[];
      try {
        addresses = await resolve(host);
      } catch (err) {
        sock.write(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        sock.end();
        o.log?.(`[net ${o.pluginId}] ${host} didn't resolve: ${(err as Error).message}`);
        return;
      }
      const inside = localName(host) ? undefined : addresses.find((a) => ipAddressClass(a) !== null);
      if (addresses.length === 0 || inside !== undefined) return refuse(sock, `${host}, which resolves to ${inside ?? "nothing"}, a private address`);
      address = addresses[0]!;
    }
    let upstream: Upstream;
    try {
      upstream = await connect({
        hostname: address, port,
        socket: {
          data: (_u, d) => void sock.write(d),
          close: () => void sock.end(),
          error: () => void sock.end(),
        },
      });
    } catch (err) {
      sock.write(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      sock.end();
      o.log?.(`[net ${o.pluginId}] ${host}:${port} unreachable: ${(err as Error).message}`);
      return;
    }
    sock.data.upstream = upstream;
    if (tunnel) sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (first !== undefined && first.length > 0) upstream.write(first);
    for (const b of sock.data.pending.splice(0)) upstream.write(b);
  };
  const listener: TCPSocketListener<ConnState> = Bun.listen<ConnState>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(sock) {
        sock.data = { head: Buffer.alloc(0), pending: [], done: false };
      },
      data(sock, chunk) {
        const st = sock.data;
        if (st.done) return;
        if (st.upstream !== undefined) return void st.upstream.write(chunk);
        if (st.head === undefined) return void st.pending.push(Buffer.from(chunk));
        st.head = Buffer.concat([st.head, chunk]);
        const end = st.head.indexOf("\r\n\r\n");
        if (end < 0) {
          if (st.head.length > HEAD_MAX) refuse(sock, "a request head over 16 KiB");
          return;
        }
        const head = st.head.subarray(0, end).toString("latin1");
        const rest = st.head.subarray(end + 4);
        (st as { head?: Buffer }).head = undefined;
        const [line, ...headers] = head.split("\r\n");
        const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line ?? "");
        if (m === null) return refuse(sock, "a request the proxy doesn't read");
        const rules = hostRules(o.capabilities());
        if (m[1] === "CONNECT") {
          const t = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(m[2]!);
          if (t === null) return refuse(sock, `CONNECT ${m[2]}`);
          const host = t[1]!.replace(/^\[|\]$/g, "");
          const port = Number(t[2]);
          if (!hostAllowed(rules, host, port)) return refuse(sock, `${host}:${port}, which isn't on ${o.pluginId}'s network list`);
          st.pending.push(rest);
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
        sock.data.done = true;
        sock.data.upstream?.end();
      },
      error(sock) {
        sock.data.upstream?.end();
      },
    },
  });
  const url = `http://127.0.0.1:${listener.port}`;
  return {
    port: listener.port,
    env: { HTTPS_PROXY: url, HTTP_PROXY: url, ALL_PROXY: url, https_proxy: url, http_proxy: url, all_proxy: url, NO_PROXY: "", no_proxy: "" },
    close: () => listener.stop(true),
  };
}
