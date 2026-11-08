// Gap B: the app against a REAL daemon core, booted in-process (never a spawned binary, never the
// login keychain). A characterization test: it pins what the real daemon serves today so every lane's
// serving work shows up here as a test to update, and the owner-priority "usable macOS app" milestone
// has a green gate in the meantime.
//
// Safety (the #320 blocker): the daemon boots in this process via `startDaemon` on a temp home with a
// FILE secret store (`secrets.json` under that home), no agent provider, and a FORCED null launcher
// (`pair: { launcher: null }`, the test-only startDaemon seam) — the same pattern as
// packages/core/test/daemon-clover-pair-boot.test.ts. Belt and braces: the keychain isolation the core
// preload uses (`CLOVER_KEYCHAIN_SERVICE`, `WINTER_TEST_KEYCHAIN`), so even a store that forgot the file
// lands in an isolated/memory keychain, never the login one. It asserts the pair has NO launcher (a test
// daemon runs alone) and touches no real home, keychain, or network. Always runs, in CI too.
//
// Each `-32601` expectation below names its owning lane; when that lane serves the method on the Clover
// connection, the expectation flips to `ok` (that flip IS the lane's Gap B done-signal for the method).
import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore, startDaemon, type RunningDaemon } from "@waifucave/clover-core";

const daemons: RunningDaemon[] = [];
const homes: string[] = [];
const savedEnv = { CLOVER_KEYCHAIN_SERVICE: process.env.CLOVER_KEYCHAIN_SERVICE, WINTER_TEST_KEYCHAIN: process.env.WINTER_TEST_KEYCHAIN };
afterEach(async () => {
  for (const d of daemons.splice(0)) await Promise.resolve(d.stop()).catch(() => {});
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  if (savedEnv.CLOVER_KEYCHAIN_SERVICE === undefined) delete process.env.CLOVER_KEYCHAIN_SERVICE;
  else process.env.CLOVER_KEYCHAIN_SERVICE = savedEnv.CLOVER_KEYCHAIN_SERVICE;
  if (savedEnv.WINTER_TEST_KEYCHAIN === undefined) delete process.env.WINTER_TEST_KEYCHAIN;
  else process.env.WINTER_TEST_KEYCHAIN = savedEnv.WINTER_TEST_KEYCHAIN;
});

/** One persistent connection: calls are multiplexed by id (a fresh connection proves, a hello'd one calls).
 *  Messages that carry a `method` are the daemon's calls, never answers: `app.ping` is answered at once
 *  (an unanswered heartbeat safe-modes the connection), and the rest are skipped, never id-matched. */
function makeClient(sock: string): Promise<{ call: (method: string, params?: unknown) => Promise<unknown>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const s: Socket = connect(sock);
    let buf = "";
    let nextId = 1;
    const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error & { code?: number }) => void; timer: ReturnType<typeof setTimeout> }>();
    const answer = (id: number, result: unknown) => s.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
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
          const msg = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: { code: number; message: string } };
          if (typeof msg.method === "string") {
            if (msg.method === "app.ping" && typeof msg.id === "number") answer(msg.id, { ok: true });
            continue;
          }
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

describe("the app against a real daemon core, booted in-process (Gap B interop)", () => {
  test("hello, prove, pair.status and events.subscribe work; lanes' methods report not-served-yet", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-realinterop-"));
    homes.push(home);
    // File secrets, no provider, a forced null launcher: this daemon can reach neither the login
    // keychain nor the machine. The keychain env pins the isolation even a store built without the
    // file would get (the core preload's own values).
    process.env.CLOVER_KEYCHAIN_SERVICE = "com.waifucave.clover.core.test-isolated";
    process.env.WINTER_TEST_KEYCHAIN = "memory";
    const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: { launcher: null } });
    daemons.push(daemon);
    expect(daemon.pair?.launcher, "a test daemon runs alone: no launcher").toBeNull();
    const token = readFileSync(join(home, "run", "app.token"), "utf8").trim();
    expect(token.length).toBeGreaterThan(0);

    const client = await makeClient(daemon.socketPath);
    try {
      // Lane C serves these today.
      const hello = await client.call("protocol.hello", { protocolVersion: 1, role: "app", token, clientName: "real-interop", features: ["app.show", "app.quit", "layers"] }) as { ok?: boolean; caller?: { kind?: string; client?: string } };
      expect(hello.ok).toBe(true);
      expect(hello.caller).toMatchObject({ kind: "user", client: "app" });

      // Prove runs pre-hello on its own connection (lane C's review-S3 shape).
      const prover = await makeClient(daemon.socketPath);
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
      // Lane B serves ui.settings (UiSettings): flip to ok then; the app keeps its default fallback meanwhile.
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
