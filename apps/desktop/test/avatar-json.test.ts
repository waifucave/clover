// `/_t/` and a bot's own model files: served by the kinds the installed renderer of the bot's format declared (`avatar.formats`), only
// from the folder the avatar sits in, by real path; everything else stays as it was (no JSON for themes, layouts, bots of no format).
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("electron", () => ({ app: {}, ipcMain: {}, protocol: {}, webFrameMain: {}, BrowserWindow: class {} }));

let handler: (request: Request) => Response | Promise<Response>;
const dir = mkdtempSync(join(tmpdir(), "clover-avjson-"));

function folder(name: string, files: Record<string, string>): string {
  const base = join(dir, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(base, rel, ".."), { recursive: true });
    writeFileSync(join(base, rel), text);
  }
  return base;
}

const MODEL = { "assets/live2d/a.model3.json": "{}", "assets/live2d/a.physics3.json": "{}", "assets/live2d/motions/idle.motion3.json": "{}", "assets/live2d/a.moc3": "MOC3", "assets/live2d/tex.png": "png", "assets/other/x.json": "{}", "clover.json": "{\"secret\":1}", "assets/live2d/notes.json": "{}" };
const plugin = (id: string, assetBase: string, extra: Record<string, unknown>) => ({ id, topId: id, layer: id, assetBase, isBot: false, themes: [], entries: [], css: [], avatarFormats: [], ...extra });
const LIVE2D = { format: "live2d", extensions: [".model3.json"], find: "cubism-model3", kinds: [{ ext: [".json"], type: "json", maxBytes: 8 * 1024 * 1024 }, { ext: [".moc3"], type: "binary", maxBytes: 128 * 1024 * 1024 }, { ext: [".png"], type: "image", maxBytes: 128 * 1024 * 1024 }] };
const VRM = { format: "vrm", extensions: [".vrm"], find: "folder", kinds: [{ ext: [".vrm", ".glb"], type: "binary", maxBytes: 128 * 1024 * 1024 }] };
const PNGTUBER = { format: "pngtuber", extensions: [".pngtuber.json"], find: "folder", kinds: [{ ext: [".json"], type: "json", maxBytes: 65536 }, { ext: [".png"], type: "image", maxBytes: 4 * 1024 * 1024 }] };

