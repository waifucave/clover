// Lane J's side of B's `onOkApproved` (#376): the user's yes to a plugin's OK card on this computer ticks its local MCP
// servers here (`mcpTicks.installed`). One answered before the computer node is up, or on a node without ticks yet, waits
// for it, each plugin once; a tick that fails is logged, never thrown into the OK.
import { describe, expect, test } from "bun:test";
import { pluginOkTicks } from "../src/daemon-parts";

describe("pluginOkTicks", () => {
  test("ticks at once on a node with ticks", () => {
    const ticked: string[] = [];
    const t = pluginOkTicks(() => ({ mcpTicks: { installed: (id: string) => ticked.push(id) } }), () => {});
    t.approved("acme/blender");
    expect(ticked).toEqual(["acme/blender"]);
    expect(t.waiting).toBe(0);
  });

  test("an OK before the node is up (or on a node without ticks) waits, once per plugin, and is ticked at the flush", () => {
    let node: object | undefined;
    const ticked: string[] = [];
    const t = pluginOkTicks(() => node, () => {});
    t.approved("acme/blender");
    t.approved("acme/blender");
    t.approved("acme/coder");
    expect(t.waiting).toBe(2);
    // A node without ticks (main before J-M2): still waiting.
    node = {};
    t.flush();
    expect(t.waiting).toBe(2);
    node = { mcpTicks: { installed: (id: string) => ticked.push(id) } };
    t.flush();
    expect(ticked).toEqual(["acme/blender", "acme/coder"]);
    expect(t.waiting).toBe(0);
    t.flush();
    expect(ticked).toHaveLength(2);
  });

  test("a tick that fails is logged and never thrown into the OK", () => {
    const lines: string[] = [];
    const t = pluginOkTicks(() => ({ mcpTicks: { installed: () => { throw new Error("levels/ can't be written"); } } }), (l) => lines.push(l));
    expect(() => t.approved("acme/blender")).not.toThrow();
    expect(lines).toEqual(["[parts] acme/blender's MCP servers couldn't be ticked on this computer: levels/ can't be written"]);
    expect(t.waiting).toBe(0);
  });
});
