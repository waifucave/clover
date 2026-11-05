// The Worker under the harness's local emulator (miniflare): nothing leaves this machine.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startWorker, type RunningWorker } from "@waifucave/clover-test-harness/workers";

let worker: RunningWorker;
beforeAll(async () => {
  worker = await startWorker({ dir: join(import.meta.dir, "..") });
});
afterAll(async () => {
  await worker?.dispose();
});

describe("services/hello", () => {
  test("greets with its variable", async () => {
    expect(await (await worker.fetch("/")).json()).toEqual({ service: "hello", greeting: "hello" });
  });

  test("echoes a body", async () => {
    const res = await worker.fetch("/echo", { method: "POST", body: "ping", headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ping");
  });

  test("counts in a Durable Object, one count per name", async () => {
    const count = async (name: string) => ((await (await worker.fetch(`/count/${name}`)).json()) as { count: number }).count;
    expect(await count("a")).toBe(1);
    expect(await count("a")).toBe(2);
    expect(await count("b")).toBe(1);
  });

  test("anything else is a 404", async () => {
    expect((await worker.fetch("/nope")).status).toBe(404);
  });
});
