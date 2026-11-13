// Rows 15 and 2.14: `secrets.get` for a third party's own process, through a REAL plugin host. A folder plugin whose
// host runs in a process of its own (`host.process: "own"`) reads the key the user stored for its own `auth` entry; a
// name it doesn't list is refused; the same plugin shape in a worker of the shared process is refused the call, as the
// spec's §5.2 says. Temp home, the fake approval broker, in-memory secret stores; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import type { SecretStore as DaemonSecretStore } from "../../auth/secret-store";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startModelPlugins } from "../../runtime-sdk/model-plugins/start";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER: Caller = { kind: "user", client: "app" };

class NoSlots implements DaemonSecretStore {
  async get(): Promise<string | null> { return null; }
  async set(): Promise<void> {}
  async delete(): Promise<boolean> { return false; }
}

function plugin(home: string, id: string, own: boolean): void {
  const folder = join(home, "plugins", id);
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({
    manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
    host: { entry: "host/index.js", ...(own ? { process: "own" } : {}) },
    auth: [{ method: "api-key", secret: "api-key" }],
  }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), [
    "export const read = async (args, ctx) => {",
    "  try { return (await ctx.api.secrets.get(args.name)) ?? null; } catch (e) { return `refused: ${e.message}`; }",
    "};",
    "",
  ].join("\n"));
}

describe("secrets.get in a third party's own process (real host)", () => {
  test("reads its own stored key; another name is refused; a worker is refused the call", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-secrets-")));
    temps.push(home);
    plugin(home, "vault", true);
    plugin(home, "sharer", false);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    await secrets.set({ owner: { kind: "plugin", pluginId: "vault" }, name: "api-key" }, "VAULT-OWN-KEY");
    await secrets.set({ owner: { kind: "plugin", pluginId: "sharer" }, name: "api-key" }, "SHARER-KEY");
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets });
    let started: Awaited<ReturnType<typeof startModelPlugins>> | undefined;
    try {
      for (const id of ["vault", "sharer"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        for (let i = 0; i < 200 && opened.registry.get(id)?.state === "found"; i++) await Bun.sleep(20);
      }
      started = await startModelPlugins({ registry: opened.registry, host: ph.host, pluginSecrets: ph.pluginSecrets, home, secrets: new NoSlots(), fetch: async () => new Response("no network here", { status: 599 }), addApiHandlers: (h) => ph.addApiHandlers(h) });
      const read = (pluginId: string, name: string) => ph.host.invoke({ pluginId, handler: "read", args: { name }, caller: USER });
      expect(await read("vault", "api-key")).toBe("VAULT-OWN-KEY");
      expect(String(await read("vault", "other"))).toMatch(/^refused: .*vault has no secret "other"/);
      expect(String(await read("sharer", "api-key"))).toMatch(/^refused: .*secrets\.get/);
    } finally {
      started?.stop();
      await ph.close();
      opened.close();
    }
  }, 90_000);
});
