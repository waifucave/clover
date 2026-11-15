// PluginNew, as a bot calls it: each template's files, the same as `clover plugin new` writes; a bad template or id
// is a tool error, never a throw; and the host half's MCP server answers initialize, tools/list and tools/call on the
// in-process transport.
import { describe, expect, test } from "bun:test";
import type { McpServerTransport } from "@waifucave/clover-plugin-sdk";
import { PLUGIN_TEMPLATES, templateFiles } from "@waifucave/clover-plugin-sdk/templates";
import { mcp, serveBuilder } from "../host/index";
import { pluginNew, runTool, TOOL_NEW, TOOLS } from "../src/tools";

describe("PluginNew", () => {
  for (const template of Object.keys(PLUGIN_TEMPLATES)) {
    test(`${template}: the scaffold's files, and how to write them`, () => {
      const r = pluginNew({ template, id: "my-thing", name: "My thing" });
      expect(r.isError).toBeUndefined();
      const made = templateFiles(template, { id: "my-thing", name: "My thing" });
      if ("error" in made) throw new Error(made.error);
      expect(r.structuredContent).toEqual({ id: "my-thing", template, files: made.files });
      const text = r.content[0]!.text;
      expect(text).toContain("folder named `my-thing`");
      for (const [path, body] of Object.entries(made.files)) expect(text).toContain(`--- ${path} ---\n${body}`);
    });
  }

  test("a template that doesn't exist, or a bad id, is a tool error with the reason", () => {
    const bad = pluginNew({ template: "spaceship", id: "x", name: "X" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("spaceship");
    expect(pluginNew({ template: "tool", id: "Not An Id", name: "X" }).isError).toBe(true);
    expect(pluginNew(undefined).isError).toBe(true);
  });

  test("its schema offers exactly the SDK's templates; it is the one tool", async () => {
    expect(TOOLS.map((t) => t.name)).toEqual([TOOL_NEW]);
    expect([...TOOLS[0]!.inputSchema.properties.template.enum]).toEqual(Object.keys(PLUGIN_TEMPLATES));
    expect((await runTool("Nope", {})).isError).toBe(true);
  });
});

function pair(): { transport: McpServerTransport; ask(m: Record<string, unknown>): Promise<Record<string, unknown>> } {
  const waiting = new Map<unknown, (m: Record<string, unknown>) => void>();
  const transport: McpServerTransport = {
    start: async () => {},
    close: async () => {},
    send: async (m) => { waiting.get(m.id)?.(m); },
  };
  return {
    transport,
    ask: (m) => new Promise((resolve) => { waiting.set(m.id, resolve); transport.onmessage!(m); }),
  };
}

test("the builder server answers on the in-process transport, and the module serves it under its manifest key", async () => {
  expect(Object.keys(mcp!)).toEqual(["builder"]);
  const { transport, ask } = pair();
  await serveBuilder(transport);
  const init = await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  expect((init.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  const list = await ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect((list.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["PluginNew"]);
  const call = await ask({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "PluginNew", arguments: { template: "theme", id: "dusk", name: "Dusk" } } });
  expect((call.result as { structuredContent: { id: string } }).structuredContent.id).toBe("dusk");
  const unknown = await ask({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "PluginInstall", arguments: {} } });
  expect((unknown.error as { code: number }).code).toBe(-32602);
  expect(((await ask({ jsonrpc: "2.0", id: 5, method: "nope" })).error as { code: number }).code).toBe(-32601);
});
