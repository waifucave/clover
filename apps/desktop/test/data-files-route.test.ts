// `/_t/` and the files that come with a plugin's point entries (`dataFiles`, a general capability: a point declares
// `files` on a path field, and the core names each entry's folder and kinds), proven with a fixture that has nothing to
// do with figures: a word-game plugin's word lists and sound bank. And `/_d/<id>/`: what a plugin shares with its own pages (its data folder's `shared/`), to its layer
// only. Everything is judged by real path; nothing else changes on `/_t/` (themes keep images only).
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredKind, ownDataRequest } from "../src/main/ui/files";

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
  // What each plugin shares with its pages is its data folder's `shared/`; the rest (its host code's) is never served.
  folder("plugin-data/wordgame", { "shared/own/saved.json": "{\"score\":1}", "shared/own/pic.png": "png", "shared/own/page.html": "<p>", "shared/own/v.svg": "<svg/>", "shared/own/run.js": "x", "shared/own/m.wasm": "w", "shared/.hidden.json": "{}", "db.json": "{\"PROBE_SECRET\":\"dummy123\"}" });
  folder("plugin-data/other", { "shared/theirs.json": "{}" });
  symlinkSync(join(dir, "plugin-data", "other", "shared", "theirs.json"), join(dir, "plugin-data", "wordgame", "shared", "own", "link.json"));
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
  test("a manifest is never a data file, whichever separator its real path is written with (Windows uses \\)", () => {
    const kinds = [{ kinds: [{ ext: [".json"], type: "json" as const, maxBytes: 1024 }] }];
    for (const f of ["/p/lists/en/moss.json", "C:\\p\\lists\\en\\moss.json", "C:\\p\\lists\\en\\package.json"]) expect([f, declaredKind(kinds as never, f)]).toEqual([f, undefined]);
    expect(declaredKind(kinds as never, "C:\\p\\lists\\en\\animals.json")).toBeDefined();
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

describe("what a plugin shares with its own pages, on /_d/<id>/", () => {
  test("its shared folder's inert files, by real path; never HTML, SVG, a script or wasm, never a dot file, never a link to another's", async () => {
    const r = await own("wordgame", "wordgame/own/saved.json");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toContain("application/json");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await own("wordgame", "wordgame/own/pic.png")).status).toBe(200);
    for (const p of ["own/page.html", "own/v.svg", "own/run.js", "own/m.wasm", "own/link.json"]) expect((await own("wordgame", `wordgame/${p}`)).status, p).toBe(403);
    for (const p of [".hidden.json", "own/../../db.json", "own/%2e%2e/%2e%2e/db.json", "own/nothing.json", "OWN/../../DB.JSON"]) {
      const st = (await own("wordgame", `wordgame/${p}`)).status;
      expect(st === 403 || st === 404, `${p}: ${st}`).toBe(true);
    }
  });
  test("the data folder outside shared/ (its host code's) is never served: the planted dummy is not visible", async () => {
    const r = await own("wordgame", "wordgame/../db.json");
    const body = r.status === 200 ? await r.text() : "";
    expect(body.includes("dummy123")).toBe(false);
  });
  test("each layer reaches only its own plugins' shared folders; a frame of another layer is cancelled before the handler", async () => {
    expect((await own("other", "other/theirs.json")).status).toBe(200);
    // Another layer's plugin named in the URL: refused on this host.
    expect((await own("other", "wordgame/own/saved.json")).status).toBe(403);
    expect((await own("wordgame", "other/theirs.json")).status).toBe(403);
    expect(ownDataRequest("wordgame", "moss-plugin://wordgame/_d/wordgame/own/saved.json")).toBe("allow");
    expect(ownDataRequest("other", "moss-plugin://wordgame/_d/wordgame/own/saved.json")).toBe("refuse");
    expect(ownDataRequest(undefined, "moss-plugin://wordgame/_d/wordgame/own/saved.json")).toBe("refuse");
    expect(ownDataRequest("moss", "moss-plugin://wordgame/_d/wordgame/own/saved.json")).toBe("refuse");
    expect(ownDataRequest("other", "moss-plugin://wordgame/_t/wordgame/x.json")).toBe("not-own-data");
    // A layer no plugin is on, or an id that isn't one, is refused.
    expect((await own("nobody", "nobody/x.json")).status).toBe(403);
    expect((await own("wordgame", "..%2Fx/x.json")).status).toBe(403);
  });
});
