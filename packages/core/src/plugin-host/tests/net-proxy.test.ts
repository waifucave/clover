// A plugin's way to the network (2g): its proxy lets through only its `network:` hosts, and under the fence its process
// reaches nothing else. Local servers stand in for the hosts; nothing leaves this computer.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { HookRunner } from "../../plugins/hook-runner";
import { ensurePluginRunFiles } from "../../registry/plugin-run";
import { startPluginHost } from "../daemon-host";
import { hostAllowed, hostRules, startPluginProxy, type PluginProxy } from "../net-proxy";

/** Waits for the install card's answer to land, rather than a fixed sleep. */
async function approved(registry: { get(id: string): { state: string } | undefined }, id: string): Promise<void> {
  for (let i = 0; i < 500 && registry.get(id)?.state === "found"; i++) await Bun.sleep(10);
}

const USER: Caller = { kind: "user", client: "app" };
const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
const servers: { stop(force?: boolean): void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** The `Proxy-Authorization` line (with its CRLF) for a proxy's token, from the URL its processes get. */
const authOf = (proxy: PluginProxy) => {
  const u = new URL(proxy.env.HTTPS_PROXY!);
  return `Proxy-Authorization: Basic ${Buffer.from(`${u.username}:${u.password}`).toString("base64")}\r\n`;
};
/** Sends `text` to a proxy on a raw socket and gives back what came back by the time it closes (or `ms` pass). */
const raw = (port: number, text: string | undefined, ms = 5_000) =>
  new Promise<string>((resolve) => {
    let buf = "";
    const t = setTimeout(() => resolve(`${buf}[still open]`), ms);
    void Bun.connect({ hostname: "127.0.0.1", port, socket: { open: (s) => void (text !== undefined && s.write(text)), data: (_s, d) => void (buf += d.toString()), close: () => (clearTimeout(t), resolve(buf)) } });
  });

/** A local stand-in for a host on the internet. */
function upstream(text: string): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(text) });
  servers.push(s);
  return s.port!;
}
/** The proxies' resolver: `<name>.test` resolves to a public documentation address (TEST-NET-3), `rebind.test` to
 *  this computer, and `printer.local` too; any other name fails. */
const PUBLIC_STAND_IN = "203.0.113.7";
const testResolve = async (host: string): Promise<string[]> => {
  if (host === "rebind.test" || host === "printer.local") return ["127.0.0.1"];
  if (host.endsWith(".test")) return [PUBLIC_STAND_IN];
  throw new Error(`no such host ${host}`);
};
/** The proxies' upstream: the stand-in public address (and a raw loopback one, when listed) is this computer. */
const testConnect = ((o: Parameters<typeof Bun.connect>[0]) => {
  const address = (o as unknown as { hostname: string }).hostname;
  if (address !== PUBLIC_STAND_IN && address !== "127.0.0.1") return Promise.reject(new Error(`no route to ${address}`));
  return Bun.connect({ ...(o as object), hostname: "127.0.0.1" } as unknown as Parameters<typeof Bun.connect>[0]);
}) as typeof Bun.connect;

