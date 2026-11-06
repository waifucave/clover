// Which addresses a tab may reach (ruling R13): checked when each connection is made, after DNS, so a name that
// resolves (or rebinds) to a local address can't get round it. Every browser partition sends all its traffic through a
// small SOCKS5 proxy in the main process (`session.ts` sets it, with `<-loopback>` so loopback isn't bypassed).
// Through SOCKS5 Chromium sends the name, not an address, for every scheme (http, https, WebSockets), so the proxy
// resolves each name itself, keeps only the addresses the tab's owner may reach, and connects to those it checked, in
// turn until one answers (a name like `localhost` has an IPv6 and an IPv4 address, and a server may listen on one): the
// addresses are pinned, never looked up twice.
//
// * A bot's tabs: no loopback, private (RFC 1918, ULA, shared CGNAT space), link-local or cloud metadata address. A
//   per-bot setting that allows the LAN is L-M2.
// * A coding session's tabs: loopback too (its dev servers), never the metadata address.
// * A plugin's own tabs (a plugin acting as itself): as a bot's.
// * The person's own tabs: their own network, never the metadata address.
// * Nobody: the unspecified, multicast and reserved ranges, and this proxy's own ports.
//
// Plain Node, no Electron, so it is tested on its own (`test/browser-network.test.ts`). TLS stays end to end: the proxy
// only ever joins two sockets.
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, connect as netConnect, isIP, type Server, type Socket } from "node:net";
import type { TabOwner } from "./contract";

export interface AddressPolicy {
  loopback: boolean;
  privateNetworks: boolean;
  linkLocal: boolean;
}

export const BOT_POLICY: AddressPolicy = Object.freeze({ loopback: false, privateNetworks: false, linkLocal: false });
export const SESSION_POLICY: AddressPolicy = Object.freeze({ loopback: true, privateNetworks: false, linkLocal: false });
export const PERSON_POLICY: AddressPolicy = Object.freeze({ loopback: true, privateNetworks: true, linkLocal: true });

export function policyFor(owner: TabOwner): AddressPolicy {
  return owner.kind === "session" ? SESSION_POLICY : owner.kind === "user" ? PERSON_POLICY : BOT_POLICY;
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
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  if (g.slice(0, 6).every((x) => x === 0)) return "reserved"; // IPv4-compatible, deprecated
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // ULA, fc00::/7
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

export interface NetworkFilterOptions {
  /** Every address a name has (default: the system's resolver, all of them). */
  lookup?: (host: string) => Promise<string[]>;
  /** Opens the connection to a checked address (default: `net.connect`). */
  dial?: (port: number, ip: string) => Socket;
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

/** The filtering proxies: one SOCKS5 listener on loopback per policy, each its own port. */
export class NetworkFilter {
  private readonly listeners = new Map<string, Promise<{ server: Server; port: number }>>();
  private readonly ports = new Set<number>();
  private readonly sockets = new Set<Socket>();
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly dial: (port: number, ip: string) => Socket;
  private closed = false;

  constructor(private readonly opts: NetworkFilterOptions = {}) {
    this.lookup = opts.lookup ?? (async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address));
    this.dial = opts.dial ?? ((port, ip) => netConnect({ port, host: ip }));
  }

  /** The proxy for a policy, as Chromium's proxy rules spell it (`socks5://127.0.0.1:<port>`). */
  async proxyFor(policy: AddressPolicy): Promise<string> {
    if (this.closed) throw new Error("the browser's network filter is closed");
    const key = `${+policy.loopback}${+policy.privateNetworks}${+policy.linkLocal}`;
    let listener = this.listeners.get(key);
    if (listener === undefined) {
      listener = this.listen(policy);
      this.listeners.set(key, listener);
      listener.catch(() => this.listeners.delete(key));
    }
    return `socks5://127.0.0.1:${(await listener).port}`;
  }

  /** The addresses to try for `host`, in the resolver's order: those the policy allows. */
  async resolve(host: string, policy: AddressPolicy): Promise<string[]> {
    const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    const addresses = isIP(literal) !== 0 ? [literal] : await this.lookup(literal).catch(() => [] as string[]);
    return addresses.filter((ip) => addressAllowed(ip, policy));
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

  private async targets(host: string, port: number, policy: AddressPolicy): Promise<string[]> {
    // A page never reaches one of these proxies through another (a looser policy's port, or its own).
    return (await this.resolve(host, policy)).filter((ip) => !(classifyAddress(ip) === "loopback" && this.ports.has(port)));
  }

  private listen(policy: AddressPolicy): Promise<{ server: Server; port: number }> {
    const server = createServer((socket) => this.serve(socket, policy));
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

  private serve(client: Socket, policy: AddressPolicy): void {
    this.sockets.add(client);
    client.on("error", () => undefined);
    client.on("close", () => this.sockets.delete(client));
    client.setTimeout(30_000, () => client.destroy());
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
        void this.join(client, parsed.host, parsed.port, rest, policy);
      }
    };
    client.on("data", onData);
  }

  private async join(client: Socket, host: string, port: number, rest: Buffer, policy: AddressPolicy): Promise<void> {
    const ips = await this.targets(host, port, policy);
    if (ips.length === 0) {
      reply(client, REPLY.notAllowed);
      client.end();
      return;
    }
    let lastError: NodeJS.ErrnoException | undefined;
    for (const ip of ips) {
      if (client.destroyed) return;
      const upstream = await this.connectTo(port, ip).catch((e: NodeJS.ErrnoException) => {
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
      reply(client, REPLY.ok);
      if (rest.length > 0) upstream.write(rest);
      upstream.pipe(client);
      client.pipe(upstream);
      client.resume();
      return;
    }
    if (!client.destroyed) {
      reply(client, lastError?.code === "ECONNREFUSED" ? REPLY.refused : REPLY.unreachable);
      client.end();
    }
  }

  /** A connected socket to a checked address, or the connection's error. */
  private connectTo(port: number, ip: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = this.dial(port, ip);
      const fail = (e: Error): void => {
        socket.destroy();
        reject(e);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.removeListener("error", fail);
        resolve(socket);
      });
    });
  }
}
