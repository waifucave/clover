// A packaged run's outside world (fake-exa.ts serveOutsideWorld) against the test build's seam in the core's pinned
// fetch (mappedNamesSeam): what the bundled web plugin asks for reaches the fakes by name, and nothing else widens.
import { afterAll, expect, test } from "bun:test";
import { mappedNamesSeam, pinnedFetch, PinnedFetchRefused } from "../../packages/core/src/plugin-host/pinned-fetch";
import { FAKE_ARTICLE_TEXT, FAKE_PRIVATE_SITE, FAKE_PUBLIC_SITE, FAKE_SEARCH_HIT, FAKE_SEARCH_HOST, serveOutsideWorld } from "./fake-exa";

const world = serveOutsideWorld();
afterAll(() => world.stop());
const f = pinnedFetch(mappedNamesSeam(world.spec));

test("the search backend's MCP call and the public site's article reach the fakes, by name over the core's pinned fetch", async () => {
  const init = await f(`https://${FAKE_SEARCH_HOST}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query: "x" } } }) });
  expect(await init.text()).toContain(FAKE_SEARCH_HIT);
  const page = await f(`https://${FAKE_PUBLIC_SITE}/article`, {});
  expect(await page.text()).toContain(FAKE_ARTICLE_TEXT);
  expect(world.refused).toEqual([]);
});

test("the private site's name and a LAN address are refused before any request; the fakes saw nothing", async () => {
  await expect(f(`https://${FAKE_PRIVATE_SITE}/x`, {})).rejects.toBeInstanceOf(PinnedFetchRefused);
  await expect(f("http://192.168.1.10/router", {})).rejects.toBeInstanceOf(PinnedFetchRefused);
  expect(world.refused).toEqual([]);
});
