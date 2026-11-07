// The registry's state machine against the PluginRegistry conformance suite, and what its records keep across a
// restart: OKs, refusals, switches and the synced list's order.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import { runPluginRegistryConformance } from "../../contracts/conformance/plugin-registry";
import type { Manifest } from "../../contracts/sdk-types";
import { RegistryCore, type OkCardRaiser } from "../core";
import { memoryRegistryStore } from "../state";

runPluginRegistryConformance((opts) => {
  const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore({ adult: opts.adultConfirmed ?? false }) });
  reg.putAll(opts.plugins ?? []);
  return reg;
});

const m = (over: Partial<Manifest> = {}): Manifest => ({ manifest: 1, name: "A plugin", ...over });

describe("RegistryCore: its records", () => {
  test("an OK, a refusal and a switch survive a restart; a refused tree stays refused until it changes", async () => {
    const store = memoryRegistryStore();
    const a = new RegistryCore({ catalog: catalogPointDecl, store });
    a.putAll([
      { id: "tarot", manifest: m({ name: "Tarot" }), treeHash: "sha256:1", approved: false },
      { id: "luna", manifest: m({ name: "Luna" }), treeHash: "sha256:2", approved: false },
      { id: "fish", manifest: m({ name: "Fish" }), treeHash: "sha256:3" },
    ]);
    expect(await a.approve("tarot", "sha256:1")).toBe("approved");
    await a.refuse("luna");
    await a.setEnabled("fish", false);
    expect(store.state.order).toEqual(["tarot", "luna", "fish"]);

    const b = new RegistryCore({ catalog: catalogPointDecl, store });
    b.putAll([
      { id: "fish", manifest: m({ name: "Fish" }), treeHash: "sha256:3" },
      { id: "luna", manifest: m({ name: "Luna" }), treeHash: "sha256:2" },
      { id: "tarot", manifest: m({ name: "Tarot" }), treeHash: "sha256:1" },
    ]);
    expect(b.list().map((r) => [r.id, r.state])).toEqual([["tarot", "running"], ["luna", "refused"], ["fish", "off"]]);
    b.put({ id: "luna", manifest: m({ name: "Luna" }), treeHash: "sha256:2b" });
    expect(b.get("luna")?.state).toBe("found");
    // Changed while the core was down: a change that asks again waits for a new OK; a data edit applies.
    const c = new RegistryCore({ catalog: catalogPointDecl, store });
    c.putAll([{ id: "tarot", manifest: m({ name: "Tarot" }), treeHash: "sha256:1c", change: "asks-again" }]);
    expect(c.get("tarot")?.state).toBe("found");
    const d = new RegistryCore({ catalog: catalogPointDecl, store });
    d.putAll([{ id: "tarot", manifest: m({ name: "Tarot" }), treeHash: "sha256:1d", change: "applies" }]);
    expect(d.get("tarot")).toMatchObject({ state: "running", okHash: "sha256:1d" });
  });

  test("the OK card's answer approves the tree it showed, with the children checked; a deny refuses", async () => {
    const answers: ((a: { approved: boolean; children?: readonly string[] }) => void)[] = [];
    const shown: { id: string; treeHash: string; children: { id: string; checked: boolean }[] }[] = [];
    const cards: OkCardRaiser = { raise: (req, answered) => (shown.push(req), answers.push(answered), `card_ok${shown.length}`) };
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore(), cards });
    reg.putAll([
      { id: "pack", manifest: m({ name: "Pack" }), treeHash: "sha256:p", approved: false },
      { id: "pack/a", manifest: m({ name: "A" }), treeHash: "sha256:p" },
      { id: "pack/b", manifest: m({ name: "B" }), treeHash: "sha256:p" },
      { id: "other", manifest: m({ name: "Other" }), treeHash: "sha256:o", approved: false },
    ]);
    expect(await reg.installed("pack", "app")).toEqual({ state: "found", card: "card_ok1" });
    expect(shown[0]).toMatchObject({ id: "pack", treeHash: "sha256:p", children: [{ id: "pack/a", checked: true }, { id: "pack/b", checked: true }] });
    answers[0]!({ approved: true, children: ["pack/b"] });
    await Bun.sleep(0);
    expect(reg.list().filter((r) => r.id.startsWith("pack")).map((r) => [r.id, r.state])).toEqual([["pack", "running"], ["pack/a", "off"], ["pack/b", "running"]]);
    expect((await reg.setEnabled("other", true)).applied).toBe(false);
    answers[1]!({ approved: false });
    await Bun.sleep(0);
    expect(reg.get("other")?.state).toBe("refused");
  });
});
