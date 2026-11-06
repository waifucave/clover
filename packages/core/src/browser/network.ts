// Which addresses a tab may reach (ruling R13): checked when each connection is made, after DNS, so a name that
// resolves (or rebinds) to a local address can't get round it. Every browser partition sends all its traffic through a
// small SOCKS5 proxy in the main process (`session.ts` sets it, with `<-loopback>` so loopback isn't bypassed).
// Through SOCKS5 Chromium sends the name, not an address, for every scheme (http, https, WebSockets), so the proxy
// resolves each name itself, keeps only the addresses the tab's owner may reach, and connects to those it checked, in
// turn until one answers (a name like `localhost` has an IPv6 and an IPv4 address, and a server may listen on one): the
// addresses are pinned, never looked up twice.
//
// * A bot's tabs: no loopback, private (RFC 1918, ULA, shared CGNAT space), link-local or cloud metadata address. A
//   bot whose LAN setting is on reaches private and link-local addresses too, still never loopback.
// * A coding session's tabs: loopback too (its dev servers), never the metadata address.
// * A plugin's own tabs (a plugin acting as itself): as a bot's.
// * The person's own tabs: their own network, never the metadata address.
// * Nobody: the unspecified, multicast and reserved ranges, and this proxy's own ports.
//
// The proxy setting (R14) chains behind the check (`proxy.ts` turns the setting into routes): the filter still resolves
// each name itself and checks every address, then reaches the checked address either directly or through the proxy
// the setting names for that connection, asking that proxy for the checked address (an HTTP `CONNECT ip:port`, or a
// SOCKS request for the address), never the name. So the pinned, checked address is what the proxy connects to, and
// the check can't be got round through it. A name this computer can't resolve isn't reached, even where only the
// proxy could resolve it. Loopback is always reached directly.
//
// Each policy has three listeners, one per kind of URL (http, https, anything else: WebSockets, and whatever Chromium
// sends to its `socks=` fallback), so the routes can follow the URL's scheme as a system proxy or PAC file does. The
// proxy rules a session gets name all three, and never change when the setting does: the filter reads the setting
// for each new connection.
//
// This file is plain Node, no Electron, and the app and the core share it: `apps/desktop/src/main/browser/network.ts`
// is a copy of `packages/core/src/browser/network.ts`, which a test keeps identical. TLS stays end to end: the
// filter only ever joins two sockets (or a socket and a proxy's tunnel).
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, connect as netConnect, isIP, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { TabOwner } from "./contract";

export interface AddressPolicy {
  loopback: boolean;
  privateNetworks: boolean;
  linkLocal: boolean;
}

export const BOT_POLICY: AddressPolicy = Object.freeze({ loopback: false, privateNetworks: false, linkLocal: false });
export const SESSION_POLICY: AddressPolicy = Object.freeze({ loopback: true, privateNetworks: false, linkLocal: false });
export const PERSON_POLICY: AddressPolicy = Object.freeze({ loopback: true, privateNetworks: true, linkLocal: true });
/** A bot whose LAN setting is on: its LAN (private and link-local addresses), still never loopback or metadata. */
export const BOT_LAN_POLICY: AddressPolicy = Object.freeze({ loopback: false, privateNetworks: true, linkLocal: true });

/** Which addresses an owner's tabs reach. `lanBots` holds the bots whose LAN setting is on (lane D's bot settings,
 *  through the core's `BrowserNetworkConfig`). */
export function policyFor(owner: TabOwner, lanBots?: ReadonlySet<string> | readonly string[]): AddressPolicy {
  if (owner.kind === "session") return SESSION_POLICY;
  if (owner.kind === "user") return PERSON_POLICY;
  if (owner.kind === "bot" && lanBots !== undefined && (Array.isArray(lanBots) ? lanBots.includes(owner.bot) : (lanBots as ReadonlySet<string>).has(owner.bot))) return BOT_LAN_POLICY;
  return BOT_POLICY;
}

