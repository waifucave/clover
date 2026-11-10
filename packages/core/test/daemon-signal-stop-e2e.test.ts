import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/clover-protocol";

// Review M7: the signal stop end to end. A daemon in a child process with the real signal wiring (`stopOnSignals`,
// what daemon.ts's main runs), this test as its app, a real SIGTERM: the app reads `app.quit`, the daemon exits 0,
// and this run's app token is gone.
test.skipIf(process.platform === "win32")("SIGTERM: the app gets app.quit, then the daemon exits 0 and its token goes", async () => {
  const home = mkdtempSync(join(tmpdir(), "clover-signal-"));
  const src = join(import.meta.dir, "..", "src");
  const script = `
    import { startDaemon, stopOnSignals } from ${JSON.stringify(join(src, "daemon.ts"))};
    import { FileSecretStore } from ${JSON.stringify(join(src, "auth", "secret-store.ts"))};
    const d = await startDaemon({ home: ${JSON.stringify(home)}, secrets: new FileSecretStore(${JSON.stringify(join(home, "secrets.json"))}), agentProvider: null, appPeer: null });
    stopOnSignals(d);
    console.log("ready " + d.socketPath);`;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  let out = "";
  while (!/ready \S+\n/.test(out)) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value); }
  reader.releaseLock();
  const socketPath = /ready (\S+)\n/.exec(out)![1]!;
  const tokenFile = join(home, "run", "app.token");

  const fromDaemon: any[] = [];
  const decoder = new LineDecoder();
  let closed = false;
  const socket = await Bun.connect({ unix: socketPath, socket: {
    data(_s, chunk) { for (const l of decoder.push(chunk)) fromDaemon.push(JSON.parse(l)); },
    drain() { writer.onDrain(); },
    close() { closed = true; },
  } });
  const writer = new ConnWriter(socket as unknown as WritableSocket);
  writer.enqueue(encodeLine({ jsonrpc: "2.0", id: 1, method: METHODS.hello, params: { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token: readFileSync(tokenFile, "utf8"), clientName: "test-app", features: ["app.quit"] } }));
  for (let i = 0; i < 200 && !fromDaemon.some((m) => m.id === 1); i++) await Bun.sleep(10);
  expect(fromDaemon.find((m) => m.id === 1)?.result?.ok).toBe(true);

  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  for (let i = 0; i < 100 && !closed; i++) await Bun.sleep(10);
  expect(fromDaemon.find((m) => m.method === "app.quit")).toMatchObject({ params: { reason: "quit" } });
  expect(existsSync(tokenFile)).toBe(false);
}, 60_000);
