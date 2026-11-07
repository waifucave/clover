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


import { createCipheriv as cc2, createHash as ch2, randomBytes as rb2 } from "node:crypto";
import { contentAad as aad2, keyCommit as kc2, keyStatement as ks2 } from "../memory-keys";

function keyAndEntry(creator: ClusterDevice, members: string[], epoch: number, rel: string, counter: number) {
  const bytes = new Uint8Array(rb2(32));
  const unsigned = { kid: `${epoch}.${creator.id}.${Buffer.from(rb2(9)).toString("base64url")}`, epoch, creator: creator.id, members, createdAt: DAY, commit: kc2(bytes) };
  const key = { ...unsigned, sig: toBase64(creator.key.sign(ks2(unsigned))), key: toBase64(bytes) };
  return { key, entry: entryUnder(creator, unsigned.kid, bytes, rel, counter) };
}
function entryUnder(creator: ClusterDevice, kid: string, bytes: Uint8Array, rel: string, counter: number) {
  const data = new TextEncoder().encode(`x${counter}`);
  const hash = ch2("sha256").update(data).digest("hex");
  const v = { rel, vv: { [creator.id]: counter }, ts: DAY + 1000, by: creator.id, hash, size: data.length, sig: "" };
  const nonce = rb2(12);
  const c = cc2("aes-256-gcm", bytes, nonce);
  c.setAAD(aad2({ kid, bot: BOT, key: rel, hash }));
  const box = Buffer.concat([nonce, c.update(data), c.final(), c.getAuthTag()]).toString("base64url");
  return { ...v, sig: toBase64(creator.key.sign(versionStatement(BOT, v))), kid, box };
}

describe("review-h H-M3 check 3 probes", () => {
  test("M9: a member ratchets its own epochs at the studio; the studio's own epochs and the laptop's convergence don't move", async () => {
    const w = await world(["Studio", "Laptop", "Server", "Old"]);
    await w.linkAll();
    w.at("Studio").write("MEMORY.md", "base\n");
    for (const n of ["Laptop", "Server"]) await waitFor(() => w.at(n).read("MEMORY.md") === "base\n");
    const [studio, laptop, server, old] = [w.at("Studio").d, w.at("Laptop").d, w.at("Server").d, w.at("Old").d];
    const link = await server.transport.connect(studio.id);
    let epoch = 0;
    for (let p = 0; p < 20; p++) {
      const keys: unknown[] = [];
      const entries: unknown[] = [];
      for (let i = 0; i < 16; i++) {
        epoch += 4096;
        const { key, entry } = keyAndEntry(server, [server.id, studio.id], epoch, `f${i}.md`, p * 16 + i + 1);
        keys.push(key);
        entries.push(entry);
      }
      const r = await link.request<PushResult>("sync.push", { stream: `memory:${BOT}`, entries, keys });
      if (!r.ok) { console.error(`M9 push ${p}: ${JSON.stringify(r)}`); break; }
    }
    const serverTop = Math.max(...w.at("Studio").sync.keys().filter((k) => k.creator === server.id).map((k) => k.epoch));
    await studio.registry.revoke(old.id);
    await laptop.registry.revoke(old.id);
    await Bun.sleep(300);
    w.at("Studio").write("MEMORY.md", "after\n");
    await Bun.sleep(1500);
    const own = Math.max(...w.at("Studio").sync.keys().filter((k) => k.creator === studio.id).map((k) => k.epoch));
    console.error(`M9 server's epochs at the studio reach ${serverTop}; the studio's own newest ${own}; laptop reads ${JSON.stringify(w.at("Laptop").read("MEMORY.md"))}`);
    expect(own).toBeLessThan(10);
    expect(w.at("Laptop").read("MEMORY.md")).toBe("after\n");
  }, 60_000);

  test("M10: an old key of the studio's, made before a device's revoke, replayed to a member that never held it", async () => {
    const w = await world(["Studio", "Laptop", "Server", "Old"]);
    await w.linkAll();
    const [studio, laptop, server, old] = [w.at("Studio").d, w.at("Laptop").d, w.at("Server").d, w.at("Old").d];
    w.c.net.partition(w.at("Laptop").d.key.publicKey);
    await waitFor(() => !studio.transport.links().some((l) => l.up && l.peer === laptop.id));
    w.at("Studio").write("MEMORY.md", "before\n");
    await waitFor(() => w.at("Server").read("MEMORY.md") === "before\n");
    // The server pulls from the studio and keeps the key it was sent (its members include the old device).
    const pl = await server.transport.connect(studio.id);
    const page = await pl.request<{ entries: MemoryEntry[]; keys: { kid: string; members: string[]; key: string }[] }>("sync.pull", { stream: `memory:${BOT}`, have: {}, after: "", limit: 64 });
    const k1 = page.keys[0]!;
    console.error(`M10 the studio's key ${k1.kid.split(".")[0]} names the old device: ${k1.members.includes(old.id)}, the laptop: ${k1.members.includes(laptop.id)}`);
    await studio.registry.revoke(old.id);
    await laptop.registry.revoke(old.id);
    await server.registry.revoke(old.id);
    w.c.net.heal(w.at("Laptop").d.key.publicKey);
    // Replayed before the laptop links to the studio: the old key and an entry under it.
    const e = page.entries.find((x) => x.rel === "MEMORY.md")!;
    await w.link("Server", "Laptop");
    const to = await server.transport.connect(laptop.id);
    const r = await to.request<PushResult>("sync.push", { stream: `memory:${BOT}`, entries: [e], keys: [k1] });
    console.error(`M10 replay to the laptop: ${JSON.stringify(r)}; the laptop holds it: ${w.at("Laptop").sync.keys().some((k) => k.kid === k1.kid)}`);
    expect(w.at("Laptop").sync.keys().some((k) => k.kid === k1.kid)).toBe(false);
  }, 60_000);
});
