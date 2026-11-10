// The app's answer key is served from the daemon's start, not when its links finish starting (the owner's try 8: the
// app registered once, 3 s after its hello, got "device.answerKey.set is not served yet", and every sealed press then
// failed the broker's proof check). The registry is this device's own state: it opens before any wire, directory,
// account or network call, and `device.answerKey.set` answers from then on; before it opens, the call is told to try
// again (RETRY), never "not served".
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOVER_PROTOCOL_VERSION, ConnWriter, encodeLine, ERR, LineDecoder, METHODS, type Caller, type WritableSocket } from "@waifucave/clover-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { answerKeyMethods, MethodError } from "../../src/devices/rpc";
import { MemoryNetwork } from "../../src/links/memory-wire";
import { SystemClock } from "../../src/clock/system-clock";

const wire = (k: { publicKey: string; signature: string }) => ({ publicKey: k.publicKey, signature: k.signature });
const app: Caller = { kind: "user", client: "app" } as Caller;
const cli: Caller = { kind: "user", client: "cli" } as Caller;

function keyFor(device: string): { publicKey: string; signature: string; privateKey: KeyObject } {
  const k = generateKeyPairSync("ed25519");
  const der = k.publicKey.export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(der.subarray(der.length - 32)).toString("base64");
  return { publicKey, privateKey: k.privateKey, signature: sign(null, Buffer.from(`clover/answer-key/1\n${device}\n${publicKey}\nnone`), k.privateKey).toString("base64") };
}

describe("answerKeyMethods before the registry opens", () => {
  const set = answerKeyMethods({ registry: () => undefined, clock: new SystemClock() })["device.answerKey.set"]!;
  test("the app's call is told to try again (RETRY), not refused and not missing", async () => {
    const err = await set({ ...wire(keyFor("d")), held: "none" }, { caller: app } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MethodError);
    expect((err as MethodError).code).toBe(ERR.RETRY);
  });
  test("a caller that isn't the app is still refused first", async () => {
    const err = await set({ ...wire(keyFor("d")), held: "none" }, { caller: cli } as never).catch((e: unknown) => e);
    expect((err as MethodError).code).not.toBe(ERR.RETRY);
    const plugin = await set({ ...wire(keyFor("d")), held: "none" }, { caller: { kind: "plugin", pluginId: "x" } } as never).catch((e: unknown) => e);
    expect((plugin as MethodError).code).not.toBe(ERR.RETRY);
  });
});

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

describe.skipIf(process.platform === "win32")("a real daemon whose links are still starting", () => {
  test("device.answerKey.set takes the app's key while the links wait on their wire; device.list isn't served yet", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-akearly-"));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    daemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
      links: {
        binary: null, handshake: null, publicTime: null, watch: () => () => {}, self: { name: "Studio", os: "macos" },
        mainComputer: { watchSleep: false, monotonic: () => performance.now() },
        // The wire (the sidecar, on a real start) holds the links back: the registry is already open.
        wire: async (key) => { await held; return new MemoryNetwork().endpoint(key.publicKey); },
      },
      parts: { userHome: mkdtempSync(join(tmpdir(), "clover-akearly-user-")) },
    });
    const c = await connect(daemon.socketPath);
    try {
      const token = readFileSync(join(home, "run", "app.token"), "utf8").trim();
      const hello = await c.request(METHODS.hello, { protocolVersion: CLOVER_PROTOCOL_VERSION, role: "app", token, clientName: "early", features: [] });
      const device = (hello.result as { device: string }).device;
      expect(typeof device).toBe("string");
      const k = keyFor(device);
      let r: Awaited<ReturnType<typeof c.request>> | undefined;
      for (let i = 0; i < 100; i++) {
        r = await c.request("device.answerKey.set", { publicKey: k.publicKey, signature: k.signature, held: "none" });
        if (r.error?.code !== ERR.RETRY) break;
        await Bun.sleep(50);
      }
      expect(r?.error, r?.error?.message).toBeUndefined();
      expect(r?.result).toEqual({ applied: true });
      // The links haven't finished: their own methods aren't in the table yet.
      expect((await c.request("device.list")).error?.code).toBe(-32601);
      // The same key again applies at once (every connection registers it).
      expect((await c.request("device.answerKey.set", { publicKey: k.publicKey, signature: k.signature, held: "none" })).result).toEqual({ applied: true });
      // Once the links are up, the registry they serve holds the key the app registered early.
      release();
      let listed: { devices?: { isThis: boolean; answerKey?: { publicKey: string } }[] } | undefined;
      for (let i = 0; i < 100 && listed === undefined; i++) {
        const l = await c.request("device.list");
        if (l.error === undefined) listed = l.result as typeof listed;
        else await Bun.sleep(50);
      }
      const self = listed?.devices?.find((d) => d.isThis);
      expect(self).toBeDefined();
      // A different key with no hand-over is still refused (the rotation rule holds from the early handler too).
      const other = keyFor(device);
      const refused = await c.request("device.answerKey.set", { publicKey: other.publicKey, signature: other.signature, held: "none" });
      expect(refused.error?.message).toMatch(/hand-over/);
      // With the current key's hand-over, the replacement asks on a change card on the parts' broker (the daemon wires
      // the rotation now; before, every replacement was told the approvals weren't running).
      let rotated: Awaited<ReturnType<typeof c.request>> | undefined;
      for (let i = 0; i < 200; i++) {
        const at = Date.now();
        const handOver = sign(null, Buffer.from(`clover/answer-key-rotate/1\n${device}\n${k.publicKey}\n${other.publicKey}\n${at}`), k.privateKey).toString("base64");
        rotated = await c.request("device.answerKey.set", { publicKey: other.publicKey, signature: other.signature, held: "none", rotation: { from: k.publicKey, at, signature: handOver } });
        if (rotated.error?.code !== ERR.RETRY) break;
        await Bun.sleep(50);
      }
      expect(rotated?.error, rotated?.error?.message).toBeUndefined();
      expect(rotated?.result).toMatchObject({ applied: false, card: expect.any(String) });
    } finally {
      release();
      c.close();
    }
  }, 60_000);
});
