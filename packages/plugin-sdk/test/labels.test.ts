import { describe, expect, test } from "bun:test";
import { CONTRIBUTION_LABEL_ORDER, contributionLabels } from "../src";

const m = (contributes: Record<string, unknown>) => ({ manifest: 1, name: "X", contributes });

describe("the labels a plugin shows for what it brings", () => {
  test("each contribution gives its label, in the one order", () => {
    expect(contributionLabels([m({ bot: { name: "Luna" }, mcpServers: { s: { type: "host" } }, skills: ["skills/*"], themes: [{ id: "t", file: "t.json" }] })])).toEqual(["Bot", "Tools", "Skills", "Theme"]);
    expect(contributionLabels([m({ ui: [{ spot: "island.tab", id: "a", component: "A" }, { spot: "sidebar.app", id: "b", component: "B" }, { spot: "avatar", key: "vrm", component: "V" }, { spot: "settings.section", id: "s", component: "S" }] })]))
      .toEqual(["Island tab", "App page", "Settings section", "Avatar renderer"]);
    expect(contributionLabels([m({ models: [{ id: "m" }], voices: [{ id: "v" }], agents: ["agents/a.md"], triggers: [{ type: "x" }], hooks: [{ id: "h" }] })])).toEqual(["Agent", "Model", "Voice", "Hooks", "Trigger"]);
  });
  test("a panel with a key that isn't a stock panel's is a Panel; replacing a stock one is not", () => {
    expect(contributionLabels([m({ ui: [{ spot: "panel", key: "sheets", component: "S", title: "Sheets" }] })])).toEqual(["Panel"]);
    expect(contributionLabels([m({ ui: [{ spot: "panel", key: "browser", component: "B" }, { spot: "panel", key: "agent", component: "A" }] })])).toEqual([]);
  });
  test("a tree: the parent's labels include its children's, a child's are its own, repeats once", () => {
    const parent = m({ bot: { name: "Luna" } });
    const child = m({ mcpServers: { s: { type: "host" } }, ui: [{ spot: "island.tab", id: "a", component: "A" }] });
    const other = m({ mcpServers: { t: { type: "host" } } });
    expect(contributionLabels([parent, child, other])).toEqual(["Bot", "Tools", "Island tab"]);
    expect(contributionLabels([child])).toEqual(["Tools", "Island tab"]);
  });
  test("empty or unknown contributions give nothing, and a spot a person wouldn't name gives nothing", () => {
    expect(contributionLabels([m({}), m({ skills: [], mcpServers: {}, ui: [{ spot: "composer.action", key: "model", component: "C" }] }), { manifest: 1 }, undefined, null])).toEqual([]);
    expect(contributionLabels([m({ "webhook.ingress": { id: "w" } })])).toEqual([]);
  });
  test("no label names a kind of plugin", () => {
    for (const l of CONTRIBUTION_LABEL_ORDER) expect(l).not.toMatch(/plugin|type|kind/i);
  });
});
