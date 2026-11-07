// Cloud computers (spec §9.2; plan §4 J, M3) against a fake provider: no VM, no account, no network.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../src/contracts/common";
import {
  CloudComputers, cloudLabelOf, FileCloudStateStore, PairingTokens,
  type CloudAuthority, type CloudCard, type CloudFolder, type CloudInstance, type CloudProviderHandler,
} from "../../src/computers/cloud";
import { cloudInit, readCloudJoinFiles, removeCloudJoinFiles } from "../../src/computers/image";

/** A cloud in memory: VMs with their label, and every call. Acts only on a VM whose id and label match. */
class FakeProvider implements CloudProviderHandler {
  readonly calls: string[] = [];
  readonly userData: string[] = [];
  readonly vms = new Map<string, CloudInstance & { userData: string }>();
  /** The next create makes the VM and then throws (the answer lost), or throws before making it. */
  failNext: "after" | "before" | undefined;
  #n = 0;
  async create(a: { name: string; size: string; region: string; userData: string; label: string }) {
    this.calls.push(`create ${a.name} ${a.size} ${a.region} ${a.label}`);
    const fail = this.failNext;
    this.failNext = undefined;
    if (fail === "before") throw new Error("the cloud said no");
    this.userData.push(a.userData);
    const serverId = `srv-${++this.#n}`;
    this.vms.set(serverId, { serverId, label: a.label, region: a.region, size: a.size, state: "running", address: `203.0.113.${this.#n}`, userData: a.userData });
    if (fail === "after") throw new Error("the answer was lost");
    return { serverId, address: `203.0.113.${this.#n}` };
  }
  async list(a: { label?: string }) {
    this.calls.push(`list ${a.label ?? "*"}`);
    return [...this.vms.values()].filter((v) => a.label === undefined || v.label === a.label).map(({ userData: _, ...v }) => ({ ...v }));
  }
  #mine(a: { serverId: string; label: string }) {
    const v = this.vms.get(a.serverId);
    if (v && v.label !== a.label) throw new Error(`${a.serverId} isn't the Clover computer ${a.label}`);
    return v;
  }
  async resize(a: { serverId: string; label: string; size: string }) {
    this.calls.push(`resize ${a.serverId} ${a.label} ${a.size}`);
    this.#mine(a)!.size = a.size;
  }
  async delete(a: { serverId: string; label: string }) {
    this.calls.push(`delete ${a.serverId} ${a.label}`);
    if (this.#mine(a)) this.vms.delete(a.serverId);
  }
  async status(a: { serverId: string; label: string }) {
    const v = this.#mine(a);
    return { state: v ? v.state : ("gone" as const) };
  }
  async paired(a: { serverId: string; label: string }) {
    this.calls.push(`paired ${a.serverId} ${a.label}`);
  }
}

/** Lane H's lease, as the cloud sees it: held or not, under a scope and an epoch. */
class FakeAuthority implements CloudAuthority {
  holding = true;
  epoch = 1;
  canAct() { return this.holding; }
  tenure() { return this.holding ? `group-1:${this.epoch}` : undefined; }
  /** Another computer took the lease; this one got it back later under a new epoch, or never. */
  lose() { this.holding = false; }
  regain() { this.holding = true; this.epoch++; }
}

const SHA = "a".repeat(64);
const userData = ({ name, token }: { name: string; token: string }) => cloudInit({
  name, token, join: "join-ticket-for-tests",
  daemon: { url: "https://example.invalid/clover-core-linux-x64.tar.gz", sha256: SHA },
  browser: { url: "https://example.invalid/chrome-headless-shell-linux64.zip", sha256: SHA },
});
const tokenIn = (y: string) => /pairing-token"?\n[^\n]*\n[^\n]*\n[^\n]*\n\s*content: "([A-Za-z0-9_-]+)"/.exec(y)?.[1];
const LABEL = "computer-hetzner-1";
const NONE = { created: [], adopted: [], resized: [], deleted: [], repaired: [], declined: [], failed: [] };

