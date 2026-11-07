// Cloud computers (spec §9.2; plan §4 J, M3) against a fake provider: no VM, no account, no network.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../src/contracts/common";
import { CloudComputers, FileCloudStateStore, PairingTokens, type CloudCard, type CloudFolder, type CloudProviderHandler } from "../../src/computers/cloud";
import { cloudInit } from "../../src/computers/image";

class FakeProvider implements CloudProviderHandler {
  readonly calls: string[] = [];
  readonly userData: string[] = [];
  #n = 0;
  async create(a: { name: string; size: string; region: string; userData: string }) {
    this.calls.push(`create ${a.name} ${a.size} ${a.region}`);
    this.userData.push(a.userData);
    return { serverId: `srv-${++this.#n}`, address: `203.0.113.${this.#n}` };
  }
  async resize(a: { serverId: string; size: string }) { this.calls.push(`resize ${a.serverId} ${a.size}`); }
  async delete(a: { serverId: string }) { this.calls.push(`delete ${a.serverId}`); }
  async status() { return { state: "running" as const }; }
}

const SHA = "a".repeat(64);
const userData = ({ name, token }: { name: string; token: string }) => cloudInit({
  name, token, join: "join-ticket-for-tests",
  daemon: { url: "https://example.invalid/clover-core-linux-x64.tar.gz", sha256: SHA },
  browser: { url: "https://example.invalid/chrome-headless-shell-linux64.zip", sha256: SHA },
});

function setup(answers: (c: CloudCard) => boolean = () => true) {
  let now = 1_000_000;
  const clock = { now: () => now };
  const home = mkdtempSync(join(tmpdir(), "lane-j-cloud-"));
  const provider = new FakeProvider();
  const cards: CloudCard[] = [];
  const mains: string[] = [];
  const cloud = new CloudComputers({
    clock, store: new FileCloudStateStore(home), provider: (id) => (id === "hetzner" ? provider : undefined),
    confirm: async (c) => { cards.push(c); return answers(c); }, userData, makeMain: async (n) => { mains.push(n); },
  });
  return { cloud, provider, cards, mains, home, advance: (ms: number) => { now += ms; } };
}

const folder = (o: Partial<CloudFolder> = {}): CloudFolder => ({ folder: "computer-hetzner-1", provider: "hetzner", name: "Cloud1", size: "cx22", region: "fsn1", ...o });

