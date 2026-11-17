// Point messages between two real host halves (a metronome that declares a point and a dancer that fills it), over a
// real plugin registry and plugin-host processes: a listener a host half opens in its `start` hears what the other
// sends, in order, and answers back, while that half runs (a host half starts on its first call). Temp homes, the fake approval broker, an in-memory secret store; no window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/moss-plugin-sdk";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER = { kind: "user", client: "app" } as const;
const POINT = "metronome.beats";

async function until(f: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("not in time");
    await Bun.sleep(20);
  }
}

function plugin(home: string, id: string, manifest: Record<string, unknown>, host: string[]): void {
  const folder = join(home, "plugins", id);
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "moss.json"), JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { moss: `^${PLUGIN_API_VERSION}` }, ...manifest, host: { entry: "host/index.js", ...(manifest.host as object | undefined) } }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), `${host.join("\n")}\n`);
}

describe("point messages between host halves", () => {
  test("the declarer's beats reach the filler's listener opened in its start, in order, and its answers come back", async () => {
    const home = mkdtempSync(join(tmpdir(), "moss-mc2-pm-"));
    temps.push(home);
    plugin(home, "metronome", {
      host: { declares: { [POINT]: { shape: "list", title: "Beats", fields: { type: "object", properties: { id: { type: "string" } } }, fills: { ok: "it hears the beats" } } } },
      contributes: { commands: [{ name: "beat", description: "beat", handler: "beat" }] },
    }, [
      "let api; const back = []; let n = 0;",
      `export function start(a) { api = a; a.points.onMessage(${JSON.stringify(POINT)}, (m) => back.push([m.from, m.value.echo])); }`,
      `export async function beat() { for (let i = 0; i < 3; i++) await api.points.send(${JSON.stringify(POINT)}, { n: ++n }); return { sent: 3 }; }`,
      "export function heard() { return back; }",
    ]);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ mossHome: home, os: "linux", broker, secrets, settleMs: 50 });
    const lines: string[] = [];
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, log: (l) => lines.push(l) });
    const logOf = (id: string) => { try { return readFileSync(join(home, "logs", "plugins", `${id}.log`), "utf8"); } catch { return ""; } };
    try {
      const approve = async (id: string): Promise<string> => {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        return JSON.stringify(shown);
      };
      // The metronome first, its point active, then the dancer, as a person installs a filler of a point that is there.
      // (The flake this replaced: with both folders read at the registry's first scan, the dancer's OK was taken on the
      // snapshot of that scan, before the metronome's point was active; the re-read that follows (folders.ts
      // `#fillsMoved`, `fillsAdded`) found the metronome's line missing from that OK and asked again, putting the dancer
      // back to `found` and its host half away mid-test, though the card shown had carried the line.)
      await approve("metronome");
      await until(() => opened.registry.get("metronome")?.state === "running" && opened.registry.points().some((p) => p.name === POINT && p.active));
      // The dancer arrives after (a person installs a filler of a point that is there): copied in and read as an install.
      plugin(home, "dancer", { contributes: { [POINT]: [{ id: "waltz" }] } }, [
        `export function start(a) { globalThis.__got = []; a.points.onMessage(${JSON.stringify(POINT)}, (m) => { globalThis.__got.push(m); if (m.from === "metronome") void a.points.send(${JSON.stringify(POINT)}, { echo: m.value.n }).catch((e) => console.log("send failed " + e.message)); }); }`,
        "export function got() { return globalThis.__got; }",
      ]);
      await opened.folders.installed("dancer", "user-app");
      const dancerCard = await approve("dancer");
      expect(dancerCard).toContain("it hears the beats");
      await until(() => opened.registry.get("dancer")?.state === "running")
        .catch((e: Error) => { throw new Error(`${e.message}: ${opened.registry.get("dancer")?.state} ${JSON.stringify(opened.registry.get("dancer")?.issues)}`); });
      // A host half starts on its first call, and its `start` (which opens the listener) runs before that call is answered.
      expect(await ph.host.invoke({ pluginId: "dancer", handler: "got", args: null, caller: USER })).toEqual([]);
      expect(await ph.host.invoke({ pluginId: "metronome", handler: "beat", args: null, caller: USER })).toEqual({ sent: 3 });
      let heard: unknown;
      await until(async () => { heard = await ph.host.invoke({ pluginId: "metronome", handler: "heard", args: null, caller: USER }); return Array.isArray(heard) && heard.length >= 3; }, 10_000)
        .catch(async (e: Error) => { throw new Error(`${e.message}: heard ${JSON.stringify(heard)}; dancer got ${JSON.stringify(await ph.host.invoke({ pluginId: "dancer", handler: "got", args: null, caller: USER }).catch((x: Error) => x.message))}\nhost: ${lines.join(" | ")}\nmetronome: ${logOf("metronome")}\ndancer: ${logOf("dancer")}`); });
      expect(heard).toEqual([["dancer", 1], ["dancer", 2], ["dancer", 3]]);
    } finally {
      await ph.close();
      opened.close();
    }
  }, 60_000);
});
