// `Glossary` and plugins (the coordinator's ruling of try 14e): loading a plugin is the way into what it offers a bot.
// A registry holding a plugin shaped like the owner's bot-built video editor (a host MCP server with an instructions
// file and 37 on-demand tools, two child plugins with servers of their own), one with more tools than load at once, a
// theme with nothing for bots, and plugins that don't run: built by this bot, by another, or installed by the user.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_LOAD_MAX_TOOLS, glossaryTool } from "../../../src/runtime-sdk/turn-loop/glossary";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const INSTRUCTIONS = "Start with OpenProject, then Timeline to see the clips. Export renders with ffmpeg.";
const tools = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i + 1}`, description: `Does ${prefix.toLowerCase()} step ${i + 1}\nMore detail that isn't the one line.`, load: "on-demand" as const, inputSchema: { type: "object" as const } }));

function world() {
  const folder = mkdtempSync(join(tmpdir(), "clover-a-glossary-"));
  dirs.push(folder);
  mkdirSync(join(folder, "skills", "cut"), { recursive: true });
  writeFileSync(join(folder, "skills", "cut", "SKILL.md"), "---\nname: rough-cut\ndescription: Make a rough cut\n---\nTrim the silences.\n");
  const records = [
    { id: "vid", name: "Video editor", description: "Edits videos with ffmpeg", state: "running", children: ["vid/fx", "vid/export"], provenance: { by: "bot", bot: "alpha" }, manifest: {} },
    { id: "vid/fx", parent: "vid", name: "Effects", state: "running", children: [], provenance: { by: "bot", bot: "alpha" }, manifest: {} },
    { id: "vid/export", parent: "vid", name: "Export", state: "running", children: [], provenance: { by: "bot", bot: "alpha" }, manifest: {} },
    { id: "big", name: "Big kit", state: "running", children: [], provenance: { by: "user-app" }, manifest: {} },
    { id: "dusk", name: "Dusk theme", description: "A dark theme", state: "running", children: [], provenance: { by: "user-app" }, manifest: {} },
    { id: "broken", name: "Broken tool", state: "stopped", reason: "crashed 3 times in 10 minutes: start failed: bug.", children: [], provenance: { by: "bot", bot: "alpha" }, manifest: {} },
    { id: "pending", name: "Pending tool", state: "found", children: [], provenance: { by: "bot", bot: "alpha" }, manifest: {} },
    { id: "lunas", name: "Luna's tool", state: "stopped", children: [], provenance: { by: "bot", bot: "luna" }, manifest: {} },
    { id: "users", name: "User's tool", state: "stopped", children: [], provenance: { by: "user-app" }, manifest: {} },
  ];
  const registry = {
    entries: (point: string) => (point === "skills" ? [{ point, pluginId: "vid", ref: "skills/0", value: "skills/*/SKILL.md", state: "active" }] : []),
    get: (id: string) => {
      const r = records.find((x) => x.id === id);
      return r === undefined ? undefined : { ...r, folder };
    },
    list: () => records,
    points: () => [{ name: "vid.filters", shape: "list", declaredBy: { pluginId: "vid" }, spot: false, active: true, decl: {} }],
  } as never;
  const servers = [
    { server: "vid-editor", plugin: "vid", instructions: INSTRUCTIONS, tools: tools("Edit", 37) },
    { server: "vid-fx-fx", plugin: "vid/fx", tools: tools("Fx", 3) },
    { server: "vid-export-out", plugin: "vid/export", instructions: "Pick a save target first.", tools: tools("Out", 2) },
    { server: "big-kit", plugin: "big", tools: tools("Big", PLUGIN_LOAD_MAX_TOOLS + 10) },
  ];
  const all = servers.flatMap((s) => s.tools.map((t) => ({ name: `mcp__${s.server}__${t.name}`, description: t.description })));
  return { registry, servers, all };
}

describe("Glossary: a skills entry that names a folder", () => {
  // A wrapped skill folder's generated manifest names its one skill's folder (`skills/<name>`); a hand-written one may
  // name the folders by a glob (`skills/*`). Each folder's SKILL.md is the skill, as `skills/*/SKILL.md` gives it.
  for (const value of ["skills/arrival-notes", "skills/arrival-notes/", "./skills/*", "skills/*/SKILL.md"]) {
    test(`${JSON.stringify(value)}: the skill is listed and loads`, async () => {
      const folder = mkdtempSync(join(tmpdir(), "clover-d-glossary-folder-"));
      dirs.push(folder);
      mkdirSync(join(folder, "skills", "arrival-notes", "scripts"), { recursive: true });
      writeFileSync(join(folder, "skills", "arrival-notes", "SKILL.md"), "---\nname: Arrival notes\ndescription: Notes on what arrived\n---\nARRIVAL-BODY\n");
      writeFileSync(join(folder, "skills", "arrival-notes", "scripts", "note.md"), "not a skill\n");
      const record = { id: "skill-arrival-notes", name: "Arrival notes", state: "running", children: [], provenance: { by: "user-app" }, manifest: {} };
      const registry = {
        entries: (point: string) => (point === "skills" ? [{ point, pluginId: record.id, ref: "skills/0", value, state: "active" }] : []),
        get: (id: string) => (id === record.id ? { ...record, folder } : undefined),
        list: () => [record],
        points: () => [],
      } as never;
      const tool = glossaryTool({ tools: () => [], registry, servers: () => [], bot: "alpha" });
      const found = await tool.run({ query: "arrival notes" });
      expect(found.text).toContain("skill-arrival-notes:Arrival notes");
      expect(found.text).not.toContain("note.md");
      const loaded = await tool.run({ load: "skill-arrival-notes:Arrival notes" });
      expect(loaded.text).toContain("ARRIVAL-BODY");
    });
  }
});

