// Read-only MCP tools (lane C's ask): declared in the manifest, named on the OK card, true only for the tree the user
// OK'd; a change to the list asks for the OK again, and nothing a server says at run time counts. Never for a dev
// folder or a server that can reach the network, and the card says so; a list the card can't show is refused.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeOk, OK_LINE_MAX, PLUGIN_API_VERSION, readOnlyOkLines, READ_ONLY_OK_MAX_LINES, validateManifest } from "@waifucave/clover-plugin-sdk";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../open";
import { pluginToolReadOnly } from "../read-only-tools";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const tempHome = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "clover-ro-")));
  temps.push(d);
  return d;
};

type Server = Record<string, unknown>;
const STDIO: Server = { type: "stdio", command: "bin/notes" };
const manifest = (readOnly?: string[], o: { id?: string; server?: Server; capabilities?: string[] } = {}) => JSON.stringify({
  manifest: 1, id: o.id ?? "notes", name: "Notes", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
  ...(o.capabilities ? { capabilities: o.capabilities } : {}),
  contributes: { mcpServers: { notes: { ...(o.server ?? STDIO), ...(readOnly ? { readOnly } : {}) } } },
});
const write = (dir: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "clover.json"), text);
};
const open = (home: string, extra: { bundledDirs?: string[] } = {}) =>
  openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50, sandboxed: true, ...extra });
const FENCED = { fenced: true };

