// F5: a Browser tool is any plugin's that holds `browser` and lists the tool in a server's `browserTools`, never a plugin
// the core names. Its class holds on the tree the user OK'd (or the build's copy) while the grant is in force; the OK card
// names it with its warning, and a plugin without `browser` can't declare one.
import { expect, test } from "bun:test";
import { describeOk, validateManifest } from "@waifucave/moss-plugin-sdk";
import { pluginWebTool } from "../../src/registry/read-only-tools";

const server = { type: "host", tools: { Browse: "preload", Other: "preload" }, browserTools: ["Browse"] };
const record = (id: string, granted: string[], o: { okHash?: string } = {}) => ({
  id, state: "running", enabled: true, dev: false, okHash: o.okHash ?? "sha256:a", treeHash: "sha256:a", capabilities: granted, granted, provenance: {}, source: "user",
  manifest: { capabilities: ["browser"], host: { entry: "host/index.js" }, contributes: { mcpServers: { web: server } } },
});

test("a third party's browserTools tool is the Browser class while it holds browser on its OK'd tree; nothing by id", () => {
  const records = [record("surfer", ["browser"]), record("switched-off", []), record("changed", ["browser"], { okHash: "sha256:b" })];
  const reg = { get: (id: string) => records.find((r) => r.id === id), list: () => records } as never;
  expect(pluginWebTool(reg, "surfer", "web", "Browse")).toBe("browser");
  expect(pluginWebTool(reg, "surfer", "web", "Other")).toBeUndefined();
  // Without the grant in force, or on a tree the user didn't OK, it is judged as any tool.
  expect(pluginWebTool(reg, "switched-off", "web", "Browse")).toBeUndefined();
  expect(pluginWebTool(reg, "changed", "web", "Browse")).toBeUndefined();
});

test("the validator: browserTools needs browser; its card line says what the tab gives the plugin", () => {
  const m = (caps: string[]) => ({ manifest: 1, id: "surfer", name: "Surfer", engines: { moss: "^1.0.0" }, capabilities: caps, host: { entry: "host/index.ts" }, contributes: { mcpServers: { web: server } } });
  const codes = (caps: string[]) => validateManifest(m(caps), { folderName: "surfer" }).issues.filter((i) => i.severity === "error").map((i) => i.code);
  expect(codes([])).toContain("browser_tool_no_capability");
  expect(codes(["browser"])).toEqual([]);
  expect(describeOk(validateManifest(m(["browser"]), { folderName: "surfer" })).join("\n")).toContain("Its server web says Browse drives the calling bot's own tab of the MOSS Browser. Looking and acting are told apart by the plugin's own word (its verbs)");
});
