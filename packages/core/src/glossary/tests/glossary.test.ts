// `Glossary` (spec §6.8): the index built from the registry, keyword search, loads, and `glossary.query`.
import { describe, expect, test } from "bun:test";
import { catalogPointDecl, type Manifest } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePluginRegistry } from "../../contracts/fakes/plugin-registry";
import { glossaryMethods, GlossaryIndex, parseSkill, runGlossary, words } from "../index";

const manifest = (m: Partial<Manifest>): Manifest => ({ manifest: 1, name: "P", ...m }) as Manifest;

function setup() {
  const folder = mkdtempSync(join(tmpdir(), "clover-b2-glossary-"));
  const write = (rel: string, text: string) => {
    mkdirSync(join(folder, rel, ".."), { recursive: true });
    writeFileSync(join(folder, rel), text);
  };
  write("skills/deploy/SKILL.md", "---\nname: deploy-hetzner\ndescription: Deploy a site to a Hetzner server\n---\nUse rsync, then restart the service.\n");
  write("skills/pdf/SKILL.md", "---\nname: pdf-tools\ndescription: Read and split PDF files\n---\nUse qpdf.\n");
  const outside = mkdtempSync(join(tmpdir(), "clover-b2-outside-"));
  writeFileSync(join(outside, "SKILL.md"), "---\nname: stolen\ndescription: outside the plugin\n---\n");
  if (process.platform !== "win32") symlinkSync(outside, join(folder, "skills", "linked"));
  const registry = new FakePluginRegistry({
    catalog: catalogPointDecl,
    plugins: [{
      id: "ops", folder,
      manifest: manifest({
        id: "ops", name: "Ops", description: "Server operations", addons: { description: "deploy recipes" },
        contributes: { skills: ["skills/*"], agents: [{ id: "deployer", name: "Deployer", backend: "claude-code" }] },
      } as Partial<Manifest>),
    }],
  });
  const tools = [{ name: "mcp__ops__Restart", description: "Restart a service on a server", inputSchema: { type: "object", properties: { name: { type: "string" } } }, pluginId: "ops" }];
  return { registry, index: new GlossaryIndex({ registry, tools: () => tools }), write };
}

describe("Glossary", () => {
  test("a skill's front matter, and words for search", () => {
    expect(parseSkill("---\nname: a\ndescription: \"b c\"\n---\nbody")).toEqual({ name: "a", description: "b c", body: "body" });
    expect(parseSkill("no front matter")).toEqual({ body: "no front matter" });
    expect(words("Deploy to Hetzner, x!")).toEqual(["deploy", "to", "hetzner"]);
  });

  test("search finds skills, tools, agents, plugins and points, best match first", () => {
    const { index } = setup();
    expect(index.search("deploy to hetzner")[0]).toEqual({ name: "deploy-hetzner", kind: "skill", description: "Deploy a site to a Hetzner server", pluginId: "ops" });
    expect(index.search("restart").map((r) => r.name)).toContain("mcp__ops__Restart");
    expect(index.search("deployer").map((r) => [r.name, r.kind])).toContainEqual(["deployer", "agent"]);
    expect(index.search("ops")[0]).toMatchObject({ name: "ops", kind: "plugin", description: "Server operations Takes add-ons of its own: deploy recipes" });
    expect(index.search("hooks").some((r) => r.kind === "point" && r.name === "hooks")).toBe(true);
    expect(index.search("rsync").map((r) => r.name)).toEqual(["deploy-hetzner"]); // a skill's full text is searched
    expect(index.search("stolen")).toEqual([]); // a link out of the plugin's folder is never read
    expect(index.search("")).toEqual([]);
  });

  test("load: a tool's schema, a skill's instructions, an agent, or missing; the hooks hear tools and agents", () => {
    const { index } = setup();
    const loadedTools: string[] = [];
    const loadedAgents: string[] = [];
    const r = runGlossary(index, { query: ["pdf", "pdf"], load: ["mcp__ops__Restart", "pdf-tools", "deployer", "nope"] }, { onLoadTool: (n) => loadedTools.push(n), onLoadAgent: (n) => loadedAgents.push(n) });
    expect(r.results.filter((x) => x.name === "pdf-tools").length).toBe(1);
    expect(r.loaded).toEqual([
      { kind: "tool", name: "mcp__ops__Restart", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
      { kind: "skill", name: "pdf-tools", instructions: "---\nname: pdf-tools\ndescription: Read and split PDF files\n---\nUse qpdf.\n" },
      { kind: "agent", name: "deployer" },
      { kind: "missing", name: "nope" },
    ]);
    expect([loadedTools, loadedAgents]).toEqual([["mcp__ops__Restart"], ["deployer"]]);
  });

  test("the index rebuilds when a plugin changes, and glossary.query serves the same call", async () => {
    const { registry, index } = setup();
    expect(index.search("qpdf").length).toBe(1);
    registry.remove("ops");
    expect(index.search("qpdf")).toEqual([]);
    const m = glossaryMethods(index);
    expect(await m["glossary.query"]!({ query: "hooks" }, { caller: { kind: "core" } as Caller })).toMatchObject({ loaded: [] });
    index.close();
  });
});
