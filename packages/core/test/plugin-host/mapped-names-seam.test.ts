// The test build's outside world for the acceptance run (`mappedNamesSeam`, read only in a test-marked branch of the
// daemon): the names it maps reach the run's loopback server; everything else keeps the pinned fetch's rules.
import { afterAll, expect, test } from "bun:test";
import { mappedNamesSeam, pinnedFetch, PinnedFetchRefused } from "../../src/plugin-host/pinned-fetch";

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Response(`host=${req.headers.get("host")} path=${new URL(req.url).pathname}`) });
afterAll(() => server.stop(true));

test("a mapped name reaches the run's loopback server over http, with its name in the Host header", async () => {
  const f = pinnedFetch(mappedNamesSeam(`news.acceptance-site.com=127.0.0.1:${server.port};intranet.acceptance-site.com=10.0.0.5`));
  const r = await f("https://news.acceptance-site.com/article", {});
  expect(await r.text()).toBe("host=news.acceptance-site.com path=/article");
});

test("everything else keeps the rules: a name mapped to a private address, a LAN address, loopback itself", async () => {
  const f = pinnedFetch(mappedNamesSeam(`news.acceptance-site.com=127.0.0.1:${server.port};intranet.acceptance-site.com=10.0.0.5`));
  await expect(f("https://intranet.acceptance-site.com/x", {})).rejects.toBeInstanceOf(PinnedFetchRefused);
  await expect(f("http://192.168.1.10/", {})).rejects.toBeInstanceOf(PinnedFetchRefused);
  await expect(f(`http://127.0.0.1:${server.port}/`, {})).rejects.toBeInstanceOf(PinnedFetchRefused);
  // An unmapped name is resolved by the system as always: "localhost" is loopback, refused.
  await expect(f(`http://localhost:${server.port}/`, {})).rejects.toBeInstanceOf(PinnedFetchRefused);
});

test("no entry, or none that parses, is no seam; a loopback mapping needs a port, and other loopback addresses aren't taken", () => {
  expect(mappedNamesSeam(undefined)).toBeUndefined();
  expect(mappedNamesSeam("")).toBeUndefined();
  expect(mappedNamesSeam("nonsense")).toBeUndefined();
  expect(mappedNamesSeam("a.example=127.0.0.1")).toBeUndefined();
  const s = mappedNamesSeam("a.example=127.0.0.1:8080")!;
  expect(s.reach!("a.example", "127.0.0.1")).toBe(true);
  expect(s.reach!("b.example", "127.0.0.1")).toBe(false);
  expect(s.reach!("a.example", "10.0.0.5")).toBe(false);
});
