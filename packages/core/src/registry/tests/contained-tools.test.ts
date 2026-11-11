// Display-only MCP tools (`contained`, the owner's ask for a plugin's own stage): declared in the manifest, named on the
// OK card in a sentence of their own, true only for the tree the user OK'd; a change to the list asks for the OK
// again. The same conditions as read-only tools (never a dev folder, a child's list, a server or tree that can reach
// the network, or where the plugin fence doesn't hold), and besides, a tree holding no capability beyond reading
// Clover's own state. One tool is on one list at most.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITIES, CONTAINED_TOOL_CAPABILITIES, containedOkLines, containedToolsHold, OK_LINE_MAX, PLUGIN_API_VERSION, READ_ONLY_OK_MAX_LINES, validateManifest,
} from "@waifucave/clover-plugin-sdk";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../open";
import { pluginToolContained, pluginToolReadOnly } from "../read-only-tools";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const tempHome = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "clover-ct-")));
  temps.push(d);
  return d;
};

type Server = Record<string, unknown>;
const STDIO: Server = { type: "stdio", command: "bin/stage" };
const manifest = (contained?: string[], o: { id?: string; server?: Server; capabilities?: string[]; readOnly?: string[] } = {}) => JSON.stringify({
  manifest: 1, id: o.id ?? "stage", name: "Stage", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
  ...(o.capabilities ? { capabilities: o.capabilities } : {}),
  contributes: { mcpServers: { stage: { ...(o.server ?? STDIO), ...(contained ? { contained } : {}), ...(o.readOnly ? { readOnly: o.readOnly } : {}) } } },
});
const write = (dir: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "clover.json"), text);
};
const open = (home: string, extra: { bundledDirs?: string[] } = {}) =>
  openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50, sandboxed: true, ...extra });
const FENCED = { fenced: true };
const HELD = "Its server stage says these tools only change its own display, so at the default level they run without asking: celebrate, set_mood.";

