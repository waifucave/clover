// `bot.importAvatar`'s core: a user's own model, folder or zip, lands in the fenced avatars folder under a `user:` path;
// nothing outside a model's own data files comes along, and names written in GBK read back as they were written.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import { join } from "node:path";
import { creditNote, importAvatar, userAvatarFile } from "../avatar-import";
import { userAvatarsDir } from "../paths";

const roots: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "avatar-import-")); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A stored (uncompressed) zip with raw entry names, and the UTF-8 flag off: what an old Windows tool writes. */
function zipOf(entries: { name: Uint8Array; data: Uint8Array; utf8?: boolean; deflate?: boolean }[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e0 of entries) {
    const stored = e0.deflate ? deflateRawSync(e0.data) : e0.data;
    const e = { ...e0, data: stored, plain: e0.data };
    const crc = Bun.hash.crc32(e0.data) >>> 0;
    const method = e0.deflate ? 8 : 0;
    const lh = new Uint8Array(30 + e.name.length);
    const v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, e.utf8 ? 0x800 : 0, true); v.setUint16(8, method, true);
    v.setUint32(14, crc, true); v.setUint32(18, e.data.length, true); v.setUint32(22, e0.data.length, true); v.setUint16(26, e.name.length, true);
    lh.set(e.name, 30);
    const ch = new Uint8Array(46 + e.name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, e.utf8 ? 0x800 : 0, true); c.setUint16(10, method, true);
    c.setUint32(16, crc, true); c.setUint32(20, e.data.length, true); c.setUint32(24, e0.data.length, true); c.setUint16(28, e.name.length, true); c.setUint32(42, offset, true);
    ch.set(e.name, 46);
    local.push(lh, e.data); central.push(ch);
    offset += lh.length + e.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return Buffer.concat([...local, ...central, end]);
}

const enc = (s: string) => new TextEncoder().encode(s);
const model3 = JSON.stringify({ Version: 3, FileReferences: { Moc: "m.moc3", Textures: ["t.png"] } });

describe("importAvatar", () => {
  test("a folder: the shallowest model3.json roots it, only data files come along, the path is `user:`", () => {
    const home = temp(); const src = temp();
    mkdirSync(join(src, "pack", "Model"), { recursive: true });
    writeFileSync(join(src, "pack", "Model", "x.model3.json"), model3);
    writeFileSync(join(src, "pack", "Model", "m.moc3"), "MOC3");
    writeFileSync(join(src, "pack", "Model", "t.png"), "PNG");
    writeFileSync(join(src, "pack", "Model", "run.sh"), "echo no");
    writeFileSync(join(src, "pack", "art.psd"), "PSD");
    const r = importAvatar(home, "alpha", join(src, "pack"));
    expect(r.format).toBe("live2d");
    expect(r.file).toMatch(/^user:m-[0-9a-z]+-[0-9a-f]{12}\/x\.model3\.json$/);
    const names = readdirSync(join(userAvatarsDir(home, "alpha"), r.file.slice(5).split("/")[0]!)).sort();
    expect(names).toEqual(["m.moc3", "t.png", "x.model3.json"]);
  });

  test("a zip whose names are GBK reads back with its CJK names; its PSD stays behind", () => {
    const home = temp(); const src = temp();
    // "大肥鱼" in GBK: B4 F3 B7 CA D3 E3
    const gbk = (tail: string) => Buffer.concat([Buffer.from([0xb4, 0xf3, 0xb7, 0xca, 0xd3, 0xe3]), Buffer.from(tail)]);
    const zip = zipOf([
      { name: gbk(".model3.json"), data: enc(model3) },
      { name: enc("m.moc3"), data: enc("MOC3"), utf8: true },
      { name: enc("t.png"), data: enc("PNG"), utf8: true },
      { name: enc("art.psd"), data: enc("PSD"), utf8: true },
    ]);
    writeFileSync(join(src, "model.zip"), zip);
    const r = importAvatar(home, "alpha", join(src, "model.zip"));
    expect(r.file.endsWith("/大肥鱼.model3.json")).toBe(true);
    expect(r.files).toBe(3);
    expect(userAvatarFile(home, "alpha", r.file.slice(5))).toBeDefined();
  });

  test("a single .vrm is kept as it is, and importing again replaces the earlier model", () => {
    const home = temp(); const src = temp();
    writeFileSync(join(src, "me.vrm"), "VRM");
    const first = importAvatar(home, "alpha", join(src, "me.vrm"));
    expect(first.format).toBe("vrm");
    const second = importAvatar(home, "alpha", join(src, "me.vrm"));
    expect(readdirSync(userAvatarsDir(home, "alpha"))).toEqual([second.file.slice(5).split("/")[0]!]);
  });

  test("refuses what is not a model: no model3.json, an unknown kind, a path that is not there", () => {
    const home = temp(); const src = temp();
    writeFileSync(join(src, "a.png"), "x");
    expect(() => importAvatar(home, "alpha", src)).toThrow(/model3\.json/);
    expect(() => importAvatar(home, "alpha", join(src, "a.png"))).toThrow(/folder or a zip/);
    expect(() => importAvatar(home, "alpha", join(src, "nope"))).toThrow(/nothing at/);
    expect(existsSync(userAvatarsDir(home, "alpha"))).toBe(false);
  });

  test("a zip entry that climbs out of the folder is not copied", () => {
    const home = temp(); const src = temp();
    writeFileSync(join(src, "evil.zip"), zipOf([
      { name: enc("m.model3.json"), data: enc(model3), utf8: true },
      { name: enc("../../escape.png"), data: enc("X"), utf8: true },
    ]));
    const r = importAvatar(home, "alpha", join(src, "evil.zip"));
    expect(r.files).toBe(1);
  });

  test("the served path never names anything outside the bot's own folder", () => {
    const home = temp();
    expect(userAvatarFile(home, "alpha", "m-1/../../x")).toBeUndefined();
    expect(userAvatarFile(home, "alpha", "m-1/.hidden")).toBeUndefined();
    expect(userAvatarFile(home, "alpha", "m-1/ok.png")).toBe(join(userAvatarsDir(home, "alpha"), "m-1", "ok.png"));
  });
});

