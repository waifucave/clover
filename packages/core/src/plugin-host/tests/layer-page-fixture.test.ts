// The acceptance-points row's page fixture (scripts/acceptance/fixtures/acceptance-points-page) through a component's
// own route in a real plugin host: its page's calls of its own point (`points.call`, an entry it contributes itself)
// and its own command (`commands.run`) go through the gate from the `ui` side as the plugin, and what it hands its host
// half (`host.call("pageReport")`) comes back in `report`. So the acceptance row's page checks what the core answers,
// not the fixture's own wiring. Temp homes, the fake approval broker, an in-memory secret store; nothing opens a window.
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGINS_METHODS } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";
import { pluginUi } from "../ui";

const ID = "acceptance-points-page";
const FIXTURE = join(import.meta.dir, "..", "..", "..", "..", "..", "scripts", "acceptance", "fixtures", ID);
const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

test("the page fixture's own point, own command and report answer on a component's route", async () => {
  const home = mkdtempSync(join(tmpdir(), "clover-a-page-"));
  temps.push(home);
  cpSync(FIXTURE, join(home, "plugins", ID), { recursive: true });
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50 });
  const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets: new MemorySecretStore() });
  const ui = pluginUi({ registry: opened.registry, router: ph.gate, emit: () => {} });
  try {
    const { card } = await opened.registry.installed(ID, "app");
    const shown = broker.cards().find((c) => c.id === card)!;
    await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
    for (let i = 0; i < 750 && opened.registry.get(ID)?.state !== "running"; i++) await Bun.sleep(20);
    expect(opened.registry.get(ID)?.state).toBe("running");
    const ctx = { caller: { kind: "plugin", pluginId: ID }, stream: { send: () => {}, follows: new Map() } } as never;
    const call = async (c: string, args: unknown[]) => ((await ui.methods[PLUGINS_METHODS.pluginLayerCall.name]!({ call: c, args }, ctx)) as { result: unknown }).result;
    expect(await call("points.call", [`${ID}.items`, { pluginId: ID, entryId: "hello" }, "greet", { who: "page" }])).toBe("hello page from the page's own point");
    expect(await call("commands.run", [`${ID}.report`, {}])).toEqual({});
    expect(await call("host.call", ["pageReport", { memory: "a list" }])).toBe("kept");
    expect(await call("commands.run", [`${ID}.report`, {}])).toEqual({ page: { memory: "a list" } });
  } finally {
    ui.close();
    await ph.close();
    opened.close();
  }
});
