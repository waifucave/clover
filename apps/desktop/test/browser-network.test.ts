// The network filter (R13), in plain Node: which addresses each owner's tabs reach, decided after DNS on the address
// the filter then connects to, through a real SOCKS5 listener on loopback, spoken to as Chromium does. No Electron, no network beyond loopback: a
// "public" address is played by a local server through the filter's dialer.
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect, isIP, Socket, type AddressInfo } from "node:net";
import { addressAllowed, BOT_LAN_POLICY, BOT_POLICY, classifyAddress, NetworkFilter, PERSON_POLICY, policyFor, SESSION_POLICY, type AddressPolicy } from "../src/main/browser/network";

describe("addresses", () => {
  test("each address is the kind it is, IPv4 and IPv6, mapped and embedded forms included", () => {
    const kinds: Record<string, string> = {
      "93.184.216.34": "public", "8.8.8.8": "public", "2606:4700::1111": "public",
      "127.0.0.1": "loopback", "127.8.9.10": "loopback", "::1": "loopback", "::ffff:127.0.0.1": "loopback",
      "10.1.2.3": "private", "172.16.0.1": "private", "172.31.255.255": "private", "192.168.1.1": "private", "100.64.0.1": "private",
      "fd12:3456::1": "private", "fc00::1": "private", "fec0::1": "private", "feff::1": "private",
      "64:ff9b:1::10.0.0.1": "private", "64:ff9b:1::8.8.8.8": "public", "::ffff:0:127.0.0.1": "loopback", "::ffff:0:169.254.169.254": "metadata", "::ffff:192.168.0.10": "private", "64:ff9b::10.0.0.1": "private", "2002:c0a8:0101::1": "private",
      "169.254.10.20": "link-local", "fe80::1": "link-local", "fe80::1%en0": "link-local",
      "169.254.169.254": "metadata", "169.254.170.2": "metadata", "100.100.100.200": "metadata", "fd00:ec2::254": "metadata", "::ffff:169.254.169.254": "metadata",
      "0.0.0.0": "unspecified", "0.1.2.3": "unspecified", "::": "unspecified",
      "224.0.0.1": "multicast", "ff02::1": "multicast", "255.255.255.255": "reserved", "240.0.0.1": "reserved", "2001:db8::1": "reserved",
      "172.32.0.1": "public", "100.128.0.1": "public", "not an address": "reserved",
    };
    for (const [ip, kind] of Object.entries(kinds)) expect(`${ip} ${classifyAddress(ip)}`).toBe(`${ip} ${kind}`);
  });

  test("a bot's tabs: public only; a coding session's: loopback too; the person's: their network; never metadata", () => {
    expect(policyFor({ kind: "bot", bot: "alpha" })).toEqual(BOT_POLICY);
    expect(policyFor({ kind: "session", session: "s1" })).toEqual(SESSION_POLICY);
    expect(policyFor({ kind: "user" })).toEqual(PERSON_POLICY);
    expect(policyFor({ kind: "plugin", pluginId: "acme/tool" })).toEqual(BOT_POLICY);
    // A bot whose LAN setting is on (and only that bot); never a session's or a plugin's.
    expect(policyFor({ kind: "bot", bot: "alpha" }, ["alpha"])).toEqual(BOT_LAN_POLICY);
    expect(policyFor({ kind: "bot", bot: "alpha" }, new Set(["alpha"]))).toEqual(BOT_LAN_POLICY);
    expect(policyFor({ kind: "bot", bot: "luna" }, ["alpha"])).toEqual(BOT_POLICY);
    expect(policyFor({ kind: "session", session: "s1" }, ["alpha"])).toEqual(SESSION_POLICY);
    const row = (p: AddressPolicy) => ["93.184.216.34", "127.0.0.1", "192.168.1.1", "fd00::1", "169.254.1.1", "169.254.169.254", "0.0.0.0", "224.0.0.1"].map((ip) => addressAllowed(ip, p));
    expect(row(BOT_POLICY)).toEqual([true, false, false, false, false, false, false, false]);
    expect(row(SESSION_POLICY)).toEqual([true, true, false, false, false, false, false, false]);
    expect(row(PERSON_POLICY)).toEqual([true, true, true, true, true, false, false, false]);
    // The LAN: private and link-local, still no loopback, metadata, unspecified or multicast.
    expect(row(BOT_LAN_POLICY)).toEqual([true, false, true, true, true, false, false, false]);
  });
});

/** A plain HTTP server on loopback that says which path it was asked for. */
async function echoServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => res.end(`echo ${req.url}`));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

const PUBLIC = "93.184.216.34";