export type AddressKind = "public" | "loopback" | "private" | "link-local" | "metadata" | "unspecified" | "multicast" | "reserved";

/** Cloud metadata services: AWS, GCP, Azure, Oracle (169.254.169.254), AWS's DNS and ECS (169.254.169.253, .170.2),
 *  Alibaba (100.100.100.200), and AWS's IPv6 one (fd00:ec2::254). */
const METADATA_V4 = new Set(["169.254.169.254", "169.254.169.253", "169.254.170.2", "100.100.100.200"]);
const METADATA_V6 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254];

function v4Octets(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return n.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? n : undefined;
}

function classifyV4(o: number[]): AddressKind {
  const [a, b, c] = o as [number, number, number, number];
  const ip = o.join(".");
  if (METADATA_V4.has(ip)) return "metadata";
  if (a === 0) return "unspecified"; // 0.0.0.0/8, which reaches this machine on most systems
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // shared address space (CGNAT)
  if (a === 169 && b === 254) return "link-local";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved"; // and the broadcast address
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  return "public";
}

/** An IPv6 address as eight 16-bit groups (a dotted IPv4 tail included), or undefined. */
function v6Groups(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const o = v4Octets(s.slice(lastColon + 1));
    if (o === undefined) return undefined;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const g = part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
    return g.every((x) => !Number.isNaN(x)) ? g : undefined;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (head === undefined || rest === undefined) return undefined;
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array<number>(fill).fill(0), ...rest];
  if (groups.length !== 8) return undefined;
  if (tail.length === 2) groups.splice(6, 2, tail[0]!, tail[1]!);
  return groups;
}

function classifyV6(g: number[]): AddressKind {
  const embedded = (hi: number, lo: number): AddressKind => classifyV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  if (g.every((x, i) => x === METADATA_V6[i])) return "metadata";
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) reach the IPv4 address inside.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!);
  // Local-use NAT64 (64:ff9b:1::/48, RFC 8215) and IPv4-translated (::ffff:0:a.b.c.d, RFC 2765): the IPv4 inside.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return embedded(g[6]!, g[7]!);
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return embedded(g[6]!, g[7]!);
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  if (g.slice(0, 6).every((x) => x === 0)) return "reserved"; // IPv4-compatible, deprecated
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // ULA, fc00::/7
  if ((g[0]! & 0xffc0) === 0xfec0) return "private"; // site-local, fec0::/10 (deprecated, still routed on some LANs)
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0]! & 0xff00) === 0xff00) return "multicast";
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return "reserved"; // discard-only
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "reserved"; // documentation
  return "public";
}

export function classifyAddress(ip: string): AddressKind {
  const family = isIP(ip.split("%")[0]!);
  if (family === 4) return classifyV4(v4Octets(ip)!);
  if (family === 6) {
    const g = v6Groups(ip);
    return g === undefined ? "reserved" : classifyV6(g);
  }
  return "reserved";
}

export function addressAllowed(ip: string, policy: AddressPolicy): boolean {
  switch (classifyAddress(ip)) {
    case "public":
      return true;
    case "loopback":
      return policy.loopback;
    case "private":
      return policy.privateNetworks;
    case "link-local":
      return policy.linkLocal;
    default:
      return false;
  }
}

/** How long after one address's connection attempt the next one starts (RFC 8305's default). */
export const HAPPY_EYEBALLS_MS = 250;

/** The kind of URL a connection is for, by the listener Chromium sent it to. */
export type UrlKind = "http" | "https" | "other";
export const URL_KINDS: readonly UrlKind[] = ["http", "https", "other"];

/** Where a connection goes after the check: straight to the checked address, or through a proxy, which is asked for
 *  that address. */
export type Upstream =
  | { kind: "direct" }
  | { kind: "http" | "https" | "socks5" | "socks4"; host: string; port: number };

