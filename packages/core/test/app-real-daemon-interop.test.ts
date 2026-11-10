// Lane E's Gap B interop pins (apps/desktop/test/real-daemon-interop.test.ts), against a real daemon as the app calls
// it: an `app` hello with this run's `run/app.token` over the daemon's socket, then each method a lane serves answers
// and each one still unserved fails METHOD_NOT_FOUND, naming its owner. Unlike E's original it never touches the
// user's Keychain or app: the daemon runs in this test process, its secrets in a file in its temp home, with no app to
// launch, and its links local-only (no clover-link beside it, as a daemon from source or a build without it).
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, UiSettings, type WritableSocket } from "@waifucave/clover-protocol";
import { FileSecretStore } from "../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../src/daemon";

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

async function connect(path: string) {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: { result?: unknown; error?: { code: number; message: string } }) => void>();
  let next = 1;
  const socket = await Bun.connect({ unix: path, socket: {
    data(_s, chunk) {
      for (const l of decoder.push(chunk)) {
        const m = JSON.parse(l) as { id?: number };
        if (typeof m.id === "number") { pending.get(m.id)?.(m as never); pending.delete(m.id); }
      }
    },
    drain() { writer.onDrain(); },
  } });
  const writer = new ConnWriter(socket as unknown as WritableSocket);
  const request = (method: string, params: unknown = {}) => new Promise<{ result?: unknown; error?: { code: number; message: string } }>((r) => {
    const id = next++;
    pending.set(id, r);
    writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
  });
  return { request, close: () => socket.end() };
}

describe.skipIf(process.platform === "win32")("the app against a real daemon (lane E's Gap B pins)", () => {
  test("the methods the app calls answer it, plugin.ui, ui.settings and card.list among them; app-start.json stays absent (no app started)", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-interop-"));
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
      links: { binary: null, handshake: null, publicTime: null, mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "macos" } },
      parts: { userHome: mkdtempSync(join(tmpdir(), "clover-interop-user-")) },
    });
    expect(daemon.pair?.launcher).toBeNull(); // no app to launch
    const c = await connect(daemon.socketPath);
    try {
      const token = readFileSync(join(home, "run", "app.token"), "utf8").trim();
      const hello = await c.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token, clientName: "interop", features: ["app.show", "app.quit", "layers"] });
      expect(hello.result).toMatchObject({ ok: true, caller: { kind: "user", client: "app" } });
      await daemon.cloverParts.ready;
      const ok = async (method: string, params: unknown = {}) => {
        const r = await c.request(method, params);
        expect(r.error, `${method}: ${r.error?.message}`).toBeUndefined();
        return r.result as Record<string, unknown>;
      };

      // Served now (flipped from E's -32601 pins).
      const computers = (await ok("computer.list")).computers as { name: string; device: string }[];
      expect(computers.map((x) => x.name)).toEqual(["Studio"]);
      expect(await ok("computer.get", { name: "Studio" })).toMatchObject({ computer: { name: "Studio" } });
      expect(await ok("hold.list", { computer: "Studio" })).toEqual({ holds: [], userWorking: false });
      expect(Array.isArray((await ok("session.list")).sessions)).toBe(true);
      expect(Array.isArray((await ok("bot.list")).bots)).toBe(true);
      const self = ((await ok("device.list")).devices as { id: string; isThis: boolean }[]).find((d) => d.isThis)!;
      expect(self.id).toBe(computers[0]!.device);
      // device.answerKey.set: a key the app didn't sign is refused (served, not missing); the app's signed key is taken.
      const k = generateKeyPairSync("ed25519");
      const der = k.publicKey.export({ format: "der", type: "spki" });
      const publicKey = Buffer.from(der.subarray(der.length - 32)).toString("base64");
      const statement = Buffer.from(`clover/answer-key/1\n${self.id}\n${publicKey}\nnone`);
      const unsigned = await c.request("device.answerKey.set", { publicKey, held: "none", signature: sign(null, Buffer.from("something else"), k.privateKey).toString("base64") });
      expect(unsigned.error?.code).toBeDefined();
      expect(unsigned.error?.code).not.toBe(-32601);
      expect(await ok("device.answerKey.set", { publicKey, held: "none", signature: sign(null, statement, k.privateKey).toString("base64") })).toEqual({ applied: true });
      expect(await ok("usage.summary", { from: 0, to: Date.now(), groupBy: "day" })).toEqual({ groups: [] });
      // B's plugin registry methods (#277, on main).
      expect(Array.isArray((await ok("plugin.list")).plugins)).toBe(true);

      // Served since try 6 (#333's plugin.ui and ui.settings, #346's card.* over INT's broker): their answers.
      expect(Array.isArray((await ok("plugin.ui")).plugins)).toBe(true);
      const settings = await ok("ui.settings");
      expect(UiSettings.safeParse(settings).success).toBe(true);
      expect(await ok("card.list")).toEqual({ cards: [] });
      // A method nobody serves still fails METHOD_NOT_FOUND, not some other error.
      expect((await c.request("nothing.here", {})).error?.code).toBe(-32601);
    } finally {
      c.close();
    }
    // Written only when the daemon starts the app through the OS (C-M1); none was started here.
    expect(existsSync(join(home, "run", "app-start.json"))).toBe(false);
  }, 60_000);
});
