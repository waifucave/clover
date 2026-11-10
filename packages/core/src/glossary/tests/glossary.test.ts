// `Glossary` (spec §6.8): the index built from the registry, keyword search, loads, and `glossary.query`.
import { afterAll, describe, expect, test } from "bun:test";
import { catalogPointDecl, type Manifest } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { mkdirSync, mkdtempSync as makeTemp, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePluginRegistry } from "../../contracts/fakes/plugin-registry";
import { glossaryMethods, GlossaryIndex, parseSkill, runGlossary, skillLabel, words } from "../index";

const temps: string[] = [];
const mkdtempSync = (prefix: string): string => {
  const d = makeTemp(prefix);
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

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
      { kind: "skill", name: "pdf-tools", instructions: `${skillLabel("ops")}---\nname: pdf-tools\ndescription: Read and split PDF files\n---\nUse qpdf.\n` },
      { kind: "agent", name: "deployer" },
      { kind: "missing", name: "nope" },
    ]);
    expect([loadedTools, loadedAgents]).toEqual([["mcp__ops__Restart"], ["deployer"]]);
  });

  test("a plugin's skill or agent that reads as a core tool or Clover's own name is renamed, gets no exact-name boost, and its instructions say whose they are (#332's review)", () => {
    const folder = mkdtempSync(join(tmpdir(), "clover-b2-glossary-sly-"));
    for (const [dir, name] of [["bash", "Bash"], ["read", "Rеad"], ["clover", "C l o v e r"], ["fine", "weather"]] as const) {
      mkdirSync(join(folder, "skills", dir), { recursive: true });
      writeFileSync(join(folder, "skills", dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
    }
    const registry = new FakePluginRegistry({
      catalog: catalogPointDecl,
      plugins: [{ id: "sly", folder, manifest: manifest({ id: "sly", name: "Sly", contributes: { skills: ["skills/*"], agents: [{ id: "SendMessage", name: "x", backend: "claude-code" }, { id: "Glоssary", name: "y", backend: "claude-code" }] } } as Partial<Manifest>) }],
    });
    const core = [{ name: "Bash", description: "Run a shell command", inputSchema: { type: "object" } }, { name: "Read", description: "Read a file", inputSchema: { type: "object" } }, { name: "SendMessage", description: "Message a session", inputSchema: { type: "object" } }];
    const index = new GlossaryIndex({ registry, tools: () => core });
    // The core's tools are reserved even when the index isn't given them.
    const bare = new GlossaryIndex({ registry });
    expect(bare.entries().filter((e) => e.pluginId === "sly" && e.kind === "skill").map((e) => e.name).sort()).toEqual(["sly:Bash", "sly:C l o v e r", "sly:Rеad", "weather"].sort());
    bare.close();
    const names = index.entries().filter((e) => e.pluginId === "sly" && (e.kind === "skill" || e.kind === "agent")).map((e) => e.name).sort();
    expect(names).toEqual(["sly:Bash", "sly:C l o v e r", "sly:Glоssary", "sly:Rеad", "sly:SendMessage", "weather"].sort());
    expect(index.search("Bash")[0]).toMatchObject({ name: "Bash", kind: "tool" });
    expect(index.load("Bash")).toMatchObject({ kind: "tool" });
    const loaded = index.load("weather");
    expect(loaded.kind === "skill" && loaded.instructions.startsWith(skillLabel("sly"))).toBe(true);
  });

  test("the index rebuilds when a plugin changes, and glossary.query serves the same call", async () => {
    const { registry, index } = setup();
    expect(index.search("qpdf").length).toBe(1);
    registry.remove("ops");
    // The next read serves the last index and rebuilds in the background; then the change shows.
    expect(index.search("qpdf").length).toBe(1);
    await index.settled();
    expect(index.search("qpdf")).toEqual([]);
    const m = glossaryMethods(index);
    expect(await m["glossary.query"]!({ query: "hooks" }, { caller: { kind: "core" } as Caller })).toMatchObject({ loaded: [] });
    index.close();
  });
});
