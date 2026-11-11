import { describe, expect, test } from "bun:test";
import { readUiPlugins } from "../src/main/ui/model";

describe("the daemon's plugin.ui view of a bot plugin", () => {
  test("`bot: { name, theme, layout }` is read as the bot flag, theme and layout (the app read only botLayout and isBot)", () => {
    const view = { pluginId: "luna", name: "Luna", treeHash: `sha256:${"2".repeat(64)}`, layer: "luna", assetBase: "/x", ui: [], themes: [], locales: [], bots: "all", bot: { name: "Luna", theme: "luna-night", layout: "tab/layout.json" } };
    const [p] = readUiPlugins([view] as never);
    expect(p).toMatchObject({ isBot: true, botTheme: "luna-night", botLayout: "tab/layout.json" });
  });

  test("the avatar its manifest names is read, for the Live2D JSON rule on `/_t/`", () => {
    const view = { pluginId: "luna", name: "Luna", treeHash: `sha256:${"2".repeat(64)}`, layer: "luna", assetBase: "/x", ui: [], themes: [], locales: [], bots: "all", bot: { name: "Luna", avatar: { file: "assets/m/luna.model3.json", format: "live2d" } } };
    const [p] = readUiPlugins([view] as never);
    expect(p).toMatchObject({ isBot: true, botAvatar: { file: "assets/m/luna.model3.json", format: "live2d" } });
  });
});
