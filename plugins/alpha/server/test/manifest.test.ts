// Alpha as the reference plugin: her whole tree validates as the bundled tree it ships in; her tools qualify for
// running without a card by the generic rule (no network, no capability beyond reading Clover's state, anywhere in
// her tree, extras included); every handler her manifest names is exported; her locales match; her child is off by
// default.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTAINED_TOOL_CAPABILITIES, containedToolsHold, validateTree } from "../../../../packages/plugin-sdk/src/index";
import * as server from "../index";
import { OWN_SCENES } from "../stage";
import { CONTAINED_TOOLS, READ_ONLY_TOOLS, STAGE_TOOLS } from "../tools";
import { ALPHA, diskReader } from "./fakes";

const manifest = JSON.parse(readFileSync(join(ALPHA, "clover.json"), "utf8"));

test("her tree validates as the bundled tree, with her extras as an off-by-default child", async () => {
  const tree = await validateTree(diskReader(ALPHA), { folderName: "alpha", bundled: true });
  const errors = [...tree.top.issues, ...tree.issues, ...tree.children.flatMap((c) => c.report.issues)].filter((i) => i.severity === "error");
  expect(errors).toEqual([]);
  expect(tree.children.map((c) => [c.folder, c.ok])).toEqual([["extras", true], ["sidebar", true]]);
  expect(JSON.parse(readFileSync(join(ALPHA, "plugins", "extras", "clover.json"), "utf8")).enabledByDefault).toBe(false);
});

test("her tools qualify by the generic rule: the whole tree reaches no network and only reads Clover's state", async () => {
  const tree = await validateTree(diskReader(ALPHA), { folderName: "alpha", bundled: true });
  const capabilities = [tree.top, ...tree.children.map((c) => c.report)].flatMap((r) => r.capabilities);
  for (const c of capabilities) expect([c, CONTAINED_TOOL_CAPABILITIES.includes(c)]).toEqual([c, true]);
  expect([tree.top, ...tree.children.map((c) => c.report)].flatMap((r) => r.networkHosts)).toEqual([]);
  const stage = manifest.contributes.mcpServers.stage;
  expect(stage.type).toBe("host");
  expect(containedToolsHold(stage, { capabilities, wrappedNetwork: false, fenced: true })).toBe(true);
  expect(new Set(stage.contained)).toEqual(new Set(CONTAINED_TOOLS));
  expect(stage.readOnly).toEqual(READ_ONLY_TOOLS);
});

/** Every manifest in her tree: hers and her extras'. */
const treeManifests = (): { where: string; m: Record<string, any> }[] => [
  { where: "alpha", m: manifest },
  { where: "alpha/extras", m: JSON.parse(readFileSync(join(ALPHA, "plugins", "extras", "clover.json"), "utf8")) },
];

test("the guard: no http server, no hook that can steer, every hook her own bot's, and every tool on a list by name", () => {
  for (const { where, m } of treeManifests()) {
    // An http server reaches the network; none anywhere in her tree.
    for (const [name, srv] of Object.entries((m.contributes?.mcpServers ?? {}) as Record<string, { type?: string; url?: unknown }>)) {
      expect([where, name, srv.type]).toEqual([where, name, "host"]);
      expect(srv.url).toBeUndefined();
    }
    for (const h of (m.contributes?.hooks ?? []) as { id: string; on: string[]; scope?: string; command?: unknown }[]) {
      // No hook that can deny or rewrite a call or a message: tool.before (it also fails closed), message.in, message.out.
      for (const e of h.on) expect([where, h.id, e, ["tool.before", "message.in", "message.out"].includes(e)]).toEqual([where, h.id, e, false]);
      // Only her own bot's sessions: never "bots", "agents" or "both" (the host enforces it; hooks.ts checks again).
      expect([where, h.id, h.scope]).toEqual([where, h.id, "own-bot"]);
      expect(h.command).toBeUndefined();
    }
  }
  // Every tool her server serves is on exactly one list, by name: a new tool on neither list fails here, and until
  // someone puts it on one it asks before it runs (the host skips the card only for a name on `contained`/`readOnly`).
  const stage = manifest.contributes.mcpServers.stage;
  for (const t of STAGE_TOOLS) {
    const on = [CONTAINED_TOOLS.includes(t.name), READ_ONLY_TOOLS.includes(t.name)].filter(Boolean).length;
    expect([t.name, on]).toEqual([t.name, 1]);
    expect([t.name, [...(stage.contained as string[]), ...(stage.readOnly as string[])].filter((n) => n === t.name).length]).toEqual([t.name, 1]);
  }
  for (const n of [...stage.contained, ...stage.readOnly] as string[]) expect([n, STAGE_TOOLS.some((t) => t.name === n)]).toEqual([n, true]);
  expect([...stage.contained, ...stage.readOnly].some((n: string) => n.includes("*"))).toBe(false);
});

test("every handler her manifest names is an export of her server; her settings' scenes are hers", () => {
  const names = [
    ...manifest.contributes.hooks.map((h: { handler: string }) => h.handler),
    ...manifest.contributes.commands.map((c: { handler: string }) => c.handler),
  ];
  for (const n of names) expect([n, typeof (server as Record<string, unknown>)[n]]).toEqual([n, "function"]);
  expect(typeof server.mcp.stage).toBe("function");
  // Her tab reaches only the `ui` table, and it holds no handler the manifest names.
  expect(Object.keys(server.ui)).toEqual(["setCatalog"]);
  for (const n of names) expect(Object.hasOwn(server.ui, n)).toBe(false);
  expect(manifest.settings.scene.options.map((o: { value: string }) => o.value)).toEqual(OWN_SCENES.map((s) => s.id));
});

test("her locales have the same keys in every language, all under her id", () => {
  const read = (lang: string) => JSON.parse(readFileSync(join(ALPHA, "locales", `${lang}.json`), "utf8")).strings as Record<string, string>;
  const en = Object.keys(read("en")).sort();
  expect(Object.keys(read("ja")).sort()).toEqual(en);
  for (const k of en) expect(k.startsWith("alpha.")).toBe(true);
  expect(manifest.contributes.locales.map((l: { lang: string }) => l.lang)).toEqual(["en", "ja"]);
});
