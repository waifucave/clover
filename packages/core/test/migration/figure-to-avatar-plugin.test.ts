// The figure left the core for the avatar plugin: each bot's own model and the figure chosen move to `moss/character`, once,
// in a temp home; the layers lose their `avatar` field; the copied originals stay; nothing of a link is copied; a pick the
// plugin already holds is kept; a home with none is left as it was.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userLayerFile, userLayersDir } from "../../src/bots/paths";
import { moveFigureToAvatarPlugin } from "../../src/migration/figure-to-avatar-plugin";
import { filePluginSettings } from "../../src/plugin-host/api/settings";
import { pluginDataFolder } from "../../src/plugin-host/paths";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "moss-mc2-figure-"));
  temps.push(h);
  mkdirSync(join(h, "settings"), { recursive: true });
  mkdirSync(userLayersDir(h), { recursive: true });
  return h;
};
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const layer = (h: string, bot: string, fields: Record<string, unknown>) => writeFileSync(userLayerFile(h, bot), JSON.stringify({ userLayer: 1, bot, fields }));

test("Alpha's own model and her pick move into the avatar plugin; Luna's model is kept too; the layers lose the field", () => {
  const h = home();
  const alphaModel = join(userLayersDir(h), "avatars", "alpha", "k3x9");
  mkdirSync(join(alphaModel, "motions"), { recursive: true });
  writeFileSync(join(alphaModel, "hero.model3.json"), "{}");
  writeFileSync(join(alphaModel, "hero.moc3"), "MOC3");
  writeFileSync(join(alphaModel, "motions", "idle.motion3.json"), "{}");
  // A link planted in the folder, to a file outside it: never copied.
  writeFileSync(join(h, "secret.txt"), "PROBE_SECRET=dummy123");
  symlinkSync(join(h, "secret.txt"), join(alphaModel, "link.json"));
  const lunaModel = join(userLayersDir(h), "avatars", "luna", "q1");
  mkdirSync(lunaModel, { recursive: true });
  writeFileSync(join(lunaModel, "luna.vrm"), "VRM");
  layer(h, "alpha", { avatar: { file: "user:k3x9/hero.model3.json", format: "live2d", credit: "by someone" }, theme: "alpha#t" });
  layer(h, "luna", { avatar: { file: "user:q1/luna.vrm", format: "vrm" } });
  layer(h, "mika", { name: "Mika" });

  const lines: string[] = [];
  const moved = moveFigureToAvatarPlugin(h, { log: (l) => lines.push(l) });
  expect(moved).toContain("alpha's own figure (live2d) → moss/character's data folder, own/alpha/k3x9/hero.model3.json");
  expect(moved).toContain("the figure shown → moss/character's setting figure (own)");
  expect(lines.every((l) => l.startsWith("migration: "))).toBe(true);
  const s = filePluginSettings(h).read("moss/character");
  expect(s.account.figure).toBe("own:live2d:own/alpha/k3x9/hero.model3.json");
  expect(JSON.parse(s.account.ownModels as string)).toEqual([
    { name: "hero", format: "live2d", file: "own/alpha/k3x9/hero.model3.json", credit: "by someone" },
    { name: "luna", format: "vrm", file: "own/luna/q1/luna.vrm" },
  ]);
  const data = join(pluginDataFolder(h, "moss/character"), "shared");
  expect(data).toBe(join(h, "plugin-data", "moss", "character", "shared"));
  for (const f of ["own/alpha/k3x9/hero.model3.json", "own/alpha/k3x9/hero.moc3", "own/alpha/k3x9/motions/idle.motion3.json", "own/luna/q1/luna.vrm"]) expect([f, existsSync(join(data, f))]).toEqual([f, true]);
  // The planted link: not visible in the copy (false), the original untouched.
  expect(existsSync(join(data, "own/alpha/k3x9/link.json"))).toBe(false);
  // The layers: Alpha keeps her theme, Luna's (only a figure) is gone, Mika's untouched; the originals stay.
  expect(json(userLayerFile(h, "alpha")).fields).toEqual({ theme: "alpha#t" });
  expect(existsSync(userLayerFile(h, "luna"))).toBe(false);
  expect(json(userLayerFile(h, "mika")).fields).toEqual({ name: "Mika" });
  expect(existsSync(join(alphaModel, "hero.moc3"))).toBe(true);

  // Once: the next boot finds nothing to move, and the settings stay as they are.
  expect(moveFigureToAvatarPlugin(h)).toEqual([]);
  expect(filePluginSettings(h).read("moss/character").account.figure).toBe("own:live2d:own/alpha/k3x9/hero.model3.json");
});