interface SetupOptions {
  answers?: (c: CloudCard) => boolean | Promise<boolean>;
  home?: string;
  provider?: FakeProvider;
  authority?: FakeAuthority;
  paired?: Set<string>;
  now?: { t: number };
}

function setup(o: SetupOptions = {}) {
  const now = o.now ?? { t: 1_000_000 };
  const clock = { now: () => now.t };
  const home = o.home ?? mkdtempSync(join(tmpdir(), "lane-j-cloud-"));
  const provider = o.provider ?? new FakeProvider();
  const authority = o.authority ?? new FakeAuthority();
  const paired = o.paired ?? new Set<string>();
  const cards: CloudCard[] = [];
  const mains: string[] = [];
  const answers = o.answers ?? (() => true);
  const cloud = new CloudComputers({
    clock, store: new FileCloudStateStore(home), provider: (id) => (id === "hetzner" ? provider : undefined), providerIds: () => ["hetzner"],
    authority, confirm: async (c) => { cards.push(c); return answers(c); }, userData, makeMain: async (n) => { mains.push(n); },
    isPaired: (n) => paired.has(n),
  });
  return { cloud, provider, authority, cards, mains, home, paired, now, advance: (ms: number) => { now.t += ms; } };
}

const folder = (o: Partial<CloudFolder> = {}): CloudFolder => ({ folder: "computer-hetzner-1", provider: "hetzner", name: "Cloud1", size: "cx22", region: "fsn1", ...o });