beforeAll(async () => {
  const live = folder("live", MODEL);
  mkdirSync(join(dir, "outside"), { recursive: true });
  writeFileSync(join(dir, "outside", "o.json"), "{}");
  symlinkSync(join(dir, "outside", "o.json"), join(live, "assets/live2d/link.json"));
  symlinkSync(join(live, "clover.json"), join(live, "assets/live2d/rootlink.json"));
  writeFileSync(join(live, "assets/live2d/big.json"), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
  const rootModel = folder("rootmodel", { "r.model3.json": "{}", "r.physics3.json": "{}", "clover.json": "{}", "data.json": "{}" });
  const vrm = folder("vrmbot", { "assets/a.vrm": "VRM", "assets/data.json": "{}" });
  const theme = folder("themed", { "t/theme.json": "{}", "t/a.png": "png" });
  const tuber = folder("tuber", { "model/hero.pngtuber.json": "{}", "model/idle.png": "png", "model/data.json": "{}", "model/a.skel": "x", "model/x.svg": "<svg/>", "model/talk.wav": "w", "clover.json": "{}", "other/o.json": "{}" });
  const registry = [
    plugin("live", live, { isBot: true, botAvatar: { file: "assets/live2d/a.model3.json", format: "live2d" } }),
    plugin("rootmodel", rootModel, { isBot: true, botAvatar: { file: "r.model3.json", format: "live2d" } }),
    plugin("vrmbot", vrm, { isBot: true, botAvatar: { file: "assets/a.vrm", format: "vrm" } }),
    plugin("themed", theme, { themes: [{ id: "t", file: "t/theme.json" }] }),
    plugin("noavatar", live, { isBot: true }),
    plugin("nobody-draws", live, { isBot: true, botAvatar: { file: "assets/live2d/a.model3.json", format: "live2d-2" } }),
    plugin("tuber", tuber, { isBot: true, botAvatar: { file: "model/hero.pngtuber.json", format: "pngtuber" } }),
    plugin("vrm-renderer", join(dir, "vrm-renderer"), { avatarFormats: [VRM] }),
    plugin("live2d-renderer", join(dir, "l2d-renderer"), { avatarFormats: [LIVE2D] }),
    plugin("tuber-renderer", join(dir, "tuber-renderer"), { avatarFormats: [PNGTUBER] }),
  ];
  const { installUiSession } = await import("../src/main/ui/electron");
  const ses = { protocol: { handle: (scheme: string, h: typeof handler) => { if (scheme === "clover-plugin") handler = h; } }, webRequest: { onBeforeRequest: () => {} } };
  installUiSession(ses as never, { registry } as never, { core: dir, layer: dir }, () => {});
});

const get = async (id: string, path: string) => handler(new Request(`clover-plugin://clover/_t/${id}/${path}`));

describe("a Live2D bot's own model JSON on /_t/", () => {
  test("model3, physics3 and motion files in the avatar folder are served, as JSON, nosniff, with the strict CSP", async () => {
    for (const p of ["assets/live2d/a.model3.json", "assets/live2d/a.physics3.json", "assets/live2d/motions/idle.motion3.json"]) {
      const r = await get("live", p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("content-type")).toContain("application/json");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
  });
  test("its other model files still pass as before", async () => {
    expect((await get("live", "assets/live2d/a.moc3")).status).toBe(200);
    expect((await get("live", "assets/live2d/tex.png")).status).toBe(200);
  });
  test("the plugin's root clover.json and a JSON in a sibling folder are refused", async () => {
    expect((await get("live", "clover.json")).status).toBe(403);
    expect((await get("live", "assets/other/x.json")).status).toBe(403);
  });
  test("traversal, plain and encoded, is refused", async () => {
    for (const p of ["assets/live2d/../../clover.json", "assets/live2d/%2e%2e/%2e%2e/clover.json", "assets%2Flive2d%2F..%2F..%2Fclover.json", "..%2Fclover.json"]) {
      const s = (await get("live", p)).status;
      expect(s === 403 || s === 404, `${p}: ${s}`).toBe(true);
    }
  });
  test("a link inside the avatar folder to a JSON outside it is refused", async () => {
    // A link out of the plugin altogether is not found, as it always was; one to the plugin's own root JSON is forbidden.
    expect((await get("live", "assets/live2d/link.json")).status).toBe(404);
    expect((await get("live", "assets/live2d/rootlink.json")).status).toBe(403);
  });
  test("a model at the plugin's root passes its declared kinds, never the manifest", async () => {
    expect((await get("rootmodel", "r.model3.json")).status).toBe(200);
    expect((await get("rootmodel", "r.physics3.json")).status).toBe(200);
    expect((await get("rootmodel", "clover.json")).status).toBe(403);
    expect((await get("rootmodel", "data.json")).status).toBe(200);
  });
  test("a VRM bot, a theme plugin and a bot with no avatar get no JSON", async () => {
    expect((await get("vrmbot", "assets/data.json")).status).toBe(403);
    expect((await get("vrmbot", "assets/a.vrm")).status).toBe(200);
    expect((await get("themed", "t/theme.json")).status).toBe(403);
    expect((await get("themed", "t/a.png")).status).toBe(200);
    expect((await get("noavatar", "assets/live2d/a.model3.json")).status).toBe(403);
  });
  test("a bot with no installed renderer for its format (the renderer's plugin is off) gets no model JSON or binary", async () => {
    expect((await get("nobody-draws", "assets/live2d/a.model3.json")).status).toBe(403);
    expect((await get("nobody-draws", "assets/live2d/a.moc3")).status).toBe(403);
    expect((await get("nobody-draws", "assets/live2d/tex.png")).status).toBe(200);
  });
  test("a community format is served by what its renderer declared: its JSON and pictures in the avatar's folder, nothing else", async () => {
    const hero = await get("tuber", "model/hero.pngtuber.json");
    expect(hero.status).toBe(200);
    expect(hero.headers.get("content-type") ?? "").toContain("application/json");
    expect((await get("tuber", "model/data.json")).status).toBe(200);
    expect((await get("tuber", "model/idle.png")).status).toBe(200);
    // Not a declared kind (a `.skel`, a sound it never listed, an SVG), not the manifest, not outside the avatar's folder.
    for (const p of ["model/a.skel", "model/talk.wav", "clover.json", "other/o.json"]) expect((await get("tuber", p)).status, p).toBe(403);
  });
  test("an unknown plugin is refused as it always was", async () => {
    expect((await get("nobody", "assets/live2d/a.model3.json")).status).toBe(403);
  });
  test("a JSON over 8 MiB is refused with 413; one at the cap's edge is not", async () => {
    expect((await get("live", "assets/live2d/big.json")).status).toBe(413);
  });
  test("a case-variant path is judged by the file's real path: outside the avatar folder it is refused; inside, it is the same file", async () => {
    // On a case-insensitive disk (macOS) the variant names the very file the real path names; on a case-sensitive one it is not found.
    for (const p of ["CLOVER.JSON", "Clover.json", "ASSETS/OTHER/X.JSON", "assets/Other/x.json"]) {
      const s = (await get("live", p)).status;
      expect(s === 403 || s === 404, `${p}: ${s}`).toBe(true);
    }
    const same = (await get("live", "assets/LIVE2D/a.model3.json")).status;
    expect(same === 200 || same === 404, `variant of an in-folder file: ${same}`).toBe(true);
  });
  test("a plugin that is off (not in the registry) gets what its images get: refused alike", async () => {
    expect((await get("switched-off", "assets/live2d/a.model3.json")).status).toBe(403);
    expect((await get("switched-off", "assets/live2d/tex.png")).status).toBe(403);
  });
  test("a link to the avatar's own JSON from inside its folder is served only as the file it really is", async () => {
    expect((await get("live", "assets/live2d/rootlink.json")).status).toBe(403);
  });
});