describe("the network list", () => {
  test("names, subdomains, ports and raw addresses", () => {
    const r = hostRules(["network:api.example.com", "network:*.cdn.example.com", "network:files.example.com:8443", "network:10.0.0.5:9000", "network:[::1]:8080", "storage", "network:"]);
    const yes: [string, number][] = [["api.example.com", 443], ["API.example.com.", 80], ["a.cdn.example.com", 443], ["x.y.cdn.example.com", 443], ["files.example.com", 8443], ["10.0.0.5", 9000], ["::1", 8080]];
    const no: [string, number][] = [["api.example.com", 8080], ["cdn.example.com", 443], ["evil.example.com", 443], ["files.example.com", 443], ["10.0.0.5", 443], ["10.0.0.6", 9000], ["93.184.216.34", 443], ["api.example.com.evil.net", 443]];
    for (const [h, p] of yes) expect([h, p, hostAllowed(r, h, p)]).toEqual([h, p, true]);
    for (const [h, p] of no) expect([h, p, hostAllowed(r, h, p)]).toEqual([h, p, false]);
  });

  test("the proxy tunnels and forwards to a listed host, and refuses any other, raw addresses included", async () => {
    const listed = upstream("listed");
    const other = upstream("other");
    const lines: string[] = [];
    const proxy = startPluginProxy({ pluginId: "spy", capabilities: () => [`network:api.test:${listed}`], connect: testConnect, resolve: testResolve, log: (l) => lines.push(l) });
    try {
      // Plain HTTP in absolute form, as fetch sends it to an HTTP proxy.
      expect(await (await fetch(`http://api.test:${listed}/`, { proxy: proxy.env.HTTPS_PROXY! })).text()).toBe("listed");
      // Unlisted host, unlisted port, and the listed host's raw address: 403 at the proxy.
      for (const url of [`http://other.test:${other}/`, `http://api.test:${other}/`, `http://api.test:${listed}/`.replace("api.test", "other.test")]) {
        expect((await fetch(url, { proxy: proxy.env.HTTPS_PROXY! })).status).toBe(403);
      }
      // A CONNECT tunnel to the listed host.
      const tunnel = await new Promise<string>((resolve) => {
        let buf = "";
        void Bun.connect({
          hostname: "127.0.0.1", port: proxy.port,
          socket: {
            open: (s) => void s.write(`CONNECT api.test:${listed} HTTP/1.1\r\nHost: api.test\r\n${authOf(proxy)}\r\n`),
            data: (s, d) => {
              buf += d.toString();
              if (buf.includes("200 Connection Established\r\n\r\n") && !buf.includes("GET-SENT")) {
                buf += "GET-SENT";
                s.write(`GET / HTTP/1.1\r\nHost: api.test\r\nConnection: close\r\n\r\n`);
              }
              if (buf.includes("listed")) resolve(buf);
            },
            close: () => resolve(buf),
          },
        });
      });
      expect(tunnel).toContain("200 Connection Established");
      // A raw address, even the listed host's, is refused unless the list names it.
      const raw = await new Promise<string>((resolve) => {
        let buf = "";
        void Bun.connect({ hostname: "127.0.0.1", port: proxy.port, socket: { open: (s) => void s.write(`CONNECT 127.0.0.1:${listed} HTTP/1.1\r\n${authOf(proxy)}\r\n`), data: (_s, d) => void (buf += d.toString()), close: () => resolve(buf) } });
      });
      expect(raw).toStartWith("HTTP/1.1 403");
      expect(tunnel).toContain("listed");
      expect(lines.some((l) => l.includes(`other.test:${other}`))).toBe(true);
    } finally {
      proxy.close();
    }
  });

  // #371's review, 3: a proxy's token. A plugin granted localhost can't use another plugin's proxy by its port.
  test("a proxy takes only requests that carry its own token: none, a wrong one or another proxy's is 407", async () => {
    const listed = upstream("listed");
    const lines: string[] = [];
    const proxy = startPluginProxy({ pluginId: "spy", capabilities: () => [`network:api.test:${listed}`], connect: testConnect, resolve: testResolve, log: (l) => lines.push(l) });
    const other = startPluginProxy({ pluginId: "other", capabilities: () => [`network:api.test:${listed}`], connect: testConnect, resolve: testResolve });
    try {
      const token = new URL(proxy.env.HTTPS_PROXY!).password;
      expect(token).toMatch(/^[0-9a-f]{48}$/);
      expect(new URL(other.env.HTTPS_PROXY!).password).not.toBe(token);
      const bare = `http://127.0.0.1:${proxy.port}`;
      const wrong = `http://clover:${"0".repeat(48)}@127.0.0.1:${proxy.port}`;
      const borrowed = `http://clover:${new URL(other.env.HTTPS_PROXY!).password}@127.0.0.1:${proxy.port}`;
      for (const via of [bare, wrong, borrowed]) expect([via, (await fetch(`http://api.test:${listed}/`, { proxy: via })).status]).toEqual([via, 407]);
      expect(await raw(proxy.port, `CONNECT api.test:${listed} HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 407");
      expect(lines.filter((l) => l.includes("without this proxy's token")).length).toBe(4);
      // The token is never logged.
      expect(lines.some((l) => l.includes(token))).toBe(false);
      expect(await (await fetch(`http://api.test:${listed}/`, { proxy: proxy.env.HTTPS_PROXY! })).text()).toBe("listed");
    } finally {
      proxy.close();
      other.close();
    }
  });

  // #371's review, 2: limits.
  test("limits: a slow head, a slow resolve, an idle tunnel and too many connections are each closed", async () => {
    const listed = upstream("listed");
    const lines: string[] = [];
    const slow = (host: string) => (host === "slow.test" ? new Promise<string[]>(() => {}) : testResolve(host));
    const proxy = startPluginProxy({
      pluginId: "spy", capabilities: () => [`network:api.test:${listed}`, `network:slow.test:${listed}`], connect: testConnect, resolve: slow, log: (l) => lines.push(l),
      limits: { maxPerProxy: 3, headMs: 100, connectMs: 150, idleMs: 200 },
    });
    try {
      // A head that never comes: 408.
      expect(await raw(proxy.port, undefined)).toStartWith("HTTP/1.1 408");
      // A resolve that never answers: 504.
      expect(await raw(proxy.port, `CONNECT slow.test:${listed} HTTP/1.1\r\n${authOf(proxy)}\r\n`)).toStartWith("HTTP/1.1 504");
      // An idle tunnel: closed after the idle time.
      const t0 = Date.now();
      const idle = await raw(proxy.port, `CONNECT api.test:${listed} HTTP/1.1\r\n${authOf(proxy)}\r\n`);
      expect(idle).toStartWith("HTTP/1.1 200 Connection Established");
      expect(idle).not.toContain("[still open]");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
      expect(lines.some((l) => l.includes("idle"))).toBe(true);
      // Connections that never show the token don't count toward this proxy's cap (#377's review): three of them, and an
      // authenticated tunnel still opens.
      const connect = `CONNECT api.test:${listed} HTTP/1.1\r\n${authOf(proxy)}\r\n`;
      const strangers = [0, 1, 2].map(() => raw(proxy.port, undefined, 2_000));
      await Bun.sleep(30);
      const tunnels = [0, 1, 2].map(() => raw(proxy.port, connect, 2_000));
      await Bun.sleep(50);
      // Three authenticated tunnels fill it; a fourth is 503.
      expect(await raw(proxy.port, connect)).toStartWith("HTTP/1.1 503");
      for (const t of await Promise.all(tunnels)) expect(t).toStartWith("HTTP/1.1 200 Connection Established");
      await Promise.all(strangers);
    } finally {
      proxy.close();
    }
  });

  // #371's review, 1: an upstream is never left open for a client that's gone.
  test("a client that leaves while its host resolves or connects leaves no upstream connection open", async () => {
    let upstreamOpen = 0;
    let upstreamSeen = 0;
    const counted = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: () => void (upstreamOpen++, upstreamSeen++), close: () => void upstreamOpen--, data: () => {} } });
    servers.push(counted);
    const port = counted.port;
    let release: () => void = () => {};
    const resolve = () => new Promise<string[]>((r) => (release = () => r([PUBLIC_STAND_IN])));
    let connected: () => void = () => {};
    const slowConnect = ((o: Parameters<typeof Bun.connect>[0]) => new Promise((r) => (connected = () => r(testConnect(o))))) as unknown as typeof Bun.connect;
    for (const phase of ["resolve", "connect"] as const) {
      const proxy = startPluginProxy({ pluginId: "spy", capabilities: () => [`network:api.test:${port}`], connect: phase === "connect" ? slowConnect : testConnect, resolve: phase === "resolve" ? resolve : testResolve });
      try {
        const client = await Bun.connect({ hostname: "127.0.0.1", port: proxy.port, socket: { data: () => {} } });
        client.write(`CONNECT api.test:${port} HTTP/1.1\r\n${authOf(proxy)}\r\n`);
        await Bun.sleep(30);
        client.end();
        await Bun.sleep(30);
        if (phase === "resolve") release();
        else connected();
        for (let i = 0; i < 50 && upstreamOpen > 0; i++) await Bun.sleep(10);
        await Bun.sleep(30);
        expect([phase, upstreamOpen]).toEqual([phase, 0]);
      } finally {
        proxy.close();
      }
    }
    // Gone before the resolve answered: never connected at all; gone while it connected: connected, then closed.
    expect(upstreamSeen).toBe(1);
  });

  // #371's review, 2: what's held for a slow side is bounded; the sender is paused instead.
  test("a tunnel carries a large body intact through a small buffer (backpressure, not an unbounded hold)", async () => {
    let received = 0;
    const sink = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: (_s, d) => void (received += d.length) } });
    servers.push(sink);
    const proxy = startPluginProxy({ pluginId: "spy", capabilities: () => [`network:api.test:${sink.port}`], connect: testConnect, resolve: testResolve, limits: { bufferBytes: 64 * 1024 } });
    try {
      const total = 8 * 1024 * 1024;
      let established = false;
      const client = await Bun.connect({ hostname: "127.0.0.1", port: proxy.port, socket: { data: (_s, d) => void (established ||= d.toString().includes("200 Connection Established")) } });
      client.write(`CONNECT api.test:${sink.port} HTTP/1.1\r\n${authOf(proxy)}\r\n`);
      for (let i = 0; i < 100 && !established; i++) await Bun.sleep(10);
      expect(established).toBe(true);
      const chunk = Buffer.alloc(256 * 1024, 7);
      let sent = 0;
      while (sent < total) {
        let rest: Buffer = chunk;
        while (rest.length > 0) {
          const n = client.write(rest);
          sent += n;
          rest = rest.subarray(n);
          if (rest.length > 0) await Bun.sleep(2);
        }
      }
      for (let i = 0; i < 500 && received < total; i++) await Bun.sleep(10);
      expect(received).toBe(total);
      client.end();
    } finally {
      proxy.close();
    }
  });

  // 2g's self-probe: a plugin controls its own DNS, so a listed name could point at this computer or the LAN.
  test("a listed name that resolves to a private address is refused, unless the name says it's local; the connection goes to the address checked", async () => {
    const listed = upstream("listed");
    const lines: string[] = [];
    const seen: string[] = [];
    const connect = ((o: Parameters<typeof Bun.connect>[0]) => (seen.push((o as unknown as { hostname: string }).hostname), testConnect(o))) as typeof Bun.connect;
    const caps = [`network:rebind.test:${listed}`, `network:api.test:${listed}`, `network:printer.local:${listed}`];
    const proxy = startPluginProxy({ pluginId: "spy", capabilities: () => caps, connect, resolve: testResolve, log: (l) => lines.push(l) });
    try {
      const via = { proxy: proxy.env.HTTPS_PROXY! };
      expect((await fetch(`http://rebind.test:${listed}/`, via)).status).toBe(403);
      expect(lines.some((l) => l.includes("rebind.test, which resolves to 127.0.0.1, a private address"))).toBe(true);
      expect(await (await fetch(`http://api.test:${listed}/`, via)).text()).toBe("listed");
      expect(await (await fetch(`http://printer.local:${listed}/`, via)).text()).toBe("listed");
      // Never the name again (no second lookup to rebind): the address the check passed.
      expect(seen).toEqual([PUBLIC_STAND_IN, "127.0.0.1"]);
    } finally {
      proxy.close();
    }
  });
});

