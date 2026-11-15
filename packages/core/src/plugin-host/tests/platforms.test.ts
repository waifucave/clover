// A plugin's `platforms` over the real registry and a real plugin host (checklist row 1.21): one whose list leaves this
// computer out still installs behind its ordinary OK card (which gains no line), and after the OK it is off here, saying
// why ("Not for this computer: it supports …"): its host half doesn't start (not even with `host.start`), its tools
// aren't offered, and its switch can't turn it on here. One whose list names this computer runs as any plugin. Temp
// homes, the fake approval broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { thisPlatform } from "../../registry/core";
import { openPluginRegistry } from "../../registry/open";
import { hostedRecordOf, startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const HERE = thisPlatform();
const ELSEWHERE = HERE === "windows-x64" ? "linux-x64" : "windows-x64";

function plugin(home: string, id: string, platforms: string[]): void {
  const folder = join(home, "plugins", id);
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({
    manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, platforms,
    host: { entry: "host/index.js", start: "each" },
    contributes: { mcpServers: { tools: { type: "host" } } },
  }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), `export async function start() { console.log("${id} started"); }\n`);
}

describe("a plugin's platforms", () => {
  test("left out here: installed behind its usual card, then off here saying why, never started, its tools not offered", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b-platforms-"));
    temps.push(home);
    plugin(home, "elsewhere", [ELSEWHERE]);
    plugin(home, "here", [HERE, ELSEWHERE]);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets });
    try {
      for (const id of ["elsewhere", "here"]) {
        const { state, card } = await opened.registry.installed(id, "app");
        expect(state).toBe("found");
        const shown = broker.cards().find((c) => c.id === card)!;
        // The card is the ordinary one: nothing about platforms.
        expect(JSON.stringify(shown.fields)).not.toMatch(/platform|Not for this computer/i);
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        for (let i = 0; i < 250 && opened.registry.get(id)?.state === "found"; i++) await Bun.sleep(20);
      }
      const off = opened.registry.get("elsewhere")!;
      expect([off.state, off.reason]).toEqual(["off", `Not for this computer: it supports ${ELSEWHERE}`]);
      expect(hostedRecordOf(opened.registry, home, "elsewhere")).toBeUndefined();
      // Its tools aren't offered here; the other plugin's are.
      expect(opened.registry.entries("mcpServers").map((e) => e.pluginId)).toEqual(["here"]);
      // Its switch doesn't turn it on here.
      await opened.registry.setEnabled("elsewhere", true);
      expect(opened.registry.get("elsewhere")!.state).toBe("off");
      // The other one runs, started at once by its host.start; this one never started.
      for (let i = 0; i < 250 && ph.host.status("here").state !== "running"; i++) await Bun.sleep(20);
      expect(ph.host.status("here").state).toBe("running");
      expect(ph.host.status("elsewhere").state).toBe("idle");
      await expect(ph.host.ensureStarted("elsewhere")).rejects.toThrow(/isn't installed/);
    } finally {
      await ph.close();
      opened.close();
    }
  }, 60_000);
});
