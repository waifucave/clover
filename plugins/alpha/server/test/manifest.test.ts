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
import { CONTAINED_TOOLS, READ_ONLY_TOOLS } from "../tools";
import { ALPHA, diskReader } from "./fakes";

const manifest = JSON.parse(readFileSync(join(ALPHA, "clover.json"), "utf8"));

test("her tree validates as the bundled tree, with her extras as an off-by-default child", async () => {
  const tree = await validateTree(diskReader(ALPHA), { folderName: "alpha", bundled: true });
  const errors = [...tree.top.issues, ...tree.issues, ...tree.children.flatMap((c) => c.report.issues)].filter((i) => i.severity === "error");
  expect(errors).toEqual([]);
  expect(tree.children.map((c) => [c.folder, c.ok])).toEqual([["extras", true]]);
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

test("every handler her manifest names is an export of her server; her settings' scenes are hers", () => {
  const names = [
    ...manifest.contributes.hooks.map((h: { handler: string }) => h.handler),
    ...manifest.contributes.commands.map((c: { handler: string }) => c.handler),
  ];
  for (const n of names) expect([n, typeof (server as Record<string, unknown>)[n]]).toEqual([n, "function"]);
  expect(typeof server.mcp.stage).toBe("function");
  expect(typeof server.setCatalog).toBe("function");
  expect(manifest.settings.scene.options.map((o: { value: string }) => o.value)).toEqual(OWN_SCENES.map((s) => s.id));
});

test("her locales have the same keys in every language, all under her id", () => {
  const read = (lang: string) => JSON.parse(readFileSync(join(ALPHA, "locales", `${lang}.json`), "utf8")).strings as Record<string, string>;
  const en = Object.keys(read("en")).sort();
  expect(Object.keys(read("ja")).sort()).toEqual(en);
  for (const k of en) expect(k.startsWith("alpha.")).toBe(true);
  expect(manifest.contributes.locales.map((l: { lang: string }) => l.lang)).toEqual(["en", "ja"]);
});
