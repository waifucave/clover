// The page's Worker: its security headers on every answer, and /config.json. Loaded by path, so this test's
// TypeScript program doesn't take in the Worker's own (workers-types) program.

import { describe, expect, test } from "bun:test";

interface PageWorker {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
}

const workerPath = "../src/worker.ts";
const worker = ((await import(workerPath)) as { default: PageWorker }).default;

const assets = { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) };

describe("the page's Worker", () => {
  test("serves pages with a strict CSP naming only the handshake", async () => {
    const env = { ASSETS: assets, HANDSHAKE_ORIGIN: "https://handshake.waifucave.com", ALLOWED_HANDSHAKES: "" };
    const response = await worker.fetch(new Request("https://clover.waifucave.com/"), env);
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' https://handshake.waifucave.com wss://handshake.waifucave.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(await response.text()).toBe("<!doctype html>");
  });

  test("/config.json names the handshake, and local emulators only when configured", async () => {
    const prod = await worker.fetch(new Request("https://clover.waifucave.com/config.json"), { ASSETS: assets, HANDSHAKE_ORIGIN: "https://handshake.waifucave.com" });
    expect(await prod.json()).toEqual({ handshake: "https://handshake.waifucave.com" });
    const local = await worker.fetch(new Request("http://127.0.0.1:8790/config.json"), {
      ASSETS: assets,
      HANDSHAKE_ORIGIN: "http://127.0.0.1:8787",
      ALLOWED_HANDSHAKES: "http://127.0.0.1:9000",
    });
    expect(await local.json()).toEqual({ handshake: "http://127.0.0.1:8787", allowedHandshakes: ["http://127.0.0.1:9000"] });
    expect(local.headers.get("content-security-policy")).toContain("ws://127.0.0.1:9000");
  });
});
