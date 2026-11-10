import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/clover-protocol";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { FileSecretStore } from "../src/auth/secret-store";
import { cloverCall } from "../src/ipc/clover-client";
import { checkDaemonServer } from "../src/platform/server-check";

// C-M1 on a real daemon: the app token in the run directory, an `app` hello through the caller check
// (this test process is outside every floor), the pair's methods, and the pair's quit ending the run.

async function rpc(path: string) {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: any) => void>();
  let next = 1;
  const fromDaemon: any[] = [];
  const socket = await Bun.connect({ unix: path, socket: {
    data(_s, chunk) { for (const l of decoder.push(chunk)) { const m = JSON.parse(l); if (typeof m.id === "number") { pending.get(m.id)?.(m); pending.delete(m.id); } else if (m.method) fromDaemon.push(m); } },
    drain() { writer.onDrain(); },
  } });
  const writer = new ConnWriter(socket as unknown as WritableSocket);
  return {
    fromDaemon,
    request(method: string, params?: unknown): Promise<any> { const id = next++; writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params })); return new Promise((r) => pending.set(id, r)); },
    close() { socket.end(); },
  };
}

describe("the daemon's Clover side, booted", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(async () => { await daemon?.stop(); daemon = undefined; });

  test("the app's hello with run/app.token, pair.status, and pair.quit ends the run", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-pair-boot-"));
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none" });
    const tokenFile = join(home, "run", "app.token");
    expect(existsSync(tokenFile)).toBe(true);
    if (process.platform !== "win32") expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(daemon.pair?.launcher).toBeNull(); // no app installed for a test daemon: it runs alone
    expect(await checkDaemonServer(daemon.socketPath, { image: process.execPath })).toMatchObject({ ok: true }); // what the app runs before its hello
    const c = await rpc(daemon.socketPath);
    const hello = await c.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token: readFileSync(tokenFile, "utf8"), clientName: "test-app", features: ["app.quit"] });
    expect(hello.error).toBeUndefined();
    expect(hello.result.caller).toEqual({ kind: "user", client: "app" });
    expect((await c.request("pair.status", {})).result.safeMode).toBe(false);
    expect((await c.request("pair.quit", { handOver: false })).result).toEqual({ ok: true });
    c.close();
    const why = await Promise.race([daemon.pairStopped, Bun.sleep(5_000).then(() => "timed out")]);
    expect(why).toBe("the app went (quit)");
    await daemon.stop();
    expect(existsSync(tokenFile)).toBe(false); // this run's token goes with it
    daemon = undefined;
  });

  test("an uninstaller's clean stop: the CLI's pair.quit through cloverCall ends the run", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-pair-boot-"));
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none" });
    expect(await cloverCall(daemon.socketPath, { role: "cli", token: daemon.tokens.harness, clientName: "autostart" }, "pair.quit", { handOver: false })).toEqual({ ok: true });
    expect(await Promise.race([daemon.pairStopped, Bun.sleep(5_000).then(() => "timed out")])).toBe("quit, no app connected");
    await expect(cloverCall(daemon.socketPath, { role: "cli", token: "nope", clientName: "x" }, "pair.status", {})).rejects.toThrow();
  });

  test("a daemon with the pair turned off has no app token, and quitPair still ends it", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-pair-boot-"));
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, pair: false, appPeer: "none" });
    expect(existsSync(join(home, "run", "app.token"))).toBe(false);
    daemon.quitPair();
    expect(await daemon.pairStopped).toBe("quit");
  });

  test("a signal's stop: the app is sent app.quit at once, with no wait of the daemon's own", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-pair-boot-"));
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none" });
    const c = await rpc(daemon.socketPath);
    const token = readFileSync(join(home, "run", "app.token"), "utf8");
    expect((await c.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token, clientName: "test-app", features: ["app.quit"] })).result.ok).toBe(true);
    const started = Date.now();
    let stopped: string | undefined;
    void daemon.pairStopped.then((why) => { stopped = why; });
    await daemon.stop();
    expect(Date.now() - started).toBeLessThan(2_500); // not the pair's 3 s wait for the app
    for (let i = 0; i < 100 && c.fromDaemon.length === 0; i++) await Bun.sleep(10);
    expect(c.fromDaemon.find((m) => m.method === "app.quit")).toMatchObject({ params: { reason: "quit" } });
    await Bun.sleep(100);
    expect(stopped).toBeUndefined(); // stop() stopped the pair itself: no second shutdown
    daemon = undefined;
  });
});
