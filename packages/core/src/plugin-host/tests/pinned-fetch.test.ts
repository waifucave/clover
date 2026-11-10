// The keyed fetch's platform fetch (pinned-fetch.ts, from lane B's parked #377): a name resolved once and connected to
// by the address checked; only public addresses; never an environment proxy; the test seam the only way to loopback.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinnedFetchRefused, pinnedFetch } from "../pinned-fetch";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A CA and a server certificate for `name` (and only it), made with openssl in a temp folder. */
function certificates(name: string): { ca: string; cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "clover-pinned-tls-"));
  temps.push(dir);
  const run = (...args: string[]) => {
    const r = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr}`);
  };
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=clover-test-ca");
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", `/CN=${name}`);
  writeFileSync(join(dir, "ext.cnf"), `subjectAltName=DNS:${name}\n`);
  run("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "2", "-extfile", "ext.cnf");
  return { ca: readFileSync(join(dir, "ca.pem"), "utf8"), cert: readFileSync(join(dir, "server.pem"), "utf8"), key: readFileSync(join(dir, "server.key"), "utf8") };
}

function harness(addresses: Record<string, string[]>) {
  const resolved: string[] = [];
  const sent: { url: string; init: RequestInit & { proxy?: unknown; tls?: { serverName?: string } } }[] = [];
  return {
    resolved,
    sent,
    resolve: async (host: string) => {
      resolved.push(host);
      return addresses[host] ?? [];
    },
    fetch: async (url: string, init: RequestInit) => {
      sent.push({ url, init: init as never });
      return new Response("ok");
    },
  };
}

describe("pinnedFetch", () => {
  test("a public name: resolved once, connected to by that address, its name as Host and the TLS server name, no proxy", async () => {
    const h = harness({ "api.example.com": ["93.184.216.34", "2606:2800:220:1::1"] });
    const f = pinnedFetch({ resolve: h.resolve, fetch: h.fetch });
    await f("https://api.example.com:8443/v1/x?q=1", { method: "POST", headers: { "x-a": "1" } });
    expect(h.resolved).toEqual(["api.example.com"]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.url).toBe("https://93.184.216.34:8443/v1/x?q=1");
    const headers = new Headers(h.sent[0]!.init.headers);
    expect(headers.get("host")).toBe("api.example.com:8443");
    expect(headers.get("x-a")).toBe("1");
    expect(h.sent[0]!.init.proxy).toBe(false);
    expect(h.sent[0]!.init.tls?.serverName).toBe("api.example.com");
    expect(h.sent[0]!.init.method).toBe("POST");
  });

  test("an IPv6 address is bracketed in the pinned URL", async () => {
    const h = harness({ "v6.example.com": ["2606:2800:220:1::1"] });
    await pinnedFetch({ resolve: h.resolve, fetch: h.fetch })("https://v6.example.com/", {});
    expect(h.sent[0]!.url).toBe("https://[2606:2800:220:1::1]/");
  });

  test("a name resolving to any loopback, private, link-local or unique-local address is refused, nothing sent", async () => {
    for (const bad of ["127.0.0.1", "10.0.0.5", "192.168.1.2", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "0.0.0.0"]) {
      const h = harness({ "evil.example.com": ["93.184.216.34", bad] });
      const err = await pinnedFetch({ resolve: h.resolve, fetch: h.fetch })("https://evil.example.com/", {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PinnedFetchRefused);
      expect((err as Error).message).toContain(bad);
      expect(h.sent).toEqual([]);
    }
  });

  test("no exception for a name that says it is local, nor for a raw private address; a raw public one goes unproxied", async () => {
    const h = harness({ localhost: ["127.0.0.1"], "printer.local": ["192.168.1.9"] });
    const f = pinnedFetch({ resolve: h.resolve, fetch: h.fetch });
    for (const url of ["http://localhost:8080/", "http://printer.local/", "http://127.0.0.1:9/", "http://[::1]:9/", "https://10.1.2.3/"]) {
      expect(await f(url, {}).catch((e: unknown) => e)).toBeInstanceOf(PinnedFetchRefused);
    }
    expect(h.sent).toEqual([]);
    await f("https://93.184.216.34/x", {});
    expect(h.sent.map((s) => [s.url, s.init.proxy])).toEqual([["https://93.184.216.34/x", false]]);
  });

  test("a name with no address is refused", async () => {
    const h = harness({});
    expect(await pinnedFetch({ resolve: h.resolve, fetch: h.fetch })("https://nothing.example.com/", {}).catch((e: unknown) => e)).toBeInstanceOf(PinnedFetchRefused);
  });

  test("the test seam reaches exactly what it names: a loopback backend, nothing else private", async () => {
    const h = harness({ "backend.test": ["127.0.0.1"], "lan.test": ["192.168.1.2"] });
    const f = pinnedFetch({ resolve: h.resolve, fetch: h.fetch, reach: (_host, address) => address === "127.0.0.1" });
    await f("http://backend.test:4000/", {});
    await f("http://127.0.0.1:4000/", {});
    expect(await f("http://lan.test/", {}).catch((e: unknown) => e)).toBeInstanceOf(PinnedFetchRefused);
    expect(h.sent.map((s) => s.url)).toEqual(["http://127.0.0.1:4000/", "http://127.0.0.1:4000/"]);
  });

  test("a real request to a loopback server is refused without the seam, and reaches it with it", async () => {
    let hits = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return new Response("here"); } });
    try {
      const url = `http://127.0.0.1:${server.port}/`;
      expect(await pinnedFetch()(url, {}).catch((e: unknown) => e)).toBeInstanceOf(PinnedFetchRefused);
      expect(hits).toBe(0);
      const r = await pinnedFetch({ reach: (_h, a) => a === "127.0.0.1" })(url, {});
      expect(await r.text()).toBe("here");
      expect(hits).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("over real TLS: connected by the pinned address, the certificate checked against the NAME, and the name as Host", async () => {
    const tls = certificates("pinned.test");
    let host: string | null = null;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: tls.cert, key: tls.key }, fetch: (req) => { host = req.headers.get("host"); return new Response("secure"); } });
    try {
      const seam = {
        resolve: async (name: string) => (name === "pinned.test" || name === "other.test" ? ["127.0.0.1"] : []),
        reach: (_h: string, a: string) => a === "127.0.0.1",
        // The test's CA, added to what the pinned fetch sends (its URL, Host and TLS server name untouched).
        fetch: (url: string, init: RequestInit) => fetch(url, { ...init, tls: { ...(init as { tls?: object }).tls, ca: tls.ca } } as RequestInit),
      };
      const r = await pinnedFetch(seam)(`https://pinned.test:${server.port}/x`, {});
      expect(await r.text()).toBe("secure");
      expect(host).toBe(`pinned.test:${server.port}`);
      // The same server under another name: the certificate doesn't name it, so the request fails.
      expect(await pinnedFetch(seam)(`https://other.test:${server.port}/x`, {}).then(() => "sent", () => "refused")).toBe("refused");
    } finally {
      server.stop(true);
    }
  });

  test("an address that can't be connected to: the next checked one is tried; a streamed body gets the first only", async () => {
    const tried: string[] = [];
    const seam = {
      resolve: async () => ["2606:2800:220:1::1", "93.184.216.34"],
      fetch: async (url: string) => {
        tried.push(url);
        if (url.includes("[")) throw Object.assign(new Error("unreachable"), { code: "ENETUNREACH" });
        return new Response("v4");
      },
    };
    expect(await (await pinnedFetch(seam)("https://dual.example.com/", {})).text()).toBe("v4");
    expect(tried).toEqual(["https://[2606:2800:220:1::1]/", "https://93.184.216.34/"]);
    tried.length = 0;
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
    expect(await pinnedFetch(seam)("https://dual.example.com/", { method: "POST", body }).then(() => "sent", () => "failed")).toBe("failed");
    expect(tried).toEqual(["https://[2606:2800:220:1::1]/"]);
  });
});
