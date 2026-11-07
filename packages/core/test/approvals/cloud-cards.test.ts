// C-M3: lane J's cloud cards as sealed cards through the broker. Table words in `text`, names and ids in `code`, no
// "always" on any, and a duplicate offers to delete only when the kept VM ranks strictly above it.
import { describe, expect, test } from "bun:test";
import type { Card } from "@waifucave/clover-protocol";
import { CLOUD_CARD_TEXT, CLOUD_PAIRED_TEXT, CLOUD_VALUE_MAX, CloudCardDesk, cloudCardConfirm, cloudCardRequest, cloudCardSubject, type CloudCardRequest } from "../../src/approvals/cloud-cards";
import { CloverApprovalBroker, type CloverApprovalRequest } from "../../src/approvals/broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { CloudCard } from "../../src/computers/cloud";

const TABLE = new Set([...Object.values(CLOUD_CARD_TEXT).flatMap((t) => Object.values(t) as string[]), ...Object.values(CLOUD_PAIRED_TEXT), "Clover doesn't know whether these devices are paired."]);
const ALL: CloudCardRequest[] = [
  { kind: "cloud-create", name: "studio-cloud", provider: "hetzner", size: "cx22", region: "fsn1", folder: "Projects" },
  { kind: "cloud-resize", name: "studio-cloud", provider: "hetzner", from: "cx22", to: "cx32" },
  { kind: "cloud-delete", name: "studio-cloud", provider: "gcp", why: "folder-removed" },
  { kind: "cloud-delete", name: "studio-cloud", provider: "gcp", why: "asked" },
  { kind: "cloud-duplicate", name: "Projects", provider: "hetzner", serverId: "4711", region: "fsn1", paired: false, keeper: { serverId: "42", region: "fsn1", paired: true }, deletable: true },
  { kind: "cloud-duplicate", name: "Projects", provider: "hetzner", serverId: "4711", region: "fsn1", paired: true, keeper: { serverId: "42", paired: true }, deletable: false },
  { kind: "cloud-repair", name: "studio-cloud", provider: "gcp", why: "token-expired" },
  { kind: "cloud-repair", name: "studio-cloud", provider: "gcp", why: "main-changed" },
  { kind: "cloud-make-main", name: "studio-cloud" },
];

