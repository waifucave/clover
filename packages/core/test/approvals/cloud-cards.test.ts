// C-M3: lane J's cloud cards as sealed cards through the broker. Table words in `text`, names and ids in `code`, no
// "always" on any, and a duplicate offers to delete only when the kept VM ranks strictly above it.
import { describe, expect, test } from "bun:test";
import type { Card } from "@waifucave/clover-protocol";
import { CLOUD_CARD_TEXT, cloudCardConfirm, cloudCardRequest, type CloudCardRequest } from "../../src/approvals/cloud-cards";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { CloudCard } from "../../src/computers/cloud";

const TABLE = new Set(Object.values(CLOUD_CARD_TEXT).flatMap((t) => Object.values(t) as string[]));
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
    expect((deletable.fields.detail as { code: string }).code).toBe("folder: Projects\nthis one: hetzner 4711 (fsn1), device paired: no\nthe one kept: hetzner 42 (fsn1), device paired: yes");
    expect(deletable.options!.map((o) => [o.id, o.kind])).toEqual([["approve", "approve"], ["deny", "deny"]]);
    const report = cloudCardRequest(ALL[5]!);
    expect(report.fields.what).toEqual({ type: "text", text: CLOUD_CARD_TEXT["cloud-duplicate-report"].what });
    expect(report.options).toEqual([{ id: "ok", kind: "deny", label: "OK" }]); // nothing to delete
    // J's current shape (no paired flags yet, no `deletable`): reported, never deleted.
    const bare = cloudCardRequest({ kind: "cloud-duplicate", name: "Projects", provider: "hetzner", serverId: "4711", region: "fsn1" });
    expect(bare.options!.every((o) => o.kind === "deny")).toBe(true);
    expect((bare.fields.detail as { code: string }).code).toContain("device paired: not known");
  });

  test("names from settings or a provider lose their hiding characters", () => {
    const r = cloudCardRequest({ kind: "cloud-create", name: "stu\u202Edio", provider: "het\u200Bzner", size: "cx22", region: "fsn1", folder: "Pro\u0007jects" });
    expect((r.fields.computer as { code: string }).code).toBe("name: studio");
    expect((r.fields.detail as { code: string }).code).toBe("folder: Projects\nprovider: hetzner\nsize: cx22\nregion: fsn1");
  });

  test("through the broker: approve is yes, deny, report and an unanswered card are no", async () => {
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
    const pending = confirm(ALL[8]!);
    await Bun.sleep(0);
    clock.advance(10 * 60 * 1000);
    expect(await pending).toBe(false); // the daemon's own reconcile: denied after 10 minutes unanswered
  });

  test("lane J's CloudCard fits the mapping as it is", () => {
    const j: CloudCard = { kind: "cloud-delete", name: "x", provider: "gcp", why: "asked" };
    expect(cloudCardRequest(j).change).toBe("computer-delete");
  });
});
