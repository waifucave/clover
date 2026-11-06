// The proxy setting (R14), chained behind the network filter (R13), in plain Node: the filter checks each address,
// then reaches it through the proxy the setting names, asking the proxy for the checked address and never the name.
// The proxies here are small local servers (HTTP CONNECT, SOCKS5, SOCKS4); no network beyond loopback. Also the
// system readers (macOS, Windows, GNOME, KDE, the environment), the bypass rules and PAC answers, from their texts.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { BOT_POLICY, NetworkFilter, PERSON_POLICY, SESSION_POLICY } from "../src/main/browser/network";
import {
  bypassMatches, checkProxySetting, parsePacResult, parseProxyEnv, parseProxyUrl, parseScutil, parseWindowsInternetSettings,
  proxyRoutes, readSystemProxy, type SystemProxy,
} from "../src/main/browser/proxy";

const PUBLIC = "93.184.216.34";

describe("the app's copies are the core's", () => {
  test("network.ts and proxy.ts are the same file in both places", () => {
    for (const f of ["network.ts", "proxy.ts"]) {
      const app = readFileSync(join(import.meta.dir, "../src/main/browser", f), "utf8");
      const core = readFileSync(join(import.meta.dir, "../../../packages/core/src/browser", f), "utf8");
      expect(`${f}: ${app === core}`).toBe(`${f}: true`);
    }
  });
});

describe("the setting", () => {
  test("off, system, or an explicit http, https or socks proxy with no password", () => {
    expect(checkProxySetting({ mode: "off" })).toEqual({ mode: "off" });
    expect(checkProxySetting({ mode: "system" })).toEqual({ mode: "system" });
    expect(checkProxySetting({ mode: "explicit", url: "socks5://proxy.test:1080", bypass: ["*.corp"] })).toEqual({ mode: "explicit", url: "socks5://proxy.test:1080", bypass: ["*.corp"] });
    expect(parseProxyUrl("http://proxy.test")).toEqual({ protocol: "http", host: "proxy.test", port: 80 });
    expect(parseProxyUrl("https://proxy.test")).toEqual({ protocol: "https", host: "proxy.test", port: 443 });
    expect(parseProxyUrl("socks://[::1]:9050")).toEqual({ protocol: "socks5", host: "::1", port: 9050 });
    expect(parseProxyUrl("socks4://10.0.0.1:1080")).toEqual({ protocol: "socks4", host: "10.0.0.1", port: 1080 });
    for (const bad of [{ mode: "auto" }, { mode: "explicit" }, { mode: "explicit", url: "ftp://x:1" }, { mode: "explicit", url: "http://user:pw@x:1" },
      { mode: "explicit", url: "http://x:1/path" }, { mode: "explicit", url: "not a url" }, { mode: "explicit", url: "http://x:1", bypass: "*.corp" }, null]) {
      expect(() => checkProxySetting(bad)).toThrow();
    }
    // A refusal never repeats a password back.
    try {
      checkProxySetting({ mode: "explicit", url: "http://user:hunter2@x:1" });
    } catch (e) {
      expect(String(e)).not.toContain("hunter2");
    }
  });

  test("bypass rules in each OS's spelling", () => {
    const rules = ["*.corp.test", ".example.test", "intranet", "10.0.0.0/8", "169.254/16", "fd00::/8", "*mid*", "api.test:8443", "<local>"];
    const yes = [["a.corp.test", 80], ["example.test", 80], ["x.example.test", 80], ["intranet", 80], ["10.2.3.4", 443], ["169.254.9.9", 80], ["fd00::5", 80], ["amidb", 80], ["api.test", 8443], ["printer", 80]] as const;
    const no = [["corp.test.evil", 80], ["notexample.test", 80], ["11.0.0.1", 80], ["api.test", 443], ["fe80::1", 80], ["public.test", 80]] as const;
    for (const [h, p] of yes) expect(`${h}:${p} ${bypassMatches(rules, h, p)}`).toBe(`${h}:${p} true`);
    for (const [h, p] of no) expect(`${h}:${p} ${bypassMatches(rules, h, p)}`).toBe(`${h}:${p} false`);
    expect(bypassMatches(["*"], "anything.test", 1)).toBe(true);
  });

  test("a PAC answer as routes", () => {
    expect(parsePacResult("PROXY a.test:3128; SOCKS5 b.test:1080; HTTPS c.test; DIRECT")).toEqual([
      { kind: "http", host: "a.test", port: 3128 }, { kind: "socks5", host: "b.test", port: 1080 }, { kind: "https", host: "c.test", port: 443 }, { kind: "direct" },
    ]);
    expect(parsePacResult("SOCKS d.test:9; SOCKS4 [::1]:9")).toEqual([{ kind: "socks5", host: "d.test", port: 9 }, { kind: "socks4", host: "::1", port: 9 }]);
    expect(parsePacResult("QUIC q.test:443")).toEqual([]);
  });
});

