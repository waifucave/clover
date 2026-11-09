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
import { hostAllowed, hostRules, startPluginProxy } from "../net-proxy";

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

/** A local stand-in for a host on the internet. */
function upstream(text: string): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(text) });
  servers.push(s);
  return s.port!;
}
/** The proxies' upstream: `<name>.test` is this computer, as a resolver would make it; any other name fails. */
const testConnect = ((o: Parameters<typeof Bun.connect>[0]) => {
  const name = (o as unknown as { hostname: string }).hostname;
  if (!name.endsWith(".test") && name !== "127.0.0.1") return Promise.reject(new Error(`no such host ${name}`));
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
    const proxy = startPluginProxy({ pluginId: "spy", capabilities: () => [`network:api.test:${listed}`], connect: testConnect, log: (l) => lines.push(l) });
    try {
      // Plain HTTP in absolute form, as fetch sends it to an HTTP proxy.
      expect(await (await fetch(`http://api.test:${listed}/`, { proxy: `http://127.0.0.1:${proxy.port}` })).text()).toBe("listed");
      // Unlisted host, unlisted port, and the listed host's raw address: 403 at the proxy.
      for (const url of [`http://other.test:${other}/`, `http://api.test:${other}/`, `http://api.test:${listed}/`.replace("api.test", "other.test")]) {
        expect((await fetch(url, { proxy: `http://127.0.0.1:${proxy.port}` })).status).toBe(403);
      }
      // A CONNECT tunnel to the listed host.
      const tunnel = await new Promise<string>((resolve) => {
        let buf = "";
        void Bun.connect({
          hostname: "127.0.0.1", port: proxy.port,
          socket: {
            open: (s) => void s.write(`CONNECT api.test:${listed} HTTP/1.1\r\nHost: api.test\r\n\r\n`),
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
        void Bun.connect({ hostname: "127.0.0.1", port: proxy.port, socket: { open: (s) => void s.write(`CONNECT 127.0.0.1:${listed} HTTP/1.1\r\n\r\n`), data: (_s, d) => void (buf += d.toString()), close: () => resolve(buf) } });
      });
      expect(raw).toStartWith("HTTP/1.1 403");
      expect(tunnel).toContain("listed");
      expect(lines.some((l) => l.includes(`other.test:${other}`))).toBe(true);
    } finally {
      proxy.close();
    }
  });
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
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, userHome: temp("cf-net-user-"), netConnect: testConnect });
    try {
      const { card } = await opened.registry.installed("spy", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await Bun.sleep(5);
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
