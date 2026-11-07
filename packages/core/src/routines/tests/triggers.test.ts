// The bundled schedule and webhook triggers as the core sees them (spec §7 "triggers are plugins"): each validates as a
// child of `clover`, its `triggers` entry comes up, its handler answers through the plugin host, and the webhook
// trigger declares `webhook.ingress`, so the forwarder's entry waits for it and is active beside it.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogPointDecl } from "../../../../plugin-sdk/src/catalogs/index";
import { pluginFromFolder, REPO, removeTemps, tempDir } from "../../bots/tests/fixtures";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakePluginHost } from "../../contracts/fakes/plugin-host";
import { FakePluginRegistry } from "../../contracts/fakes/plugin-registry";
import type { HostModule } from "../../contracts/sdk-types";
import { triggerOwnersFrom } from "../../bots/wiring";
import { WebhookIngress } from "../webhooks";

afterEach(removeTemps);

async function installed(children: string[]) {
  const root = join(tempDir(), "clover");
  mkdirSync(root, { recursive: true });
  const parent = join(REPO, "plugins", "clover", "clover.json");
  writeFileSync(join(root, "clover.json"), existsSync(parent) ? readFileSync(parent, "utf8") : `${JSON.stringify({ manifest: 1, id: "clover", name: "Clover" })}\n`);
  for (const c of children) {
    cpSync(join(REPO, "plugins", "clover", "plugins", c), join(root, "plugins", c), { recursive: true, filter: (src) => !src.includes("node_modules") });
  }
  const { report, inputs } = await pluginFromFolder(root, { bundled: true });
  return { report, inputs, registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: inputs }), root };
}

