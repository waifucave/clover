// A plugin's settings by scope over the real registry and a real plugin-host process (checklist row 1.14): an
// `account` value, a `device` one and a `bot` one (one value per bot, the bot named), each set by the user and read by
// the plugin's host half as the user set it, kept apart on disk; the views say each field's scope and `required`. Temp
// homes, the fake approval broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { startPluginHost } from "../daemon-host";

const USER: Caller = { kind: "user", client: "app" };
const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

describe("a plugin's settings by scope", () => {
  test("account, device and bot values are set by the user, read by its host half as set, and kept apart", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-b-scopes-"));
    temps.push(home);
    const folder = join(home, "plugins", "moods");
    mkdirSync(join(folder, "host"), { recursive: true });
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id: "moods", name: "Moods", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` },
      host: { entry: "host/index.js" },
      settings: {
        region: { type: "string", title: "Region", default: "eu" },
        tint: { type: "color", title: "Tint", scope: "device" },
        nick: { type: "string", title: "Nickname", scope: "bot", required: true },
      },
    }));
    writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(folder, "host", "index.js"), [
      "export const read = async (args, ctx) => ({",
      "  region: await ctx.api.settings.get(\"region\"),",
      "  tint: await ctx.api.settings.get(\"tint\") ?? null,",
      "  nick: await ctx.api.settings.get(\"nick\", { bot: args.bot }) ?? null,",
      "});",
      "",
    ].join("\n"));
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "linux", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets });
    try {
      const { card } = await opened.registry.installed("moods", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      for (let i = 0; i < 250 && opened.registry.get("moods")?.state !== "running"; i++) await Bun.sleep(20);
      const read = (bot: string) => ph.host.invoke({ pluginId: "moods", handler: "read", args: { bot }, caller: USER });
      // Defaults first: the account default, nothing for the others.
      expect(await read("alpha")).toEqual({ region: "eu", tint: null, nick: null });
      expect(await ph.settings.setByUser("moods", "region", "us")).toEqual({ applied: true });
      expect(await ph.settings.setByUser("moods", "tint", "#ff8800")).toEqual({ applied: true });
      expect(await ph.settings.setByUser("moods", "nick", "Al", "alpha")).toEqual({ applied: true });
      // A bot field without its bot is refused: it has one value per bot.
      await expect(ph.settings.setByUser("moods", "nick", "Nobody")).rejects.toThrow("one value per bot");
      expect(await read("alpha")).toEqual({ region: "us", tint: "#ff8800", nick: "Al" });
      expect(await read("luna")).toEqual({ region: "us", tint: "#ff8800", nick: null });
      // Kept apart on disk: the account's, this device's and each bot's.
      expect(JSON.parse(readFileSync(join(home, "settings", "plugins", "moods.json"), "utf8"))).toEqual({ account: { region: "us" }, device: { tint: "#ff8800" }, bot: { alpha: { nick: "Al" } } });
      // What Settings shows: each field's scope, and `required`.
      const views = await ph.settings.views("moods", "alpha");
      expect(views.map((v) => [v.key, v.scope, v.required, (v as { value?: unknown }).value])).toEqual([["region", "account", false, "us"], ["tint", "device", false, "#ff8800"], ["nick", "bot", true, "Al"]]);
    } finally {
      await ph.close();
      opened.close();
    }
  }, 60_000);
});