describe("cloud computers", () => {
  test("a new folder asks before the VM is made; the VM pairs with its token once, then the user is asked about main", async () => {
    const { cloud, provider, cards, mains, home } = setup();
    expect(await cloud.reconcile([folder()])).toMatchObject({ created: ["Cloud1"] });
    expect(cards[0]).toEqual({ kind: "cloud-create", name: "Cloud1", provider: "hetzner", size: "cx22", region: "fsn1", folder: "computer-hetzner-1" });
    expect(provider.calls).toEqual(["create Cloud1 cx22 fsn1"]);
    // The token travels in the VM's cloud-init only; the core keeps the VM's state, never the token.
    const token = /pairing-token"?\n[^\n]*\n[^\n]*\n[^\n]*\n\s*content: "([A-Za-z0-9_-]+)"/.exec(provider.userData[0]!)?.[1];
    expect(token).toBeDefined();
    const saved = readFileSync(join(home, "computers", "cloud.json"), "utf8");
    expect(saved).toContain("srv-1");
    expect(saved).not.toContain(token!);
    expect(await cloud.paired(token!, [folder()])).toBe("Cloud1");
    expect(cards.at(-1)).toEqual({ kind: "cloud-make-main", name: "Cloud1" });
    expect(mains).toEqual(["Cloud1"]);
    expect(cloud.get("Cloud1")!.state).toBe("paired");
    // A token works once.
    expect(await cloud.paired(token!, [folder()])).toBeNull();
    // Nothing more to do for the same folder.
    expect(await cloud.reconcile([folder()])).toEqual({ created: [], resized: [], deleted: [], declined: [], failed: [] });
  });

  test("a declined card makes nothing; a folder that says no main isn't asked", async () => {
    const declined = setup(() => false);
    expect(await declined.cloud.reconcile([folder()])).toMatchObject({ declined: ["Cloud1"], created: [] });
    expect(declined.provider.calls).toEqual([]);
    const { cloud, provider, cards } = setup();
    await cloud.reconcile([folder({ makeMain: "no" })]);
    const token = /content: "([A-Za-z0-9_-]{40,})"/.exec(provider.userData[0]!)![1]!;
    await cloud.paired(token, [folder({ makeMain: "no" })]);
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
  });

  test("editing the size asks before resizing; removing the folder asks before deleting; deleting always asks", async () => {
    const { cloud, provider, cards } = setup((c) => c.kind !== "cloud-delete" || c.why === "asked");
    await cloud.reconcile([folder()]);
    expect(await cloud.reconcile([folder({ size: "cx32" })])).toMatchObject({ resized: ["Cloud1"] });
    expect(cards.at(-1)).toEqual({ kind: "cloud-resize", name: "Cloud1", provider: "hetzner", from: "cx22", to: "cx32" });
    expect(provider.calls.at(-1)).toBe("resize srv-1 cx32");
    // The folder goes; the user keeps the VM; it isn't asked about again.
    expect(await cloud.reconcile([])).toMatchObject({ declined: ["Cloud1"], deleted: [] });
    expect(await cloud.reconcile([])).toEqual({ created: [], resized: [], deleted: [], declined: [], failed: [] });
    expect(cloud.get("Cloud1")).toBeDefined();
    // Deleting it on purpose still asks, and then deletes.
    expect(await cloud.delete("Cloud1")).toBe(true);
    expect(cards.at(-1)).toMatchObject({ kind: "cloud-delete", why: "asked" });
    expect(provider.calls.at(-1)).toBe("delete srv-1");
    expect(cloud.get("Cloud1")).toBeUndefined();
  });

  test("a folder that's off or waiting for its OK keeps its VM unasked; a provider that's gone fails before the card", async () => {
    const { cloud, provider, cards } = setup();
    await cloud.reconcile([folder()]);
    expect(await cloud.reconcile([], new Set(["computer-hetzner-1"]))).toEqual({ created: [], resized: [], deleted: [], declined: [], failed: [] });
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    expect(provider.calls).toEqual(["create Cloud1 cx22 fsn1"]);
    const orphan = new CloudComputers({
      clock: { now: () => 0 }, store: { load: () => cloud.list(), save: () => {} }, provider: () => undefined,
      confirm: async (c) => { cards.push(c); return true; }, userData,
    });
    expect(isContractError(await orphan.delete("Cloud1").catch((e) => e), "not_installed")).toBe(true);
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
  });

  test("a folder whose name changed keeps its VM: no second VM and no delete card", async () => {
    const { cloud, provider, cards } = setup();
    await cloud.reconcile([folder()]);
    const r = await cloud.reconcile([folder({ name: "Cloud9" })]);
    expect(r).toMatchObject({ created: [], deleted: [], declined: [] });
    expect(r.failed[0]!.reason).toContain("rename it in the tree");
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    expect(provider.calls).toEqual(["create Cloud1 cx22 fsn1"]);
    expect(cloud.get("Cloud1")).toBeDefined();
  });

  test("a folder that says keep: removing it never asks and keeps the VM", async () => {
    const { cloud, provider, cards } = setup();
    await cloud.reconcile([folder({ onRemove: "keep" })]);
    expect(await cloud.reconcile([])).toEqual({ created: [], resized: [], deleted: [], declined: [], failed: [] });
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    expect(provider.calls).toEqual(["create Cloud1 cx22 fsn1"]);
  });

  test("an unknown provider or a bad name refuses; a pairing token expires", async () => {
    const { cloud } = setup();
    // One folder's failure doesn't stop the others, and a folder that's there isn't asked about deleting.
    const r = await cloud.reconcile([folder({ provider: "nimbus" }), folder({ folder: "computer-bad", name: "CON" + "/x" }), folder({ folder: "computer-hetzner-2", name: "Cloud2" })]);
    expect(r.created).toEqual(["Cloud2"]);
    expect(r.failed.map((f) => f.name)).toEqual(["Cloud1", "CON/x"]);
    expect(r.failed[0]!.reason).toContain("no computer provider nimbus");
    // Another folder can't take a name that's another folder's computer.
    expect((await cloud.reconcile([folder({ folder: "computer-hetzner-2", name: "Cloud2" }), folder({ folder: "computer-other", name: "Cloud2", size: "cx52" })])).failed).toMatchObject([{ name: "Cloud2" }]);
    let now = 0;
    const tokens = new PairingTokens({ clock: { now: () => now }, ttlMs: 1000 });
    const t = tokens.mint("Cloud2");
    now = 2000;
    expect(tokens.consume(t)).toBeNull();
    const t2 = tokens.mint("Cloud2");
    const t3 = tokens.mint("Cloud2");
    expect(tokens.consume(t2)).toBeNull(); // a newer token replaces it
    expect(tokens.consume(t3)).toBe("Cloud2");
  });
});

describe("the official image", () => {
  test("downloads are pinned and checked, lingering is on, and the metadata address is blocked last", () => {
    const y = userData({ name: "Cloud1", token: "t".repeat(43) });
    expect(y.startsWith("#cloud-config\n")).toBe(true);
    expect(y).toContain(`sha256sum -c -`);
    expect(y).toContain("loginctl enable-linger clover");
    expect(y).toContain("169.254.169.254");
    expect(y).toContain("fd00:ec2::254");
    const lines = y.split("\n");
    const nft = lines.findIndex((l) => l.includes("nft -f /etc/nftables.d/clover-metadata.nft"));
    const daemon = lines.findIndex((l) => l.includes("systemctl --user enable --now clover-core"));
    expect(nft).toBeGreaterThan(daemon);
    // Nothing a value carries can break out of its quoting.
    expect(() => userData({ name: "Cloud1\nruncmd:", token: "t".repeat(43) })).toThrow();
    expect(() => cloudInit({ name: "Cloud1", token: "t".repeat(43), join: "a\nb", daemon: { url: "https://x.invalid/a", sha256: SHA }, browser: { url: "https://x.invalid/b", sha256: SHA } })).toThrow();
    expect(() => cloudInit({ name: "Cloud1", token: "t".repeat(43), join: "j", daemon: { url: "http://x.invalid/a", sha256: SHA }, browser: { url: "https://x.invalid/b", sha256: SHA } })).toThrow();
  });
});