describe("the bundled triggers", () => {
  test("both validate as children of clover and their triggers come up", async () => {
    const { report, registry } = await installed(["trigger-schedule", "trigger-webhook"]);
    for (const folder of ["trigger-schedule", "trigger-webhook"]) {
      const child = report.children.find((c) => c.folder === folder);
      expect(child?.ok).toBe(true);
      expect(child?.report.issues.filter((i) => i.severity === "error")).toEqual([]);
    }
    expect(registry.entries("triggers").map((c) => ({ pluginId: c.pluginId, entryId: c.entryId, state: c.state }))).toEqual([
      { pluginId: "clover/trigger-schedule", entryId: "schedule", state: "active" },
      { pluginId: "clover/trigger-webhook", entryId: "webhook", state: "active" },
    ]);
    expect(registry.points().find((p) => p.name === "webhook.ingress")).toMatchObject({ declaredBy: { pluginId: "clover/trigger-webhook" }, active: true });
    // Who may fire which trigger type: its contributing plugin.
    const owners = triggerOwnersFrom(registry);
    expect(owners("schedule")).toEqual(["clover/trigger-schedule"]);
    expect(owners("webhook")).toEqual(["clover/trigger-webhook"]);
    expect(owners("slack")).toEqual([]);
  });

  test("their handlers answer through the plugin host", async () => {
    const { registry } = await installed(["trigger-schedule", "trigger-webhook"]);
    const host = new FakePluginHost({ clock: new FakeClock() });
    for (const id of ["clover/trigger-schedule", "clover/trigger-webhook"]) {
      const record = registry.get(id)!;
      host.define(id, (await import(join(record.folder, record.manifest!.host!.entry))) as HostModule);
    }
    const call = <R>(pluginId: string, handler: string, method: string, args: unknown) => host.invoke<R>({ pluginId, handler, method, args, caller: { kind: "core" } });
    expect(await call("clover/trigger-schedule", "schedule", "check", { fields: { schedule: "0 8 * * 1-5" } })).toEqual({ ok: true, summary: "cron 0 8 * * 1-5" });
    expect(await call("clover/trigger-schedule", "schedule", "next", { fields: { schedule: "0 8 * * *" }, after: Date.parse("2026-07-01T06:00:00Z"), timezone: "Europe/London" }))
      .toEqual({ at: Date.parse("2026-07-01T07:00:00Z") });
    const label = await call<{ text: string }>("clover/trigger-webhook", "webhook", "label", { body: "{}", contentType: "application/json" });
    expect(label.text).toMatch(/^Untrusted outside content from a webhook \(application\/json\), between the two =====[0-9a-f]{16}===== lines\./);
  });

  test("the forwarder's webhook.ingress waits for the webhook trigger, and the core's ingress uses it once it is active", async () => {
    const alone = await installed(["forwarder"]);
    expect(alone.report.children.find((c) => c.folder === "forwarder")?.ok).toBe(true);
    expect(alone.registry.entries("webhook.ingress")).toMatchObject([{ pluginId: "clover/forwarder", state: "waiting" }]);

    const both = await installed(["forwarder", "trigger-webhook"]);
    expect(both.registry.entries("webhook.ingress")).toMatchObject([{ pluginId: "clover/forwarder", entryId: "waifucave", state: "active", value: { handler: "ingress" } }]);
    // The forwarder's own host half needs its service; a stand-in answers for it here.
    const host = new FakePluginHost({ clock: new FakeClock() });
    const keyHashes: string[] = [];
    host.define("clover/forwarder", {
      ingress: {
        register: async (a: { routine: string; keyHash: string }) => (keyHashes.push(a.keyHash), { url: `https://hooks.waifucave.com/t/${a.routine}` }),
        next: async () => ({ deliveries: [] }),
        ack: async () => ({}),
        drop: async () => ({}),
      },
    } as never);
    const ingress = new WebhookIngress({ registry: both.registry, host, engine: { deliverWebhook: async () => "accepted", webhookRoutines: () => [], webhook: async () => ({ url: "", key: "" }) }, clock: new FakeClock() });
    expect(await ingress.register("r_abcdefgh", "the-key")).toBe("https://hooks.waifucave.com/t/r_abcdefgh");
    expect(keyHashes).toHaveLength(1);
    expect(keyHashes[0]).not.toContain("the-key");
    // Without the webhook trigger there is no active ingress, and the routine has no URL yet.
    const none = new WebhookIngress({ registry: alone.registry, host, engine: { deliverWebhook: async () => "accepted", webhookRoutines: () => [], webhook: async () => ({ url: "", key: "" }) }, clock: new FakeClock() });
    await expect(none.register("r_abcdefgh", "the-key")).rejects.toThrow("no webhook ingress");
  });

  test("a routine registers with one ingress, its named one or else the first, and only that ingress delivers for it (review S2)", async () => {
    const host = new FakePluginHost({ clock: new FakeClock() });
    const calls: { plugin: string; method: string; args: unknown }[] = [];
    const queues: Record<string, unknown[]> = { "clover/forwarder": [], "pack/tunnel": [] };
    for (const plugin of Object.keys(queues)) {
      host.define(plugin, {
        ingress: {
          register: async (a: { routine: string }) => (calls.push({ plugin, method: "register", args: a }), { url: `https://${plugin}/${a.routine}` }),
          unregister: async (a: unknown) => (calls.push({ plugin, method: "unregister", args: a }), { released: true }),
          next: async () => ({ deliveries: queues[plugin]!.splice(0) }),
          ack: async (a: unknown) => (calls.push({ plugin, method: "ack", args: a }), {}),
          drop: async (a: unknown) => (calls.push({ plugin, method: "drop", args: a }), {}),
        },
      } as never);
    }
    const registry = { entries: () => [
      { pluginId: "clover/forwarder", entryId: "waifucave", state: "active", value: { handler: "ingress" } },
      { pluginId: "pack/tunnel", entryId: "tunnel", state: "active", value: { handler: "ingress" } },
    ] } as never;
    const delivered: { ingress: string; id: string }[] = [];
    const ingress = new WebhookIngress({
      registry, host, clock: new FakeClock(),
      engine: { deliverWebhook: async (d) => (delivered.push({ ingress: d.ingress, id: d.id }), "accepted"), webhookRoutines: () => [], webhook: async () => ({ url: "", key: "" }) },
    });
    expect(await ingress.register("r_first001", "k1")).toBe("https://clover/forwarder/r_first001");
    expect(await ingress.register("r_named001", "k2", "tunnel")).toBe("https://pack/tunnel/r_named001");
    await expect(ingress.register("r_nope0001", "k3", "ngrok")).rejects.toThrow('no webhook ingress "ngrok"');
    expect(calls.filter((c) => c.method === "register").map((c) => c.plugin)).toEqual(["clover/forwarder", "pack/tunnel"]);
    const d = (id: string, routine: string) => ({ id, routine, receivedAt: 0, method: "POST", query: "", headers: [], body: new Uint8Array(), untrusted: true });
    queues["clover/forwarder"]!.push(d("a1", "r_first001"), d("a2", "r_named001"));
    queues["pack/tunnel"]!.push(d("b1", "r_named001"), d("b2", "r_first001"));
    await ingress.pollOnce(0);
    expect(delivered).toEqual([{ ingress: "clover/forwarder", id: "a1" }, { ingress: "pack/tunnel", id: "b1" }]);
    expect(calls.filter((c) => c.method === "drop")).toEqual([
      { plugin: "clover/forwarder", method: "drop", args: { ids: ["a2"] } },
      { plugin: "pack/tunnel", method: "drop", args: { ids: ["b2"] } },
    ]);
    // Moving a routine to another ingress lets go of the old one.
    await ingress.register("r_first001", "k1", "tunnel");
    expect(calls.at(-1)).toEqual({ plugin: "clover/forwarder", method: "unregister", args: { routine: "r_first001" } });
  });

  test("the loop registers a webhook routine it finds, and again where its file names a new ingress", async () => {
    const host = new FakePluginHost({ clock: new FakeClock() });
    const calls: { plugin: string; method: string; routine?: string }[] = [];
    for (const plugin of ["clover/forwarder", "pack/tunnel"]) {
      host.define(plugin, {
        ingress: {
          register: async (a: { routine: string }) => (calls.push({ plugin, method: "register", routine: a.routine }), { url: `https://${plugin}/${a.routine}` }),
          unregister: async (a: { routine: string }) => (calls.push({ plugin, method: "unregister", routine: a.routine }), { released: true }),
        },
      } as never);
    }
    const registry = { entries: () => [
      { pluginId: "clover/forwarder", entryId: "waifucave", state: "active", value: { handler: "ingress" } },
      { pluginId: "pack/tunnel", entryId: "tunnel", state: "active", value: { handler: "ingress" } },
    ] } as never;
    let named: string | undefined;
    let present = true;
    const ingress: WebhookIngress = new WebhookIngress({
      registry, host, clock: new FakeClock(),
      engine: {
        deliverWebhook: async () => "accepted",
        webhookRoutines: () => (present ? [{ id: "r_hook0003", ...(named === undefined ? {} : { ingress: named }) }] : []),
        webhook: async (id: string) => ({ url: await ingress.register(id, "k", named), key: "k" }),
      },
    });
    await ingress.sync();
    await ingress.sync();
    expect(calls).toEqual([{ plugin: "clover/forwarder", method: "register", routine: "r_hook0003" }]);
    named = "tunnel";
    await ingress.sync();
    expect(calls.slice(1)).toEqual([
      { plugin: "pack/tunnel", method: "register", routine: "r_hook0003" },
      { plugin: "clover/forwarder", method: "unregister", routine: "r_hook0003" },
    ]);
    present = false;
    await ingress.sync();
    expect(calls.at(-1)).toEqual({ plugin: "pack/tunnel", method: "unregister", routine: "r_hook0003" });
  });
});