/** The routes to try, in order, for a connection to `host:port` (the name as the page asked for it) from a URL of
 *  `scheme`; the proxy setting's (`proxy.ts`). An empty list refuses the connection. */
export type UpstreamRoutes = (target: { scheme: UrlKind; host: string; port: number }) => Promise<Upstream[]>;

export interface NetworkFilterOptions {
  /** Every address a name has (default: the system's resolver, all of them). */
  lookup?: (host: string) => Promise<string[]>;
  /** Opens the connection to a checked address, or to a proxy (default: `net.connect`). */
  dial?: (port: number, ip: string) => Socket;
  /** The proxy setting's routes (R14); direct when absent. `setUpstream` changes it. */
  upstream?: UpstreamRoutes;
  /** How long a proxy has to answer its handshake (default 15 s). */
  proxyTimeoutMs?: number;
  /** How long one connection attempt has before the next address is tried (default 2.5 s): a dead first address
   *  never fails a page whose second answers. */
  connectTimeoutMs?: number;
  /** Whether a connection to a listener comes from the browser's own network process (the second review's should-fix
   *  1: any local process could otherwise use the filter). Asked once per connection, before anything is read; a no,
   *  or an error, closes it unanswered. `peer-owner.ts` answers it from the OS's socket table. */
  acceptPeer?: (peer: { address: string; port: number }, listenerPort: number) => Promise<boolean>;
  log?: (line: string) => void;
}

/** SOCKS5's replies (RFC 1928): granted, not allowed by the rules, host unreachable, refused, command not supported,
 *  address type not supported. Chromium shows a refusal as its own error page. */
const REPLY = { ok: 0x00, notAllowed: 0x02, unreachable: 0x04, refused: 0x05, badCommand: 0x07, badAddress: 0x08 } as const;

/** A SOCKS5 CONNECT request's destination, once the whole request has arrived: `undefined` while more is needed. */
type Parsed = { host: string; port: number; used: number } | { reply: number } | undefined;

function parseRequest(buf: Buffer): Parsed {
  if (buf.length < 5) return undefined;
  if (buf[0] !== 5) return { reply: REPLY.badCommand };
  if (buf[1] !== 1) return { reply: REPLY.badCommand }; // only CONNECT: no BIND, no UDP ASSOCIATE
  const type = buf[3];
  let host: string;
  let at: number;
  if (type === 1) {
    if (buf.length < 10) return undefined;
    host = [...buf.subarray(4, 8)].join(".");
    at = 8;
  } else if (type === 3) {
    const len = buf[4]!;
    if (buf.length < 5 + len + 2) return undefined;
    host = buf.subarray(5, 5 + len).toString("latin1");
    at = 5 + len;
  } else if (type === 4) {
    if (buf.length < 22) return undefined;
    const g: string[] = [];
    for (let i = 0; i < 8; i++) g.push(buf.readUInt16BE(4 + i * 2).toString(16));
    host = g.join(":");
    at = 20;
  } else {
    return { reply: REPLY.badAddress };
  }
  return { host, port: buf.readUInt16BE(at), used: at + 2 };
}

function reply(socket: Socket, code: number): void {
  socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
}

/** The filtering proxies: SOCKS5 listeners on loopback, three per policy (one per kind of URL), each its own port. */
export class NetworkFilter {
  private readonly listeners = new Map<string, Promise<{ server: Server; port: number }>>();
  private readonly ports = new Set<number>();
  private readonly sockets = new Set<Socket>();
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly dial: (port: number, ip: string) => Socket;
  private upstream: UpstreamRoutes | undefined;
  private closed = false;

