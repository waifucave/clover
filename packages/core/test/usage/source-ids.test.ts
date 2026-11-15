// F3 review items: a source id belongs to the plugin that holds it (a folder plugin cannot take `codex` over and replace
// the rows stored there), and a source's `more: true` cannot keep every Usage request running every source.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { MORE_PASSES_MAX, UsageService } from "../../src/usage/service";
import type { UsageSourceEntry, UsageSourcePort } from "../../src/usage/sources";
import { tempDir } from "./fixtures";

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const rec = (dedupe: string, input: number, at = NOW - 3_600_000) => ({ dedupe, at, provider: "openai", model: "gpt-5.1", input, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
const entry = (pluginId: string, id: string, bundled = false): UsageSourceEntry => ({ pluginId, id, name: id, handler: "source", provides: ["usage"], ...(bundled ? { bundled: true } : {}) });

function setup(entries: () => UsageSourceEntry[], replies: Record<string, (args: any) => unknown>, over: { ingestEveryMs?: number } = {}) {
  const db = new UsageDb(join(tempDir("ids"), "usage", "usage.db"));
  const called: string[] = [];
  const logs: string[] = [];
  const port: UsageSourcePort = {
    entries,
    call: async (e, _m, args) => { called.push(e.pluginId); return replies[e.pluginId]!(args); },
  };
  const svc = new UsageService({ db, pricer: new UsagePricer(), tracking: () => ({}), sources: port, now: () => NOW, ingestEveryMs: over.ingestEveryMs ?? 0, log: { warn: (m) => logs.push(m), info: (m) => logs.push(m) } });
  return { db, svc, called, logs };
}
const codexRows = (db: UsageDb) => (db.db.query("SELECT dedupe, input FROM usage_records WHERE source = 'codex' ORDER BY dedupe").all() as Array<{ dedupe: string; input: number }>);

describe("a source id belongs to the plugin that holds it", () => {
  const bundled = { records: [rec("codex:real:1", 100), rec("codex:real:2", 200)] };
  // What a hostile folder plugin would send: a row of its own, and a span that wipes the day the real rows are in.
  const hostile = { records: [rec("evil:1", 5)], replace: [{ from: NOW - 86_400_000, to: NOW, records: [] }] };

  test("a folder plugin declaring `codex`, listed first, is refused: never called, the bundled rows untouched", async () => {
    const { db, svc, called, logs } = setup(() => [entry("evil", "codex"), entry("usage-codex", "codex", true)], { evil: () => hostile, "usage-codex": () => bundled });
    await svc.ingest(true);
    expect(called).toEqual(["usage-codex"]);
    expect(codexRows(db).map((r) => r.dedupe)).toEqual(["codex:real:1", "codex:real:2"]);
    expect(logs.some((l) => l.includes("evil") && l.includes("refused") && l.includes("usage-codex"))).toBe(true);
  });

  test("it holds across a restart and while the bundled plugin is off: the same folder plugin alone is still refused", async () => {
    let list = [entry("usage-codex", "codex", true)];
    const first = setup(() => list, { evil: () => hostile, "usage-codex": () => bundled });
    await first.svc.ingest(true);
    expect(codexRows(first.db)).toHaveLength(2);
    // A new service on the same database, the bundled plugin off, the folder plugin naming `codex`.
    list = [entry("evil", "codex")];
    const again = new UsageService({ db: first.db, pricer: new UsagePricer(), tracking: () => ({}), now: () => NOW, ingestEveryMs: 0,
      sources: { entries: () => list, call: async () => hostile } });
    await again.ingest(true);
    expect(codexRows(first.db)).toHaveLength(2);
    expect(again.planSources()).toEqual([]);
  });

  test("among installed plugins the first to hold an id keeps it", async () => {
    const { svc, called } = setup(() => [entry("acme-a", "acme"), entry("acme-b", "acme")], { "acme-a": () => ({ records: [rec("a:1", 1)] }), "acme-b": () => ({ records: [rec("b:1", 1)] }) });
    await svc.ingest(true);
    expect(called).toEqual(["acme-a"]);
  });

  test("a bundled entry takes an id an installed plugin held before it came", async () => {
    let list = [entry("acme-a", "codex")];
    const { svc, called, db } = setup(() => list, { "acme-a": () => ({ records: [rec("a:1", 1)] }), "usage-codex": () => bundled });
    await svc.ingest(true);
    list = [entry("acme-a", "codex"), entry("usage-codex", "codex", true)];
    await svc.ingest(true);
    expect(called).toEqual(["acme-a", "usage-codex"]);
    expect(db.db.query("SELECT COUNT(*) n FROM usage_records WHERE source = 'codex'").get()).toBeTruthy();
  });
});

describe("`more: true` is bounded", () => {
  test("only a pass that brought records is asked again at once, and at most MORE_PASSES_MAX in a row; then the throttle holds", async () => {
    let n = 0;
    const { svc, called } = setup(() => [entry("usage-codex", "codex", true)], { "usage-codex": () => ({ records: [rec(`codex:${++n}`, 1)], more: true }) }, { ingestEveryMs: 20_000 });
    await svc.catchUp();
    expect(called).toHaveLength(MORE_PASSES_MAX);
    // The next page request is inside the throttle: nothing runs.
    await svc.ingest();
    expect(called).toHaveLength(MORE_PASSES_MAX);
  });

  test("a source that always answers `more` with nothing new is run once, not again and again", async () => {
    const { svc, called } = setup(() => [entry("usage-codex", "codex", true)], { "usage-codex": () => ({ more: true }) }, { ingestEveryMs: 20_000 });
    await svc.catchUp();
    expect(called).toHaveLength(1);
    await svc.ingest();
    await svc.ingest();
    expect(called).toHaveLength(1);
  });
});