describe("net.fetch's gate", () => {
  test("a served net.fetch reaches only the hosts the plugin's OK granted, on the URL's port or its scheme's", async () => {
    const home = temp("cf-netgate-");
    const root = join(home, "plugins", "spy");
    mkdirSync(join(root, "host"), { recursive: true });
    writeFileSync(join(root, "clover.json"), JSON.stringify({
      manifest: 1, id: "spy", name: "Spy", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
      host: { entry: "host/index.js" }, capabilities: ["network:api.example.com", "network:*.cdn.example.com", "network:files.example.com:8443"],
    }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "host", "index.js"), "export const get = async (args, ctx) => { try { return await (await ctx.api.net.fetch(args.url)).text(); } catch (e) { return `refused: ${e.message}`; } };\n");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, fence: false });
    // `net.fetch` answers a Response (it crosses the plugin host as its own messages since #428: fetch-wire.ts).
    const off = ph.addApiHandlers({ "net.fetch": (_ctx, args) => new Response(`fetched ${String(args[0])}`) });
    try {
      const { card } = await opened.registry.installed("spy", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await approved(opened.registry, "spy");
      const get = (url: string) => ph.host.invoke({ pluginId: "spy", handler: "get", args: { url }, caller: USER });
      expect(await get("https://api.example.com/v1")).toBe("fetched https://api.example.com/v1");
      expect(await get("http://api.example.com/")).toBe("fetched http://api.example.com/");
      expect(await get("https://img.cdn.example.com/a.png")).toBe("fetched https://img.cdn.example.com/a.png");
      expect(await get("https://files.example.com:8443/x")).toBe("fetched https://files.example.com:8443/x");
      for (const url of ["https://other.example.com/", "https://api.example.com:8443/", "https://cdn.example.com/", "https://files.example.com/", "https://93.184.216.34/", "file:///etc/passwd", "not a url"]) {
        expect(String(await get(url))).toStartWith("refused:");
      }
      expect(String(await get("https://other.example.com/"))).toContain("network:other.example.com");
    } finally {
      off();
      await ph.close();
      opened.close();
    }
  }, 60_000);
});

