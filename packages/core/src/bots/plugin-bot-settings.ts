// A plugin's bot-scoped settings for the records (§5.9 `Setting.scope: "bot"`; the controller's ruling "no voice in the
// bot record"): the store's port (`BotPluginSettingsPort`) over the plugin host's own settings, so a bot holds no
// plugin's data and nothing keeps a second copy. Declarations come from the registry's manifests, values from the
// plugin host's file (`settings/plugins/<id>.json`'s `bot` map), and a change goes through the plugin host's own
// `setByUser` (its checks, its events). General: any plugin's bot-scoped setting. Owner: lane BT.
import type { PluginSettingView, Text } from "@waifucave/moss-protocol";
import type { PluginRegistry } from "../contracts/plugin-registry";
import type { PluginSettings, PluginSettingsBackend } from "../plugin-host/api/settings";
import type { BotPluginSettingsPort } from "./records";

type Scope = "account" | "device" | "bot";

export interface PluginBotSettings extends BotPluginSettingsPort {
  /** One bot's values of every plugin's bot-scoped settings with their schema (`bot.pluginSettings`). */
  views(bot: string): Promise<{ pluginId: string; name: Text; settings: PluginSettingView[] }[]>;
}

export function pluginBotSettings(o: {
  registry: Pick<PluginRegistry, "list" | "get">;
  backend: Pick<PluginSettingsBackend, "read">;
  /** The plugin host's settings, once it is up. */
  settings: () => Pick<PluginSettings, "setByUser" | "views"> | undefined;
}): PluginBotSettings {
  const declared = () => o.registry.list().flatMap((r) => {
    const fields = Object.entries(r.manifest?.settings ?? {});
    if (fields.length === 0) return [];
    return [{ pluginId: r.id, settings: fields.map(([key, f]) => ({ key, scope: ((f as { scope?: Scope }).scope ?? "account") as Scope, ...((f as { default?: unknown }).default === undefined ? {} : { default: (f as { default?: unknown }).default }) })) }];
  });
  return {
    declared,
    value(bot, pluginId, key) {
      const slot = o.backend.read(pluginId).bot[bot];
      return slot !== undefined && Object.hasOwn(slot, key) ? { set: true, value: slot[key] } : { set: false };
    },
    async set(bot, pluginId, key, value) {
      const s = o.settings();
      if (s === undefined) throw new Error("the plugin host isn't up yet");
      await s.setByUser(pluginId, key, value, bot);
    },
    async views(bot) {
      const s = o.settings();
      if (s === undefined) return [];
      const out: { pluginId: string; name: Text; settings: PluginSettingView[] }[] = [];
      for (const d of declared()) {
        if (!d.settings.some((x) => x.scope === "bot")) continue;
        const views = (await s.views(d.pluginId, bot)).filter((v) => v.scope === "bot");
        out.push({ pluginId: d.pluginId, name: o.registry.get(d.pluginId)?.manifest?.name ?? d.pluginId, settings: views });
      }
      return out;
    },
  };
}
