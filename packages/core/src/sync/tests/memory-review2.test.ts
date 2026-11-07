// Each bot's memory, kept alike on the user's computers (H-M3): a write on one appears on the others, live and after a
// computer comes back (over a link, or as sealed mail when the writer is off by then); concurrent edits keep both
// copies; a revoked device gets nothing new after the content key's rotation; a forged writer, over-cap pushes and
// paths that leave the bot's memory are refused; nothing is written through a link.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { botPaths } from "../../bots/paths";
import { SystemClock } from "../../clock/system-clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { BoxKey } from "../../identity/box-key";
import { fromUtf8, toBase64 } from "../../identity/bytes";
import { type ClusterDevice, makeLinkCluster } from "../../links/testing";
import { MAIL_MAX_PIECE, MemoryMailRelay, type SyncMailbox } from "../mailbox";
import { COUNTER_STEP, type MemoryEntry, type MemoryLimits, MemorySync, type PushResult, type SkipReason, versionStatement } from "../memory";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { contentAad, keyCommit, keyStatement } from "../memory-keys";
import { memoryPath, readMemoryFile, removeMemoryFile, writeMemoryFile } from "../memory-files";

const clock = new SystemClock();
// A link cut and healed again re-dials with its backoff: give those tests room.
setDefaultTimeout(20_000);
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

const BOT = "alpha";
const DAY = Date.UTC(2026, 10, 6, 12);

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

interface Computer {
  d: ClusterDevice;
  home: string;
  box: BoxKey;
  sync: MemorySync;
  write(rel: string, text: string): void;
  read(rel: string): string | undefined;
  remove(rel: string): void;
  restart(): Promise<void>;
}

async function world(names: string[], opts: { limits?: Record<string, Partial<MemoryLimits>>; mail?: boolean; mailbox?: (relay: MemoryMailRelay, device: string) => SyncMailbox } = {}) {
  const c = await makeLinkCluster(names, { clock });
  stops.push(() => c.close());
  const relay = new MemoryMailRelay();
  // The shared clock, which a test moves on by hand so the later of two concurrent writes is known.
  let now = DAY;
  const tick = () => (now += 1_000);
  const computers = new Map<string, Computer>();
  for (const n of names) {
    const d = c.devices.get(n)!;
    const home = mkdtempSync(join(tmpdir(), "clover-h-memory-"));
    stops.push(() => rmSync(home, { recursive: true, force: true }));
    const box = BoxKey.generate();
    const store = new MemorySecretStore();
    const start = () => MemorySync.start({
      home, self: d.id, key: d.key, boxKey: box, store, transport: d.transport, registry: d.registry, now: () => now,
      ...(opts.mail ? { mailbox: opts.mailbox?.(relay, d.id) ?? relay.for(d.id), mailDelayMs: 0, mailRetryMs: 100 } : {}),
      ...(opts.limits?.[n] ? { limits: opts.limits[n] } : {}),
    });
    const root = botPaths(home, BOT).memory;
    const me: Computer = {
      d, home, box, sync: await start(),
      write(rel, text) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
        tick();
        me.sync.changed(BOT, rel);
      },
      read(rel) {
        const p = join(root, rel);
        return existsSync(p) ? readFileSync(p, "utf8") : undefined;
      },
      remove(rel) {
        unlinkSync(join(root, rel));
        tick();
        me.sync.changed(BOT, rel);
      },
      async restart() {
        me.sync.close();
        me.sync = await start();
      },
    };
    stops.push(() => me.sync.close());
    computers.set(n, me);
  }
  const at = (n: string) => computers.get(n)!;
  /** Brings a link up, again after a heal (a dial that just failed backs off, so this asks until one answers). */
  const link = async (a: string, b: string) => {
    const end = Date.now() + 5_000;
    for (;;) {
      try {
        await at(a).d.transport.connect(at(b).d.id);
        return;
      } catch (e) {
        if (Date.now() > end) throw e;
        at(a).d.transport.networkChanged();
        await Bun.sleep(20);
      }
    }
  };
  const linkAll = async () => {
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) await link(names[i]!, names[j]!);
  };
  return { c, relay, at, link, linkAll, tick };
}