describe("display-only MCP tools", () => {
  test("named on the OK in their own sentence; contained only as the OK'd tree says; a change to the list asks again", async () => {
    const home = tempHome();
    const dir = join(home, "plugins", "stage");
    write(dir, manifest(["set_mood", "celebrate"], { capabilities: ["bots.read", "conversation.read"] }));
    const opened = await open(home);
    try {
      const reg = opened.registry;
      expect(pluginToolContained(reg, "stage", "stage", "set_mood", FENCED)).toBe(false);
      expect(opened.folders.okText("stage", "macos", false, true).lines).toContain(HELD);
      await reg.approve("stage", reg.get("stage")!.treeHash!);
      expect(reg.get("stage")!.state).toBe("running");
      expect(["set_mood", "celebrate", "read_file"].map((t) => pluginToolContained(reg, "stage", "stage", t, FENCED))).toEqual([true, true, false]);
      // Never a read: the read-only list is another list.
      expect(pluginToolReadOnly(reg, "stage", "stage", "set_mood", FENCED)).toBe(false);
      expect(pluginToolContained(reg, "stage", "other", "set_mood", FENCED)).toBe(false);
      expect(pluginToolContained(reg, "stage", "stage", "set_mood", { fenced: false })).toBe(false);
      // A wider list asks again: until the new OK, nothing is contained.
      writeFileSync(join(dir, "clover.json"), manifest(["set_mood", "celebrate", "wipe"], { capabilities: ["bots.read", "conversation.read"] }));
      await opened.folders.refresh(dir);
      expect(reg.get("stage")!.state).toBe("found");
      expect(pluginToolContained(reg, "stage", "stage", "set_mood", FENCED)).toBe(false);
    } finally {
      opened.close();
    }
  });

  test("never for a development folder or a child's list; a bundled plugin's list holds", async () => {
    const home = tempHome();
    write(join(home, "plugins", "stage"), manifest(["set_mood"]));
    write(join(home, "plugins", "stage", "plugins", "extra"), JSON.stringify({
      manifest: 1, name: "Extra", version: "1.0.0", contributes: { mcpServers: { more: { type: "stdio", command: "bin/more", contained: ["wave"] } } },
    }));
    const bundled = join(home, "bundled");
    write(join(bundled, "mascot"), manifest(["set_mood"], { id: "mascot" }));
    const opened = await open(home, { bundledDirs: [bundled] });
    try {
      const reg = opened.registry;
      await reg.approve("stage", reg.get("stage")!.treeHash!);
      expect(pluginToolContained(reg, "stage", "stage", "set_mood", FENCED)).toBe(true);
      expect(pluginToolContained(reg, "stage/extra", "more", "wave", FENCED)).toBe(false);
      expect(reg.get("mascot")).toMatchObject({ state: "running", source: "bundled" });
      expect(pluginToolContained(reg, "mascot", "stage", "set_mood", FENCED)).toBe(true);
      const dev = join(home, "dev", "stage");
      write(dev, manifest(["set_mood", "wipe"]));
      await opened.folders.addDevFolder(dev, "cli");
      expect(reg.get("stage")).toMatchObject({ dev: true });
      expect(pluginToolContained(reg, "stage", "stage", "set_mood", FENCED)).toBe(false);
      expect(pluginToolContained(reg, "stage", "stage", "wipe", FENCED)).toBe(false);
    } finally {
      opened.close();
    }
  });

  test("a tree that can reach the network, or do more than read Clover's state, keeps the card, and its OK says so", async () => {
    const home = tempHome();
    const cases: [string, string][] = [
      ["web-stage", manifest(["set_mood"], { id: "web-stage", server: { type: "http", url: "https://stage.example.com/mcp" } })],
      ["net-stage", manifest(["set_mood"], { id: "net-stage", capabilities: ["network:api.example.com"] })],
      ["files-stage", manifest(["set_mood"], { id: "files-stage", capabilities: ["files"] })],
      ["notify-stage", manifest(["set_mood"], { id: "notify-stage", capabilities: ["notify"] })],
      ["post-stage", manifest(["set_mood"], { id: "post-stage", capabilities: ["conversation.post"] })],
      ["call-stage", manifest(["set_mood"], { id: "call-stage", capabilities: ["call:other"] })],
      ["logs-stage", manifest(["set_mood"], { id: "logs-stage", capabilities: ["logs.read"] })],
    ];
    for (const [id, text] of cases) write(join(home, "plugins", id), text);
    // A child's capability counts for its tree.
    write(join(home, "plugins", "pack"), manifest(["set_mood"], { id: "pack" }));
    write(join(home, "plugins", "pack", "plugins", "speaker"), JSON.stringify({ manifest: 1, name: "Speaker", version: "1.0.0", capabilities: ["audio"] }));
    const opened = await open(home);
    try {
      const reg = opened.registry;
      for (const id of [...cases.map(([i]) => i), "pack"]) {
        const lines = opened.folders.okText(id, "macos", false, true).lines;
        expect([id, lines.some((l) => l.includes("run without asking"))]).toEqual([id, false]);
        expect([id, lines]).toEqual([id, expect.arrayContaining(["Its server stage says one tool only changes its own display, but it can reach the network or do more than read Clover's state, so it still asks before running."])]);
        await reg.approve(id, reg.get(id)!.treeHash!);
        expect([id, pluginToolContained(reg, id, "stage", "set_mood", FENCED)]).toEqual([id, false]);
      }
    } finally {
      opened.close();
    }
  });

  test("an update that lets a tree with tools run without asking reach the network says so on its card", async () => {
    const home = tempHome();
    const dir = join(home, "plugins", "stage");
    write(dir, manifest(["set_mood"]));
    const opened = await open(home);
    try {
      const reg = opened.registry;
      const line = "This update lets it reach the network, which it couldn't when you OK'd the tools it runs without asking, so it could then send what its tools were given earlier.";
      expect(opened.folders.okText("stage", "macos", false, true).lines).not.toContain(line);
      await reg.approve("stage", reg.get("stage")!.treeHash!);
      writeFileSync(join(dir, "clover.json"), manifest(["set_mood"], { capabilities: ["network:api.example.com"] }));
      await opened.folders.refresh(dir);
      expect(reg.get("stage")!.state).toBe("found");
      expect(opened.folders.okText("stage", "macos", false, true).lines).toContain(line);
      // A tree with no such tools, gaining the network, gets no such line.
      const plain = join(home, "plugins", "plain");
      write(plain, JSON.stringify({ manifest: 1, id: "plain", name: "Plain", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, contributes: { mcpServers: { s: STDIO } } }));
      await opened.folders.refresh(plain);
      await reg.approve("plain", reg.get("plain")!.treeHash!);
      write(plain, JSON.stringify({ manifest: 1, id: "plain", name: "Plain", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, capabilities: ["network:api.example.com"], contributes: { mcpServers: { s: STDIO } } }));
      await opened.folders.refresh(plain);
      expect(opened.folders.okText("plain", "macos", false, true).lines).not.toContain(line);
    } finally {
      opened.close();
    }
  });

  test("the capabilities a contained tree may hold are reads of Clover's own state, and every other one keeps the card", () => {
    const tree = (capabilities: string[]) => ({ capabilities, wrappedNetwork: false, fenced: true });
    const server = { type: "host" };
    for (const c of CONTAINED_TOOL_CAPABILITIES) {
      // Reads of Clover's own state, and the one write that is only the plugin's own figure's display.
      expect([c, CAPABILITIES.some((k) => k.name === c), c.endsWith(".read") || c === "avatar.control"]).toEqual([c, true, true]);
      expect([c, containedToolsHold(server, tree([c]))]).toEqual([c, true]);
    }
    // Every other capability in the catalog, and one added later, keeps the card.
    const others = CAPABILITIES.map((k) => k.name.replace("<plugin-id>", "other").replace("<host>", "api.example.com"))
      .filter((c) => !CONTAINED_TOOL_CAPABILITIES.includes(c));
    expect(others).toEqual(expect.arrayContaining(["files", "project.write", "computers.control", "conversation.post", "browser", "terminal", "audio", "approvals", "notify", "logs.read", "plugins.install", "avatar.report", "network:public", "call:other", "network:api.example.com"]));
    for (const c of [...others, "something.new"]) expect([c, containedToolsHold(server, tree([c]))]).toEqual([c, false]);
    expect(containedToolsHold(server, tree([]))).toBe(true);
    expect(containedToolsHold(server, { ...tree([]), fenced: false })).toBe(false);
    expect(containedToolsHold(server, { ...tree([]), wrappedNetwork: true })).toBe(false);
    expect(containedToolsHold({ type: "http", url: "https://x.example.com" }, tree([]))).toBe(false);
  });

  test("a tool on both lists is refused at validation; both lists share the OK card's line cap", () => {
    const both = validateManifest(JSON.parse(manifest(["set_mood"], { readOnly: ["set_mood", "look"] })));
    expect(both.issues.map((i) => i.code)).toContain("tool_in_both_lists");
    const fine = validateManifest(JSON.parse(manifest(["set_mood"], { readOnly: ["look"] })));
    expect(fine.issues.filter((i) => i.severity === "error").map((i) => i.code)).toEqual([]);
    // Names that fill more lines than the card holds, across both lists, are refused.
    const name = (i: number) => `tool_${String(i).padStart(4, "0")}_${"x".repeat(50)}`;
    const per = Math.floor(OK_LINE_MAX / 60);
    const many = Array.from({ length: per * 2 + 10 }, (_, i) => name(i));
    expect(containedOkLines({ server: "stage", tools: many }, true).length).toBe(3);
    const crowded = validateManifest(JSON.parse(manifest(many, { readOnly: Array.from({ length: per * 2 }, (_, i) => name(10_000 + i)) })));
    expect(crowded.issues.map((i) => i.code)).toContain("read_only_too_long");
    expect(READ_ONLY_OK_MAX_LINES).toBe(4);
  });
});