/** Reads exactly `n` bytes, keeping what comes after for the next read. */
function reader(socket: Socket) {
  let buf = Buffer.alloc(0);
  let want: { n: number; resolve: (b: Buffer) => void } | undefined;
  let ended = false;
  const check = () => {
    if (want !== undefined && (buf.length >= want.n || ended)) {
      const out = buf.subarray(0, want.n);
      buf = buf.subarray(want.n);
      const w = want;
      want = undefined;
      w.resolve(out);
    }
  };
  socket.on("data", (c: Buffer) => { buf = Buffer.concat([buf, c]); check(); });
  socket.on("end", () => { ended = true; check(); });
  socket.on("close", () => { ended = true; check(); });
  return {
    read: (n: number) => new Promise<Buffer>((resolve) => { want = { n, resolve }; check(); }),
    rest: () => new Promise<string>((resolve) => {
      const done = () => resolve(buf.toString("utf8"));
      if (ended) done();
      else socket.once("close", done);
    }),
  };
}

/** SOCKS5 CONNECT to `host:port` through `proxy`, as Chromium asks: the reply code, and the open tunnel on success.
 *  `v6` sends an IPv6 address as its 16 bytes rather than as a name. */
async function socks(proxy: string, host: string, port: number, v6?: number[]): Promise<{ code: number; socket: Socket; io: ReturnType<typeof reader> }> {
  const u = new URL(proxy);
  const socket = connect(Number(u.port), u.hostname);
  socket.on("error", () => undefined);
  const io = reader(socket);
  await new Promise((r) => socket.once("connect", r));
  socket.write(Buffer.from([5, 1, 0]));
  const hello = await io.read(2);
  expect([...hello]).toEqual([5, 0]);
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  let address: Buffer;
  if (v6 !== undefined) {
    const b = Buffer.alloc(16);
    v6.forEach((g, i) => b.writeUInt16BE(g, i * 2));
    address = Buffer.concat([Buffer.from([4]), b]);
  } else if (isIP(host) === 4) address = Buffer.from([1, ...host.split(".").map(Number)]);
  else address = Buffer.concat([Buffer.from([3, host.length]), Buffer.from(host, "latin1")]);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, p]));
  const answer = await io.read(10);
  return { code: answer[1] ?? -1, socket, io };
}

/** `GET path` from `host:port` through the proxy: the status and body, or the SOCKS refusal code. */
async function get(proxy: string, host: string, port: number, path = "/"): Promise<{ status: number; body: string } | { refused: number }> {
  const t = await socks(proxy, host, port);
  if (t.code !== 0) {
    t.socket.destroy();
    return { refused: t.code };
  }
  t.socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  const raw = await t.io.rest();
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);
  return { status, body: raw.slice(raw.indexOf("\r\n\r\n") + 4) };
}

const NOT_ALLOWED = { refused: 2 };

