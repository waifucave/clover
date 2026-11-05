// The Workers emulator: a service's wrangler config, run in Miniflare on 127.0.0.1.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { miniflareOptions, readWranglerConfig, startWorker } from "../src/workers";

const fixture = join(import.meta.dir, "fixtures", "worker");

describe("startWorker", () => {
  test("runs the Worker with its variables and an in-memory KV namespace", async () => {
    const worker = await startWorker({ dir: fixture });
    try {
      expect(worker.url.hostname).toBe("127.0.0.1");
      expect(await (await worker.fetch("/who")).text()).toBe("fixture");
      expect((await worker.fetch("/kv/a")).status).toBe(404);
      expect((await worker.fetch("/kv/a", { method: "PUT", body: "1" })).status).toBe(204);
      expect(await (await worker.fetch("/kv/a")).text()).toBe("1");
    } finally {
      await worker.dispose();
    }
  }, 60_000);

  test("a test's bindings override the config's variables", async () => {
    const worker = await startWorker({ dir: fixture, bindings: { WHO: "override" } });
    try {
      expect(await (await worker.fetch("/who")).text()).toBe("override");
    } finally {
      await worker.dispose();
    }
  }, 60_000);

  test("two Workers at once, each with its own storage", async () => {
    const [a, b] = await Promise.all([startWorker({ dir: fixture }), startWorker({ dir: fixture })]);
    try {
      await a.fetch("/kv/k", { method: "PUT", body: "a" });
      expect((await b.fetch("/kv/k")).status).toBe(404);
    } finally {
      await Promise.all([a.dispose(), b.dispose()]);
    }
  }, 60_000);
});

describe("readWranglerConfig", () => {
  const dirWith = (config: string, file = "wrangler.jsonc"): string => {
    const dir = mkdtempSync(join(tmpdir(), "clover-wrangler-"));
    writeFileSync(join(dir, file), config);
    return dir;
  };

  test("reads JSONC and TOML", () => {
    expect(readWranglerConfig(fixture).name).toBe("harness-fixture");
    const toml = dirWith('name = "t"\nmain = "src/index.ts"\ncompatibility_date = "2026-07-01"\n', "wrangler.toml");
    expect(readWranglerConfig(toml)).toMatchObject({ name: "t", main: "src/index.ts" });
  });

  test("refuses what it would not emulate, by name", () => {
    expect(() => readWranglerConfig(dirWith('{ "main": "a.ts", "compatibility_date": "2026-07-01", "queues": {} }'))).toThrow(/does not support queues/);
    expect(() => readWranglerConfig(dirWith('{ "main": "a.ts" }'))).toThrow(/compatibility_date/);
    expect(() => readWranglerConfig(dirWith('{ "main": "a.ts", "compatibility_date": "2026-07-01", "durable_objects": { "bindings": [{ "name": "X", "class_name": "X", "script_name": "other" }] } }'))).toThrow(/another Worker/);
    expect(() => readWranglerConfig(mkdtempSync(join(tmpdir(), "clover-wrangler-")))).toThrow(/no wrangler/);
  });

  test("maps Durable Objects, with SQLite where a migration says so", () => {
    const options = miniflareOptions({ main: "x", compatibility_date: "2026-07-01", durable_objects: { bindings: [{ name: "A", class_name: "A" }, { name: "B", class_name: "B" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["A"], new_classes: ["B"] }] }, "") as { durableObjects: unknown; host: string };
    expect(options.durableObjects).toEqual({ A: { className: "A", useSQLite: true }, B: { className: "B", useSQLite: false } });
    expect(options.host).toBe("127.0.0.1");
  });
});
