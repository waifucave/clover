// Read-only MCP tools (lane C's ask): declared in the manifest, named on the OK card, true only for the tree the user
// OK'd; a change to the list asks for the OK again, and nothing a server says at run time counts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../open";
import { pluginToolReadOnly } from "../read-only-tools";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const manifest = (readOnly?: string[]) => JSON.stringify({
  manifest: 1, id: "notes", name: "Notes", version: "1.0.0",
  contributes: { mcpServers: { notes: { type: "http", url: "https://notes.example.com/mcp", ...(readOnly ? { readOnly } : {}) } } },
});

describe("read-only MCP tools", () => {
  test("named on the OK; read-only only as the OK'd tree says; a change to the list asks again", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-ro-")));
    temps.push(home);
    const dir = join(home, "plugins", "notes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "clover.json"), manifest(["search", "read_note"]));
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
    try {
      const reg = opened.registry;
      // Not before the OK.
      expect(pluginToolReadOnly(reg, "notes", "notes", "search")).toBe(false);
      expect(opened.folders.okText("notes", "macos").lines).toContain("Its server notes says these tools only read, so at the default approval level they run without asking: read_note, search.");
      await reg.approve("notes", reg.get("notes")!.treeHash!);
      expect(reg.get("notes")!.state).toBe("running");
      expect(["search", "read_note", "delete_note"].map((t) => pluginToolReadOnly(reg, "notes", "notes", t))).toEqual([true, true, false]);
      expect(pluginToolReadOnly(reg, "notes", "other", "search")).toBe(false);
      // A wider list is a change that asks again: until the new OK, nothing is read-only.
      writeFileSync(join(dir, "clover.json"), manifest(["search", "read_note", "delete_note"]));
      await opened.folders.refresh(dir);
      expect(reg.get("notes")!.state).toBe("found");
      expect(pluginToolReadOnly(reg, "notes", "notes", "delete_note")).toBe(false);
      expect(pluginToolReadOnly(reg, "notes", "notes", "search")).toBe(false);
      await reg.approve("notes", reg.get("notes")!.treeHash!);
      expect(pluginToolReadOnly(reg, "notes", "notes", "delete_note")).toBe(true);
      // Taking the list away asks again too.
      writeFileSync(join(dir, "clover.json"), manifest());
      await opened.folders.refresh(dir);
      expect(reg.get("notes")!.state).toBe("found");
    } finally {
      opened.close();
    }
  });
});
