// The old product's names (`src/old-names.ts`): a project's `.clover/` folder, a `CLOVER.md`, a folder plugin's
// `clover.json`. The new build reads the new name first and the old name second, never writes the old one, and these
// are the only old names live code spells (the residue test holds the rest of the tree to that).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/moss-plugin-sdk";
import { readRawProjectMcpConfig } from "../src/agent/mcp/project-file";
import { loadProjectAgentDefinitions } from "../src/agent/agent-definitions";
import { readPluginFolder } from "../src/registry/folders";
import { treeEntries } from "../src/registry/tree";
import {
  OLD_INSTRUCTIONS_FILE, OLD_NAMES, OLD_PLUGIN_MANIFEST, OLD_PLUGIN_SDK, OLD_PROJECT_DIR, instructionsFileIn, manifestPathIn, newManifestFor, newThenOld, oldManifestFor, projectDirOf,
} from "../src/old-names";

const temps: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "moss-oldnames-")));
  temps.push(d);
  return d;
};
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

describe("the one list", () => {
  test("four names, and the helpers give the new name first, the old second, the new when neither is there", () => {
    expect([...OLD_NAMES]).toEqual([OLD_PROJECT_DIR, OLD_INSTRUCTIONS_FILE, OLD_PLUGIN_MANIFEST, OLD_PLUGIN_SDK]);
    const d = temp();
    expect([projectDirOf(d), instructionsFileIn(d), manifestPathIn(d)]).toEqual([join(d, ".moss"), join(d, "MOSS.md"), join(d, "moss.json")]);
    write(d, { [`${OLD_PROJECT_DIR}/x`]: "", [OLD_INSTRUCTIONS_FILE]: "old", [OLD_PLUGIN_MANIFEST]: "{}" });
    expect([projectDirOf(d), instructionsFileIn(d), manifestPathIn(d)]).toEqual([join(d, OLD_PROJECT_DIR), join(d, OLD_INSTRUCTIONS_FILE), join(d, OLD_PLUGIN_MANIFEST)]);
    write(d, { ".moss/x": "", "MOSS.md": "new", "moss.json": "{}" });
    expect([projectDirOf(d), instructionsFileIn(d), manifestPathIn(d)]).toEqual([join(d, ".moss"), join(d, "MOSS.md"), join(d, "moss.json")]);
    expect(newThenOld(join(d, "absent-new"), join(d, "absent-old"))).toBe(join(d, "absent-new"));
  });

  test("a manifest path maps to its old name at the top and in a child, and back; nothing else does", () => {
    expect([oldManifestFor("moss.json"), oldManifestFor("plugins/a/moss.json"), oldManifestFor("xmoss.json"), oldManifestFor("other.json")]).toEqual([OLD_PLUGIN_MANIFEST, `plugins/a/${OLD_PLUGIN_MANIFEST}`, undefined, undefined]);
    expect([newManifestFor(OLD_PLUGIN_MANIFEST), newManifestFor(`plugins/a/${OLD_PLUGIN_MANIFEST}`), newManifestFor(`deep/dir/${OLD_PLUGIN_MANIFEST}`), newManifestFor("moss.json")]).toEqual(["moss.json", "plugins/a/moss.json", undefined, undefined]);
  });
});

describe("a project's old folder", () => {
  test("its mcp.json is read when the new folder has none; the new folder's wins when both are there", () => {
    const d = temp();
    write(d, { [`${OLD_PROJECT_DIR}/mcp.json`]: JSON.stringify({ mcpServers: { old: { command: "x" } } }) });
    const old = readRawProjectMcpConfig(d);
    expect(old.kind === "ok" && Object.keys(old.servers)).toEqual(["old"]);
    write(d, { ".moss/mcp.json": JSON.stringify({ mcpServers: { fresh: { command: "y" } } }) });
    const both = readRawProjectMcpConfig(d);
    expect(both.kind === "ok" && Object.keys(both.servers)).toEqual(["fresh"]);
  });

  test("its agents are loaded when the new folder has none", () => {
    const d = temp();
    write(d, { [`${OLD_PROJECT_DIR}/agents/helper.md`]: "---\nname: helper\ndescription: Helps.\n---\nHelp.\n" });
    expect(Object.keys(loadProjectAgentDefinitions(d).definitions)).toEqual(["helper"]);
    write(d, { ".moss/agents/other.md": "---\nname: other\ndescription: Other.\n---\nOther.\n" });
    expect(Object.keys(loadProjectAgentDefinitions(d).definitions)).toEqual(["other"]);
  });
});

describe("a folder plugin's old manifest", () => {
  const manifest = (id: string) => JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { moss: `^${PLUGIN_API_VERSION}` }, contributes: { mcpServers: { srv: { type: "stdio", command: "bin/srv" } } } });

  test("is read as the plugin's manifest, and listed under the new name, so the tree hash is the same as the new-named folder's", async () => {
    const root = temp();
    const oldFolder = join(root, "tool");
    const newFolder = join(temp(), "tool");
    write(oldFolder, { [OLD_PLUGIN_MANIFEST]: manifest("tool"), "bin/srv": "#!/bin/sh\n" });
    write(newFolder, { "moss.json": manifest("tool"), "bin/srv": "#!/bin/sh\n" });
    const o = await readPluginFolder(oldFolder, { source: "local" });
    const n = await readPluginFolder(newFolder, { source: "local" });
    expect([o.parses, o.id, o.inputs[0]!.invalid, o.inputs[0]!.manifest.id]).toEqual([true, "tool", undefined, "tool"]);
    expect(o.inputs[0]!.treeHash).toBe(n.inputs[0]!.treeHash);
    expect(treeEntries(oldFolder).map((e) => e.path).sort()).toEqual(["bin/srv", "moss.json"]);
  });

  test("a folder with both is the new manifest's: the old file is just a file", async () => {
    const folder = join(temp(), "tool");
    write(folder, { "moss.json": manifest("tool"), [OLD_PLUGIN_MANIFEST]: manifest("stale"), "bin/srv": "#!/bin/sh\n" });
    const r = await readPluginFolder(folder, { source: "local" });
    expect([r.id, r.inputs[0]!.manifest.id]).toEqual(["tool", "tool"]);
    expect(treeEntries(folder).map((e) => e.path).sort()).toEqual(["bin/srv", OLD_PLUGIN_MANIFEST, "moss.json"]);
    expect(readFileSync(join(folder, OLD_PLUGIN_MANIFEST), "utf8")).toContain("stale");
  });
});
