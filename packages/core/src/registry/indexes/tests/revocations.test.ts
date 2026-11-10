// Revocation (spec §5.1; the controller's rulings B and D): the official list blocks a tree hash from any source and
// its ids for official installs; an added index's list only its own installs; blocked keeps files, data and keys; the
// last good list holds offline from the first scan; replay refused; the override behind `REVOKED_OVERRIDE`.
import { afterAll, describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeApprovalBroker } from "../../../contracts/fakes/approval-broker";
import { FakeClock } from "../../../contracts/fakes/clock";
import { MemorySecretStore } from "../../../contracts/fakes/secret-store";
import { pluginRegistryMethods } from "../../../plugin-host/registry-methods";
import { openPluginRegistry } from "../../open";
import { signatureUrl, type SignedFetch } from "../client";
import { REVOKED_OVERRIDE } from "../revocations";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function testKey(): { priv: KeyObject; hex: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return { priv: privateKey, hex: spki.subarray(spki.length - 32).toString("hex") };
}
const OFFICIAL = "https://plugins.example.test/index.json";
const OFFICIAL_LIST = "https://plugins.example.test/revocations.json";
const COMMUNITY = "https://community.example.test/index.json";
const COMMUNITY_LIST = "https://community.example.test/revocations.json";
const APP = { caller: { kind: "user", client: "app" } } as never;

function web() {
  const files = new Map<string, Uint8Array>();
  let offline = false;
  const fetch: SignedFetch = async (url, max) => {
    if (offline) throw new Error("offline");
    const b = files.get(url);
    if (b === undefined) throw new Error("it answered 404");
    if (b.byteLength > max) throw new Error("too large");
    return b;
  };
  const publish = (priv: KeyObject, url: string, value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    files.set(url, bytes);
    files.set(signatureUrl(url), new TextEncoder().encode(`${sign(null, bytes, priv).toString("base64")}\n`));
  };
  return { fetch, publish, setOffline: (v: boolean) => void (offline = v) };
}
const list = (seq: number, entries: unknown[], issued = "2026-11-10T00:00:00Z") => ({ revocations: 1, issued, seq, entries });
const index = (seq: number, revocations?: string) => ({ index: 1, issued: "2026-11-10T00:00:00Z", seq, name: "Index", ...(revocations ? { revocations } : {}), plugins: [] });

async function world(o: { override?: boolean; home?: string; w?: ReturnType<typeof web> } = {}) {
  const home = o.home ?? temp("clover-revoke-");
  const official = testKey();
  const w = o.w ?? web();
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  const opened = await openPluginRegistry({
    cloverHome: home, os: "macos", broker, secrets, settleMs: 50,
    indexes: { cacheDir: join(home, "plugins-state", "index-cache"), fetch: w.fetch, official: { url: OFFICIAL, keys: [official.hex], revocations: OFFICIAL_LIST }, ...(o.override !== undefined ? { revokedOverride: o.override } : {}) },
  });
  const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home, secrets, indexes: opened.indexes!, revocations: opened.revocations! });
  /** A plugin folder in the plugins directory, recorded as installed by the user (from `index` when named). */
  const plugin = async (id: string, from?: string) => {
    const dir = join(home, "plugins", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "clover.json"), JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0" }));
    writeFileSync(join(dir, "notes.md"), `${id}\n`);
    await opened.folders.installed(id, "user-app", from !== undefined ? { index: { url: from, version: "1.0.0" } } : {});
    return opened.registry.get(id)!.treeHash!;
  };
  return { home, w, official, opened, m, secrets, plugin };
}

