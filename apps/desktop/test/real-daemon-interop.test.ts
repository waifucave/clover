// Gap B: the app against a REAL clover-core (not the fake). A characterization test: it pins what the
// real daemon serves today so every lane's serving work shows up here as a test to update, and the
// owner-priority "usable macOS app" milestone has a green gate in the meantime.
//
// Runs only when CLOVER_REAL_DAEMON_BIN points at a built daemon (`bun run build:daemon` first); CI
// never sets it, so CI stays on the fake. Locally: `CLOVER_REAL_DAEMON_BIN=dist/daemon/darwin-arm64/clover-core
// scripts/heavy bun test test/real-daemon-interop.test.ts` from apps/desktop.
//
// Each `-32601` expectation below names its owning lane; when that lane serves the method on the Clover
// connection, the expectation flips to `ok` (that flip IS the lane's Gap B done-signal for the method).
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.env.CLOVER_REAL_DAEMON_BIN;
const enabled = bin !== undefined && bin !== "" && existsSync(bin);

const daemons: ChildProcess[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) {
    try { d.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bootRealDaemon(): Promise<{ home: string; sock: string; token: string }> {
  const home = mkdtempSync(join(tmpdir(), "clover-realinterop-"));
  homes.push(home);
  const sock = join(home, "run", "core.sock");
  const d = spawn(bin!, ["daemon", "run"], {
    env: { ...process.env, CLOVER_HOME: home, CLOVER_PROFILE: "dev" },
    stdio: "ignore",
  });
  daemons.push(d);
  const end = Date.now() + 30000;
  while (!existsSync(sock)) {
    if (Date.now() > end) throw new Error(`real daemon never bound ${sock}`);
    await sleep(200);
  }
  const token = readFileSync(join(home, "run", "app.token"), "utf8").trim();
  expect(token.length).toBeGreaterThan(0);
  return { home, sock, token };
}

type RpcResult = { result?: unknown; error?: { code: number; message: string } };

/** One persistent connection: calls are multiplexed by id (a fresh connection proves, a hello'd one calls). */
function makeClient(sock: string): Promise<{ call: (method: string, params?: unknown) => Promise<unknown>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const s: Socket = connect(sock);
    let buf = "";
    let nextId = 1;
    const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error & { code?: number }) => void; timer: ReturnType<typeof setTimeout> }>();
    s.on("connect", () => resolve({
      close: () => s.destroy(),
      call: (method: string, params: unknown = {}) => new Promise<unknown>((res, rej) => {
        const id = nextId++;
        const timer = setTimeout(() => { waiting.delete(id); rej(Object.assign(new Error("timeout"), { code: "timeout" })); }, 8000);
        waiting.set(id, { resolve: res, reject: rej as (e: Error & { code?: number }) => void, timer });
        s.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    }));
    s.on("data", (chunk) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line === "") continue;
        try {
          const msg = JSON.parse(line) as RpcResult & { id?: number };
          if (typeof msg.id !== "number") continue;
          const w = waiting.get(msg.id);
          if (!w) continue;
          waiting.delete(msg.id);
          clearTimeout(w.timer);
          if (msg.error) w.reject(Object.assign(new Error(`rpc ${msg.error.code}: ${msg.error.message}`), { code: msg.error.code }));
          else w.resolve(msg.result);
        } catch { /* partial line */ }
      }
    });
    s.on("error", (e) => reject(e));
  });
}

async function expectNotServedYet(call: (method: string, params?: unknown) => Promise<unknown>, method: string, params?: unknown): Promise<void> {
  try {
    await call(method, params);
  } catch (err) {
    expect((err as Error & { code?: number }).code, `${method} should fail with METHOD_NOT_FOUND while unserved`).toBe(-32601);
    return;
  }
  throw new Error(`${method} is served now — flip this expectation to ok (see the header)`);
}

describe.if(enabled)("the app against a real daemon (Gap B interop)", () => {
  test("hello, prove, pair.status and events.subscribe work; lanes' methods report not-served-yet", async () => {
    const { home, sock, token } = await bootRealDaemon();
    const client = await makeClient(sock);
    try {
      // Lane C serves these today.
      const hello = await client.call("protocol.hello", { protocolVersion: 1, role: "app", token, clientName: "real-interop", features: ["app.show", "app.quit", "layers"] }) as { ok?: boolean; caller?: { kind?: string; client?: string } };
      expect(hello.ok).toBe(true);
      expect(hello.caller).toMatchObject({ kind: "user", client: "app" });

      // Prove runs pre-hello on its own connection (lane C's review-S3 shape).
      const prover = await makeClient(sock);
      try {
        const proof = await prover.call("protocol.prove", { nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }) as { proof?: unknown; pid?: unknown };
        expect(typeof proof.proof).toBe("string");
        expect(typeof proof.pid).toBe("number");
      } finally {
        prover.close();
      }

      const status = await client.call("pair.status") as { safeMode?: unknown };
      expect(typeof status.safeMode).toBe("boolean");

      const sub = await client.call("events.subscribe", { areas: ["plugins", "app"] }) as { ok?: boolean };
      expect(sub.ok).toBe(true);

      // Lane B serves these when #277's registry build lands: flip to ok then.
      await expectNotServedYet(client.call, "plugin.ui");
      await expectNotServedYet(client.call, "plugin.list");
      // Lane C serves card.list then.
      await expectNotServedYet(client.call, "card.list");
      // Lane E serves ui.settings itself (the app's loadRegistry reads it, defaulting meanwhile): flip to ok then.
      await expectNotServedYet(client.call, "ui.settings");
      // Lane D serves sessions then.
      await expectNotServedYet(client.call, "session.list");
      // Lane B's bot/computer lists (bot tab + Computer surface) then.
      await expectNotServedYet(client.call, "bot.list");
      await expectNotServedYet(client.call, "computer.list");
      // Lane H serves devices (answerKey + list) then.
      await expectNotServedYet(client.call, "device.list");
      await expectNotServedYet(client.call, "device.answerKey.set", { publicKey: Buffer.alloc(32).toString("base64"), held: "none", signature: Buffer.alloc(64).toString("base64") });
    } finally {
      client.close();
    }
    // Lane C's C-M1 writes run/app-start.json for the app's proof bootstrap: missing until then.
    expect(existsSync(join(home, "run", "app-start.json")), "app-start.json arrives with C-M1 — flip to exists then").toBe(false);
  }, 120_000);
});