  constructor(private readonly opts: NetworkFilterOptions = {}) {
    this.lookup = opts.lookup ?? (async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address));
    this.dial = opts.dial ?? ((port, ip) => netConnect({ port, host: ip }));
    this.upstream = opts.upstream;
  }

  /** The proxy setting's routes from now on (R14): each new connection takes them; open ones keep their path. */
  setUpstream(routes: UpstreamRoutes | undefined): void {
    this.upstream = routes;
  }

  /** The proxy rules for a policy, as Chromium spells them (a session's `proxyRules`, the headless shell's
   *  `--proxy-server`): `http=socks5://127.0.0.1:<a>;https=socks5://127.0.0.1:<b>;socks=socks5://127.0.0.1:<c>`. The
   *  `socks=` entry is the fallback for every other scheme (WebSockets included), so nothing goes direct. Stable for
   *  the filter's life: the setting changes the routes behind them, not the rules. */
  async proxyFor(policy: AddressPolicy): Promise<string> {
    const [http, https, other] = await Promise.all(URL_KINDS.map((k) => this.listenerFor(policy, k)));
    return `http=${http};https=${https};socks=${other}`;
  }

  /** One listener, `socks5://127.0.0.1:<port>`: for a policy and a kind of URL. */
  async listenerFor(policy: AddressPolicy, scheme: UrlKind): Promise<string> {
    if (this.closed) throw new Error("the browser's network filter is closed");
    const key = `${+policy.loopback}${+policy.privateNetworks}${+policy.linkLocal}:${scheme}`;
    let listener = this.listeners.get(key);
    if (listener === undefined) {
      listener = this.listen(policy, scheme);
      this.listeners.set(key, listener);
      listener.catch(() => this.listeners.delete(key));
    }
    return `socks5://127.0.0.1:${(await listener).port}`;
  }

  /** Whether `port` on loopback is one of the filter's own listeners: a proxy setting never points at one. */
  isOwnPort(port: number): boolean {
    return this.ports.has(port);
  }

  /** The listeners' ports on 127.0.0.1, for lane C's fence, which denies them to fenced commands as a backstop. */
  listenerPorts(): number[] {
    return [...this.ports].sort((a, b) => a - b);
  }

  /** The addresses to try for `host`, in the resolver's order: those the policy allows. */
  async resolve(host: string, policy: AddressPolicy): Promise<string[]> {
    return (await this.lookupChecked(host, policy)).allowed;
  }

  /** Every address `host` has, and those the policy allows; `found` is false when the name didn't resolve at all. */
  private async lookupChecked(host: string, policy: AddressPolicy): Promise<{ found: boolean; allowed: string[] }> {
    const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    // `localhost` and its subdomains are loopback, both families, whatever the resolver says (RFC 6761, as Chromium
    // reads them): Windows' resolver sometimes answers ::1 alone, which a server on IPv4 never answers.
    const addresses = isIP(literal) !== 0 ? [literal]
      : /^(.+\.)?localhost\.?$/i.test(literal) ? ["::1", "127.0.0.1"]
      : await this.lookup(literal).catch(() => [] as string[]);
    return { found: addresses.length > 0, allowed: addresses.filter((ip) => addressAllowed(ip, policy)) };
  }

  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.listeners.values()];
    this.listeners.clear();
    this.ports.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.all(all.map(async (l) => {
      const opened = await l.catch(() => undefined);
      if (opened !== undefined) await new Promise<void>((r) => opened.server.close(() => r()));
    }));
  }

  private async targets(host: string, port: number, policy: AddressPolicy): Promise<{ found: boolean; ips: string[] }> {
    // A page never reaches one of these proxies through another (a looser policy's port, or its own).
    const { found, allowed } = await this.lookupChecked(host, policy);
    return { found, ips: allowed.filter((ip) => !(classifyAddress(ip) === "loopback" && this.ports.has(port))) };
  }

  private listen(policy: AddressPolicy, scheme: UrlKind): Promise<{ server: Server; port: number }> {
    const server = createServer((socket) => this.serve(socket, policy, scheme));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") return reject(new Error("the network filter has no port"));
        this.ports.add(address.port);
        resolve({ server, port: address.port });
      });
    });
  }

  private serve(client: Socket, policy: AddressPolicy, scheme: UrlKind): void {
    this.sockets.add(client);
    client.on("error", () => undefined);
    client.on("close", () => this.sockets.delete(client));
    client.setTimeout(30_000, () => client.destroy());
    const listenerPort = client.localPort ?? 0;
    let buf = Buffer.alloc(0);
    let stage: "greeting" | "request" | "joined" = "greeting";
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) return;
        const n = buf[1]!;
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        if (buf[0] !== 5 || !methods.includes(0)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        client.write(Buffer.from([5, 0]));
        buf = buf.subarray(2 + n);
        stage = "request";
      }
      if (stage === "request") {
        const parsed = parseRequest(buf);
        if (parsed === undefined) return;
        if ("reply" in parsed) {
          reply(client, parsed.reply);
          client.end();
          return;
        }
        stage = "joined";
        client.removeListener("data", onData);
        client.pause();
        const rest = buf.subarray(parsed.used);
        void this.join(client, parsed.host, parsed.port, rest, policy, scheme);
      }
    };
    const accept = this.opts.acceptPeer;
    if (accept === undefined) {
      client.on("data", onData);
      return;
    }
    // Nothing is read until the peer is known to be the browser's own network process.
    client.pause();
    void accept({ address: client.remoteAddress ?? "", port: client.remotePort ?? 0 }, listenerPort).then(
      (yes) => {
        if (client.destroyed) return;
        if (!yes) {
          this.opts.log?.(`browser network filter: a connection from another process (port ${client.remotePort}) was closed`);
          client.destroy();
          return;
        }
        client.on("data", onData);
        client.resume();
      },
      () => client.destroy(),
    );
  }

  private async join(client: Socket, host: string, port: number, rest: Buffer, policy: AddressPolicy, scheme: UrlKind): Promise<void> {
    const { found, ips } = await this.targets(host, port, policy);
    if (ips.length === 0) {
      // A name that doesn't resolve is unreachable; one whose every address is refused is not allowed.
      reply(client, found ? REPLY.notAllowed : REPLY.unreachable);
      client.end();
      return;
    }
    // Loopback is always reached directly (Chromium's own rule); anything else takes the setting's routes.
    const routes = ips.every((ip) => classifyAddress(ip) === "loopback") || this.upstream === undefined
      ? [{ kind: "direct" } as const]
      : await this.upstream({ scheme, host: host.startsWith("[") ? host.slice(1, -1) : host, port }).catch((e: unknown) => {
        this.opts.log?.(`browser proxy: no route (${e instanceof Error ? e.message : String(e)})`);
        return [] as Upstream[];
      });
    let lastError: NodeJS.ErrnoException | undefined;
    for (const route of routes) {
      // Directly, the checked addresses race, each started a little after the one before (happy eyeballs, RFC 8305):
      // a first address that never answers, or answers slowly with a refusal (Windows retries a SYN to a closed
      // loopback port for about 2 s, as `localhost`'s ::1 does when a server listens on IPv4 only), never holds up the
      // next. Through a proxy, one address at a time.
      for (const ip of route.kind === "direct" ? [ips] : ips.map((one) => [one])) {
        if (client.destroyed) return;
        const upstream = await (route.kind === "direct" ? this.race(ip, port) : this.viaProxy(route, ip[0]!, port)).catch((e: NodeJS.ErrnoException) => {
          lastError = e;
          return undefined;
        });
        if (upstream === undefined) continue;
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        this.sockets.add(upstream);
        upstream.on("error", () => undefined);
        upstream.on("close", () => {
          this.sockets.delete(upstream);
          client.destroy();
        });
        client.on("close", () => upstream.destroy());
        client.setTimeout(0);
        upstream.setTimeout(0);
        reply(client, REPLY.ok);
        if (rest.length > 0) upstream.write(rest);
        upstream.pipe(client);
        client.pipe(upstream);
        client.resume();
        return;
      }
    }
    if (!client.destroyed) {
      reply(client, lastError?.code === "ECONNREFUSED" ? REPLY.refused : routes.length === 0 ? REPLY.notAllowed : REPLY.unreachable);
      client.end();
    }
  }

  /** A tunnel to the checked address `ip:port` through a proxy: the proxy is asked for the address, never the name. */
  private async viaProxy(proxy: Exclude<Upstream, { kind: "direct" }>, ip: string, port: number): Promise<Socket> {
    const proxyIps = isIP(proxy.host) !== 0 ? [proxy.host] : await this.lookup(proxy.host).catch(() => [] as string[]);
    const usable = proxyIps.filter((a) => !(classifyAddress(a) === "loopback" && this.ports.has(proxy.port)));
    if (usable.length === 0) throw Object.assign(new Error(`the proxy ${proxy.host} can't be reached`), { code: "EPROXYNAME" });
    let last: unknown;
    for (const proxyIp of usable) {
      let socket: Socket | undefined;
      try {
        socket = await this.connectTo(proxy.port, proxyIp);
        if (proxy.kind === "https") socket = await startTls(socket, proxy.host);
        socket.setTimeout(this.opts.proxyTimeoutMs ?? 15_000, () => socket?.destroy(Object.assign(new Error("the proxy didn't answer"), { code: "ETIMEDOUT" })));
        await (proxy.kind === "socks5" ? socks5Connect(socket, ip, port) : proxy.kind === "socks4" ? socks4Connect(socket, ip, port) : httpConnect(socket, ip, port));
        socket.setTimeout(0);
        return socket;
      } catch (e) {
        socket?.destroy();
        last = e;
      }
    }
    throw last;
  }

  /** A connected socket to a checked address, or the connection's error. */
  /** The first of `ips` to connect on `port`, the attempts started `HAPPY_EYEBALLS_MS` apart (and the next one at once
   *  when an attempt fails); the others are closed. Fails with the last error when none connects. */
  private race(ips: readonly string[], port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      let next = 0;
      let running = 0;
      let won = false;
      let lastError: unknown;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const attempts: Promise<Socket>[] = [];
      const start = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (won || next >= ips.length) return;
        const ip = ips[next++]!;
        running++;
        const attempt = this.connectTo(port, ip);
        attempts.push(attempt);
        attempt.then(
          (socket) => {
            running--;
            if (won) {
              socket.destroy();
              return;
            }
            won = true;
            if (timer !== undefined) clearTimeout(timer);
            resolve(socket);
          },
          (e: unknown) => {
            running--;
            lastError = e;
            if (won) return;
            if (next < ips.length) start();
            else if (running === 0) reject(lastError);
          },
        );
        if (next < ips.length) timer = setTimeout(start, HAPPY_EYEBALLS_MS);
      };
      if (ips.length === 0) reject(Object.assign(new Error("no address"), { code: "EHOSTUNREACH" }));
      else start();
    });
  }

  /** A connected socket to `ip:port`, or the connection's error; an attempt that hasn't connected in
   *  `connectTimeoutMs` (2.5 s) gives up, so the next address gets its turn (the second review's should-fix 2). */
  private connectTo(port: number, ip: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = this.dial(port, ip);
      const timer = setTimeout(() => fail(Object.assign(new Error(`${ip}:${port} didn't answer in time`), { code: "ETIMEDOUT" })), this.opts.connectTimeoutMs ?? 2_500);
      const fail = (e: Error): void => {
        clearTimeout(timer);
        socket.removeListener("connect", done);
        socket.destroy();
        reject(e);
      };
      const done = (): void => {
        clearTimeout(timer);
        socket.removeListener("error", fail);
        resolve(socket);
      };
      socket.once("error", fail);
      socket.once("connect", done);
    });
  }
}

