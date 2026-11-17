// `/_t/` and the files that come with a plugin's point entries (`dataFiles`, a general capability: a point declares
// `files` on a path field, and the core names each entry's folder and kinds), proven with a fixture that has nothing to
// do with figures: a word-game plugin's word lists and sound bank. And `/_d/`: a layer's own data folder, to that layer
// only. Everything is judged by real path; nothing else changes on `/_t/` (themes keep images only).
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownDataRequest } from "../src/main/ui/files";

mock.module("electron", () => ({ app: {}, ipcMain: {}, protocol: {}, webFrameMain: {}, BrowserWindow: class {} }));

let handler: (request: Request) => Response | Promise<Response>;
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "moss-datafiles-")));

function folder(name: string, files: Record<string, string | Buffer>): string {
  const base = join(dir, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(base, rel, ".."), { recursive: true });
    writeFileSync(join(base, rel), text);
  }
  return base;
}
const plugin = (id: string, assetBase: string, extra: Record<string, unknown> = {}) => ({ id, topId: id.split("/")[0], layer: id.split("/")[0], assetBase, isBot: false, themes: [], entries: [], css: [], dataFiles: [], ...extra });
const WORDS = { folder: "lists/en", kinds: [{ ext: [".json"], type: "json", maxBytes: 1024 }, { ext: [".mp3"], type: "audio", maxBytes: 4 * 1024 * 1024 }, { ext: [".txt"], type: "text", maxBytes: 4096 }] };

beforeAll(async () => {
  const words = folder("words", { "lists/en/animals.json": "[\"fox\"]", "lists/en/ding.mp3": "ID3", "lists/en/readme.txt": "hi", "lists/en/x.svg": "<svg/>", "lists/en/run.js": "x", "lists/en/big.json": Buffer.alloc(2048, 32), "lists/fr/chat.json": "[]", "moss.json": "{\"secret\":1}", "lists/en/moss.json": "{}" });
  mkdirSync(join(dir, "outside"), { recursive: true });
  writeFileSync(join(dir, "outside", "o.json"), "{}");
  symlinkSync(join(dir, "outside", "o.json"), join(words, "lists/en/link.json"));
  const plain = folder("plain", { "lists/en/animals.json": "[]", "a.png": "png" });
  const data = join(dir, "plugin-data");
  folder("plugin-data/wordgame", { "own/saved.json": "{\"score\":1}", "own/pic.png": "png", "own/page.html": "<p>", "own/v.svg": "<svg/>", ".hidden.json": "{}" });
  folder("plugin-data/other", { "theirs.json": "{}" });
  symlinkSync(join(dir, "plugin-data", "other", "theirs.json"), join(dir, "plugin-data", "wordgame", "own", "link.json"));
  const registry = [plugin("wordgame", words, { dataFiles: [WORDS] }), plugin("plain", plain), plugin("other", plain)];
  const { installUiSession } = await import("../src/main/ui/electron");
  const ses = { protocol: { handle: (scheme: string, h: typeof handler) => { if (scheme === "moss-plugin") handler = h; } }, webRequest: { onBeforeRequest: () => {} } };
  installUiSession(ses as never, { registry } as never, { core: dir, layer: dir }, () => {}, { pluginDataDir: data } as never);
});

const get = async (id: string, path: string, host = "moss") => handler(new Request(`moss-plugin://${host}/_t/${id}/${path}`));
const own = async (host: string, path: string) => handler(new Request(`moss-plugin://${host}/_d/${path}`));

describe("files that come with a point entry, on /_t/", () => {
  test("the declared kinds inside the entry's folder are served as inert types, nosniff, under the strict CSP", async () => {
    for (const [p, type] of [["lists/en/animals.json", "application/json"], ["lists/en/ding.mp3", "audio/mpeg"], ["lists/en/readme.txt", "text/plain"]] as const) {
      const r = await get("wordgame", p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("content-type") ?? "").toContain(type);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
  });
  test("not a declared kind, not inside the folder, the manifest, a link out, traversal: refused", async () => {
    for (const p of ["lists/en/x.svg", "lists/en/run.js", "lists/fr/chat.json", "moss.json", "lists/en/moss.json"]) expect((await get("wordgame", p)).status, p).toBe(403);
    expect((await get("wordgame", "lists/en/link.json")).status).toBe(404);
    for (const p of ["lists/en/../../moss.json", "lists/en/%2e%2e/%2e%2e/moss.json", "lists%2Fen%2F..%2F..%2Fmoss.json"]) {
      const s = (await get("wordgame", p)).status;
      expect(s === 403 || s === 404, `${p}: ${s}`).toBe(true);
    }
    // Case variants are judged by the real path.
    for (const p of ["MOSS.JSON", "LISTS/FR/CHAT.JSON"]) { const s = (await get("wordgame", p)).status; expect(s === 403 || s === 404, `${p}: ${s}`).toBe(true); }
  });
  test("over the declared cap: 413", async () => {
    expect((await get("wordgame", "lists/en/big.json")).status).toBe(413);
  });
  test("a plugin whose entries bring no files gets no JSON, as before; its pictures stay refused unless something else lets it in", async () => {
    expect((await get("plain", "lists/en/animals.json")).status).toBe(403);
  });
});

describe("a layer's own data, on /_d/", () => {
  test("its own folder's inert files, by real path; never HTML or SVG, never a dot file, never a link to another plugin's data", async () => {
    const r = await own("wordgame", "own/saved.json");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toContain("application/json");
    expect((await own("wordgame", "own/pic.png")).status).toBe(200);
    for (const p of ["own/page.html", "own/v.svg", "own/link.json"]) expect((await own("wordgame", p)).status, p).toBe(403);
    for (const p of [".hidden.json", "own/../../other/theirs.json", "own/%2e%2e/%2e%2e/other/theirs.json", "own/nothing.json"]) expect((await own("wordgame", p)).status, p).toBe(404);
  });
  test("each layer reaches only its own folder; a frame of another layer is cancelled before the handler", async () => {
    expect((await own("other", "theirs.json")).status).toBe(200);
    expect((await own("other", "own/saved.json")).status).toBe(404);
    expect(ownDataRequest("wordgame", "moss-plugin://wordgame/_d/own/saved.json")).toBe("allow");
    expect(ownDataRequest("other", "moss-plugin://wordgame/_d/own/saved.json")).toBe("refuse");
    expect(ownDataRequest(undefined, "moss-plugin://wordgame/_d/own/saved.json")).toBe("refuse");
    expect(ownDataRequest("moss", "moss-plugin://wordgame/_d/own/saved.json")).toBe("refuse");
    expect(ownDataRequest("other", "moss-plugin://wordgame/_t/wordgame/x.json")).toBe("not-own-data");
    // A layer no plugin is on is refused.
    expect((await own("nobody", "x.json")).status).toBe(403);
  });
});
