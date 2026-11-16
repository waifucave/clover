// The build's copy's declared tools on the REAL path: the repository's bundled tree built and staged as a source daemon
// stages it (`buildDevBundledPlugins`, `stageBundledPlugins`), the real registry over that staged copy, and the
// daemon's own judges (`builtCopy`, `pluginToolReadOnly`, `pluginWebTool`) over the manifests' `readOnly`, `webSearch`
// and `webFetch`, never a plugin id the core names (R1, 2026-11-15). The builder's PluginNew is a read with no card at
// the default level, loaded through Glossary first too (the 14c acceptance found it carded). A folder plugin under
// another id gets the same from its own manifest once the user OK'd it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botApprovalCheck } from "../../src/approvals/bot-check";
import { builtCopy, type OfferedServer } from "../../src/approvals/bundled-tools";
import { pluginToolReadOnly, pluginWebTool } from "../../src/registry/read-only-tools";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";
import type { BotSessionContext } from "../../src/bots/service";
import { FakeApprovalBroker } from "../../src/contracts/fakes/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { MemorySecretStore } from "../../src/contracts/fakes/secret-store";
import { buildDevBundledPlugins, devBundledSource, stageBundledPlugins, stagedBundledDir } from "../../src/registry/bundled-stage";
import { openPluginRegistry, type OpenedRegistry } from "../../src/registry/open";
import { pluginMcpServerKey } from "../../src/runtime-sdk/turn-loop/plugin-mcp";

const REPO_PLUGINS = join(import.meta.dir, "..", "..", "..", "..", "plugins");

let home = "";
let opened: OpenedRegistry;
let staged: { dir: string; digests: ReadonlyMap<string, string> };

/** The servers a bot's session is offered for the bundled plugins, as `PluginMcp.servers` names them: each `host`
 *  server of the staged registry's bundled plugins, under the key the daemon serves it by, with its manifest's tools. */
function offered(): OfferedServer[] {
  const out: OfferedServer[] = [];
  for (const p of opened.registry.list()) {
    if (p.source !== "bundled") continue;
    const servers = ((p.manifest as { contributes?: { mcpServers?: Record<string, { type?: string; tools?: Record<string, string> }> } } | undefined)?.contributes?.mcpServers) ?? {};
    for (const [name, s] of Object.entries(servers)) {
      if (s.type !== "host") continue;
      const key = pluginMcpServerKey(p.id, name, true);
      if (key !== undefined) out.push({ server: key, plugin: p.id, tools: Object.keys(s.tools ?? {}).filter((t) => t !== "*").map((t) => ({ name: t })) });
    }
  }
  return out;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "moss-bundled-tools-"));
  await buildDevBundledPlugins({ sources: REPO_PLUGINS, ids: ["alpha", "moss"], mossHome: home });
  const source = devBundledSource(home)!;
  const s = stageBundledPlugins({ ...source, out: stagedBundledDir(home) });
  staged = { dir: s.dir!, digests: s.digests! };
  mkdirSync(join(home, "plugins"), { recursive: true });
  opened = await openPluginRegistry({ mossHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), bundledDirs: [staged.dir], settleMs: 50 });
}, 240_000);

afterAll(() => {
  opened?.close();
  if (home !== "") rmSync(home, { recursive: true, force: true });
});

describe("the build's copy's declared tools on the staged tree", () => {
  const built = () => builtCopy({ record: (id: string) => opened.registry.get(id), staged });
  test("the builder's PluginNew is a read and the web plugin's tools are a search and a fetch, from their manifests", () => {
    const reg = opened.registry;
    expect(offered().find((s) => s.plugin === "moss/plugin-builder")).toEqual({ server: "builder", plugin: "moss/plugin-builder", tools: [{ name: "PluginNew" }] });
    expect(pluginToolReadOnly(reg, "moss/plugin-builder", "builder", "PluginNew", { built: built() })).toBe(true);
    expect(pluginWebTool(reg, "moss/web", "web", "WebSearch", { built: built() })).toBe("web-search");
    expect(pluginWebTool(reg, "moss/web", "web", "WebFetch", { built: built() })).toBe("web-fetch");
    // Another tool, or the same tools judged without the build's copy (a child of a tree that reaches the network):
    // never a read or a web tool.
    expect(pluginToolReadOnly(reg, "moss/plugin-builder", "builder", "Nope", { built: built() })).toBe(false);
    expect(pluginToolReadOnly(reg, "moss/plugin-builder", "builder", "PluginNew")).toBe(false);
    expect(pluginWebTool(reg, "moss/web", "web", "WebSearch")).toBeUndefined();
    expect(pluginToolReadOnly(reg, "moss/plugin-builder", "builder", "PluginNew", { built: builtCopy({ record: (id) => reg.get(id), staged: undefined }) })).toBe(false);
    expect(pluginToolReadOnly(reg, "moss/plugin-builder", "builder", "PluginNew", { built: builtCopy({ record: (id) => { const r = reg.get(id); return r === undefined ? undefined : { ...r, source: "local" }; }, staged }) })).toBe(false);
  });

  test("Alpha's call of PluginNew, loaded through Glossary first, raises no card at the default level", async () => {
    const asked: ApprovalRequest[] = [];
    const broker = { request: async (r: ApprovalRequest) => { asked.push(structuredClone(r)); return { allowed: r.effect === "read", by: r.effect === "read" ? "level" : "card" } as never; } };
    const check = botApprovalCheck(broker, {
      hostTools: () => ["Glossary", "PluginValidate", "PluginStatus", "PluginInstall", "SendMessage", "ListAgents", "TaskStop", "Agent", "RequestAccess"],
      readOnlyTool: (_ctx, tool) => tool === "mcp__builder__PluginNew" && pluginToolReadOnly(opened.registry, "moss/plugin-builder", "builder", "PluginNew", { built: built() }),
      levelOf: () => "ask-risky",
    });
    const ctx = { botId: "alpha", sessionId: "s1", computer: "Studio", paths: { scratch: join(home, "scratch", "alpha") }, caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "alpha" } } as unknown as BotSessionContext;
    const run = (tool: string, input: Record<string, unknown>) => check(ctx, () => "user")(tool, input, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" });
    for (const [tool, input] of [["Glossary", { load: "mcp__builder__PluginNew" }], ["mcp__builder__PluginNew", { template: "tool", id: "ws-greeter", name: "Workshop greeter" }]] as const) {
      asked.length = 0;
      const verdict = await run(tool, input);
      expect({ tool, behavior: verdict?.behavior, effect: asked[0]?.effect }).toEqual({ tool, behavior: "allow", effect: "read" });
    }
  });

  test("a staged manifest that no longer matches its digest is never the build's copy", () => {
    const rec = opened.registry.get("moss/plugin-builder")!;
    writeFileSync(join(rec.folder, "moss.json"), "{}\n");
    expect(built()("moss/plugin-builder")).toBe(false);
  });
});