/** A version `signer` signs, saying `by` wrote it: a deletion, so it needs no content key. */
function deletion(signer: ClusterDevice, rel: string, o: { by?: string; bot?: string; n?: number } = {}): MemoryEntry {
  const by = o.by ?? signer.id;
  const v = { rel, vv: { [by]: o.n ?? 9 }, ts: DAY + 99_000, by, hash: null, size: 0, sig: "" };
  return { ...v, sig: toBase64(signer.key.sign(versionStatement(o.bot ?? BOT, v))) };
}

/** A push whose one entry was skipped for `reason` (the rest of a push is taken; #232's review, B3). */
const skipped = (reason: SkipReason): PushResult => ({ ok: true, took: 0, conflicts: 0, skipped: [{ rel: "MEMORY.md", reason }] });

async function push(from: Computer, to: Computer, entries: unknown[], bot = BOT): Promise<PushResult> {
  const link = await from.d.transport.connect(to.d.id);
  return link.request<PushResult>("sync.push", { stream: `memory:${bot}`, entries });
}


const STEP = 2 ** 20;
function signedDeletion(signer: ClusterDevice, rel: string, vv: Record<string, number>, ts: number): MemoryEntry {
  const v = { rel, vv, ts, by: signer.id, hash: null, size: 0, sig: "" };
  return { ...v, sig: toBase64(signer.key.sign(versionStatement(BOT, v))) };
}

