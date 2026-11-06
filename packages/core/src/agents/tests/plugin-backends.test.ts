// Every agent backend is a plugin's entry (spec §5.3 `agentBackends`): the bundled `clover/agent-<id>` plugins load in
// lane B's real registry, each entry's quirks file reads into a backend's row, a third-party plugin adds one the same
// way after its OK, a quirks file that leaves the plugin's folder or doesn't hold quirks is left out, and only Clover's
// own plugin for an id gets what the core grants by id.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import { RegistryCore } from "../../registry/core";
import { PluginFolders } from "../../registry/folders";
import { fileRegistryStore } from "../../registry/state";
import type { Contribution, PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";
import { ContributedBackendCache, contributedBackends, readQuirksFile } from "../plugin-backends";
import { BUNDLED_PLUGINS_DIR, bundledBackends } from "../testing/bundled-backends";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world() {
  const home = mkdtempSync(join(tmpdir(), "clover-k-plugins-"));
  temps.push(home);
  const pluginsDir = join(home, "plugins");
  const bundledDir = join(home, "app", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  // The bundled `clover` tree, with only its agent backends' children.
  const clover = join(bundledDir, "clover");
  mkdirSync(join(clover, "plugins"), { recursive: true });
  cpSync(join(BUNDLED_PLUGINS_DIR, "..", "clover.json"), join(clover, "clover.json"));
  for (const name of readdirSync(BUNDLED_PLUGINS_DIR).filter((n) => n.startsWith("agent-"))) cpSync(join(BUNDLED_PLUGINS_DIR, name), join(clover, "plugins", name), { recursive: true });
  const store = fileRegistryStore(join(home, "plugins-state"));
  let folders: PluginFolders;
  const core = new RegistryCore({ catalog: catalogPointDecl, store, onOk: (id, hash) => folders.okGiven(id, hash) });
  folders = new PluginFolders({ core, store, pluginsDir, bundledDirs: [bundledDir], settleMs: 0 });
  return { home, pluginsDir, core, folders };
}

const QUIRKS_OF = (id: string) => bundledBackends()[id]!.file;

describe("agent backends from plugins", () => {
  test("the bundled agent-<id> plugins validate, run, and give every backend's row as its quirks file holds it", async () => {
    const w = world();
    await w.folders.scan();
    const rows = bundledBackends();
    for (const r of Object.values(rows)) {
      const record = w.core.get(r.pluginId)!;
      expect([r.pluginId, record.state, record.issues.filter((i) => i.severity === "error")]).toEqual([r.pluginId, "running", []]);
    }
    const lines: string[] = [];
    const got = contributedBackends(w.core, (l) => lines.push(l));
    expect(lines).toEqual([]);
    expect(got.map((c) => c.id).sort()).toEqual(Object.keys(rows).sort());
    for (const c of got) {
      expect(c).toMatchObject({ pluginId: `clover/agent-${c.id}`, bundled: true, name: rows[c.id]!.name });
      expect(c.file).toEqual(rows[c.id]!.file);
      // The program is the manifest entry's, on every OS (what the OK covers); the file holds no command.
      expect(c.quirks.launch.command).toEqual({ macos: [c.command.program, ...c.command.acpArgs], linux: [c.command.program, ...c.command.acpArgs], windows: [c.command.program, ...c.command.acpArgs] });
      expect("command" in c.file.quirks.launch).toBe(false);
    }
    expect(got.find((c) => c.id === "cursor")!.file.readOnlyMode).toEqual({ option: "mode", values: ["ask", "plan"] });
    expect(got.find((c) => c.id === "devin-cloud")!.file.quirks.placement).toBe("cloud");
  });

  test("a third-party plugin adds an ACP backend the same way, after its OK; it isn't Clover's own", async () => {
    const w = world();
    const folder = join(w.pluginsDir, "my-agent");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id: "my-agent", name: "My agent", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
      contributes: { agentBackends: [{ id: "my-agent", name: "My agent", protocol: "acp", command: "my-agent", args: ["acp"], quirks: "rows/quirks.json" }] },
    }));
    mkdirSync(join(folder, "rows"));
    writeFileSync(join(folder, "rows", "quirks.json"), JSON.stringify({ ...QUIRKS_OF("grok"), source: "its own" }));
    await w.folders.scan();
    // Found: it waits for the user's OK, and nothing of it is offered.
    expect(contributedBackends(w.core).some((c) => c.id === "my-agent")).toBe(false);
    expect(await w.core.approve("my-agent", w.core.get("my-agent")!.treeHash!)).toBe("approved");
    const mine = contributedBackends(w.core).find((c) => c.id === "my-agent")!;
    expect(mine).toMatchObject({ pluginId: "my-agent", bundled: false, command: { program: "my-agent", acpArgs: ["acp"] }, file: { source: "its own" } });
  });

  test("a quirks file outside the plugin, through a link, or that isn't a backend's quirks is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "clover-k-quirks-"));
    temps.push(root);
    const folder = join(root, "p");
    mkdirSync(folder);
    writeFileSync(join(root, "outside.json"), JSON.stringify(QUIRKS_OF("grok")));
    expect(() => readQuirksFile(folder, "../outside.json")).toThrow(/inside the plugin/);
    expect(() => readQuirksFile(folder, join(root, "outside.json"))).toThrow(/inside the plugin/);
    require("node:fs").symlinkSync(join(root, "outside.json"), join(folder, "q.json"));
    expect(() => readQuirksFile(folder, "q.json")).toThrow(/leads out of the plugin/);
    const bad = { ...QUIRKS_OF("grok"), quirks: { ...QUIRKS_OF("grok").quirks, launch: { ...QUIRKS_OF("grok").quirks.launch, identity: { versionArgs: [], versionPattern: "", signer: "not-a-team" } } } };
    writeFileSync(join(folder, "bad.json"), JSON.stringify(bad));
    expect(() => readQuirksFile(folder, "bad.json")).toThrow(/doesn't hold a backend's quirks/);
    writeFileSync(join(folder, "extra.json"), JSON.stringify({ ...QUIRKS_OF("grok"), quirks: { ...QUIRKS_OF("grok").quirks, sneaky: true } }));
    expect(() => readQuirksFile(folder, "extra.json")).toThrow(/doesn't hold a backend's quirks/);
  });

  test("only Clover's own plugin for an id is bundled; a broken entry is left out with its reason; a backend is built once per tree", () => {
    const root = mkdtempSync(join(tmpdir(), "clover-k-reg-"));
    temps.push(root);
    const good = join(root, "good");
    mkdirSync(good);
    writeFileSync(join(good, "quirks.json"), JSON.stringify(QUIRKS_OF("cursor")));
    const records: Record<string, Partial<PluginRecord>> = {
      "someone/agents": { folder: good, treeHash: "a".repeat(64), provenance: { by: "found", at: 1 } as PluginRecord["provenance"] },
      "clover/agent-cursor": { folder: good, treeHash: "b".repeat(64), provenance: { by: "found", at: 1 } as PluginRecord["provenance"] },
    };
    let entries: Contribution[] = [
      { point: "agentBackends", pluginId: "someone/agents", ref: "agentBackends/0", entryId: "cursor", state: "active", value: { id: "cursor", name: "Not Cursor", protocol: "acp", command: "cursor-agent", args: ["acp"], quirks: "quirks.json" } },
      { point: "agentBackends", pluginId: "someone/agents", ref: "agentBackends/1", entryId: "nope", state: "active", value: { id: "nope", name: "Nope", protocol: "acp", command: "nope", quirks: "missing.json" } },
      { point: "agentBackends", pluginId: "someone/agents", ref: "agentBackends/2", entryId: "later", state: "waiting", value: { id: "later", name: "Later", protocol: "acp", command: "later", quirks: "quirks.json" } },
      { point: "agentBackends", pluginId: "someone/agents", ref: "agentBackends/3", entryId: "vendor", state: "active", value: { id: "vendor", name: "Vendor", protocol: "cloud", handler: "start" } },
    ];
    const registry = { entries: () => entries, get: (id: string) => records[id] as PluginRecord | undefined } as unknown as Pick<PluginRegistry, "entries" | "get">;
    const lines: string[] = [];
    const got = contributedBackends(registry, (l) => lines.push(l));
    // Another plugin's `cursor` gets nothing the core grants Clover's own by id.
    expect(got.map((c) => [c.id, c.bundled])).toEqual([["cursor", false]]);
    expect(lines.join("\n")).toContain("nope");
    // Clover's own id, but not loaded as a bundled plugin: still not bundled.
    entries = [{ ...entries[0]!, pluginId: "clover/agent-cursor" }];
    expect(contributedBackends(registry).map((c) => c.bundled)).toEqual([false]);
    records["clover/agent-cursor"]!.provenance = { by: "bundled", at: 1 } as PluginRecord["provenance"];
    expect(contributedBackends(registry).map((c) => c.bundled)).toEqual([true]);
    let built = 0;
    const cache = new ContributedBackendCache((c) => ({ id: c.id, n: ++built }) as never);
    const first = cache.backends(registry);
    expect(cache.backends(registry)).toEqual(first);
    expect(built).toBe(1);
    records["clover/agent-cursor"]!.treeHash = "c".repeat(64);
    cache.backends(registry);
    expect(built).toBe(2);
  });
});
