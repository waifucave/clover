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
    expect(label.text).toStartWith("Untrusted outside content from a webhook (application/json).");
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
    const ingress = new WebhookIngress({ registry: both.registry, host, engine: { deliverWebhook: async () => "accepted", webhookRoutines: () => [] }, clock: new FakeClock() });
    expect(await ingress.register("r_abcdefgh", "the-key")).toBe("https://hooks.waifucave.com/t/r_abcdefgh");
    expect(keyHashes).toHaveLength(1);
    expect(keyHashes[0]).not.toContain("the-key");
    // Without the webhook trigger there is no active ingress, and the routine has no URL yet.
    const none = new WebhookIngress({ registry: alone.registry, host, engine: { deliverWebhook: async () => "accepted", webhookRoutines: () => [] }, clock: new FakeClock() });
    await expect(none.register("r_abcdefgh", "the-key")).rejects.toThrow("no webhook ingress");
  });
});
