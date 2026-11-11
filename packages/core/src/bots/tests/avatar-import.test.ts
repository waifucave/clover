// `bot.importAvatar`'s core: a user's own model, folder or zip, lands in the fenced avatars folder under a `user:` path;
// nothing outside a model's own data files comes along, and names written in GBK read back as they were written.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAvatar, userAvatarFile } from "../avatar-import";
import { userAvatarsDir } from "../paths";

const roots: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "avatar-import-")); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** A stored (uncompressed) zip with raw entry names, and the UTF-8 flag off: what an old Windows tool writes. */
function zipOf(entries: { name: Uint8Array; data: Uint8Array; utf8?: boolean }[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const crc = Bun.hash.crc32(e.data) >>> 0;
    const lh = new Uint8Array(30 + e.name.length);
    const v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, e.utf8 ? 0x800 : 0, true); v.setUint16(8, 0, true);
    v.setUint32(14, crc, true); v.setUint32(18, e.data.length, true); v.setUint32(22, e.data.length, true); v.setUint16(26, e.name.length, true);
    lh.set(e.name, 30);
    const ch = new Uint8Array(46 + e.name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, e.utf8 ? 0x800 : 0, true); c.setUint16(10, 0, true);
    c.setUint32(16, crc, true); c.setUint32(20, e.data.length, true); c.setUint32(24, e.data.length, true); c.setUint16(28, e.name.length, true); c.setUint32(42, offset, true);
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
    expect(r.file).toMatch(/^user:m-[0-9a-z]+\/x\.model3\.json$/);
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