describe("review-h H-M3 check 2 probes", () => {
  for (const whose of ["its own", "the studio's"] as const) {
    test(`M5 (${whose} counter): two steps of 2^20 while the laptop is off: it takes the file again at the honest writer's next write`, async () => {
      const w = await world(["Studio", "Laptop", "Server"]);
      await w.linkAll();
      w.at("Studio").write("MEMORY.md", "base\n");
      for (const n of ["Laptop", "Server"]) await waitFor(() => w.at(n).read("MEMORY.md") === "base\n");
      const [studio, server] = [w.at("Studio").d, w.at("Server").d];
      w.c.net.partition(w.at("Laptop").d.key.publicKey);
      await waitFor(() => !w.at("Studio").d.transport.links().some((l) => l.up && l.peer === w.at("Laptop").d.id));
      const s0 = w.at("Studio").sync.versions(BOT)["memory.md"]?.vv ?? {};
      const inflate = whose === "its own" ? server.id : studio.id;
      for (let k = 1; k <= 2; k++) {
        const vv = { ...s0, [server.id]: whose === "its own" ? k * STEP : 1, ...(whose === "its own" ? {} : { [studio.id]: (s0[studio.id] ?? 1) + k * STEP }) };
        const r = await push(w.at("Server"), w.at("Studio"), [signedDeletion(server, "MEMORY.md", vv, DAY + 50_000 + k)]);
        console.error(`M5 ${whose}: step ${k} to the studio: ${JSON.stringify(r)}`);
      }
      void inflate;
      // The server is found out and revoked; the user writes the file again on the studio.
      await studio.registry.revoke(server.id);
      await w.at("Laptop").d.registry.revoke(server.id);
      w.at("Studio").write("MEMORY.md", "the user's later note\n");
      w.c.net.heal(w.at("Laptop").d.key.publicKey);
      await w.link("Laptop", "Studio");
      await Bun.sleep(2000);
      // And once more, live.
      w.at("Studio").write("MEMORY.md", "and another\n");
      await Bun.sleep(1500);
      console.error(`M5 ${whose}: laptop reads ${JSON.stringify(w.at("Laptop").read("MEMORY.md"))}; studio's vector ${JSON.stringify(w.at("Studio").sync.versions(BOT)["memory.md"]?.vv)}`);
      expect(w.at("Laptop").read("MEMORY.md")).toBe("and another\n");
    });
  }

  test("M6: one member can't ratchet another writer's counter push after push: one step past what that writer signed", async () => {
    const w = await world(["Studio", "Server"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "base\n");
    await waitFor(() => w.at("Server").read("MEMORY.md") === "base\n");
    const [studio, server] = [w.at("Studio").d, w.at("Server").d];
    const base = w.at("Studio").sync.versions(BOT)["memory.md"]!.vv;
    const N = 400;
    const t0 = performance.now();
    let ok = 0;
    for (let k = 1; k <= N; k++) {
      const vv = { ...base, [server.id]: 1, [studio.id]: (base[studio.id] ?? 1) + k * STEP };
      const r = await push(w.at("Server"), w.at("Studio"), [signedDeletion(server, "MEMORY.md", vv, DAY + 50_000 + k)]);
      if (r.ok && r.took === 1) ok++;
    }
    const ms = performance.now() - t0;
    const perS = (ok / ms) * 1000;
    console.error(`M6 ${ok}/${N} steps taken, ${perS.toFixed(0)} a second; the studio's counter now ${w.at("Studio").sync.versions(BOT)["memory.md"]!.vv[studio.id]}; 2^48 would take ${(2 ** 28 / perS / 86400).toFixed(1)} days at this rate`);
    // C1: a step is measured from what the studio itself signed, which the member's pushes never raise.
    expect(ok).toBeLessThanOrEqual(1);
  }, 60_000);

  test("M7: a member can't ratchet the content-key epoch (epochs count per creator), and its keys go at its revoke", async () => {
    const w = await world(["Studio", "Server"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "base\n");
    await waitFor(() => w.at("Server").read("MEMORY.md") === "base\n");
    const [studio, server] = [w.at("Studio").d, w.at("Server").d];
    const link = await server.transport.connect(studio.id);
    const highest = () => Math.max(0, ...w.at("Studio").sync.keys().map((k) => k.epoch));
    let epoch = highest();
    let counter = 0;
    const PUSHES = 40;
    const t0 = performance.now();
    for (let p = 0; p < PUSHES; p++) {
      const keys: unknown[] = [];
      const entries: unknown[] = [];
      for (let i = 0; i < 16; i++) {
        epoch += 4096;
        const bytes = new Uint8Array(randomBytes(32));
        const unsigned = { kid: `${epoch}.${server.id}`, epoch, creator: server.id, members: [server.id, studio.id], createdAt: DAY, commit: keyCommit(bytes) };
        keys.push({ ...unsigned, sig: toBase64(server.key.sign(keyStatement(unsigned))), key: toBase64(bytes) });
        const rel = `f${i}.md`;
        const data = new TextEncoder().encode(`x${p}`);
        const hash = createHash("sha256").update(data).digest("hex");
        counter++;
        const v = { rel, vv: { [server.id]: counter }, ts: DAY + 1000, by: server.id, hash, size: data.length, sig: "" };
        const nonce = randomBytes(12);
        const c = createCipheriv("aes-256-gcm", bytes, nonce);
        c.setAAD(contentAad({ kid: unsigned.kid, bot: BOT, key: rel, hash }));
        const box = Buffer.concat([nonce, c.update(data), c.final(), c.getAuthTag()]).toString("base64url");
        entries.push({ ...v, sig: toBase64(server.key.sign(versionStatement(BOT, v))), kid: unsigned.kid, box });
      }
      const r = await link.request<PushResult>("sync.push", { stream: `memory:${BOT}`, entries, keys });
      if (!r.ok) { console.error(`M7 push ${p} refused: ${JSON.stringify(r)}`); break; }
    }
    const ms = performance.now() - t0;
    const h = highest();
    console.error(`M7 the studio's highest epoch is now ${h} after ${PUSHES} pushes in ${ms.toFixed(0)} ms; 2^31-1 is ${Math.ceil((2 ** 31) / (16 * 4096))} such pushes, about ${((2 ** 31) / (16 * 4096) * (ms / PUSHES) / 60000).toFixed(1)} min at this rate`);
    await studio.registry.revoke(server.id);
    await Bun.sleep(300);
    console.error(`M7 after revoking the server: highest ${highest()}; the studio's own newest key epoch ${Math.max(...w.at("Studio").sync.keys().filter((k) => k.creator === studio.id).map((k) => k.epoch))}`);
    expect(highest()).toBeLessThan(1_000_000);
  }, 60_000);

  test("M8: one push of one key 4096 epochs ahead, to one computer, then the revoke's own rotation", async () => {
    const w = await world(["Studio", "Laptop", "Server"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "base\n");
    for (const n of ["Laptop", "Server"]) await waitFor(() => w.at(n).read("MEMORY.md") === "base\n");
    const [studio, laptop, server] = [w.at("Studio").d, w.at("Laptop").d, w.at("Server").d];
    const link = await server.transport.connect(studio.id);
    const epoch = Math.max(0, ...w.at("Studio").sync.keys().map((k) => k.epoch)) + 4096;
    const bytes = new Uint8Array(randomBytes(32));
    const unsigned = { kid: `${epoch}.${server.id}`, epoch, creator: server.id, members: [server.id, studio.id], createdAt: DAY, commit: keyCommit(bytes) };
    const rel = "f.md";
    const data = new TextEncoder().encode("x");
    const hash = createHash("sha256").update(data).digest("hex");
    const v = { rel, vv: { [server.id]: 1 }, ts: DAY + 1000, by: server.id, hash, size: data.length, sig: "" };
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", bytes, nonce);
    c.setAAD(contentAad({ kid: unsigned.kid, bot: BOT, key: rel, hash }));
    const box = Buffer.concat([nonce, c.update(data), c.final(), c.getAuthTag()]).toString("base64url");
    const r = await link.request<PushResult>("sync.push", { stream: `memory:${BOT}`, entries: [{ ...v, sig: toBase64(server.key.sign(versionStatement(BOT, v))), kid: unsigned.kid, box }], keys: [{ ...unsigned, sig: toBase64(server.key.sign(keyStatement(unsigned))), key: toBase64(bytes) }] });
    console.error(`M8 push: ${JSON.stringify(r)}`);
    await studio.registry.revoke(server.id);
    await laptop.registry.revoke(server.id);
    await Bun.sleep(300);
    w.at("Studio").write("MEMORY.md", "after the revoke\n");
    await Bun.sleep(2000);
    console.error(`M8 studio's own newest key ${Math.max(...w.at("Studio").sync.keys().filter((k) => k.creator === studio.id).map((k) => k.epoch))}; laptop's highest ${Math.max(...w.at("Laptop").sync.keys().map((k) => k.epoch))}; laptop reads ${JSON.stringify(w.at("Laptop").read("MEMORY.md"))}`);
    expect(w.at("Laptop").read("MEMORY.md")).toBe("after the revoke\n");
  }, 60_000);
  test("M8b: one push of one key 4096 epochs ahead, to one computer, then the revoke's own rotation", async () => {
    const w = await world(["Studio", "Laptop", "Server"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "base\n");
    for (const n of ["Laptop", "Server"]) await waitFor(() => w.at(n).read("MEMORY.md") === "base\n");
    const [studio, laptop, server] = [w.at("Studio").d, w.at("Laptop").d, w.at("Server").d];
    const link = await server.transport.connect(studio.id);
    let r: unknown;
    for (let step = 1; step <= 2; step++) {
    const epoch = Math.max(0, ...w.at("Studio").sync.keys().map((k) => k.epoch)) + 4096;
    const bytes = new Uint8Array(randomBytes(32));
    const unsigned = { kid: `${epoch}.${server.id}`, epoch, creator: server.id, members: [server.id, studio.id], createdAt: DAY, commit: keyCommit(bytes) };
    const rel = `f${step}.md`;
    const data = new TextEncoder().encode("x");
    const hash = createHash("sha256").update(data).digest("hex");
    const v = { rel, vv: { [server.id]: 1 }, ts: DAY + 1000, by: server.id, hash, size: data.length, sig: "" };
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", bytes, nonce);
    c.setAAD(contentAad({ kid: unsigned.kid, bot: BOT, key: rel, hash }));
    const box = Buffer.concat([nonce, c.update(data), c.final(), c.getAuthTag()]).toString("base64url");
    r = await link.request<PushResult>("sync.push", { stream: `memory:${BOT}`, entries: [{ ...v, sig: toBase64(server.key.sign(versionStatement(BOT, v))), kid: unsigned.kid, box }], keys: [{ ...unsigned, sig: toBase64(server.key.sign(keyStatement(unsigned))), key: toBase64(bytes) }] });
    }
    console.error(`M8b push: ${JSON.stringify(r)}`);
    await studio.registry.revoke(server.id);
    await laptop.registry.revoke(server.id);
    await Bun.sleep(300);
    w.at("Studio").write("MEMORY.md", "after the revoke\n");
    await Bun.sleep(2000);
    console.error(`M8b studio's own newest key ${Math.max(...w.at("Studio").sync.keys().filter((k) => k.creator === studio.id).map((k) => k.epoch))}; laptop's highest ${Math.max(...w.at("Laptop").sync.keys().map((k) => k.epoch))}; laptop reads ${JSON.stringify(w.at("Laptop").read("MEMORY.md"))}`);
    expect(w.at("Laptop").read("MEMORY.md")).toBe("after the revoke\n");
  }, 60_000);
});
