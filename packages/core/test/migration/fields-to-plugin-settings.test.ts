// The one-shot move of values the core kept for a re-founded feature into its plugin's own settings (F1: the
// speak-replies switch and each bot's voice → Clover Voice's settings): moved once, the core's fields gone after it,
// a value the plugin already holds never overwritten, nothing to do on a home that never had them.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userLayerFile, userLayersDir } from "../../src/bots/paths";
import { moveFieldsToPluginSettings } from "../../src/migration/fields-to-plugin-settings";
import { filePluginSettings } from "../../src/plugin-host/api/settings";
import { uiSettingsFile } from "../../src/plugin-host/ui-settings";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "clover-a-move-"));
  temps.push(h);
  mkdirSync(join(h, "settings"), { recursive: true });
  mkdirSync(userLayersDir(h), { recursive: true });
  return h;
};
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("the speak-replies switch and each bot's voice move into Clover Voice's settings, once; the core's fields go", () => {
  const h = home();
  writeFileSync(uiSettingsFile(h), JSON.stringify({ picks: [], lists: [], appearance: "dark", voice: { speakReplies: false } }));
  writeFileSync(userLayerFile(h, "alpha"), JSON.stringify({ userLayer: 1, bot: "alpha", fields: { voice: { provider: "fish-audio", voice: "v1", model: "s2.1-pro" }, theme: "alpha#t" } }));
  writeFileSync(userLayerFile(h, "luna"), JSON.stringify({ userLayer: 1, bot: "luna", fields: { voice: { provider: "fish-audio", voice: "v2" } } }));
  const lines: string[] = [];
  const moved = moveFieldsToPluginSettings(h, { log: (l) => lines.push(l) });
  expect(moved.length).toBe(3);
  expect(lines.every((l) => l.startsWith("migration: "))).toBe(true);
  const v = filePluginSettings(h).read("clover/voice");
  expect(v.account).toEqual({ speakReplies: false });
  expect(v.bot).toEqual({ alpha: { provider: "fish-audio", voice: "v1", model: "s2.1-pro" }, luna: { provider: "fish-audio", voice: "v2" } });
  // The core holds neither any more: ui.json keeps the rest, Alpha's layer its theme, Luna's (only a voice) is gone.
  expect(json(uiSettingsFile(h))).toEqual({ picks: [], lists: [], appearance: "dark" });
  expect(json(userLayerFile(h, "alpha")).fields).toEqual({ theme: "alpha#t" });
  expect(existsSync(userLayerFile(h, "luna"))).toBe(false);
  // Again: nothing to move.
  expect(moveFieldsToPluginSettings(h)).toEqual([]);
});

test("a value the plugin already holds is kept; a home with nothing to move is left as it is", () => {
  const h = home();
  filePluginSettings(h).write("clover/voice", { account: { speakReplies: true }, device: {}, bot: { alpha: { provider: "acme", voice: "mine" } } });
  writeFileSync(uiSettingsFile(h), JSON.stringify({ picks: [], lists: [], voice: { speakReplies: false } }));
  writeFileSync(userLayerFile(h, "alpha"), JSON.stringify({ userLayer: 1, bot: "alpha", fields: { voice: { provider: "fish-audio", voice: "v1" } } }));
  moveFieldsToPluginSettings(h);
  const v = filePluginSettings(h).read("clover/voice");
  expect(v.account).toEqual({ speakReplies: true });
  expect(v.bot.alpha).toEqual({ provider: "acme", voice: "mine" });
  expect(json(uiSettingsFile(h))).toEqual({ picks: [], lists: [] });
  const empty = home();
  expect(moveFieldsToPluginSettings(empty)).toEqual([]);
  expect(existsSync(uiSettingsFile(empty))).toBe(false);
  expect(existsSync(join(empty, "settings", "plugins"))).toBe(false);
});
