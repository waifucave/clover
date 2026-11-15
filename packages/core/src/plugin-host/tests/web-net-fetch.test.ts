// The bundled web plugin's WebSearch and WebFetch over a REAL plugin-host link: its own host code in a plugin-host
// process (`spawnHostProcess`), B's gate as the daemon builds it, the daemon's keyed fetch with the pinned fetch, and
// the acceptance run's fake search backend behind the pinned fetch's test seam (scripts/acceptance/fake-exa.ts), so
// nothing leaves the machine. Its MCP server lists both tools and each one's call reaches the backend and answers.
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostProcess } from "@waifucave/clover-protocol";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import { SystemClock } from "../../clock/system-clock";
import { FakePluginRegistry } from "../../contracts/fakes/plugin-registry";
import { guardApiRouter } from "../../contracts/plugin-host";
import { modelPluginApiHandlers } from "../../runtime-sdk/model-plugins/plugin-api";
import { createApiRouter } from "../api/router";
import { CorePluginHost, type HostedRecord } from "../core-host";
import { HOST_PROCESS_ENTRY, spawnHostProcess } from "../launch";
import type { RpcPeer } from "../link";
import { pinnedFetch } from "../pinned-fetch";
import { FAKE_ARTICLE_TEXT, FAKE_PAGE_TEXT, FAKE_PRIVATE_SITE, FAKE_PUBLIC_SITE, FAKE_SEARCH_HIT, fakeExa, searchOnlySeam } from "../../../../../scripts/acceptance/fake-exa";
import { pluginNetworkAllowed } from "../daemon-host";

const processes: { kill(): void }[] = [];
afterAll(() => { for (const p of processes) p.kill(); });

test("WebSearch and WebFetch over a real plugin-host link reach the fake search backend and answer; nothing else is reached", async () => {
  const folder = join(import.meta.dir, "../../../../../plugins/clover/plugins/web");
  const manifest = JSON.parse(readFileSync(join(folder, "clover.json"), "utf8"));
  const registry = new FakePluginRegistry({
    catalog: catalogPointDecl,
    plugins: [
      { id: "clover", manifest: { manifest: 1, id: "clover", name: "Clover" } as never, source: "bundled" },
      { id: "clover/web", manifest, source: "bundled" },
    ],
  });
  const exa = fakeExa();
  const refused: string[] = [];
  const handlers = modelPluginApiHandlers({
    registry,
    tokens: () => ({ current: async () => null, newer: async () => null }),
    secret: async () => undefined,
    fetch: pinnedFetch(searchOnlySeam(exa, (h) => void refused.push(h))),
  });
  const router = guardApiRouter(createApiRouter({ registry, handlers: [handlers, { "settings.get": async () => "" }], allowNetwork: pluginNetworkAllowed }), (id) => {
    const r = registry.get(id);
    return r === undefined ? undefined : { id: r.id, source: r.source };
  });
  const records = new Map<string, HostedRecord>([["clover/web", { id: "clover/web", source: "bundled", folder, entry: "host/index.ts", runtime: "bun", dataFolder: join(folder, ".test-data") } as HostedRecord]]);
  const links = new Map<string, RpcPeer>();
  const logs: string[] = [];
  const host = new CorePluginHost({
    clock: new SystemClock(), computer: "Studio", record: (id) => records.get(id),
    connect: (p: HostProcess) => {
      let peer = links.get(p);
      if (peer === undefined || peer.closed) {
        const sp = spawnHostProcess({ cmd: [globalThis.process.execPath, HOST_PROCESS_ENTRY], env: { ...(globalThis.process.env as Record<string, string>), CLOVER_COMPUTER: "Studio" } });
        processes.push(sp);
        links.set(p, (peer = sp.peer));
      }
      return peer;
    },
    log: (_id, lines) => void logs.push(...lines),
  });
  host.serveApi(router);

  const ch = await host.openMcp("clover/web", "web");
  const answers = new Map<unknown, Record<string, unknown>>();
  const waiters = new Map<unknown, (m: Record<string, unknown>) => void>();
  ch.onMessage((m) => {
    answers.set(m.id, m);
    waiters.get(m.id)?.(m);
  });
  const ask = (id: number, method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiters.set(id, resolve);
      ch.send({ jsonrpc: "2.0", id, method, params });
    });
  await ask(1, "initialize", { protocolVersion: "2025-06-18" });
  const listed = (await ask(2, "tools/list")).result as { tools: { name: string }[] };
  expect(listed.tools.map((t) => t.name).sort()).toEqual(["WebFetch", "WebSearch"]);

  const search = (await ask(3, "tools/call", { name: "WebSearch", arguments: { query: "acceptance search" } })).result as { content: { text: string }[]; isError?: boolean };
  expect(search.isError ?? false).toBe(false);
  expect(search.content.map((c) => c.text).join("\n")).toContain(FAKE_SEARCH_HIT);
  expect(exa.calls).toContain("web_search_exa");

  const page = (await ask(4, "tools/call", { name: "WebFetch", arguments: { url: "https://mcp.exa.ai/acceptance-page", prompt: "what does it say" } })).result as { content: { text: string }[]; isError?: boolean };
  expect(page.isError ?? false).toBe(false);
  expect(page.content.map((c) => c.text).join("\n")).toContain(FAKE_PAGE_TEXT);

  // network:public: a public website outside the plugin's list, keyless, through the web safeguards.
  const article = (await ask(5, "tools/call", { name: "WebFetch", arguments: { url: `https://${FAKE_PUBLIC_SITE}/article`, prompt: "x" } })).result as { content: { text: string }[]; isError?: boolean };
  expect(article.isError ?? false).toBe(false);
  expect(article.content.map((c) => c.text).join("\n")).toContain(FAKE_ARTICLE_TEXT);
  // A name that resolves to a private address: refused, saying so, nothing reached.
  const inside = (await ask(6, "tools/call", { name: "WebFetch", arguments: { url: `https://${FAKE_PRIVATE_SITE}/x`, prompt: "x" } })).result as { content: { text: string }[]; isError?: boolean };
  expect(inside.isError).toBe(true);
  expect(inside.content[0]!.text).toContain("private address");
  expect(refused).toEqual([]);
  ch.close();
}, 60_000);