// The proxy handshakes (R14). Each asks for the checked address and resolves once the tunnel is open, leaving any
// bytes the proxy sent after its answer unread on the socket.

function startTls(socket: Socket, servername: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername: isIP(servername) !== 0 ? undefined : servername, ALPNProtocols: ["http/1.1"] });
    tls.once("secureConnect", () => {
      tls.removeListener("error", reject);
      resolve(tls as unknown as Socket);
    });
    tls.once("error", reject);
  });
}

/** Reads from `socket` until `done` says it has its answer; the bytes after it go back on the socket. */
function readAnswer(socket: Socket, done: (buf: Buffer) => number | undefined): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 16_384) {
        cleanup();
        reject(Object.assign(new Error("the proxy's answer is too long"), { code: "EPROXY" }));
        return;
      }
      const used = done(buf);
      if (used === undefined) return;
      cleanup();
      socket.pause();
      if (used < buf.length) socket.unshift(buf.subarray(used));
      resolve(buf.subarray(0, used));
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(e);
    };
    const onClose = (): void => {
      cleanup();
      reject(Object.assign(new Error("the proxy closed the connection"), { code: "ECONNRESET" }));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    // A socket an earlier answer paused stays paused for a new listener: read on.
    socket.resume();
  });
}

function hostPort(ip: string, port: number): string {
  return isIP(ip) === 6 ? `[${ip}]:${port}` : `${ip}:${port}`;
}