describe("cloud cards", () => {
  test("every kind: a change card, Clover's words in text, names and ids in code, never an always", () => {
    for (const c of ALL) {
      const r = cloudCardRequest(c);
      expect(r.kind).toBe("change");
      expect(["computer-create", "computer-resize", "computer-delete", "device-add", "main-computer"]).toContain(r.change!);
      for (const v of Object.values(r.fields)) if (v.type === "text") expect(TABLE.has(v.text as string)).toBe(true);
      expect(r.options!.some((o) => o.remember !== undefined)).toBe(false);
      expect(r.ruleKey).toBeUndefined();
    }
  });

  test("a duplicate: both VMs and whether each device is paired; delete only when the keeper ranks above it", () => {
    const deletable = cloudCardRequest(ALL[4]!);
    expect(deletable.fields.what).toEqual({ type: "text", text: CLOUD_CARD_TEXT["cloud-duplicate"].what });
    expect((deletable.fields.detail as { code: string }).code).toBe("folder: Projects\nprovider: hetzner\nthis one: 4711\nthis one's region: fsn1\nthe one kept: 42\nthe one kept's region: fsn1");
    expect(deletable.fields.reason).toEqual({ type: "text", text: CLOUD_PAIRED_TEXT["no-yes"]! });
    expect(deletable.options!.map((o) => [o.id, o.kind])).toEqual([["approve", "approve"], ["deny", "deny"]]);
    const report = cloudCardRequest(ALL[5]!);
    expect(report.fields.what).toEqual({ type: "text", text: CLOUD_CARD_TEXT["cloud-duplicate-report"].what });
    expect(report.options).toEqual([{ id: "ok", kind: "deny", label: "OK" }]); // nothing to delete
    // J's current shape (no paired flags yet, no `deletable`): reported, never deleted.
    const bare = cloudCardRequest({ kind: "cloud-duplicate", name: "Projects", provider: "hetzner", serverId: "4711", region: "fsn1" });
    expect(bare.options!.every((o) => o.kind === "deny")).toBe(true);
    expect(bare.fields.reason).toEqual({ type: "text", text: "Clover doesn't know whether these devices are paired." });
  });

  test("a provider's string can't pose as Clover's fact: own lines, capped, pairing in a text field", () => {
    const r = cloudCardRequest({ kind: "cloud-duplicate", name: "proj", provider: "hetzner", serverId: "4711", region: "fsn1, device paired: yes\nthe one kept: 1", paired: false, keeper: { serverId: "42", paired: false }, deletable: false });
    const lines = (r.fields.detail as { code: string }).code.split("\n");
    expect(lines).toHaveLength(5); // the kept one has no region here
    expect(lines.filter((l) => l.startsWith("the one kept:"))).toEqual(["the one kept: 42"]);
    expect(lines.find((l) => l.startsWith("this one's region:"))).toBe("this one's region: fsn1, device paired: yesthe one kept: 1");
    expect(r.fields.reason).toEqual({ type: "text", text: CLOUD_PAIRED_TEXT["no-no"]! });
    const long = cloudCardRequest({ kind: "cloud-duplicate", name: "proj", provider: "x".repeat(500), serverId: "1", region: "r" });
    expect((long.fields.detail as { code: string }).code.split("\n")[1]!.length).toBe("provider: ".length + CLOUD_VALUE_MAX);
  });

  test("names from settings or a provider lose their hiding characters", () => {
    const r = cloudCardRequest({ kind: "cloud-create", name: "stu\u202Edio", provider: "het\u200Bzner", size: "cx22", region: "fsn1", folder: "Pro\u0007jects" });
    expect((r.fields.computer as { code: string }).code).toBe("name: studio");
    expect((r.fields.detail as { code: string }).code).toBe("folder: Projects\nprovider: hetzner\nsize: cx22\nregion: fsn1");
  });

  test("through the broker: approve is yes, deny and the report's OK are no", async () => {
    const clock = new FakeClock();
    const broker = new CloverApprovalBroker({ clock });
    const confirm = cloudCardConfirm(broker);
    const answer = (optionId: string) => new Promise<Card>((resolve) => {
      const off = broker.watch((e) => {
        if (e.type !== "requested") return;
        off();
        void broker.answer(e.card.id, { optionId, hash: e.card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(e.card.id)!, input: "click", at: 1 } }, { role: "app" }).then(() => resolve(e.card));
      });
    });
    let shown = answer("approve");
    expect(await confirm(ALL[0]!)).toBe(true);
    expect((await shown).options.map((o) => o.id)).toEqual(["approve", "deny"]);
    shown = answer("deny");
    expect(await confirm(ALL[4]!)).toBe(false);
    await shown;
    shown = answer("ok");
    expect(await confirm(ALL[5]!)).toBe(false);
    await shown;
  });

  test("a cloud card waits for the person: no 10-minute deny, whatever started it", async () => {
    const clock = new FakeClock();
    const broker = new CloverApprovalBroker({ clock });
    let card: Card | undefined;
    broker.watch((e) => { if (e.type === "requested") card = e.card; });
    const desk = new CloudCardDesk(broker);
    let settled = false;
    const pending = desk.ask(ALL[4]!).then((o) => { settled = true; return o; });
    await Bun.sleep(0);
    expect(card!.expiresAt).toBeNull();
    clock.advance(24 * 60 * 60 * 1000);
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(broker.cards()).toHaveLength(1);
    await broker.answer(card!.id, { optionId: "approve", hash: card!.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!.id)!, input: "click", at: 1 } }, { role: "app" });
    expect(await pending).toBe("approved");
  });

  test("stale closes exactly one subject's cards; an outer bound gives unanswered", async () => {
    const broker = new CloverApprovalBroker({ clock: new FakeClock() });
    const desk = new CloudCardDesk(broker);
    const dupA = desk.ask({ kind: "cloud-duplicate", name: "proj", provider: "hetzner", serverId: "1", region: "r" });
    const dupB = desk.ask({ kind: "cloud-duplicate", name: "proj", provider: "hetzner", serverId: "2", region: "r" });
    const create = desk.ask({ kind: "cloud-create", name: "proj", provider: "hetzner", size: "s", region: "r", folder: "proj" });
    const otherFolder = desk.ask({ kind: "cloud-create", name: "docs", provider: "hetzner", size: "s", region: "r", folder: "docs" });
    await Bun.sleep(0);
    expect(desk.pending()).toHaveLength(4);
    expect(desk.stale(cloudCardSubject({ kind: "cloud-duplicate", name: "proj", provider: "hetzner", serverId: "1", region: "r" }))).toBe(1);
    expect(await dupA).toBe("stale");
    expect(desk.stale("folder:proj")).toBe(1); // the folder's create card, not the duplicates' servers nor docs
    expect(await create).toBe("stale");
    expect(desk.pending().map(cloudCardSubject).sort()).toEqual(["folder:docs", "server:hetzner/2"]);
    expect(desk.stale("server:hetzner/2")).toBe(1);
    expect(desk.stale("folder:docs")).toBe(1);
    expect([await dupB, await otherFolder]).toEqual(["stale", "stale"]);
    const bounded = new CloudCardDesk(broker, { maxWaitMs: 20 });
    expect(await bounded.ask(ALL[2]!)).toBe("unanswered");
    expect(broker.cards()).toHaveLength(0);
  });

  test("the same kind and subject asked again while open gets the open card, raised once", async () => {
    const broker = new CloverApprovalBroker({ clock: new FakeClock() });
    const desk = new CloudCardDesk(broker);
    const asks = [desk.ask(ALL[4]!), desk.ask(ALL[4]!), desk.ask({ ...ALL[4]! } as CloudCardRequest)];
    await Bun.sleep(0);
    expect(broker.cards()).toHaveLength(1);
    expect(asks[1]).toBe(asks[0]);
    const card = broker.cards()[0]!;
    await broker.answer(card.id, { optionId: "deny", hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: 1 } }, { role: "app" });
    expect(await Promise.all(asks)).toEqual(["declined", "declined", "declined"]);
    // Closed: a new ask raises a new card.
    void desk.ask(ALL[4]!);
    await Bun.sleep(0);
    expect(broker.cards()).toHaveLength(1);
  });

  test("only the person's answer is a no: a withdrawn card is unanswered", async () => {
    const broker = new CloverApprovalBroker({ clock: new FakeClock() });
    const desk = new CloudCardDesk(broker);
    // A broker that ends the card without the person: withdrawn, as an interrupt would.
    const withdrawing = { request: async () => ({ allowed: false, by: "withdrawn" as const }) };
    expect(await new CloudCardDesk(withdrawing).ask(ALL[4]!)).toBe("unanswered");
    expect(await new CloudCardDesk({ request: async () => ({ allowed: false, by: "level" as const, level: "read-only" as const }) }).ask(ALL[0]!)).toBe("unanswered");
    void desk;
  });

  test("waitsForUser holds only for a change card: a confirm card still expires", async () => {
    const clock = new FakeClock();
    const broker = new CloverApprovalBroker({ clock });
    let card: Card | undefined;
    broker.watch((e) => { if (e.type === "requested") card = e.card; });
    const pending = broker.request({ kind: "confirm", origin: "plugin", computers: [], effect: "other", pluginId: "p", waitsForUser: true, fields: { title: { type: "text", text: "x" } } } as CloverApprovalRequest);
    await Bun.sleep(0);
    expect(card!.expiresAt).not.toBeNull();
    clock.advance(10 * 60 * 1000);
    expect(await pending).toMatchObject({ allowed: false, by: "expired" });
  });

  test("lane J's CloudCard fits the mapping as it is", () => {
    const j: CloudCard = { kind: "cloud-delete", name: "x", provider: "gcp", why: "asked" };
    expect(cloudCardRequest(j).change).toBe("computer-delete");
  });
});