describe.skipIf(process.platform !== "darwin")("a fenced plugin's network", () => {
  test("its process reaches its listed host only through its proxy: a direct socket is refused, an unlisted host is refused at the proxy; its hooks too", async () => {
    const listed = upstream("hello from the listed host");
    const other = upstream("unlisted");
    const home = temp("cf-net-");
    const root = join(home, "plugins", "spy");
    mkdirSync(join(root, "host"), { recursive: true });
    writeFileSync(join(root, "clover.json"), JSON.stringify({
      manifest: 1, id: "spy", name: "Spy", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
      host: { entry: "host/index.js" }, capabilities: [`network:api.test:${listed}`],
    }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    const probe = `
const out = {};
try { out.proxied = await (await fetch("http://api.test:${listed}/")).text(); } catch (e) { out.proxied = e.message; }
try { out.unlisted = (await fetch("http://other.test:${other}/")).status; } catch (e) { out.unlisted = e.message; }
out.direct = await new Promise((resolve) => {
  Bun.connect({ hostname: "127.0.0.1", port: ${listed}, socket: { open: (s) => { s.end(); resolve("connected"); }, data() {}, error: (_s, e) => resolve(e.code ?? e.message), connectError: (_s, e) => resolve(e.code ?? e.message) } })
    .catch((e) => resolve(e.code ?? e.message));
});
`;
    writeFileSync(join(root, "host", "index.js"), `export const probe = async () => {${probe}\nreturn out; };\n`);
    writeFileSync(join(root, "probe.mjs"), `${probe}\nconsole.log(JSON.stringify(out));\n`);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, userHome: temp("cf-net-user-"), netConnect: testConnect, netResolve: testResolve });
    try {
      const { card } = await opened.registry.installed("spy", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await approved(opened.registry, "spy");
      const expected = { proxied: "hello from the listed host", unlisted: 403, direct: expect.not.stringMatching(/^connected$/) };
      const got = await ph.host.invoke({ pluginId: "spy", handler: "probe", args: null, caller: USER });
      expect(got).toMatchObject(expected);
      // A hook of the same plugin: the same proxy, the same deny.
      const guard = { files: ensurePluginRunFiles(join(home, "run", "plugin-host"), { cloverHome: home }), shared: [], proxyFor: ph.proxyFor };
      const hook = await new HookRunner(guard).run({ pluginId: "spy", command: "bun probe.mjs", cwd: root, timeoutMs: 30_000 }, { sessionId: "s_1", event: "SessionStart" } as never);
      expect(JSON.parse(String((hook as { stdout: string }).stdout).trim().split("\n").at(-1)!)).toMatchObject(expected);
    } finally {
      await ph.close();
      opened.close();
    }
  }, 60_000);
});