describe("cloud computers", () => {
  test("a new folder asks before the VM is made, with its label; the VM pairs with its token once through H's door", async () => {
    const { cloud, provider, cards, mains, home } = setup();
    const door = cloud.door(() => [folder()]);
    expect(await cloud.reconcile([folder()])).toMatchObject({ created: ["Cloud1"] });
    expect(cards[0]).toEqual({ kind: "cloud-create", name: "Cloud1", provider: "hetzner", size: "cx22", region: "fsn1", folder: "computer-hetzner-1" });
    expect(provider.calls.filter((c) => !c.startsWith("list"))).toEqual([`create Cloud1 cx22 fsn1 ${LABEL}`]);
    // The token travels in the VM's cloud-init only; the main's home keeps its hash and expiry, 0600, never the token.
    const token = tokenIn(provider.userData[0]!)!;
    expect(token).toBeDefined();
    const file = join(home, "computers", "cloud.json");
    const saved = readFileSync(file, "utf8");
    expect(saved).toContain("srv-1");
    expect(saved).not.toContain(token);
    expect(JSON.parse(saved).tokens).toMatchObject([{ computer: "Cloud1", tenure: "group-1:1" }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await door.consume(token, "device-vm-1")).toEqual({ computer: "Cloud1" });
    expect(provider.calls).toContain(`paired srv-1 ${LABEL}`);
    expect(cards.at(-1)).toEqual({ kind: "cloud-make-main", name: "Cloud1" });
    expect(mains).toEqual(["Cloud1"]);
    expect(cloud.get("Cloud1")).toMatchObject({ state: "paired", device: "device-vm-1" });
    // A token works once.
    expect(await door.consume(token, "device-vm-2")).toBeNull();
    // Nothing more to do for the same folder.
    expect(await cloud.reconcile([folder()])).toEqual(NONE);
  });

  test("a declined card makes nothing; a folder that says no main isn't asked", async () => {
    const declined = setup({ answers: () => false });
    expect(await declined.cloud.reconcile([folder()])).toMatchObject({ declined: ["Cloud1"], created: [] });
    expect(declined.provider.calls.filter((c) => !c.startsWith("list"))).toEqual([]);
    expect(declined.cloud.list()).toEqual([]);
    const { cloud, provider, cards } = setup();
    await cloud.reconcile([folder({ makeMain: "no" })]);
    await cloud.door(() => [folder({ makeMain: "no" })]).consume(tokenIn(provider.userData[0]!)!, "device-vm-1");
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
  });

  test("editing the size asks before resizing; removing the folder asks before deleting; deleting always asks", async () => {
    const { cloud, provider, cards, paired } = setup({ answers: (c) => c.kind !== "cloud-delete" || c.why === "asked" });
    await cloud.reconcile([folder()]);
    paired.add("Cloud1");
    expect(await cloud.reconcile([folder({ size: "cx32" })])).toMatchObject({ resized: ["Cloud1"] });
    expect(cards.at(-1)).toEqual({ kind: "cloud-resize", name: "Cloud1", provider: "hetzner", from: "cx22", to: "cx32" });
    expect(provider.calls.at(-1)).toBe(`resize srv-1 ${LABEL} cx32`);
    // The folder goes; the user keeps the VM; it isn't asked about again.
    expect(await cloud.reconcile([])).toMatchObject({ declined: ["Cloud1"], deleted: [] });
    expect(await cloud.reconcile([])).toEqual(NONE);
    expect(cloud.get("Cloud1")).toBeDefined();
    // Deleting it on purpose still asks, and then deletes, by its id and its label.
    expect(await cloud.delete("Cloud1")).toBe(true);
    expect(cards.at(-1)).toMatchObject({ kind: "cloud-delete", why: "asked" });
    expect(provider.calls.at(-1)).toBe(`delete srv-1 ${LABEL}`);
    expect(cloud.get("Cloud1")).toBeUndefined();
    expect(provider.vms.size).toBe(0);
  });

  test("a folder that's off or waiting for its OK keeps its VM unasked; a provider that's gone fails before the card", async () => {
    const { cloud, provider, cards, home } = setup();
    await cloud.reconcile([folder()]);
    expect(await cloud.reconcile([], new Set(["computer-hetzner-1"]))).toEqual(NONE);
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    expect(provider.vms.size).toBe(1);
    const orphan = new CloudComputers({
      clock: { now: () => 0 }, store: new FileCloudStateStore(home), provider: () => undefined, providerIds: () => [],
      authority: new FakeAuthority(), confirm: async (c) => { cards.push(c); return true; }, userData,
    });
    expect(isContractError(await orphan.delete("Cloud1").catch((e) => e), "not_installed")).toBe(true);
    // Nor does a reconcile without the provider delete anything: its VMs can't be seen, so they are left alone.
    expect(await orphan.reconcile([])).toEqual(NONE);
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    expect(orphan.get("Cloud1")).toBeDefined();
  });

  test("a folder whose name changed keeps its VM: no second VM and no delete card", async () => {
    const { cloud, provider, cards } = setup();
    await cloud.reconcile([folder()]);
    const r = await cloud.reconcile([folder({ name: "Cloud9" })]);
    expect(r).toMatchObject({ created: [], deleted: [], declined: [] });
    expect(r.failed[0]!.reason).toContain("rename it in the tree");
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    expect(provider.vms.size).toBe(1);
    expect(cloud.get("Cloud1")).toBeDefined();
  });

  test("a folder that says keep: removing it never asks and keeps the VM", async () => {
    const { cloud, provider, cards } = setup();
    await cloud.reconcile([folder({ onRemove: "keep" })]);
    expect(await cloud.reconcile([])).toEqual(NONE);
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    expect(provider.vms.size).toBe(1);
  });

  test("an unknown provider or a bad name refuses; a pairing token expires and is bound to its tenure", async () => {
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
    const t = tokens.mint("Cloud2", "g:1");
    now = 2000;
    expect(tokens.consume(t, "g:1")).toBeNull();
    const t2 = tokens.mint("Cloud2", "g:1");
    const t3 = tokens.mint("Cloud2", "g:1");
    expect(tokens.consume(t2, "g:1")).toBeNull(); // a newer token replaces it
    expect(tokens.consume(t3, "g:2")).toBeNull(); // another main's tenure: spent, and refused
    const t4 = tokens.mint("Cloud2", "g:2");
    expect(tokens.consume(t4, "g:2")).toBe("Cloud2");
    // A label is the folder's id, `/` written `--`, and never longer than the clouds take.
    expect(cloudLabelOf("luna/computer-a")).toBe("luna--computer-a");
    expect(cloudLabelOf(`${"a".repeat(40)}/${"b".repeat(40)}`)).toMatch(/^h-[0-9a-f]{40}$/);
  });
});

describe("only the lease's holder acts (#254, B1)", () => {
  test("the lease moves while the create card is open: the user's yes does nothing, and no provider call is made", async () => {
    let answer!: (yes: boolean) => void;
    const authority = new FakeAuthority();
    const { cloud, provider, cards } = setup({ authority, answers: () => new Promise<boolean>((r) => { answer = r; }) });
    const run = cloud.reconcile([folder()]);
    for (let i = 0; i < 20 && cards.length === 0; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    authority.lose();
    answer(true);
    const r = await run;
    expect(r.created).toEqual([]);
    expect(r.failed).toMatchObject([{ name: "Cloud1" }]);
    expect(r.failed[0]!.reason).toContain("lost the main computer's lease");
    expect(provider.calls.filter((c) => !c.startsWith("list"))).toEqual([]);
    expect(cloud.list()).toEqual([]);
    // Taken back under a new epoch is another tenure: a card answered for the old one still did nothing.
    authority.regain();
    expect(provider.vms.size).toBe(0);
  });

  test("a resize or delete card answered after the lease moved does nothing; a computer without the lease never asks", async () => {
    const authority = new FakeAuthority();
    let onCard: (c: CloudCard) => void = () => {};
    const { cloud, provider, cards, paired } = setup({ authority, answers: (c) => { onCard(c); return true; } });
    await cloud.reconcile([folder()]);
    paired.add("Cloud1");
    onCard = (c) => { if (c.kind !== "cloud-create") authority.regain(); };
    expect((await cloud.reconcile([folder({ size: "cx52" })])).failed[0]!.reason).toContain("lost the main computer's lease");
    expect((await cloud.delete("Cloud1").catch((e) => e)).code).toBe("not_main");
    expect(provider.calls.filter((c) => c.startsWith("resize") || c.startsWith("delete"))).toEqual([]);
    const asked = cards.length;
    authority.lose();
    expect(await cloud.reconcile([])).toEqual(NONE);
    expect((await cloud.delete("Cloud1").catch((e) => e)).code).toBe("not_main");
    expect(await cloud.door(() => []).consume("x".repeat(43), "device-1")).toBeNull();
    expect(cards.length).toBe(asked);
  });
});

describe("the cloud is the source of truth (#254, B2)", () => {
  test("a new main with no cache finds every VM by its label: it adopts them, never makes a second, and never asks twice", async () => {
    const provider = new FakeProvider();
    const first = setup({ provider });
    await first.cloud.reconcile([folder(), folder({ folder: "computer-hetzner-2", name: "Cloud2" })]);
    expect(provider.vms.size).toBe(2);
    // Another computer becomes the main one: its own home, no cloud.json. Cloud1 has paired, Cloud2 hasn't.
    const authority = new FakeAuthority();
    authority.epoch = 2;
    const next = setup({ provider, authority, paired: new Set(["Cloud1"]), answers: (c) => c.kind !== "cloud-repair" });
    const r = await next.cloud.reconcile([folder(), folder({ folder: "computer-hetzner-2", name: "Cloud2" })]);
    expect(r.adopted.sort()).toEqual(["Cloud1", "Cloud2"]);
    expect(r.created).toEqual([]);
    expect(next.cards.map((c) => c.kind)).toEqual(["cloud-repair"]); // Cloud2: unpaired, its token was another main's
    expect(next.cards[0]).toEqual({ kind: "cloud-repair", name: "Cloud2", provider: "hetzner", why: "main-changed" });
    expect(provider.calls.filter((c) => c.startsWith("create"))).toHaveLength(2);
    expect(next.cloud.get("Cloud1")).toMatchObject({ state: "paired", serverId: "srv-1", label: LABEL });
    // A VM whose folder went is found by its label too, and deleting it asks.
    const r2 = await next.cloud.reconcile([folder()]);
    expect(next.cards.at(-1)).toEqual({ kind: "cloud-delete", name: "Cloud2", provider: "hetzner", why: "folder-removed" });
    expect(r2.deleted).toEqual(["Cloud2"]);
    expect(provider.calls.at(-1)).toBe("delete srv-2 computer-hetzner-2");
    const asked = next.cards.length;
    expect(await next.cloud.reconcile([folder()])).toEqual(NONE);
    expect(next.cards.length).toBe(asked);
  });

  test("a `creating` entry is written before the create; a lost answer is settled from the cloud by label, a failed create is dropped", async () => {
    const provider = new FakeProvider();
    const { cloud, cards, home } = setup({ provider });
    provider.failNext = "after";
    expect((await cloud.reconcile([folder()])).failed[0]!.reason).toContain("the answer was lost");
    expect(JSON.parse(readFileSync(join(home, "computers", "cloud.json"), "utf8")).vms).toMatchObject([{ name: "Cloud1", label: LABEL, state: "creating" }]);
    // The next pass finds it by its label: no second VM, no card, and its token (made before the create) still waits.
    expect(await cloud.reconcile([folder()])).toMatchObject({ adopted: [], created: [], failed: [] });
    expect(cloud.get("Cloud1")).toMatchObject({ state: "created", serverId: "srv-1" });
    expect(provider.vms.size).toBe(1);
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    // A create the cloud refused leaves nothing behind, and the next pass asks again.
    const other = setup();
    other.provider.failNext = "before";
    expect((await other.cloud.reconcile([folder()])).failed[0]!.reason).toContain("the cloud said no");
    expect(other.cloud.list()).toEqual([]);
    expect(await other.cloud.reconcile([folder()])).toMatchObject({ created: ["Cloud1"] });
    expect(other.cards.map((c) => c.kind)).toEqual(["cloud-create", "cloud-create"]);
  });

  test("a VM with the label that another main made meanwhile is adopted, not made twice", async () => {
    const provider = new FakeProvider();
    const { cloud, cards } = setup({
      provider,
      answers: async () => {
        // While the card is open, another main makes it.
        provider.vms.set("srv-9", { serverId: "srv-9", label: LABEL, region: "fsn1", size: "cx22", state: "running", userData: "" });
        return true;
      },
    });
    expect(await cloud.reconcile([folder()])).toEqual(NONE);
    expect(provider.calls.filter((c) => c.startsWith("create"))).toEqual([]);
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
  });
});

describe("pairing tokens (#254, should-fix 1)", () => {
  test("the hash survives a restart; an expired token gets a pair-again card that deletes and remakes the empty VM", async () => {
    const provider = new FakeProvider();
    const home = mkdtempSync(join(tmpdir(), "lane-j-cloud-"));
    const now = { t: 1_000_000 };
    const first = setup({ provider, home, now });
    await first.cloud.reconcile([folder()]);
    const token = tokenIn(provider.userData[0]!)!;
    // A restart: the same home, a new CloudComputers. The token still works, once.
    const again = setup({ provider, home, now });
    expect(await again.cloud.door(() => [folder({ makeMain: "no" })]).consume(token, "device-vm-1")).toEqual({ computer: "Cloud1" });
    // Another VM whose token runs out before it pairs.
    await again.cloud.reconcile([folder(), folder({ folder: "computer-hetzner-2", name: "Cloud2" })]);
    const late = tokenIn(provider.userData.at(-1)!)!;
    now.t += 2 * 60 * 60 * 1000;
    const r = await again.cloud.reconcile([folder(), folder({ folder: "computer-hetzner-2", name: "Cloud2" })]);
    expect(r.repaired).toEqual(["Cloud2"]);
    expect(again.cards.at(-1)).toEqual({ kind: "cloud-repair", name: "Cloud2", provider: "hetzner", why: "token-expired" });
    // The old VM is deleted and a new one made with a new token: nothing new goes into a running VM.
    expect(provider.calls.filter((c) => !c.startsWith("list")).slice(-2)).toEqual(["delete srv-2 computer-hetzner-2", "create Cloud2 cx22 fsn1 computer-hetzner-2"]);
    const fresh = tokenIn(provider.userData.at(-1)!)!;
    expect(fresh).not.toBe(late);
    expect(await again.cloud.door(() => []).consume(late, "device-vm-2")).toBeNull();
    expect(await again.cloud.door(() => [folder({ folder: "computer-hetzner-2", name: "Cloud2", makeMain: "no" })]).consume(fresh, "device-vm-2")).toEqual({ computer: "Cloud2" });
    // Cloud1 paired: never asked to pair again.
    expect(again.cards.filter((c) => c.kind === "cloud-repair").map((c) => (c as { name: string }).name)).toEqual(["Cloud2"]);
  });
});

describe("the official image", () => {
  test("the metadata block comes first, before any download or user service; downloads are pinned and checked", () => {
    const y = userData({ name: "Cloud1", token: "t".repeat(43) });
    expect(y.startsWith("#cloud-config\n")).toBe(true);
    expect(y).toContain(`sha256sum -c -`);
    expect(y).toContain("loginctl enable-linger clover");
    for (const a of ["169.254.169.254", "fd00:ec2::254", "fd20:ce::254"]) expect(y).toContain(a);
    const lines = y.split("\n");
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    // bootcmd applies it as early as cloud-init can, when nft is there already.
    expect(at("bootcmd:")).toBeGreaterThan(0);
    expect(at("bootcmd:")).toBeLessThan(at("runcmd:"));
    expect(lines[at("bootcmd:") + 1]).toContain("nft -f -");
    // The first runcmd lines load it, keep it across boots and enable nftables, before any curl or systemctl --user.
    const run = at("runcmd:");
    expect(lines.slice(run + 1, run + 5).join("\n")).toContain("nft -f /etc/nftables.d/clover-metadata.nft");
    expect(at("systemctl enable nftables")).toBeLessThan(at("curl "));
    expect(at("systemctl enable nftables")).toBeLessThan(at("systemctl --user"));
    expect(at("nft -f /etc/nftables.d/clover-metadata.nft")).toBeLessThan(at("curl "));
    // Reloading it is idempotent (no rule twice after a reboot).
    expect(y).toContain("delete table inet clover_metadata");
    // Nothing a value carries can break out of its quoting.
    expect(() => userData({ name: "Cloud1\nruncmd:", token: "t".repeat(43) })).toThrow();
    expect(() => cloudInit({ name: "Cloud1", token: "t".repeat(43), join: "a\nb", daemon: { url: "https://x.invalid/a", sha256: SHA }, browser: { url: "https://x.invalid/b", sha256: SHA } })).toThrow();
    expect(() => cloudInit({ name: "Cloud1", token: "t".repeat(43), join: "j", daemon: { url: "http://x.invalid/a", sha256: SHA }, browser: { url: "https://x.invalid/b", sha256: SHA } })).toThrow();
  });
});

describe("on the VM after pairing (#254, should-fix 6)", () => {
  test("the join ticket and the spent token are deleted; the name stays", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-j-etc-clover-"));
    writeFileSync(join(dir, "name"), "Cloud1\n");
    writeFileSync(join(dir, "join"), "join-ticket-for-tests\n");
    writeFileSync(join(dir, "pairing-token"), `${"t".repeat(43)}\n`);
    expect(readCloudJoinFiles(dir)).toEqual({ name: "Cloud1", join: "join-ticket-for-tests", token: "t".repeat(43) });
    removeCloudJoinFiles(dir);
    expect(existsSync(join(dir, "join")) || existsSync(join(dir, "pairing-token"))).toBe(false);
    expect(existsSync(join(dir, "name"))).toBe(true);
    expect(readCloudJoinFiles(dir)).toBeNull();
    removeCloudJoinFiles(dir); // twice is fine
  });
});
