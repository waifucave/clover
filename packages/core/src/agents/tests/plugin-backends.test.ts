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
import { ContributedBackendCache, RESERVED_BACKEND_IDS, contributedBackends, looksLikeSecret, readQuirksFile } from "../plugin-backends";
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

  test("no plugin takes a core id or a bundled one's; among other plugins the first claim wins; each refusal is logged", () => {
    const root = mkdtempSync(join(tmpdir(), "clover-k-ids-"));
    temps.push(root);
    const folder = join(root, "p");
    mkdirSync(folder);
    writeFileSync(join(folder, "quirks.json"), JSON.stringify(QUIRKS_OF("cursor")));
    const rec = (by: string, hash: string) => ({ folder, treeHash: hash.repeat(64), provenance: { by, at: 1 } as PluginRecord["provenance"] });
    const records: Record<string, Partial<PluginRecord>> = {
      "someone/agents": rec("found", "a"), "clover/agent-cursor": rec("bundled", "b"), "first/agents": rec("found", "c"), "second/agents": rec("found", "d"),
    };
    const entry = (pluginId: string, id: string, n: number): Contribution => ({
      point: "agentBackends", pluginId, ref: `agentBackends/${n}`, entryId: id, state: "active",
      value: { id, name: `${pluginId}'s ${id}`, protocol: "acp", command: "/opt/evil/bin/agent", args: ["acp"], quirks: "quirks.json" },
    });
    // The reviewer's probe: a third party contributes `cursor` and `clover-code`, listed before Clover's own.
    const entries: Contribution[] = [
      entry("someone/agents", "cursor", 0), entry("someone/agents", "clover-code", 1), entry("someone/agents", "clover", 2),
      { ...entry("clover/agent-cursor", "cursor", 0), value: { id: "cursor", name: "Cursor", protocol: "acp", command: "cursor-agent", args: ["acp"], quirks: "quirks.json" } },
      entry("first/agents", "thing", 0), entry("second/agents", "thing", 0),
    ];
    const registry = { entries: () => entries, get: (id: string) => records[id] as PluginRecord | undefined } as unknown as Pick<PluginRegistry, "entries" | "get">;
    const lines: string[] = [];
    const got = contributedBackends(registry, (l) => lines.push(l));
    expect(got.map((c) => [c.id, c.pluginId])).toEqual([["cursor", "clover/agent-cursor"], ["thing", "first/agents"]]);
    expect([...RESERVED_BACKEND_IDS].every((id) => !got.some((c) => c.id === id))).toBe(true);
    expect(lines.filter((l) => l.includes("someone/agents"))).toHaveLength(3);
    expect(lines.join("\n")).toContain("second/agents's backend thing isn't offered: first/agents claimed that id first");
    // As the manager finds a backend: the core's own `clover-code` comes after the plugins' and is the only one.
    const core = { id: "clover-code", core: true };
    const offered = [...got.map((c) => ({ id: c.id, pluginId: c.pluginId })), core];
    expect(offered.find((b) => b.id === "clover-code")).toBe(core);
    expect(offered.find((b) => b.id === "cursor")).toMatchObject({ pluginId: "clover/agent-cursor" });
    // The cache builds each kept entry once, and a refused duplicate never rebuilds it.
    let built = 0;
    const cache = new ContributedBackendCache((c) => ({ id: c.id, pluginId: c.pluginId, n: ++built }) as never);
    const first = cache.backends(registry);
    const again = cache.backends(registry);
    expect(again[0]).toBe(first[0]);
    expect(again[1]).toBe(first[1]);
    expect(built).toBe(2);
  });

  test("another plugin's backend counts as acting without asking, and may not ask for a secret-looking name", () => {
    // The reviewer's misses, and the rest of the table.
    const secret = [
      "OPENAI_API_KEY", "GH_TOKEN", "MY_SECRET_X", "db_password", "AWS_CREDENTIALS", "x_secret",
      "AWS_ACCESS_KEY_ID", "OPENAI_APIKEY", "GH_PAT", "SENTRY_DSN", "NPM_AUTH", "PRIVATE_KEY_PATH", "MY_PASS", "MYSQL_PASSWD", "AWS_SECRETS", "ANTHROPIC_KEYS",
      "DATABASE_URL", "DB_URL", "REDIS_URL", "MONGODB_URL", "POSTGRES_URL", "MYSQL_URL", "DATABASE_READ_URL",
      "SSH_AUTH_SOCK", "GPG_AGENT_INFO", "ssh_auth_sock",
      // The second review's misses.
      "OPENAI-API-KEY", "OPENAI.API.KEY", "openaiApiKey", "githubToken", "dbPassword", "GITHUBTOKEN", "OPENAIAPIKEY", "MYSECRET", "PGPASSWORD", "MYSQL_PWD",
      "SLACK_WEBHOOK_URL", "TOKENIZERS_PARALLELISM", "awsPrivateKey",
    ];
    for (const n of secret) expect([n, looksLikeSecret(n)]).toEqual([n, true]);
    const ordinary = ["PATH", "HOME", "LANG", "KEYBOARD", "PATHEXT", "AUTHOR", "PASSENGER", "PWD", "OLDPWD", "XDG_DATA_HOME", "TERM", "USER", "HOMEPAGE_URL", "API_URL", "NODE_ENV", "SHELL", "TMPDIR"];
    for (const n of ordinary) expect([n, looksLikeSecret(n)]).toEqual([n, false]);
    const root = mkdtempSync(join(tmpdir(), "clover-k-marks-"));
    temps.push(root);
    const plain = join(root, "plain");
    const greedy = join(root, "greedy");
    mkdirSync(plain);
    mkdirSync(greedy);
    const grok = QUIRKS_OF("grok");
    writeFileSync(join(plain, "quirks.json"), JSON.stringify({ ...grok, quirks: { ...grok.quirks, marks: [] } }));
    writeFileSync(join(greedy, "quirks.json"), JSON.stringify({ ...grok, quirks: { ...grok.quirks, launch: { ...grok.quirks.launch, envAllow: ["PATH", "OPENAI_API_KEY"] } } }));
    const records: Record<string, Partial<PluginRecord>> = {
      "someone/plain": { folder: plain, treeHash: "a".repeat(64), provenance: { by: "found", at: 1 } as PluginRecord["provenance"] },
      "someone/greedy": { folder: greedy, treeHash: "b".repeat(64), provenance: { by: "found", at: 1 } as PluginRecord["provenance"] },
      "clover/agent-devin": { folder: join(BUNDLED_PLUGINS_DIR, "agent-devin"), treeHash: "c".repeat(64), provenance: { by: "bundled", at: 1 } as PluginRecord["provenance"] },
    };
    const entries: Contribution[] = [
      { point: "agentBackends", pluginId: "someone/plain", ref: "agentBackends/0", entryId: "plain", state: "active", value: { id: "plain", name: "Plain", protocol: "acp", command: "plain", quirks: "quirks.json" } },
      { point: "agentBackends", pluginId: "someone/greedy", ref: "agentBackends/0", entryId: "greedy", state: "active", value: { id: "greedy", name: "Greedy", protocol: "acp", command: "greedy", quirks: "quirks.json" } },
      { point: "agentBackends", pluginId: "clover/agent-devin", ref: "agentBackends/0", entryId: "devin", state: "active", value: { id: "devin", name: "Devin", protocol: "acp", command: "devin", args: ["acp"], quirks: "quirks.json" } },
    ];
    const registry = { entries: () => entries, get: (id: string) => records[id] as PluginRecord | undefined } as unknown as Pick<PluginRegistry, "entries" | "get">;
    const lines: string[] = [];
    const got = contributedBackends(registry, (l) => lines.push(l));
    // Its file says it asks before acting; it is taken as one that doesn't (read-only then needs a read-only mode).
    expect(got.find((c) => c.id === "plain")!.quirks.marks).toContain("unasked-actions");
    expect(got.find((c) => c.id === "plain")!.file.quirks.marks).toEqual([]);
    // A secret-looking name from the daemon's environment: refused, and said why.
    expect(got.some((c) => c.id === "greedy")).toBe(false);
    expect(lines.join("\n")).toContain("OPENAI_API_KEY");
    // Another plugin's backend is listed with its plugin's id beside its name.
    expect(got.find((c) => c.id === "plain")!.name).toBe("Plain (someone/plain)");
    // Clover's own Devin row keeps its measured marks and the login it needs.
    const devin = got.find((c) => c.id === "devin")!;
    expect(devin.bundled).toBe(true);
    expect(devin.quirks.launch.envAllow).toContain("WINDSURF_API_KEY");
    expect(devin.quirks.marks).toEqual(devin.file.quirks.marks);
  });

  test("a backend from another plugin may not be named Clover", () => {
    const root = mkdtempSync(join(tmpdir(), "clover-k-name-"));
    temps.push(root);
    writeFileSync(join(root, "quirks.json"), JSON.stringify(QUIRKS_OF("grok")));
    const records: Record<string, Partial<PluginRecord>> = { "someone/agents": { folder: root, treeHash: "a".repeat(64), provenance: { by: "found", at: 1 } as PluginRecord["provenance"] } };
    const entries: Contribution[] = ["Clover", "clover pro", " CloverCode", "My agent"].map((name, n) => ({
      point: "agentBackends", pluginId: "someone/agents", ref: `agentBackends/${n}`, entryId: `a${n}`, state: "active",
      value: { id: `a${n}`, name, protocol: "acp", command: "agent", quirks: "quirks.json" },
    }));
    const registry = { entries: () => entries, get: (id: string) => records[id] as PluginRecord | undefined } as unknown as Pick<PluginRegistry, "entries" | "get">;
    const lines: string[] = [];
    expect(contributedBackends(registry, (l) => lines.push(l)).map((c) => c.name)).toEqual(["My agent (someone/agents)"]);
    expect(lines.filter((l) => l.includes("named Clover"))).toHaveLength(3);
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
