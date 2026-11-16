// End to end over real sockets: this plugin's client, in Bun as the plugin host runs it, against the
// forwarder Worker on wrangler's local runtime (workerd), started by services/forwarder/test/node/serve.mjs.
// Every key is made here for the run, in memory. The only network is 127.0.0.1.
//
// It needs services/forwarder's dependencies installed (npm install there); without them it is skipped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmdirSync } from "node:fs";
import { join } from "node:path";

import { ForwarderClient, type Delivery } from "../src/client";
import { memoryKeys, type ForwarderKeys } from "../src/keys";
import { b64u, fromUtf8, utf8 } from "../src/wire/bytes";

const serviceDir = join(import.meta.dir, "../../../../../services/forwarder");
const ready = existsSync(join(serviceDir, "node_modules/wrangler/package.json"));
const stateDir = join(serviceDir, ".wrangler");
const stateDirExisted = existsSync(stateDir);
const node = Bun.which("node");

interface Harness {
  url: string;
  command(op: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<void>;
}

let harness: Harness;
let signingKey: CryptoKey;
const issuer = "https://accounts.e2e.test";

async function startHarness(jwks: string): Promise<Harness> {
  const secret = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
  const child = Bun.spawn([node!, join(serviceDir, "test/node/serve.mjs")], {
    cwd: serviceDir,
    env: {
      ...process.env,
      CLOUDFLARE_CF_FETCH_ENABLED: "false",
      WRANGLER_SEND_METRICS: "false",
      FORWARDER_E2E: JSON.stringify({ jwks, issuer, tagKeys: JSON.stringify({ "1": secret() }), accountIdKey: secret(), ticketSecret: secret() }),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  async function line(): Promise<string> {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const out = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return out;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("the forwarder harness exited");
      buffered += decoder.decode(value);
    }
  }
  const { url } = JSON.parse(await line()) as { url: string };
  return {
    url,
    async command(op) {
      child.stdin.write(`${JSON.stringify(op)}\n`);
      await child.stdin.flush();
      return JSON.parse(await line()) as { ok: boolean; error?: string };
    },
    async stop() {
      await child.stdin.end();
      const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
      if (exited === null) child.kill();
    },
  };
}

async function token(account: string, device: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(utf8(JSON.stringify({ alg: "ES256", kid: "e2e", typ: "JWT" })));
  const claims = b64u(utf8(JSON.stringify({ iss: issuer, aud: "hooks.waifucave.com", sub: account, dev: device, iat: now, exp: now + 300 })));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, utf8(`${header}.${claims}`));
  return `${header}.${claims}.${b64u(new Uint8Array(signature))}`;
}

function computer(account: string, device: string, keys: Promise<ForwarderKeys>) {
  const deliveries: Delivery[] = [];
  const client = new ForwarderClient({
    origin: harness.url,
    fetch: async (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${await token(account, device)}`);
      return fetch(url, { ...init, headers });
    },
    // The core's key store, in memory: the same promise for one computer across its restarts.
    keys: { publicKey: async () => (await keys).publicKey(), open: async (input) => (await keys).open(input) },
    onDelivery: (d) => deliveries.push(d),
    pingIntervalMs: 100,
    pongTimeoutMs: 2_000,
  });
  return { client, deliveries };
}

async function until(predicate: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

function hook(url: string, key: string, body: string | Uint8Array<ArrayBuffer>): Promise<Response> {
  return fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "text/plain" }, body });
}

const key = () => b64u(crypto.getRandomValues(new Uint8Array(32)));

describe.skipIf(!ready || !node)("end to end against wrangler's local runtime", () => {
  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    signingKey = pair.privateKey;
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    harness = await startHarness(JSON.stringify({ keys: [{ ...publicJwk, kid: "e2e", alg: "ES256", use: "sig" }] }));
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
    // wrangler leaves an empty .wrangler/tmp behind; remove what this run made, only if it is empty.
    if (!stateDirExisted) {
      for (const dir of [join(stateDir, "tmp"), stateDir]) {
        try {
          rmdirSync(dir);
        } catch {
          // Not empty, or already gone.
        }
      }
    }
  });

  test("a webhook posted to the Worker reaches the computer's socket, opened, and is deleted once taken", async () => {
    const { client, deliveries } = computer("e2e-account-1", "laptop", memoryKeys());
    await client.start();
    await until(() => client.state === "open", "the connection");
    const routineKey = key();
    const { url } = await client.registerRoutine("on-push", routineKey);
    expect(url.startsWith(`${harness.url}/`)).toBe(true);
    expect((await hook(url, routineKey, "over real sockets")).status).toBe(202);
    await until(() => deliveries.length === 1, "the delivery");
    expect(fromUtf8(deliveries[0]!.request.body)).toBe("over real sockets");
    deliveries[0]!.ack();
    await Bun.sleep(300); // several keep-alives at 100 ms, each answered by the auto-response
    expect(client.state).toBe("open");
    const routines = await client.listRoutines();
    expect(routines).toEqual([{ id: "on-push", device: "laptop", held: 0, allowGet: false }]);
    await client.stop();
  }, 30_000);

  test("holds webhooks while the computer is away, and hands them over when it reconnects", async () => {
    const keys = memoryKeys();
    const first = computer("e2e-account-2", "desktop", keys);
    await first.client.start();
    await until(() => first.client.state === "open", "the connection");
    const routineKey = key();
    const { url } = await first.client.registerRoutine("nightly", routineKey);
    await first.client.stop();
    for (const body of ["one", "two", "three"]) expect((await hook(url, routineKey, body)).status).toBe(202);

    const again = computer("e2e-account-2", "desktop", keys);
    await again.client.start();
    await until(() => again.deliveries.length === 3, "the held webhooks");
    expect(again.deliveries.map((d) => fromUtf8(d.request.body))).toEqual(["one", "two", "three"]);
    for (const d of again.deliveries) d.ack();
    await Bun.sleep(200);
    expect(await again.client.listRoutines()).toEqual([{ id: "nightly", device: "desktop", held: 0, allowGet: false }]);
    await again.client.stop();
  }, 30_000);

  test("delivers through a socket that stayed open while the Durable Object was evicted", async () => {
    const { client, deliveries } = computer("e2e-account-3", "pc", memoryKeys());
    await client.start();
    await until(() => client.state === "open", "the connection");
    const routineKey = key();
    const { url } = await client.registerRoutine("woken", routineKey);
    expect(await harness.command({ op: "evict", tag: client.tag })).toEqual({ ok: true });
    expect((await hook(url, routineKey, "after eviction")).status).toBe(202);
    await until(() => deliveries.length === 1, "the delivery after eviction");
    expect(fromUtf8(deliveries[0]!.request.body)).toBe("after eviction");
    deliveries[0]!.ack();
    await client.stop();
  }, 30_000);

  test("reconnects after eviction closes its socket, and the webhook waits for it", async () => {
    const { client, deliveries } = computer("e2e-account-4", "pc", memoryKeys());
    await client.start();
    await until(() => client.state === "open", "the connection");
    const routineKey = key();
    const { url } = await client.registerRoutine("reconnecting", routineKey);
    expect(await harness.command({ op: "evict", tag: client.tag, webSockets: "close" })).toEqual({ ok: true });
    expect((await hook(url, routineKey, "while reconnecting")).status).toBe(202);
    await until(() => deliveries.length === 1, "the delivery after reconnecting", 15_000);
    expect(fromUtf8(deliveries[0]!.request.body)).toBe("while reconnecting");
    await client.stop();
  }, 30_000);

  test("a webhook at the production cap (1 MiB) reaches the computer, with two computers on the account", async () => {
    const laptop = computer("e2e-account-5", "laptop", memoryKeys());
    const desktop = computer("e2e-account-5", "desktop", memoryKeys());
    await laptop.client.start();
    await desktop.client.start();
    await until(() => laptop.client.state === "open" && desktop.client.state === "open", "both connections");
    const routineKey = key();
    const { url } = await laptop.client.registerRoutine("big", routineKey);
    const body = crypto.getRandomValues(new Uint8Array(64 * 1024));
    const mib = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 16; i++) mib.set(body, i * body.length);
    expect((await hook(url, routineKey, mib)).status).toBe(202);
    await until(() => laptop.deliveries.length === 1, "the 1 MiB delivery", 20_000);
    expect(laptop.deliveries[0]!.request.body.length).toBe(mib.length);
    expect(b64u(laptop.deliveries[0]!.request.body.subarray(0, 64))).toBe(b64u(mib.subarray(0, 64)));
    expect(desktop.deliveries).toHaveLength(0);
    laptop.deliveries[0]!.ack();
    const over = new Uint8Array(1024 * 1024 + 1);
    expect((await hook(url, routineKey, over)).status).toBe(413);
    await laptop.client.stop();
    await desktop.client.stop();
  }, 60_000);
});
