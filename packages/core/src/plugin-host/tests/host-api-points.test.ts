// A host half's own plugin API in a real plugin-host process, through the acceptance run's own fixture
// (scripts/acceptance/fixtures/acceptance-points): its point's entries and a call into its child's handler, its synced
// store's keys and delete, a setting's default; its watches (store, a setting the user changes, the point when the child
// is switched off) hear each change. With no bot side here, its conversation calls are refused by name, and it says so.
// Temp homes, the fake approval broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";

const FIXTURE = join(import.meta.dir, "..", "..", "..", "..", "..", "scripts", "acceptance", "fixtures", "acceptance-points");
const USER: Caller = { kind: "user", client: "app" };
const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

async function until<T>(f: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("not in time");
    await Bun.sleep(20);
  }
}

describe("a host half's own API (the acceptance-points fixture)", () => {
  test("points, the synced store, settings and their watches work in a real host", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b-points-"));
    temps.push(home);
    cpSync(FIXTURE, join(home, "plugins", "acceptance-points"), { recursive: true });
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets });
    try {
      const { card } = await opened.registry.installed("acceptance-points", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await until(async () => (opened.registry.get("acceptance-points/filler")?.state === "running" && opened.registry.get("acceptance-points")?.state === "running" ? true : undefined));
      const invoke = (handler: string, args: unknown) => ph.host.invoke<Record<string, unknown>>({ pluginId: "acceptance-points", handler, args, caller: USER });
      const probe = await invoke("probe", { session: "b_alpha" });
      expect(probe).toMatchObject({
        entries: ["acceptance-points/filler:hello"], called: "hello probe from the filler",
        keys: ["acceptance-a", "acceptance-b"], keysAfter: ["acceptance-b"], mood: "calm",
      });
      expect(String(probe.posted)).toStartWith("refused:");
      await ph.settings.setByUser("acceptance-points", "mood", "loud");
      await opened.registry.setEnabled("acceptance-points/filler", false);
      const heard = await until(async () => {
        const r = (await invoke("report", {})) as { store: string[]; settings: string[]; points: number[] };
        return r.settings.includes("mood") && r.points.includes(0) ? r : undefined;
      });
      expect(heard.store).toEqual(expect.arrayContaining(["acceptance-a", "acceptance-b"]));
    } finally {
      await ph.close();
      opened.close();
    }
  }, 60_000);
});