describe("revocation", () => {
  test("the official list: a tree hash from any source is blocked; its ids only for official installs; files, data and keys stay", async () => {
    const x = await world();
    try {
      const localHash = await x.plugin("tarot");
      await x.plugin("luna", OFFICIAL);
      await x.plugin("nova");
      mkdirSync(join(x.home, "plugin-data", "tarot"), { recursive: true });
      writeFileSync(join(x.home, "plugin-data", "tarot", "kept.txt"), "data");
      await x.secrets.set({ owner: { kind: "plugin", pluginId: "tarot" }, name: "token" }, "dummy-token");
      x.w.publish(x.official.priv, OFFICIAL, index(1));
      x.w.publish(x.official.priv, OFFICIAL_LIST, list(1, [
        { id: "tarot", hashes: [localHash], reason: "steals keys" },
        { id: "luna", reason: "malware" },
        // An id entry doesn't reach a plugin of that id from elsewhere.
        { id: "nova", reason: "only official installs" },
      ]));
      await x.opened.revocations!.check();
      const state = (id: string) => { const r = x.opened.registry.get(id)!; return [r.state, r.reason]; };
      expect(state("tarot")).toEqual(["blocked", "revoked by Clover's plugin index: steals keys"]);
      expect(state("luna")).toEqual(["blocked", "revoked by Clover's plugin index: malware"]);
      expect(state("nova")[0]).not.toBe("blocked");
      // Nothing deleted: its folder, data and secret are all there.
      expect(existsSync(join(x.home, "plugins", "tarot", "notes.md"))).toBe(true);
      expect(existsSync(join(x.home, "plugin-data", "tarot", "kept.txt"))).toBe(true);
      expect(await x.secrets.get({ owner: { kind: "plugin", pluginId: "tarot" }, name: "token" })).not.toBeNull();
      // Switching it on is refused with why (the override is the owner's question, unset).
      expect(REVOKED_OVERRIDE).toBeUndefined();
      expect(await x.m["plugin.setEnabled"]!({ id: "tarot", enabled: true }, APP).then(() => "on", (e: Error) => e.message)).toContain("is blocked: revoked by Clover's plugin index: steals keys");
      // The list's state for Settings.
      const listed = (await x.m["plugin.index.list"]!({}, APP)) as { indexes: { revocations?: { entries?: number } }[] };
      expect(listed.indexes[0]!.revocations).toMatchObject({ url: OFFICIAL_LIST, entries: 3, stale: expect.any(Boolean) });
    } finally {
      x.opened.close();
    }
  });

  test("an added index's list applies only to ids installed from it, never to another source, even by hash", async () => {
    const x = await world();
    try {
      const community = (await import("node:crypto")).generateKeyPairSync("ed25519");
      const hex = (createPublicKey(community.privateKey).export({ format: "der", type: "spki" }) as Buffer).subarray(12).toString("hex");
      x.opened.indexes!.add(COMMUNITY, [hex]);
      await x.plugin("luna", COMMUNITY);
      const otherHash = await x.plugin("tarot", OFFICIAL);
      await x.plugin("nova");
      x.w.publish(community.privateKey, COMMUNITY, index(1, COMMUNITY_LIST));
      x.w.publish(community.privateKey, COMMUNITY_LIST, list(1, [
        { id: "luna", reason: "pulled by its index" },
        { id: "tarot", hashes: [otherHash], reason: "not its to pull" },
        { id: "nova", reason: "not its to pull" },
      ]));
      await x.opened.revocations!.check();
      expect([x.opened.registry.get("luna")!.state, x.opened.registry.get("luna")!.reason]).toEqual(["blocked", "revoked by Index: pulled by its index"]);
      expect(x.opened.registry.get("tarot")!.state).not.toBe("blocked");
      expect(x.opened.registry.get("nova")!.state).not.toBe("blocked");
      // Its index removed: its list goes, and its plugin with it is no longer blocked by it.
      x.opened.indexes!.remove(COMMUNITY);
      await x.opened.revocations!.check();
      expect(x.opened.registry.get("luna")!.state).not.toBe("blocked");
    } finally {
      x.opened.close();
    }
  });

  test("offline from the first scan: the last good list blocks before anything starts; a replayed older list lifts nothing; a newer one does", async () => {
    const home = temp("clover-revoke-offline-");
    const w = web();
    const first = await world({ home, w });
    const hash = await first.plugin("tarot");
    const priv = first.official.priv;
    w.publish(priv, OFFICIAL, index(1));
    w.publish(priv, OFFICIAL_LIST, list(4, [{ id: "tarot", hashes: [hash], reason: "bad build" }]));
    await first.opened.revocations!.check();
    expect(first.opened.registry.get("tarot")!.state).toBe("blocked");
    first.opened.close();
    // Reopened offline (the same keys: a new world would make a new official key, so reuse this one's).
    w.setOffline(true);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const again = await openPluginRegistry({
      cloverHome: home, os: "macos", broker, secrets: first.secrets, settleMs: 50,
      indexes: { cacheDir: join(home, "plugins-state", "index-cache"), fetch: w.fetch, official: { url: OFFICIAL, keys: [first.official.hex], revocations: OFFICIAL_LIST } },
    });
    try {
      expect(again.registry.get("tarot")!.state).toBe("blocked");
      await again.revocations!.check();
      expect(again.registry.get("tarot")!.state).toBe("blocked");
      expect(again.revocations!.status(OFFICIAL)).toMatchObject({ error: "offline" });
      // Online, an older signed list without the entry: refused, still blocked.
      w.setOffline(false);
      w.publish(priv, OFFICIAL_LIST, list(3, []));
      await again.revocations!.check();
      expect(again.registry.get("tarot")!.state).toBe("blocked");
      expect(again.revocations!.status(OFFICIAL)!.error).toContain("older than the copy already taken");
      // A newer one lifts it.
      w.publish(priv, OFFICIAL_LIST, list(5, []));
      await again.revocations!.check();
      expect(again.registry.get("tarot")!.state).not.toBe("blocked");
    } finally {
      again.close();
    }
  });

  test("REVOKED_OVERRIDE on: the user's switch keeps an override for that exact tree; a changed tree is blocked again", async () => {
    const x = await world({ override: true });
    try {
      await x.plugin("tarot", OFFICIAL);
      x.w.publish(x.official.priv, OFFICIAL, index(1));
      x.w.publish(x.official.priv, OFFICIAL_LIST, list(1, [{ id: "tarot", reason: "bad build" }]));
      await x.opened.revocations!.check();
      expect(x.opened.registry.get("tarot")!.state).toBe("blocked");
      await x.m["plugin.setEnabled"]!({ id: "tarot", enabled: true }, APP);
      expect(x.opened.registry.get("tarot")!.state).not.toBe("blocked");
      // The tree changes: the override named the old one, so the new one is blocked again.
      writeFileSync(join(x.home, "plugins", "tarot", "notes.md"), "changed\n");
      await x.opened.folders.refresh(join(x.home, "plugins", "tarot"));
      expect(x.opened.registry.get("tarot")!.state).toBe("blocked");
    } finally {
      x.opened.close();
    }
  });

  test("stale in Settings when the list was signed more than 7 days ago; it still applies", async () => {
    const x = await world();
    try {
      const hash = await x.plugin("tarot");
      x.w.publish(x.official.priv, OFFICIAL, index(1));
      x.w.publish(x.official.priv, OFFICIAL_LIST, list(1, [{ id: "tarot", hashes: [hash], reason: "bad" }], "2020-01-01T00:00:00Z"));
      await x.opened.revocations!.check();
      expect(x.opened.revocations!.status(OFFICIAL)).toMatchObject({ stale: true, entries: 1 });
      expect(x.opened.registry.get("tarot")!.state).toBe("blocked");
    } finally {
      x.opened.close();
    }
  });
});
