// A bundled tool that only reads runs with no card at the default level on the REAL path: the repository's bundled tree
// built and staged as a source daemon stages it (`buildDevBundledPlugins`, `stageBundledPlugins`), the real registry
// over that staged copy, the daemon's own lookup (`bundledToolKind`, the function daemon.ts calls) and the real approval
// check. A call loaded through Glossary first (an on-demand tool) costs no card for the load either. The 14c acceptance
// found PluginNew carded: the load through Glossary was judged as an unknown tool, and no test went this way.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botApprovalCheck } from "../../src/approvals/bot-check";
import { bundledToolKind, type OfferedServer } from "../../src/approvals/bundled-tools";
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
  home = mkdtempSync(join(tmpdir(), "clover-bundled-tools-"));
  await buildDevBundledPlugins({ sources: REPO_PLUGINS, ids: ["alpha", "clover"], cloverHome: home });
  const source = devBundledSource(home)!;
  const s = stageBundledPlugins({ ...source, out: stagedBundledDir(home) });
  staged = { dir: s.dir!, digests: s.digests! };
  mkdirSync(join(home, "plugins"), { recursive: true });
  opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), bundledDirs: [staged.dir], settleMs: 50 });
}, 240_000);

afterAll(() => {
  opened?.close();
  if (home !== "") rmSync(home, { recursive: true, force: true });
});

describe("bundled tools on the staged tree", () => {
  test("the builder's PluginNew is a read and the web plugin's tools are theirs, by the daemon's own lookup", () => {
    const lookup = { servers: offered(), record: (id: string) => opened.registry.get(id), staged };
    expect(lookup.servers.find((s) => s.plugin === "clover/plugin-builder")).toEqual({ server: "builder", plugin: "clover/plugin-builder", tools: [{ name: "PluginNew" }] });
    expect(bundledToolKind(lookup, "mcp__builder__PluginNew")).toBe("read");
    expect(bundledToolKind(lookup, "mcp__web__WebSearch")).toBe("web-search");
    expect(bundledToolKind(lookup, "mcp__web__WebFetch")).toBe("web-fetch");
    // Another name, another plugin's server under the same tool name, no staged copy: never a bundled tool.
    expect(bundledToolKind(lookup, "mcp__builder__Nope")).toBeUndefined();
    expect(bundledToolKind({ ...lookup, servers: [...lookup.servers, { server: "acme-builder", plugin: "acme", tools: [{ name: "PluginNew" }] }] }, "mcp__acme-builder__PluginNew")).toBeUndefined();
    expect(bundledToolKind({ ...lookup, staged: undefined }, "mcp__builder__PluginNew")).toBeUndefined();
    expect(bundledToolKind({ ...lookup, record: (id) => { const r = opened.registry.get(id); return r === undefined ? undefined : { ...r, source: "local" }; } }, "mcp__builder__PluginNew")).toBeUndefined();
  });

  test("Alpha's call of PluginNew, loaded through Glossary first, raises no card at the default level", async () => {
    const asked: ApprovalRequest[] = [];
    const broker = { request: async (r: ApprovalRequest) => { asked.push(structuredClone(r)); return { allowed: r.effect === "read", by: r.effect === "read" ? "level" : "card" } as never; } };
    const lookup = { servers: offered(), record: (id: string) => opened.registry.get(id), staged };
    const check = botApprovalCheck(broker, {
      hostTools: () => ["Glossary", "PluginValidate", "PluginStatus", "PluginInstall", "SendMessage", "ListAgents", "TaskStop", "Agent", "RequestAccess"],
      bundledTool: (_ctx, tool) => bundledToolKind(lookup, tool),
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

  test("a staged manifest that no longer matches its digest is never a bundled tool", () => {
    const rec = opened.registry.get("clover/plugin-builder")!;
    const lookup = { servers: offered(), record: (id: string) => opened.registry.get(id), staged };
    writeFileSync(join(rec.folder, "clover.json"), "{}\n");
    expect(bundledToolKind(lookup, "mcp__builder__PluginNew")).toBeUndefined();
  });
});