describe("importAvatar: the door's limits", () => {
  const { installModel } = require("../avatar-import") as typeof import("../avatar-import");
  const caps = { files: 4, fileBytes: 50, totalBytes: 80, zipBytes: 1000 } as const;

  test("the real bytes are counted while writing: items that declare less than they hold stop at the total, and nothing stays", () => {
    const home = temp();
    const liar = (rel: string, n: number) => ({ rel, size: 1, read: () => new Uint8Array(n) });
    expect(() => installModel(home, "alpha", [liar("a.png", 45), liar("b.png", 45)], "a.png", "live2d", caps)).toThrow(/over/);
    expect(() => installModel(home, "alpha", [liar("c.png", 60)], "c.png", "live2d", caps)).toThrow(/over/);
    expect(readdirSync(userAvatarsDir(home, "alpha"))).toEqual([]);
  });

  test("two imports in one millisecond get different folders", () => {
    const home = temp();
    const real = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const item = { rel: "m.model3.json", size: 2, read: () => new Uint8Array(2) };
      const a = installModel(home, "alpha", [item], "m.model3.json", "live2d");
      const b = installModel(home, "alpha", [item], "m.model3.json", "live2d");
      expect(a.file).not.toBe(b.file);
      expect(a.file).toMatch(/^user:m-[0-9a-z]+-[0-9a-f]{12}\//);
    } finally {
      Date.now = real;
    }
  });

  test("a model's own credit note: a top-level readme/license/credit/terms text file, neutralised to 300 characters, never nested ones or other kinds", () => {
    const home = temp(); const src = temp();
    writeFileSync(join(src, "x.model3.json"), model3);
    writeFileSync(join(src, "m.moc3"), "MOC3");
    writeFileSync(join(src, "ReadMe.txt"), "Plain readme");
    writeFileSync(join(src, "License.md"), `Free for personal use,\u202e credit the artist.\n\n${"x".repeat(400)}`);
    mkdirSync(join(src, "docs"));
    writeFileSync(join(src, "docs", "credit.txt"), "nested: ignored");
    const got = importAvatar(home, "alpha", src);
    // License outranks readme; the bidi mark is gone, white space collapsed, 300 characters.
    expect(got.credit?.startsWith("Free for personal use, credit the artist. xxx")).toBe(true);
    expect([...got.credit!].length).toBe(300);
    expect(got.credit).not.toContain("\u202e");
    // The note isn't a served file: nothing of it lands in the model's folder.
    expect(readdirSync(join(userAvatarsDir(home, "alpha"), got.file.slice(5).split("/")[0]!)).sort()).toEqual(["m.moc3", "x.model3.json"]);
    // A GBK note reads back as written; a model with none has no credit; a big one (over 64 KB) is not read.
    const home2 = temp(); const src2 = temp();
    writeFileSync(join(src2, "x.model3.json"), model3);
    writeFileSync(join(src2, "使用条款.txt"), new Uint8Array([0xd5, 0xe2, 0xca, 0xc7, 0xcb, 0xb5, 0xc3, 0xf7]));
    expect(importAvatar(home2, "alpha", src2).credit).toBe("这是说明");
    const home3 = temp(); const src3 = temp();
    writeFileSync(join(src3, "x.model3.json"), model3);
    expect(importAvatar(home3, "alpha", src3).credit).toBeUndefined();
    const home4 = temp(); const src4 = temp();
    writeFileSync(join(src4, "x.model3.json"), model3);
    writeFileSync(join(src4, "readme.txt"), "y".repeat(70_000));
    expect(importAvatar(home4, "alpha", src4).credit).toBeUndefined();
  });

  test("a zip that wraps everything in one folder has that folder as its top level", () => {
    const home = temp(); const src = temp();
    const zip = join(src, "m.zip");
    writeFileSync(zip, zipOf([
      { name: enc("Mochi/x.model3.json"), data: enc(model3), utf8: true },
      { name: enc("Mochi/credits.txt"), data: enc("Rigging by someone"), utf8: true },
    ]));
    expect(importAvatar(home, "alpha", zip).credit).toBe("Rigging by someone");
  });
});

