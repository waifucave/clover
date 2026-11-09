// The OK as a sealed `plugin-ok` card through the broker: its text and children, the user's approve with the children
// they checked, and their deny refusing the plugin.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import type { Card } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import type { Manifest } from "../../contracts/sdk-types";
import { RegistryCore } from "../core";
import { brokerOkCards } from "../ok-cards";
import { memoryRegistryStore } from "../state";

const m = (name: string): Manifest => ({ manifest: 1, name });
const flush = () => new Promise((r) => setTimeout(r, 5));

async function click(broker: FakeApprovalBroker, card: Card, optionId: string, children?: string[]) {
  const frame = broker.frameChannel(card.id)!;
  return broker.answer(card.id, {
    optionId, hash: card.hash, proof: { via: "sealed-frame", frame, input: "click", at: Date.now() }, ...(children ? { children } : {}),
  }, { role: "app" });
}

describe("OK cards through the broker", () => {
  test("approve with the children checked runs them; deny refuses", async () => {
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const cards = brokerOkCards(broker, (id) => ({ title: id, lines: [`${id} runs code on your computers.`], source: "Found on disk" }));
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore(), cards });
    reg.putAll([
      { id: "pack", manifest: m("Pack"), treeHash: "sha256:p", approved: false },
      { id: "pack/a", manifest: m("A"), treeHash: "sha256:p" },
      { id: "pack/b", manifest: m("B"), treeHash: "sha256:p" },
      { id: "solo", manifest: m("Solo"), treeHash: "sha256:s", approved: false },
    ]);
    const { card: cardId } = await reg.installed("pack", "app");
    const card = broker.cards().find((c) => c.id === cardId)!;
    expect(card).toMatchObject({ kind: "plugin-ok", pluginId: "pack", expiresAt: null, children: [{ id: "pack/a", checked: true }, { id: "pack/b", checked: true }] });
    expect(card.fields.what).toEqual({ type: "list", items: ["pack runs code on your computers."] });
    expect(await click(broker, card, "approve", ["pack/b"])).toBe("accepted");
    await flush();
    expect(reg.list().filter((r) => r.id.startsWith("pack")).map((r) => [r.id, r.state])).toEqual([["pack", "running"], ["pack/a", "off"], ["pack/b", "running"]]);

    const sw = await reg.setEnabled("solo", true);
    expect(sw.applied).toBe(false);
    const soloCard = broker.cards().find((c) => c.pluginId === "solo")!;
    expect(await click(broker, soloCard, "deny")).toBe("accepted");
    await flush();
    expect(reg.get("solo")?.state).toBe("refused");
  });

  test("onApproved runs here for an approve of this computer's card, never for a deny or an OK that arrives by sync", async () => {
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const approved: string[] = [];
    const cards = brokerOkCards(broker, (id) => ({ title: id, lines: [], source: "Found on disk" }), (id) => approved.push(id));
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore(), cards });
    reg.putAll([
      { id: "yes", manifest: m("Yes"), treeHash: "sha256:y", approved: false },
      { id: "no", manifest: m("No"), treeHash: "sha256:n", approved: false },
      // An OK record that came by sync: approved already, no card here.
      { id: "synced", manifest: m("Synced"), treeHash: "sha256:s", approved: true },
    ]);
    for (const id of ["yes", "no"]) await reg.installed(id, "app");
    expect(await click(broker, broker.cards().find((c) => c.pluginId === "yes")!, "approve")).toBe("accepted");
    expect(await click(broker, broker.cards().find((c) => c.pluginId === "no")!, "deny")).toBe("accepted");
    await flush();
    expect(reg.get("yes")?.state).toBe("running");
    expect(approved).toEqual(["yes"]);
    // A hook that throws doesn't undo the OK.
    const logged: string[] = [];
    const throwing = brokerOkCards(broker, (id) => ({ title: id, lines: [], source: "Found on disk" }), () => { throw new Error("boom"); }, (l) => logged.push(l));
    const reg2 = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore(), cards: throwing });
    reg2.putAll([{ id: "solo", manifest: m("Solo"), treeHash: "sha256:o", approved: false }]);
    await reg2.installed("solo", "app");
    expect(await click(broker, broker.cards().find((c) => c.pluginId === "solo")!, "approve")).toBe("accepted");
    await flush();
    expect(reg2.get("solo")?.state).toBe("running");
    // ...and is logged as a warning, with the plugin and the error.
    expect(logged).toEqual(["plugins: after solo's OK, its approve hook failed: boom"]);
  });
});