async function httpConnect(socket: Socket, ip: string, port: number): Promise<void> {
  const target = hostPort(ip, port);
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const head = (await readAnswer(socket, (b) => {
    const end = b.indexOf("\r\n\r\n");
    return end < 0 ? undefined : end + 4;
  })).toString("latin1");
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  if (status !== 200) throw Object.assign(new Error(`the proxy refused the tunnel (${status || "no status"})`), { code: status === 407 ? "EPROXYAUTH" : "EPROXY" });
}

async function socks5Connect(socket: Socket, ip: string, port: number): Promise<void> {
  socket.write(Buffer.from([5, 1, 0]));
  const hello = await readAnswer(socket, (b) => (b.length >= 2 ? 2 : undefined));
  if (hello[0] !== 5 || hello[1] !== 0) throw Object.assign(new Error("the SOCKS proxy wants a password, or isn't SOCKS5"), { code: "EPROXYAUTH" });
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  let address: Buffer;
  if (isIP(ip) === 4) address = Buffer.from([1, ...ip.split(".").map(Number)]);
  else {
    const g = v6Groups(ip);
    if (g === undefined) throw Object.assign(new Error("not an address"), { code: "EPROXY" });
    const b = Buffer.alloc(16);
    g.forEach((x, i) => b.writeUInt16BE(x, i * 2));
    address = Buffer.concat([Buffer.from([4]), b]);
  }
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, p]));
  const answer = await readAnswer(socket, (b) => {
    if (b.length < 5) return undefined;
    const len = b[3] === 1 ? 4 : b[3] === 4 ? 16 : b[3] === 3 ? 1 + b[4]! : 0;
    return b.length >= 4 + len + 2 ? 4 + len + 2 : undefined;
  });
  if (answer[1] !== 0) throw Object.assign(new Error(`the SOCKS proxy refused the connection (${answer[1]})`), { code: answer[1] === 5 ? "ECONNREFUSED" : "EPROXY" });
}

async function socks4Connect(socket: Socket, ip: string, port: number): Promise<void> {
  if (isIP(ip) !== 4) throw Object.assign(new Error("a SOCKS4 proxy reaches IPv4 addresses only"), { code: "EPROXY" });
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([4, 1]), p, Buffer.from(ip.split(".").map(Number)), Buffer.from([0])]));
  const answer = await readAnswer(socket, (b) => (b.length >= 8 ? 8 : undefined));
  if (answer[1] !== 0x5a) throw Object.assign(new Error(`the SOCKS4 proxy refused the connection (${answer[1]})`), { code: "EPROXY" });
}