describe("read-only MCP tools", () => {
  test("named on the OK; read-only only as the OK'd tree says; a change to the list asks again", async () => {
    const home = tempHome();
    const dir = join(home, "plugins", "notes");
    write(dir, manifest(["search", "read_note"]));
    const opened = await open(home);
    try {
      const reg = opened.registry;
      // Not before the OK.
      expect(pluginToolReadOnly(reg, "notes", "notes", "search", FENCED)).toBe(false);
      expect(opened.folders.okText("notes", "macos", false, true).lines).toContain("Its server notes says these 2 tools only read, so at the default approval level they run without asking: read_note, search.");
      await reg.approve("notes", reg.get("notes")!.treeHash!);
      expect(reg.get("notes")!.state).toBe("running");
      expect(["search", "read_note", "delete_note"].map((t) => pluginToolReadOnly(reg, "notes", "notes", t, FENCED))).toEqual([true, true, false]);
      expect(pluginToolReadOnly(reg, "notes", "other", "search", FENCED)).toBe(false);
      // Where Clover's fence doesn't hold plugin processes, a stdio server can reach the network: no skip.
      expect(pluginToolReadOnly(reg, "notes", "notes", "search", { fenced: false })).toBe(false);
      // A wider list is a change that asks again: until the new OK, nothing is read-only.
      writeFileSync(join(dir, "clover.json"), manifest(["search", "read_note", "delete_note"]));
      await opened.folders.refresh(dir);
      expect(reg.get("notes")!.state).toBe("found");
      expect(pluginToolReadOnly(reg, "notes", "notes", "delete_note", FENCED)).toBe(false);
      expect(pluginToolReadOnly(reg, "notes", "notes", "search", FENCED)).toBe(false);
      await reg.approve("notes", reg.get("notes")!.treeHash!);
      expect(pluginToolReadOnly(reg, "notes", "notes", "delete_note", FENCED)).toBe(true);
      // Taking the list away asks again too.
      writeFileSync(join(dir, "clover.json"), manifest());
      await opened.folders.refresh(dir);
      expect(reg.get("notes")!.state).toBe("found");
    } finally {
      opened.close();
    }
  });

  test("never for a development folder, even one standing over the installed, OK'd plugin; a bundled plugin's list holds", async () => {
    const home = tempHome();
    write(join(home, "plugins", "notes"), manifest(["search"]));
    const bundled = join(home, "bundled");
    write(join(bundled, "ledger"), manifest(["total"], { id: "ledger" }));
    const opened = await open(home, { bundledDirs: [bundled] });
    try {
      const reg = opened.registry;
      await reg.approve("notes", reg.get("notes")!.treeHash!);
      expect(pluginToolReadOnly(reg, "notes", "notes", "search", FENCED)).toBe(true);
      expect(reg.get("ledger")).toMatchObject({ state: "running", source: "bundled" });
      expect(pluginToolReadOnly(reg, "ledger", "notes", "total", FENCED)).toBe(true);
      // The same list from a dev folder: its claim was never shown on a card.
      const dev = join(home, "dev", "notes");
      write(dev, manifest(["search", "delete_note"]));
      await opened.folders.addDevFolder(dev, "cli");
      expect(reg.get("notes")).toMatchObject({ state: "running", dev: true });
      expect(pluginToolReadOnly(reg, "notes", "notes", "search", FENCED)).toBe(false);
      expect(pluginToolReadOnly(reg, "notes", "notes", "delete_note", FENCED)).toBe(false);
      await opened.folders.removeDevFolder(realpathSync(dev));
      expect(reg.get("notes")).toMatchObject({ state: "running", dev: false });
      expect(pluginToolReadOnly(reg, "notes", "notes", "search", FENCED)).toBe(true);
    } finally {
      opened.close();
    }
  });

  test("a server that can reach the network never skips the card, and its OK says the tools still ask", async () => {
    const home = tempHome();
    const cases: [string, string][] = [
      ["web-notes", manifest(["search"], { id: "web-notes", server: { type: "http", url: "https://notes.example.com/mcp" } })],
      ["host-notes", manifest(["search"], { id: "host-notes", capabilities: ["network:api.notes.example.com"] })],
    ];
    for (const [id, text] of cases) write(join(home, "plugins", id), text);
    // A child plugin's network grant counts for its tree.
    write(join(home, "plugins", "pack"), manifest(["search"], { id: "pack" }));
    write(join(home, "plugins", "pack", "plugins", "fetcher"), JSON.stringify({ manifest: 1, name: "Fetcher", version: "1.0.0", capabilities: ["network:api.example.com"] }));
    // network:public is for Clover's own tree only: its web child's grant counts for the whole tree.
    const bundled = join(home, "bundled");
    write(join(bundled, "clover"), manifest(["search"], { id: "clover" }));
    write(join(bundled, "clover", "plugins", "web"), JSON.stringify({ manifest: 1, name: "Web", version: "1.0.0", capabilities: ["network:public"] }));
    const opened = await open(home, { bundledDirs: [bundled] });
    try {
      const reg = opened.registry;
      expect([reg.get("clover")?.state, reg.get("clover/web")?.reason ?? reg.get("clover/web")?.state, reg.get("clover/web")?.capabilities]).toEqual(["running", "running", ["network:public"]]);
      expect(pluginToolReadOnly(reg, "clover", "notes", "search", FENCED)).toBe(false);
      expect(opened.folders.okText("clover", "macos", false, true).lines).toContain("Its server notes says one tool only reads, but it can reach the network, so it still asks before running.");
      // A wrapper the user brought, with its install record's network grant.
      write(join(home, "plugins", "wrapped-notes"), manifest(["search"], { id: "wrapped-notes" }));
      await opened.folders.installed("wrapped-notes", "user-app", { wrapped: { from: "mcp-config", network: "any" } });
      expect(reg.get("wrapped-notes")!.provenance.wrapped?.network).toBe("any");
      for (const id of [...cases.map(([i]) => i), "pack", "wrapped-notes"]) {
        expect([id, reg.get(id)?.state, reg.get(id)?.state === "found" ? "" : reg.get(id)?.reason]).toEqual([id, "found", ""]);
        const lines = opened.folders.okText(id, "macos", false, true).lines;
        expect([id, lines.some((l) => l.includes("run without asking"))]).toEqual([id, false]);
        expect([id, lines]).toEqual([id, expect.arrayContaining(["Its server notes says one tool only reads, but it can reach the network, so it still asks before running."])]);
        await reg.approve(id, reg.get(id)!.treeHash!);
        expect([id, reg.get(id)!.state, pluginToolReadOnly(reg, id, "notes", "search", FENCED)]).toEqual([id, "running", false]);
      }
    } finally {
      opened.close();
    }
  });

  test("a list the OK card can't show is refused at validation; one near the limit shows every name", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `${String(i).padStart(3, "0")}_${"t".repeat(60)}`);
    const tooMany = validateManifest(JSON.parse(manifest(names(256))));
    expect(tooMany.ok).toBe(false);
    expect(tooMany.issues.find((i) => i.code === "read_only_too_long")?.message).toMatch(new RegExp(`would fill \\d+ lines of the OK card, and at most ${READ_ONLY_OK_MAX_LINES} lines of 4,000 characters fit`));
    // Near the limit: every name on the card, over several lines of at most 4,000, the first with the count.
    let n = 256;
    while (readOnlyOkLines({ server: "notes", tools: names(n) }, false).length > READ_ONLY_OK_MAX_LINES) n--;
    expect(n).toBeGreaterThan(150);
    const near = validateManifest(JSON.parse(manifest(names(n))));
    expect(near.issues.filter((i) => i.severity === "error")).toEqual([]);
    const lines = describeOk(near, { os: "macos", sandboxed: true }).filter((l) => l.includes("_ttt"));
    expect(lines.length).toBe(READ_ONLY_OK_MAX_LINES);
    expect(lines[0]).toStartWith(`Its server notes says these ${n} tools only read`);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(OK_LINE_MAX);
    const shown = lines.join(" ");
    for (const t of names(n)) expect(shown).toContain(t);
  });
});
