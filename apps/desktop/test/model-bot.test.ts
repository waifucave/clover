import { describe, expect, test } from "bun:test";
import { readUiPlugins } from "../src/main/ui/model";

describe("the daemon's plugin.ui view of a bot plugin", () => {
  test("`bot: { name, theme, layout }` is read as the bot flag and theme; its tab layout, retired with the bot tab (G8), is not", () => {
    const view = { pluginId: "luna", name: "Luna", treeHash: `sha256:${"2".repeat(64)}`, layer: "luna", assetBase: "/x", ui: [], themes: [], locales: [], bots: "all", bot: { name: "Luna", theme: "luna-night", layout: "tab/layout.json" } };
    const [p] = readUiPlugins([view] as never);
    expect(p).toMatchObject({ isBot: true, botTheme: "luna-night" });
    expect((p as unknown as Record<string, unknown>).botLayout).toBeUndefined();
    expect(p!.entries.some((e) => e.spot === "bot.tab")).toBe(false);
  });

  test("the files its point entries bring (`dataFiles`) are read; a retired `bot.avatar` is not", () => {
    const view = { pluginId: "luna", name: "Luna", treeHash: `sha256:${"2".repeat(64)}`, layer: "luna", assetBase: "/x", ui: [], themes: [], locales: [], bots: "all", dataFiles: [{ folder: "lists/en", kinds: [{ ext: [".json"], type: "json", maxBytes: 1024 }] }], bot: { name: "Luna", avatar: { file: "assets/m/luna.model3.json", format: "live2d" } } };
    const [p] = readUiPlugins([view] as never);
    expect(p!.dataFiles).toEqual([{ folder: "lists/en", kinds: [{ ext: [".json"], type: "json", maxBytes: 1024 }] }]);
    expect((p as unknown as Record<string, unknown>).botAvatar).toBeUndefined();
  });
});
