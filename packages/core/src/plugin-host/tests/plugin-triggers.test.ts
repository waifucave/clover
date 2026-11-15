// A plugin's routine trigger (§7) end to end, over a real plugin registry, a real plugin-host process and the routine
// engine: a routine file that names the plugin's trigger type is armed through its handler (even when the plugin is
// approved after the routine loaded), the plugin fires it through `api.routines.fire`, and the routine runs with the
// payload marked as the trigger's; a restart of its host half arms it again; a routine that goes is disarmed. Temp
// homes, the fake approval broker, an in-memory secret store and fake bots; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { RoutineRunView } from "@waifucave/clover-protocol";
import { triggerOwnersFrom } from "../../bots/wiring";
import type { SideThreadRun } from "../../bots/service";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { RoutineEngine, routineFilePath } from "../../routines/engine";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

async function until(f: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("not in time");
    await Bun.sleep(20);
  }
}

describe("a plugin's routine trigger", () => {
  test("arms a routine through the plugin, which fires it; armed again after a restart; disarmed when the routine goes", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b-triggers-"));
    temps.push(home);
    const folder = join(home, "plugins", "pinger");
    mkdirSync(join(folder, "host"), { recursive: true });
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id: "pinger", name: "Pinger", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
      host: { entry: "host/index.js" },
      contributes: { triggers: [{ type: "ping", title: "Ping", handler: "ping" }] },
    }));
    writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
    // Its handler fires the routine as soon as it is armed, later, from a timer, through the API its start was given
    // (a call's own `ctx.api` ends with the call).
    writeFileSync(join(folder, "host", "index.js"), [
      "let api;",
      "export function start(a) { api = a; }",
      "export const ping = {",
      "  arm(args) {",
      "    console.log(`armed ${args.routine} ${args.type}`);",
      "    setTimeout(() => { api.routines.fire(args.routine, \"ping\", `pinged ${args.fields.word}`).catch((e) => console.log(`fire failed: ${e.message}`)); }, 0);",
      "  },",
      "  disarm(args) { console.log(`disarmed ${args.routine}`); },",
      "};",
      "",
    ].join("\n"));
    // The routine, on this computer, for the bot alpha.
    const routineFile = routineFilePath(home, "alpha", "pinged");
    mkdirSync(join(routineFile, ".."), { recursive: true });
    writeFileSync(routineFile, "---\nid: r_pinged01\nname: Pinged\ntriggers:\n  - type: ping\n    word: hello\n---\nSay what the ping said.\n");

    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker, secrets, settleMs: 50 });
    const runs: SideThreadRun[] = [];
    let engine: RoutineEngine | undefined;
    const lines: string[] = [];
    const ph = await startPluginHost({
      home, computer: "Studio", registry: opened.registry, secrets, log: (l) => lines.push(l),
      // The API's areas: only the routines are reached here.
      areas: { bots: () => ({ routines: engine }) as never, node: () => undefined, links: () => undefined },
    });
    engine = new RoutineEngine({
      home, computer: "Studio", clock: new FakeClock(), computerLevel: () => "ask-risky", watchFiles: false, userTimeZone: () => "UTC",
      bots: {
        has: (id: string) => id === "alpha",
        runSideThread: async (_bot: string, run: SideThreadRun): Promise<RoutineRunView> => {
          runs.push(run);
          return { routine: run.routine, session: `s_side_${runs.length}`, startedAt: 1, endedAt: 2, outcome: "done", summary: "Done." };
        },
      },
      pluginTriggers: ph.triggers, triggerOwners: triggerOwnersFrom(opened.registry),
    });
    const logOf = () => { try { return readFileSync(join(home, "logs", "plugins", "pinger.log"), "utf8"); } catch { return ""; } };
    try {
      // The routine loads before the plugin has its OK: nothing adds the type yet, so it waits to be armed.
      await engine.start();
      expect(lines.join("\n")).toContain("the routine r_pinged01 uses the ping trigger, which no plugin here adds yet");
      expect(runs).toHaveLength(0);
      const { card } = await opened.registry.installed("pinger", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      // Its card says it starts routines and runs in the background.
      expect(JSON.stringify(shown.fields)).toContain("It adds routine triggers (ping)");
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      // Approved: its host half starts at once (triggers do), the routine is armed through it, and it fires.
      await until(() => runs.length === 1).catch((e: Error) => { throw new Error(`${e.message}\nhost: ${lines.join(" | ")}\nlog: ${logOf()}\nstatus: ${JSON.stringify(ph.host.status("pinger"))}`); });
      expect(logOf()).toContain("armed r_pinged01 ping");
      expect(runs[0]).toMatchObject({ routine: "r_pinged01", name: "Pinged", computer: "Studio" });
      expect(runs[0]!.text).toContain("Say what the ping said.");
      expect(runs[0]!.text).toContain("pinged hello");
      expect(runs[0]!.text).toContain("Untrusted outside content from the ping trigger");
      // Its worker forgets what it was armed with when it starts again: it is armed again, and fires again.
      await ph.host.restart("pinger");
      await until(() => runs.length === 2);
      // The routine goes: it is disarmed, and a restart arms nothing.
      rmSync(routineFile);
      await engine.rescan();
      await until(() => logOf().includes("disarmed r_pinged01"));
      await ph.host.restart("pinger");
      await Bun.sleep(300);
      expect(runs).toHaveLength(2);
      expect(logOf()).not.toContain("fire failed");
    } finally {
      engine.stop();
      await ph.close();
      opened.close();
    }
  }, 60_000);
});