test("a pack's file kept as the pick becomes `url:`; a pick the plugin already holds is never overwritten; a missing or escaping folder is left out", () => {
  const h = home();
  layer(h, "luna", { avatar: { file: "assets/luna.vrm", format: "vrm" } });
  expect(moveFigureToAvatarPlugin(h)).toContain("the figure shown → moss/character's setting figure (url)");
  expect(filePluginSettings(h).read("moss/character").account.figure).toBe("url:assets/luna.vrm");

  const h2 = home();
  const store = filePluginSettings(h2);
  store.write("moss/character", { account: { figure: "pack:acme#fox" }, device: {}, bot: {} } as never);
  layer(h2, "alpha", { avatar: { file: "user:../../escape/x.json", format: "live2d" } });
  layer(h2, "luna", { avatar: { file: "user:gone/x.vrm", format: "vrm" } });
  const lines = moveFigureToAvatarPlugin(h2);
  expect(lines.filter((l) => l.includes("was not found"))).toHaveLength(2);
  expect(filePluginSettings(h2).read("moss/character").account.figure).toBe("pack:acme#fox");
  expect(existsSync(join(h2, "plugin-data", "moss", "character", "shared", "own"))).toBe(false);
  // The fields leave even so: the core no longer reads them.
  expect(existsSync(userLayerFile(h2, "alpha"))).toBe(false);
});

test("a home with no figures (or no user layers at all) is left as it was", () => {
  const h = home();
  layer(h, "alpha", { theme: "alpha#t" });
  expect(moveFigureToAvatarPlugin(h)).toEqual([]);
  expect(existsSync(join(h, "settings", "plugins", "moss%2Fcharacter.json"))).toBe(false);
  const bare = mkdtempSync(join(tmpdir(), "moss-mc2-bare-"));
  temps.push(bare);
  expect(moveFigureToAvatarPlugin(bare)).toEqual([]);
});

// The orders a real upgrade can meet (the migration runs at every boot, under no condition but "a layer still holds an avatar").
test("a home whose plugin already has settings of its own (it ran an earlier build, the plugin first approved before the move) keeps them and gains the pick and the models", () => {
  const h = home();
  const store = filePluginSettings(h);
  store.write("moss/character", { account: { followBots: false }, device: { left: "1" }, bot: {} } as never);
  const model = join(userLayersDir(h), "avatars", "alpha", "k1");
  mkdirSync(model, { recursive: true });
  writeFileSync(join(model, "a.model3.json"), "{}");
  layer(h, "alpha", { avatar: { file: "user:k1/a.model3.json", format: "live2d" } });
  moveFigureToAvatarPlugin(h);
  const s = filePluginSettings(h).read("moss/character");
  expect(s.account.followBots).toBe(false);
  expect(s.device).toEqual({ left: "1" });
  expect(s.account.figure).toBe("own:live2d:own/alpha/k1/a.model3.json");
  expect(JSON.parse(s.account.ownModels as string)).toHaveLength(1);
});

test("a layer that reaches the home after the first boot (a sync, an older file reloaded) moves at the next boot; a boot with nothing to move changes nothing", () => {
  const h = home();
  expect(moveFigureToAvatarPlugin(h)).toEqual([]); // the first boot: no choice at all
  expect(existsSync(join(h, "settings", "plugins", "moss%2Fcharacter.json"))).toBe(false);
  const model = join(userLayersDir(h), "avatars", "luna", "q1");
  mkdirSync(model, { recursive: true });
  writeFileSync(join(model, "l.vrm"), "VRM");
  layer(h, "luna", { avatar: { file: "user:q1/l.vrm", format: "vrm" } });
  moveFigureToAvatarPlugin(h); // the next boot
  expect(filePluginSettings(h).read("moss/character").account.figure).toBe("own:vrm:own/luna/q1/l.vrm");
  const again = moveFigureToAvatarPlugin(h);
  expect(again).toEqual([]);
  expect(filePluginSettings(h).read("moss/character").account.figure).toBe("own:vrm:own/luna/q1/l.vrm");
  // The person then picks another figure; a late reload of the old layer must not undo it.
  const store = filePluginSettings(h);
  const cur = store.read("moss/character");
  cur.account.figure = "pack:acme#fox";
  store.write("moss/character", cur);
  layer(h, "luna", { avatar: { file: "user:q1/l.vrm", format: "vrm" } });
  moveFigureToAvatarPlugin(h);
  expect(filePluginSettings(h).read("moss/character").account.figure).toBe("pack:acme#fox");
});