describe("the filter, after DNS, at connect time", () => {
  const open: { close(): unknown }[] = [];
  afterEach(async () => {
    for (const o of open.splice(0)) await o.close();
  });

  async function setup(names: Record<string, string[]> = {}) {
    const echo = await echoServer();
    open.push({ close: () => new Promise((r) => echo.server.close(r)) });
    const dialed: string[] = [];
    const filter = new NetworkFilter({
      lookup: async (host) => names[host] ?? [],
      // The "public" address is this local server; everything else as asked.
      dial: (port, ip) => {
        dialed.push(`${ip}:${port}`);
        return ip === PUBLIC ? connect(echo.port, "127.0.0.1") : connect(port, ip);
      },
    });
    open.push(filter);
    return { echo, filter, dialed };
  }

  test("a public name goes through to the address that was checked, pinned (no second lookup)", async () => {
    const { filter, dialed } = await setup({ "example.test": [PUBLIC] });
    const rules = await filter.proxyFor(BOT_POLICY);
    expect(rules).toMatch(/^http=socks5:\/\/127\.0\.0\.1:\d+;https=socks5:\/\/127\.0\.0\.1:\d+;socks=socks5:\/\/127\.0\.0\.1:\d+$/);
    const proxy = await filter.listenerFor(BOT_POLICY, "http");
    expect(rules).toContain(proxy);
    expect(await get(proxy, "example.test", 80, "/a?b=1")).toEqual({ status: 200, body: "echo /a?b=1" });
    expect(await get(proxy, PUBLIC, 443, "/tls-is-end-to-end")).toEqual({ status: 200, body: "echo /tls-is-end-to-end" });
    expect(dialed).toEqual([`${PUBLIC}:80`, `${PUBLIC}:443`]);
  });

  test("a bot's tab reaches no loopback, private, link-local or metadata address, by number or by name (rebinding)", async () => {
    const { echo, filter, dialed } = await setup({ "rebind.test": ["10.0.0.7"], "localhost": ["127.0.0.1", "::1"], "meta.test": ["169.254.169.254"] });
    const proxy = await filter.listenerFor(BOT_POLICY, "http");
    for (const [host, port] of [["127.0.0.1", echo.port], ["localhost", echo.port], ["rebind.test", 80], ["::1", 80], ["169.254.169.254", 80], ["meta.test", 80], ["0.0.0.0", 80], ["192.168.1.1", 443], ["fe80::1", 443]] as const) {
      expect(`${host} ${JSON.stringify(await get(proxy, host, port))}`).toBe(`${host} ${JSON.stringify(NOT_ALLOWED)}`);
    }
    // A name that doesn't resolve is unreachable (4), not refused.
    expect(await get(proxy, "nowhere.test", 80)).toEqual({ refused: 4 });
    // An IPv6 address sent as its bytes, as Chromium sends one: ::1.
    const t = await socks(proxy, "", 80, [0, 0, 0, 0, 0, 0, 0, 1]);
    expect(t.code).toBe(2);
    t.socket.destroy();
    expect(dialed).toEqual([]);
  });

  test("a name that answers with a private and a public address is reached only at the public one", async () => {
    const { filter, dialed } = await setup({ "both.test": ["192.168.0.5", PUBLIC] });
    expect(await get(await filter.listenerFor(BOT_POLICY, "http"), "both.test", 80)).toEqual({ status: 200, body: "echo /" });
    expect(dialed).toEqual([`${PUBLIC}:80`]);
  });

  test("a name with an IPv6 and an IPv4 address reaches the one that answers, both checked (localhost, a server on IPv4)", async () => {
    const { echo, filter, dialed } = await setup({ "localhost": ["::1", "127.0.0.1"] });
    expect(await get(await filter.listenerFor(SESSION_POLICY, "http"), "localhost", echo.port, "/v4")).toEqual({ status: 200, body: "echo /v4" });
    expect(dialed).toEqual([`::1:${echo.port}`, `127.0.0.1:${echo.port}`]);
  });

  test("a coding session's tab reaches loopback (its dev servers), never the metadata address or the LAN", async () => {
    const { echo, filter } = await setup({ "localhost": ["127.0.0.1"] });
    const proxy = await filter.listenerFor(SESSION_POLICY, "http");
    expect(await get(proxy, "localhost", echo.port, "/dev")).toEqual({ status: 200, body: "echo /dev" });
    expect(await get(proxy, "127.0.0.1", echo.port, "/dev")).toEqual({ status: 200, body: "echo /dev" });
    expect(await get(proxy, "169.254.169.254", 80)).toEqual(NOT_ALLOWED);
    expect(await get(proxy, "192.168.1.1", 80)).toEqual(NOT_ALLOWED);
  });

  test("the person's tabs reach their own network, never the metadata address", async () => {
    const { echo, filter } = await setup();
    const proxy = await filter.listenerFor(PERSON_POLICY, "http");
    expect(await get(proxy, "127.0.0.1", echo.port)).toEqual({ status: 200, body: "echo /" });
    expect(await get(proxy, "fd00:ec2::254", 80)).toEqual(NOT_ALLOWED);
    expect(await get(proxy, "169.254.169.254", 80)).toEqual(NOT_ALLOWED);
  });

  test("no tab reaches the filter's own listeners, even where loopback is allowed", async () => {
    const { filter } = await setup();
    const loose = await filter.listenerFor(PERSON_POLICY, "http");
    const strict = await filter.listenerFor(BOT_POLICY, "http");
    const looseOther = await filter.listenerFor(PERSON_POLICY, "other");
    expect(await get(loose, "127.0.0.1", Number(new URL(looseOther).port))).toEqual(NOT_ALLOWED);
    expect(loose).not.toBe(strict);
    expect(await get(loose, "127.0.0.1", Number(new URL(strict).port))).toEqual(NOT_ALLOWED);
    expect(await get(loose, "127.0.0.1", Number(new URL(loose).port))).toEqual(NOT_ALLOWED);
  });

  test("a bot whose LAN setting is on reaches its LAN, never loopback or metadata", async () => {
    const echo = await echoServer();
    open.push({ close: () => new Promise((r) => echo.server.close(r)) });
    const dialed: string[] = [];
    // The NAS is played by the local server; nothing else is dialled for real.
    const filter = new NetworkFilter({
      lookup: async (host) => ({ "nas.local": ["192.168.1.20"], "localhost": ["127.0.0.1"] })[host] ?? [],
      dial: (port, ip) => {
        dialed.push(`${ip}:${port}`);
        return connect(echo.port, "127.0.0.1");
      },
    });
    open.push(filter);
    const proxy = await filter.listenerFor(BOT_LAN_POLICY, "https");
    expect(proxy).not.toBe(await filter.listenerFor(BOT_POLICY, "https"));
    expect(await get(proxy, "nas.local", 80, "/lan")).toEqual({ status: 200, body: "echo /lan" });
    expect(await get(proxy, "fe80::1", 80, "/ll")).toEqual({ status: 200, body: "echo /ll" });
    for (const host of ["127.0.0.1", "localhost", "169.254.169.254", "fd00:ec2::254"]) expect(await get(proxy, host, 80)).toEqual(NOT_ALLOWED);
    expect(dialed).toEqual(["192.168.1.20:80", "fe80::1:80"]);
    // The same bot without the setting: refused by name and by number.
    const strict = await filter.listenerFor(BOT_POLICY, "https");
    expect(await get(strict, "nas.local", 80)).toEqual(NOT_ALLOWED);
  });

  test("a dead first address never fails the page: each attempt has its time, then the next address", async () => {
    const echo = await echoServer();
    open.push({ close: () => new Promise((r) => echo.server.close(r)) });
    const dialed: string[] = [];
    const filter = new NetworkFilter({
      lookup: async () => ["203.0.113.9", PUBLIC],
      connectTimeoutMs: 300,
      // The first address never answers (a socket that never connects); the second is the local server.
      dial: (port, ip) => {
        dialed.push(ip);
        return ip === PUBLIC ? connect(echo.port, "127.0.0.1") : new Socket();
      },
    });
    open.push(filter);
    const t0 = Date.now();
    expect(await get(await filter.listenerFor(BOT_POLICY, "http"), "two.test", 80, "/second")).toEqual({ status: 200, body: "echo /second" });
    expect(dialed).toEqual(["203.0.113.9", PUBLIC]);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("a first address that refuses slowly (Windows' ::1 for a server on IPv4) doesn't hold up the next: the addresses race", async () => {
    const echo = await echoServer();
    open.push({ close: () => new Promise((r) => echo.server.close(r)) });
    const filter = new NetworkFilter({
      lookup: async () => ["::1", "127.0.0.1"],
      dial: (port, ip) => {
        if (ip === "127.0.0.1") return connect(echo.port, "127.0.0.1");
        const s = new Socket();
        setTimeout(() => s.destroy(Object.assign(new Error("refused, late"), { code: "ECONNREFUSED" })), 1_500);
        return s;
      },
    });
    open.push(filter);
    const t0 = Date.now();
    expect(await get(await filter.listenerFor(SESSION_POLICY, "http"), "localhost", 80, "/raced")).toEqual({ status: 200, body: "echo /raced" });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("only the browser's own network process may use the filter: anyone else is closed unanswered", async () => {
    const asked: { address: string; port: number; listener: number }[] = [];
    let yes = false;
    const filter = new NetworkFilter({ lookup: async () => [PUBLIC], dial: () => new Socket(), acceptPeer: async (peer, listener) => { asked.push({ ...peer, listener }); return yes; } });
    open.push(filter);
    const listener = await filter.listenerFor(BOT_POLICY, "http");
    const port = Number(new URL(listener).port);
    const s = connect(port, "127.0.0.1");
    s.on("error", () => undefined);
    const io = reader(s);
    await new Promise((r) => s.once("connect", r));
    s.write(Buffer.from([5, 1, 0]));
    expect((await io.read(2)).length).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ address: "127.0.0.1", listener: port });
    expect(asked[0]!.port).toBeGreaterThan(0);
    yes = true;
    const t = await socks(listener, "example.test", 80);
    expect(t.code).not.toBe(-1);
    t.socket.destroy();
    expect(filter.listenerPorts()).toContain(port);
  });

  test("one listener per policy; only SOCKS5 CONNECT without a password; closed means closed", async () => {
    const { filter } = await setup();
    expect(await filter.listenerFor(BOT_POLICY, "http")).toBe(await filter.listenerFor({ ...BOT_POLICY }, "http"));
    const u = new URL(await filter.listenerFor(BOT_POLICY, "http"));
    // A client that offers only a password method is turned away.
    const s = connect(Number(u.port), u.hostname);
    const io = reader(s);
    await new Promise((r) => s.once("connect", r));
    s.write(Buffer.from([5, 1, 2]));
    expect([...(await io.read(2))]).toEqual([5, 0xff]);
    s.destroy();
    await filter.close();
    await expect(filter.proxyFor(BOT_POLICY)).rejects.toThrow("closed");
  });
});
