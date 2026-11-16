// Settings that moved from the core to a plugin (the table's rows; today F1's: the speak-replies switch and each bot's
// voice → MOSS Voice's settings): moved once, each in one log line, the core's copies gone after it (only the moved
// keys), a value the plugin already holds never overwritten, nothing to do on a home that never had them.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userLayerFile, userLayersDir } from "../../src/bots/paths";
import { moveSettingsToPlugins, type SettingMove } from "../../src/migration/settings-moved-to-plugins";
import { filePluginSettings } from "../../src/plugin-host/api/settings";
import { uiSettingsFile } from "../../src/plugin-host/ui-settings";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "moss-a-move-"));
  temps.push(h);
  mkdirSync(join(h, "settings"), { recursive: true });
  mkdirSync(userLayersDir(h), { recursive: true });
  return h;
};
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("the speak-replies switch and each bot's voice move into MOSS Voice's settings, once; the core's fields go", () => {
  const h = home();
  writeFileSync(uiSettingsFile(h), JSON.stringify({ picks: [], lists: [], appearance: "dark", voice: { speakReplies: false } }));
  writeFileSync(userLayerFile(h, "alpha"), JSON.stringify({ userLayer: 1, bot: "alpha", fields: { voice: { provider: "fish-audio", voice: "v1", model: "s2.1-pro" }, theme: "alpha#t" } }));
  writeFileSync(userLayerFile(h, "luna"), JSON.stringify({ userLayer: 1, bot: "luna", fields: { voice: { provider: "fish-audio", voice: "v2" } } }));
  const lines: string[] = [];
  const moved = moveSettingsToPlugins(h, { log: (l) => lines.push(l) });
  expect(moved.length).toBe(8);
  expect(lines).toHaveLength(8);
  expect(lines).toContain("migration: luna's voice.provider → moss/voice's bot setting providerPlugin (moss/fish-audio)");
  expect(lines).toContain("migration: alpha's voice.model → moss/voice's bot setting model");
  expect(lines).toContain("migration: voice.speakReplies → moss/voice's account setting speakReplies");
  const v = filePluginSettings(h).read("moss/voice");
  expect(v.account).toEqual({ speakReplies: false });
  // A Fish Audio pick is tied to Fish Audio's plugin.
  expect(v.bot).toEqual({ alpha: { providerPlugin: "moss/fish-audio", provider: "fish-audio", voice: "v1", model: "s2.1-pro" }, luna: { providerPlugin: "moss/fish-audio", provider: "fish-audio", voice: "v2" } });
  // The core holds neither any more: ui.json keeps the rest, Alpha's layer its theme, Luna's (only a voice) is gone.
  expect(json(uiSettingsFile(h))).toEqual({ picks: [], lists: [], appearance: "dark" });
  expect(json(userLayerFile(h, "alpha")).fields).toEqual({ theme: "alpha#t" });
  expect(existsSync(userLayerFile(h, "luna"))).toBe(false);
  // Again: nothing to move.
  expect(moveSettingsToPlugins(h)).toEqual([]);
});

test("a value the plugin already holds is kept; a home with nothing to move is left as it is", () => {
  const h = home();
  filePluginSettings(h).write("moss/voice", { account: { speakReplies: true }, device: {}, bot: { alpha: { provider: "acme", voice: "mine" } } });
  writeFileSync(uiSettingsFile(h), JSON.stringify({ picks: [], lists: [], voice: { speakReplies: false } }));
  writeFileSync(userLayerFile(h, "alpha"), JSON.stringify({ userLayer: 1, bot: "alpha", fields: { voice: { provider: "fish-audio", voice: "v1" } } }));
  moveSettingsToPlugins(h);
  const v = filePluginSettings(h).read("moss/voice");
  expect(v.account).toEqual({ speakReplies: true });
  expect(v.bot.alpha).toEqual({ provider: "acme", voice: "mine" });
  expect(json(uiSettingsFile(h))).toEqual({ picks: [], lists: [] });
  const empty = home();
  expect(moveSettingsToPlugins(empty)).toEqual([]);
  expect(existsSync(uiSettingsFile(empty))).toBe(false);
  expect(existsSync(join(empty, "settings", "plugins"))).toBe(false);
});

test("only the moved keys go: what else the core kept beside them stays; the table is data", () => {
  const h = home();
  writeFileSync(uiSettingsFile(h), JSON.stringify({ picks: [], lists: [], voice: { speakReplies: true, other: 1 } }));
  writeFileSync(userLayerFile(h, "alpha"), JSON.stringify({ userLayer: 1, bot: "alpha", fields: { voice: { provider: "fish-audio", voice: "v1", pitch: 2 } } }));
  const moves: SettingMove[] = [
    { from: { ui: ["voice", "speakReplies"] }, plugin: "acme", scope: "device", key: "talk" },
    { from: { botField: "voice", key: "voice" }, plugin: "acme", scope: "bot", key: "sound" },
  ];
  expect(moveSettingsToPlugins(h, { moves })).toEqual(["voice.speakReplies → acme's device setting talk", "alpha's voice.voice → acme's bot setting sound"]);
  const v = filePluginSettings(h).read("acme");
  expect(v.device).toEqual({ talk: true });
  expect(v.bot).toEqual({ alpha: { sound: "v1" } });
  expect(json(uiSettingsFile(h)).voice).toEqual({ other: 1 });
  expect(json(userLayerFile(h, "alpha")).fields).toEqual({ voice: { provider: "fish-audio", pitch: 2 } });
});