describe("Glossary: a plugin is the way into what it offers", () => {
  test("loading the video editor answers its state, its instructions and an index, and makes its own 37 tools callable (not its children's)", async () => {
    const w = world();
    const tool = glossaryTool({ tools: () => w.all, registry: w.registry, servers: () => w.servers, bot: "alpha" });
    const r = await tool.run({ load: "vid" });
    expect(r.isError).toBe(false);
    const text = r.text;
    // In order: the state line, the instructions, the tools, the skills, the points, the children.
    const at = (s: string) => {
      const i = text.indexOf(s);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at("Plugin vid (Video editor), running. Edits videos with ffmpeg."),
      at(`Its instructions:\n${INSTRUCTIONS}`),
      at("Its tools, loaded now (call them by name):"),
      at("- mcp__vid-editor__Edit1: Does edit step 1"),
      at("Its skills (load one by name for its instructions):\n- vid:rough-cut: Make a rough cut"),
      at("The points it declares:\n- vid.filters (extension point, shape list)"),
      at("Its child plugins (load each by its id for what it offers):\n- vid/fx (Effects)\n- vid/export (Export)"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).not.toContain("More detail that isn't the one line");
    expect(text).not.toContain("Pick a save target first.");
    const loaded = (r.meta as { "clover/load": string[] })["clover/load"];
    expect(loaded).toHaveLength(37);
    expect(loaded).toContain("mcp__vid-editor__Edit37");
    expect(loaded.some((n) => n.includes("vid-fx") || n.includes("vid-export"))).toBe(false);

    // A child, by its own id: its own instructions and tools.
    const child = await tool.run({ load: "vid/export" });
    expect(child.text).toContain("Plugin vid/export (Export), running.");
    expect(child.text).toContain("Its instructions:\nPick a save target first.");
    expect((child.meta as { "clover/load": string[] })["clover/load"]).toEqual(["mcp__vid-export-out__Out1", "mcp__vid-export-out__Out2"]);
  });

  test("over the cap, its tools are listed and none loaded; a plugin with nothing for bots keeps the plain answer", async () => {
    const w = world();
    const tool = glossaryTool({ tools: () => w.all, registry: w.registry, servers: () => w.servers, bot: "alpha" });
    const big = await tool.run({ load: "big" });
    expect(big.text).toContain(`Its tools (${PLUGIN_LOAD_MAX_TOOLS + 10}, more than ${PLUGIN_LOAD_MAX_TOOLS} at once: load the ones you need by name with Glossary):`);
    expect(big.text).toContain(`- mcp__big-kit__Big${PLUGIN_LOAD_MAX_TOOLS + 10}`);
    expect(big.meta).toBeUndefined();
    // Loading it with a few of its tools by name loads just those.
    const some = await tool.run({ load: ["big", "mcp__big-kit__Big3"] });
    expect(some.meta).toEqual({ "clover/load": ["mcp__big-kit__Big3"] });
    const theme = await tool.run({ load: "dusk" });
    expect(theme.text).toBe("dusk (plugin):\nPlugin dusk (Dusk theme), running.\nA dark theme");
    expect(theme.meta).toBeUndefined();
  });

  test("a plugin's search line says what loading it gives", async () => {
    const w = world();
    const tool = glossaryTool({ tools: () => w.all, registry: w.registry, servers: () => w.servers, bot: "alpha" });
    const r = await tool.run({ query: ["video editor", "dark theme"] });
    expect(r.text).toContain("- vid (plugin): Video editor: Edits videos with ffmpeg (load it for 37 tools, instructions, 1 skill, 1 point, 2 child plugins)");
    expect(r.text).toContain("- dusk (plugin): Dusk theme: A dark theme");
    expect(r.text).not.toContain("dusk (plugin): Dusk theme: A dark theme (load it");
    // Its tools' words find it too.
    expect((await tool.run({ query: "export renders ffmpeg" })).text).toContain("- vid (plugin)");
  });

  test("a plugin a bot built that doesn't run is listed to that bot alone, with its state and where its log is", async () => {
    const w = world();
    const alpha = glossaryTool({ tools: () => w.all, registry: w.registry, servers: () => w.servers, bot: "alpha" });
    const r = await alpha.run({ query: ["broken tool", "pending tool", "luna tool", "user tool"] });
    expect(r.text).toContain("- broken (plugin): Broken tool, which you built: stopped (crashed 3 times in 10 minutes: start failed: bug). PluginStatus broken has the log.");
    expect(r.text).toContain("- pending (plugin): Pending tool, which you built: waiting for the user's OK. PluginStatus pending has the log.");
    expect(r.text).not.toContain("- lunas (plugin)");
    expect(r.text).not.toContain("- users (plugin)");
    const loaded = await alpha.run({ load: "broken" });
    expect(loaded.text).toContain("PluginStatus broken has the log. Nothing of it can be loaded until it runs.");
    expect(loaded.meta).toBeUndefined();
    // Another bot, and a session with no bot, see none of them.
    const luna = glossaryTool({ tools: () => w.all, registry: w.registry, servers: () => w.servers, bot: "luna" });
    const lr = await luna.run({ query: ["broken tool", "luna tool"] });
    expect(lr.text).not.toContain("- broken (plugin)");
    expect(lr.text).toContain("- lunas (plugin): Luna's tool, which you built: stopped. PluginStatus lunas has the log.");
    const none = glossaryTool({ tools: () => w.all, registry: w.registry, servers: () => w.servers });
    expect((await none.run({ query: "broken tool" })).text).not.toContain("- broken (plugin)");
  });
});