describe("the system's proxy, read explicitly", () => {
  test("macOS: scutil --proxy", () => {
    const out = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 3128
  HTTPProxy : proxy.corp.test
  HTTPSEnable : 1
  HTTPSPort : 3129
  HTTPSProxy : secure.corp.test
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 1
  SOCKSEnable : 0
}`;
    expect(parseScutil(out)).toEqual({
      servers: { http: { protocol: "http", host: "proxy.corp.test", port: 3128 }, https: { protocol: "http", host: "secure.corp.test", port: 3129 } },
      bypass: ["*.local", "169.254/16"], bypassSimple: true,
    });
    const pac = parseScutil(`<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://wpad.corp.test/proxy.pac\n}`);
    expect(pac.pacUrl).toBe("http://wpad.corp.test/proxy.pac");
    // Discovery alone (WPAD) is no proxy, and says so.
    expect(parseScutil(`<dictionary> {\n  ProxyAutoDiscoveryEnable : 1\n}`)).toEqual({ servers: {}, bypass: [], discoveryOnly: true });
  });

  test("Windows: the user's Internet Settings", () => {
    const out = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=web.corp.test:8080;https=web.corp.test:8443;socks=socks.corp.test:1080
    ProxyOverride    REG_SZ    *.corp.test;<local>
`;
    expect(parseWindowsInternetSettings(out)).toEqual({
      servers: { http: { protocol: "http", host: "web.corp.test", port: 8080 }, https: { protocol: "http", host: "web.corp.test", port: 8443 }, socks: { protocol: "socks4", host: "socks.corp.test", port: 1080 } },
      bypass: ["*.corp.test"], bypassSimple: true,
    });
    expect(parseWindowsInternetSettings("    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    one.test:3128\n").servers).toEqual({
      http: { protocol: "http", host: "one.test", port: 3128 }, https: { protocol: "http", host: "one.test", port: 3128 },
    });
    // Off, with a PAC URL: the PAC file.
    expect(parseWindowsInternetSettings("    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    one.test:3128\n    AutoConfigURL    REG_SZ    http://pac.test/p.pac\n")).toEqual({ pacUrl: "http://pac.test/p.pac", servers: {}, bypass: [] });
  });

  test("Linux: GNOME, KDE, else the environment; never a password from it", async () => {
    const gnome: Record<string, string> = {
      "org.gnome.system.proxy mode": "'manual'", "org.gnome.system.proxy.http host": "'web.test'", "org.gnome.system.proxy.http port": "3128",
      "org.gnome.system.proxy.https host": "''", "org.gnome.system.proxy.https port": "0", "org.gnome.system.proxy.socks host": "'s.test'",
      "org.gnome.system.proxy.socks port": "1080", "org.gnome.system.proxy ignore-hosts": "['localhost', '127.0.0.0/8', '*.lan']",
    };
    const run = async (cmd: string, args: string[]) => {
      if (cmd !== "gsettings") throw new Error("no such tool");
      const v = gnome[`${args[1]} ${args[2]}`];
      if (v === undefined) throw new Error("no key");
      return `${v}\n`;
    };
    expect(await readSystemProxy({ platform: "linux", run, env: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" } })).toEqual({
      servers: { http: { protocol: "http", host: "web.test", port: 3128 }, socks: { protocol: "socks5", host: "s.test", port: 1080 } },
      bypass: ["localhost", "127.0.0.0/8", "*.lan"],
    });
    gnome["org.gnome.system.proxy mode"] = "'auto'";
    gnome["org.gnome.system.proxy autoconfig-url"] = "''";
    expect(await readSystemProxy({ platform: "linux", run, env: { XDG_CURRENT_DESKTOP: "GNOME" } })).toEqual({ servers: {}, bypass: [], discoveryOnly: true });
    const kde = async (_cmd: string, args: string[]) => ({ ProxyType: "1", httpProxy: "http://k.test 8080", httpsProxy: "", socksProxy: "", NoProxyFor: "localhost,.kde.test" })[args[5]!] ?? "";
    expect(await readSystemProxy({ platform: "linux", run: kde, env: { XDG_CURRENT_DESKTOP: "KDE" } })).toEqual({ servers: { http: { protocol: "http", host: "k.test", port: 8080 } }, bypass: ["localhost", ".kde.test"] });
    expect(parseProxyEnv({ HTTPS_PROXY: "http://h.test:3128", all_proxy: "socks5://s.test:1080", no_proxy: "localhost, .internal", http_proxy: "http://user:pw@leak.test:1" })).toEqual({
      servers: { https: { protocol: "http", host: "h.test", port: 3128 }, socks: { protocol: "socks5", host: "s.test", port: 1080 } },
      bypass: ["localhost", ".internal"],
    });
    // A tool that fails is no proxy.
    expect(await readSystemProxy({ platform: "darwin", run: async () => { throw new Error("nope"); }, env: {} })).toEqual({ servers: {}, bypass: [] });
  });

  test("the routes for the system's proxy: per scheme, bypassed, PAC only through its evaluator, read again after a while", async () => {
    let reads = 0;
    let now = 0;
    let sys: SystemProxy = { servers: { http: { protocol: "http", host: "web.test", port: 3128 }, socks: { protocol: "socks5", host: "s.test", port: 1080 } }, bypass: ["*.lan"], bypassSimple: true };
    const logs: string[] = [];
    const routes = proxyRoutes({ mode: "system" }, { readSystem: async () => { reads++; return sys; }, now: () => now, log: (l) => logs.push(l) })!;
    expect(await routes({ scheme: "http", host: "a.test", port: 80 })).toEqual([{ kind: "http", host: "web.test", port: 3128 }]);
    expect(await routes({ scheme: "https", host: "a.test", port: 443 })).toEqual([{ kind: "socks5", host: "s.test", port: 1080 }]);
    expect(await routes({ scheme: "other", host: "a.test", port: 443 })).toEqual([{ kind: "socks5", host: "s.test", port: 1080 }]);
    expect(await routes({ scheme: "http", host: "nas.lan", port: 80 })).toEqual([{ kind: "direct" }]);
    expect(await routes({ scheme: "http", host: "printer", port: 80 })).toEqual([{ kind: "direct" }]);
    expect(reads).toBe(1);
    sys = { pacUrl: "http://pac.test/p.pac", servers: {}, bypass: [] };
    now += 11_000;
    // A PAC file and nothing to run it: refused, never round the proxy.
    expect(await routes({ scheme: "https", host: "a.test", port: 443 })).toEqual([]);
    expect(reads).toBe(2);
    expect(logs.some((l) => l.includes("PAC"))).toBe(true);
    const asked: string[] = [];
    const withPac = proxyRoutes({ mode: "system" }, { readSystem: async () => sys, pac: async (pac, url) => { asked.push(`${pac} ${url}`); return "PROXY p.test:8080; DIRECT"; } })!;
    expect(await withPac({ scheme: "https", host: "a.test", port: 443 })).toEqual([{ kind: "http", host: "p.test", port: 8080 }, { kind: "direct" }]);
    expect(await withPac({ scheme: "http", host: "b.test", port: 8000 })).toEqual([{ kind: "http", host: "p.test", port: 8080 }, { kind: "direct" }]);
    expect(asked).toEqual(["http://pac.test/p.pac https://a.test/", "http://pac.test/p.pac http://b.test:8000/"]);
    // Discovery only: direct, said once.
    const wpad = proxyRoutes({ mode: "system" }, { readSystem: async () => ({ servers: {}, bypass: [], discoveryOnly: true }), log: (l) => logs.push(l) })!;
    expect(await wpad({ scheme: "http", host: "a.test", port: 80 })).toEqual([{ kind: "direct" }]);
    expect(logs.filter((l) => l.includes("WPAD")).length).toBe(1);
    expect(proxyRoutes({ mode: "off" })).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------------------------
// Through real (local) proxies
// -----------------------------------------------------------------------------------------------

async function echoServer(): Promise<{ server: HttpServer; port: number }> {
  const server = createHttpServer((req, res) => res.end(`echo ${req.url}`));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

/** A proxy that records what it was asked for and joins `PUBLIC:*` to the echo server (anything else: refused). */
async function fakeProxy(kind: "http" | "socks5" | "socks4", echoPort: number): Promise<{ server: Server; port: number; asked: string[] }> {
  const asked: string[] = [];
  const join = (client: Socket, host: string, port: number, ok: () => void, no: () => void) => {
    asked.push(`${host}:${port}`);
    if (host !== PUBLIC) return no();
    const up = connect(echoPort, "127.0.0.1", () => {
      ok();
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
  };
  const server = createServer((client) => {
    client.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    let stage = 0;
    client.on("data", function onData(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);
      if (kind === "http") {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        client.removeListener("data", onData);
        const m = /^CONNECT (\S+) HTTP/.exec(buf.toString("latin1"));
        const target = m?.[1] ?? "";
        const at = target.lastIndexOf(":");
        join(client, target.slice(0, at).replace(/^\[|\]$/g, ""), Number(target.slice(at + 1)), () => client.write("HTTP/1.1 200 Connection established\r\n\r\n"), () => client.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
        return;
      }
      if (kind === "socks4") {
        if (buf.length < 9) return;
        client.removeListener("data", onData);
        join(client, [...buf.subarray(4, 8)].join("."), buf.readUInt16BE(2), () => client.write(Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0])), () => client.end(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0])));
        return;
      }
      if (stage === 0) {
        if (buf.length < 3) return;
        client.write(Buffer.from([5, 0]));
        buf = buf.subarray(3);
        stage = 1;
      }
      if (buf.length < 10) return;
      client.removeListener("data", onData);
      const type = buf[3];
      const host = type === 1 ? [...buf.subarray(4, 8)].join(".") : type === 3 ? `name:${buf.subarray(5, 5 + buf[4]!).toString()}` : "v6";
      const port = buf.readUInt16BE(buf.length - 2);
      join(client, host, port, () => client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])), () => client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as AddressInfo).port, asked };
}

/** `GET path` through the filter's SOCKS5 listener, as Chromium asks (the name, not an address). */
async function get(listener: string, host: string, port: number, path = "/"): Promise<{ status: number; body: string } | { refused: number }> {
  const u = new URL(listener);
  const socket = connect(Number(u.port), u.hostname);
  socket.on("error", () => undefined);
  await new Promise((r) => socket.once("connect", r));
  const chunks: Buffer[] = [];
  socket.on("data", (c: Buffer) => chunks.push(c));
  const until = async (n: number) => {
    for (let i = 0; i < 200 && Buffer.concat(chunks).length < n; i++) await new Promise((r) => setTimeout(r, 5));
  };
  socket.write(Buffer.from([5, 1, 0]));
  await until(2);
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host, "latin1"), p]));
  await until(12);
  const code = Buffer.concat(chunks)[3] ?? -1;
  if (code !== 0) {
    socket.destroy();
    return { refused: code };
  }
  chunks.splice(0);
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  await new Promise((r) => socket.once("close", r));
  const raw = Buffer.concat(chunks).toString("utf8");
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0), body: raw.slice(raw.indexOf("\r\n\r\n") + 4) };
}

describe("the filter, chained to a proxy", () => {
  const open: { close(): unknown }[] = [];
  afterEach(async () => {
    for (const o of open.splice(0)) await o.close();
  });

  async function setup(kind: "http" | "socks5" | "socks4", names: Record<string, string[]>, bypass?: string[]) {
    const echo = await echoServer();
    open.push({ close: () => new Promise((r) => echo.server.close(r)) });
    const proxy = await fakeProxy(kind, echo.port);
    open.push({ close: () => new Promise((r) => proxy.server.close(r)) });
    const dialed: string[] = [];
    const filter = new NetworkFilter({
      lookup: async (host) => names[host] ?? [],
      // Only loopback is dialled for real (the proxy, the echo server); a direct dial anywhere else is recorded and fails.
      dial: (port, ip) => {
        dialed.push(`${ip}:${port}`);
        return ip === "127.0.0.1" ? connect(port, ip) : connect(1, "127.0.0.1");
      },
      upstream: proxyRoutes({ mode: "explicit", url: `${kind}://127.0.0.1:${proxy.port}`, ...(bypass !== undefined ? { bypass } : {}) }),
    });
    open.push(filter);
    return { echo, proxy, filter, dialed };
  }

  for (const kind of ["http", "socks5", "socks4"] as const) {
    test(`${kind}: the proxy is asked for the checked address, never the name; refused names never reach it`, async () => {
      const { proxy, filter, dialed } = await setup(kind, { "example.test": [PUBLIC], "rebind.test": ["10.0.0.7"], "meta.test": ["169.254.169.254"] });
      const listener = await filter.listenerFor(BOT_POLICY, "https");
      expect(await get(listener, "example.test", 443, "/via")).toEqual({ status: 200, body: "echo /via" });
      expect(proxy.asked).toEqual([`${PUBLIC}:443`]);
      expect(dialed).toEqual([`127.0.0.1:${proxy.port}`]);
      for (const host of ["rebind.test", "meta.test", "10.0.0.7", "nowhere.test"]) expect(await get(listener, host, 80)).toEqual({ refused: 2 });
      expect(proxy.asked).toEqual([`${PUBLIC}:443`]);
    });
  }

  test("loopback goes direct, never to the proxy; a bypassed host goes direct; the person's LAN goes to the proxy", async () => {
    const { echo, proxy, filter, dialed } = await setup("http", { "localhost": ["127.0.0.1"], "skip.test": [PUBLIC], "nas.test": ["192.168.1.9"] }, ["skip.test"]);
    expect(await get(await filter.listenerFor(SESSION_POLICY, "http"), "localhost", echo.port, "/dev")).toEqual({ status: 200, body: "echo /dev" });
    expect(proxy.asked).toEqual([]);
    expect(await get(await filter.listenerFor(BOT_POLICY, "http"), "skip.test", 80)).toEqual({ refused: 5 });
    expect(dialed).toContain(`${PUBLIC}:80`);
    expect(proxy.asked).toEqual([]);
    // The proxy refuses it (it's not the "public" address), so the tunnel fails: but it was the proxy that was asked.
    expect(await get(await filter.listenerFor(PERSON_POLICY, "http"), "nas.test", 80)).toEqual({ refused: 4 });
    expect(proxy.asked).toEqual(["192.168.1.9:80"]);
  });

  test("a proxy that refuses, or isn't there, is a failure, never a direct connection", async () => {
    const { filter, dialed } = await setup("http", { "example.test": [PUBLIC] });
    filter.setUpstream(proxyRoutes({ mode: "explicit", url: "http://127.0.0.1:1" }));
    expect(await get(await filter.listenerFor(BOT_POLICY, "http"), "example.test", 80)).toEqual({ refused: 5 });
    expect(dialed).not.toContain(`${PUBLIC}:80`);
    // The setting turned off: direct again, at once, for the next connection.
    filter.setUpstream(undefined);
    await get(await filter.listenerFor(BOT_POLICY, "http"), "example.test", 80);
    expect(dialed).toContain(`${PUBLIC}:80`);
  });

  test("a proxy setting never points at the filter's own listeners", async () => {
    const { filter } = await setup("http", { "example.test": [PUBLIC] });
    const own = Number(new URL(await filter.listenerFor(PERSON_POLICY, "other")).port);
    filter.setUpstream(proxyRoutes({ mode: "explicit", url: `socks5://127.0.0.1:${own}` }));
    expect(await get(await filter.listenerFor(PERSON_POLICY, "http"), "example.test", 80)).toEqual({ refused: 4 });
  });
});