describe("the avatar's credit note in the user layer", () => {
  test("avatarCredit sets or clears the note of the avatar the layer holds, neutralised; with no avatar it changes nothing", async () => {
    const { applyUserLayerPatch, parseUserLayerPatch } = await import("../user-layer");
    const mine = { avatar: { file: "user:m-1/x.model3.json", format: "live2d", credit: "from the model" } };
    const set = applyUserLayerPatch(mine, parseUserLayerPatch({ avatarCredit: "My own‮ note\n here" }));
    expect(set.avatar?.credit).toBe("My own note here");
    const cleared = applyUserLayerPatch(mine, parseUserLayerPatch({ avatarCredit: null }));
    expect(cleared.avatar).toEqual({ file: "user:m-1/x.model3.json", format: "live2d" });
    expect(applyUserLayerPatch({}, parseUserLayerPatch({ avatarCredit: "x" }))).toEqual({});
    // A note that comes with an avatar patch is neutralised and capped too.
    const patched = parseUserLayerPatch({ avatar: { file: "user:m/x.model3.json", format: "live2d", credit: "a​b".repeat(400) } });
    expect([...patched.avatar!.credit!].length).toBeLessThanOrEqual(300);
    expect(() => parseUserLayerPatch({ avatarCredit: 5 })).toThrow();
  });
});

describe("the credit note's own reader", () => {
  test("it asks for at most 64 KB and one byte, never the model files' limit; an entry that gives more is left unread", () => {
    const asked: number[] = [];
    let wholeReads = 0;
    const item = (over: number) => ({
      rel: "readme.txt", size: 100,
      read: () => { wholeReads++; return enc("whole"); },
      readUpTo: (max: number) => { asked.push(max); return over > max ? (() => { throw new RangeError("too big"); })() : enc("small note"); },
    });
    expect(creditNote([item(10)])).toBe("small note");
    expect(creditNote([item(1 << 30)])).toBeUndefined();
    expect(asked).toEqual([64 * 1024 + 1, 64 * 1024 + 1]);
    expect(wholeReads).toBe(0);
  });

  test("a deflated note in a zip reads", () => {
    const src = temp();
    const ok = join(src, "ok.zip");
    writeFileSync(ok, zipOf([
      { name: enc("x.model3.json"), data: enc(model3), utf8: true },
      { name: enc("readme.txt"), data: enc("Deflated note"), utf8: true, deflate: true },
    ]));
    expect(importAvatar(temp(), "alpha", ok).credit).toBe("Deflated note");
  });
});
