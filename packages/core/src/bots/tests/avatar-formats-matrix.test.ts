// The two avatar formats Clover ships (`vrm`, `live2d`), as they behave before the character part reads its formats from
// installed renderers (the character-plugin design's lane 2): one matrix, row by row, so the move to declared formats is
// held to "exactly as today" for both. A row that is meant to change says so where it is.
//
// Rows: the manifest's `avatar.file` rule (`avatarFileProblem`, the bot schema and `avatar.packs`), the install-time
// Cubism check (`validateTree`), and `bot.importAvatar` (what each source becomes, which files come along, the caps, the
// words of each refusal). Temp folders only.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AvatarFormatEntry, avatarFileProblem, BUNDLED_AVATAR_FORMATS, clampAvatarCap, DATA_POINTS, validateTree, type AvatarFormatDecl, type PluginFolderReader } from "@waifucave/clover-plugin-sdk";
import { AVATAR_IMPORT_CAPS, importAvatar } from "../avatar-import";
import { userAvatarsDir } from "../paths";

const roots: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "avatar-matrix-")); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const MiB = 1024 * 1024;

describe("the manifest's avatar file, per format", () => {
  // [format, file, accepted]
  const rows: [string, string, boolean][] = [
    ["vrm", "assets/alpha.vrm", true],
    ["vrm", "assets/ALPHA.VRM", true],
    ["vrm", "assets/alpha.glb", false],
    ["vrm", "assets/alpha.zip", false],
    ["vrm", "assets/alpha/alpha.model3.json", false],
    ["live2d", "assets/alpha/alpha.model3.json", true],
    ["live2d", "assets/alpha/Alpha.Model3.JSON", true],
    ["live2d", "assets/alpha.zip", true],
    ["live2d", "assets/alpha/alpha.json", false],
    ["live2d", "assets/alpha.vrm", false],
    ["live2d", "assets/alpha/alpha.moc3", false],
  ];
  for (const [format, file, ok] of rows) {
    test(`${format}: ${file} is ${ok ? "accepted" : "refused"}`, () => {
      expect(avatarFileProblem(format, file) === undefined).toBe(ok);
    });
  }

  // The words come from each format's declaration now (its entry extensions): VRM's are as they were; Live2D's no
  // longer say "Cubism" or "holding one" (its declared name and extensions say it).
  test("the words of each refusal", () => {
    expect(avatarFileProblem("vrm", "a.glb")).toBe("a `vrm` avatar's file is a `.vrm` file");
    expect(avatarFileProblem("live2d", "a.vrm")).toBe("a `live2d` avatar's file is a `.model3.json` file or a `.zip` file");
  });

  // TODAY: a format the app doesn't draw itself isn't checked at all. Lane 2 changes this row on purpose: a format no
  // installed renderer declares is named in a plain refusal (import) or warning (install).
  test("today: another format's file isn't checked", () => {
    expect(avatarFileProblem("sprite-sheet", "anything.png")).toBeUndefined();
  });

  test("avatar.packs entries are held to the same rule", () => {
    const pack = DATA_POINTS.find((p) => p.name === "avatar.packs")!.entry;
    for (const [format, file, ok] of rows) expect([format, file, pack.safeParse({ id: "p", file, format }).success]).toEqual([format, file, ok]);
  });
});

/** An in-memory plugin folder. */
function folder(files: Record<string, string | object>): PluginFolderReader {
  const text = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const dirs = new Set<string>();
  for (const k of text.keys()) {
    const parts = k.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    readText: (p) => text.get(p),
    exists: (p) => text.has(p) || dirs.has(p),
    listDirs: (p) => [...dirs].filter((d) => d.startsWith(`${p}/`) && !d.slice(p.length + 1).includes("/")).map((d) => d.slice(p.length + 1)),
    insideFolder: () => true,
  };
}

const botWith = (avatar: object, files: Record<string, unknown> = {}) => folder({
  "clover.json": { manifest: 1, id: "luna", name: "Luna", version: "1.0.0", contributes: { bot: { name: "Luna", instructions: "bot/instructions.md", avatar } } },
  "bot/instructions.md": "Be kind.",
  ...(files as Record<string, string | object>),
});

describe("install: what each format's file must hold", () => {
  const model3 = { Version: 3, FileReferences: { Moc: "luna.moc3", Textures: ["tex/t0.png"], Physics: "luna.physics3.json", Expressions: [{ Name: "smile", File: "exp/smile.exp3.json" }], Motions: { Idle: [{ File: "mot/idle.motion3.json", Sound: "voice/hi.wav" }] } } };
  const files = {
    "assets/luna/luna.model3.json": model3, "assets/luna/luna.moc3": "moc", "assets/luna/tex/t0.png": "png", "assets/luna/luna.physics3.json": "{}",
    "assets/luna/exp/smile.exp3.json": "{}", "assets/luna/mot/idle.motion3.json": "{}", "assets/luna/voice/hi.wav": "wav",
  };
  const codes = async (avatar: object, f: Record<string, unknown>) => {
    const r = await validateTree(botWith(avatar, f), { folderName: "luna" });
    return [...r.top.issues, ...r.issues].filter((i) => i.severity === "error").map((i) => `${i.refuses}:${i.code}`);
  };

  test("live2d: a model3.json whose every named file exists inside the folder installs", async () => {
    expect(await codes({ file: "assets/luna/luna.model3.json", format: "live2d" }, files)).toEqual([]);
  });
  test("live2d: each named file is checked (moc, textures, physics, expressions, motions and their sounds)", async () => {
    for (const gone of ["assets/luna/luna.moc3", "assets/luna/tex/t0.png", "assets/luna/luna.physics3.json", "assets/luna/exp/smile.exp3.json", "assets/luna/mot/idle.motion3.json", "assets/luna/voice/hi.wav"]) {
      const less = { ...files } as Record<string, unknown>;
      delete less[gone];
      expect([gone, await codes({ file: "assets/luna/luna.model3.json", format: "live2d" }, less)]).toEqual([gone, ["contribution:file_missing"]]);
    }
  });
  test("live2d: a named file outside the folder, or a JSON that isn't a model3, is refused", async () => {
    expect(await codes({ file: "assets/luna/luna.model3.json", format: "live2d" }, { ...files, "assets/luna/luna.model3.json": { FileReferences: { Moc: "../../x.moc3", Textures: [] } } })).toEqual(["contribution:path_escape"]);
    expect(await codes({ file: "assets/luna/luna.model3.json", format: "live2d" }, { ...files, "assets/luna/luna.model3.json": { Version: 3 } })).toEqual(["contribution:file_format"]);
  });
  test("live2d: a .zip is checked when the core unpacks it, not at install", async () => {
    expect(await codes({ file: "assets/luna.zip", format: "live2d" }, { "assets/luna.zip": "zip" })).toEqual([]);
  });
  test("vrm: the file is only required to exist; its bytes aren't read at install", async () => {
    expect(await codes({ file: "assets/luna.vrm", format: "vrm" }, { "assets/luna.vrm": "not really a vrm" })).toEqual([]);
  });
  test("each format's wrong file is refused on the manifest", async () => {
    expect((await codes({ file: "assets/luna.glb", format: "vrm" }, { "assets/luna.glb": "glb" })).length).toBeGreaterThan(0);
    expect((await codes({ file: "assets/luna.vrm", format: "live2d" }, { "assets/luna.vrm": "vrm" })).length).toBeGreaterThan(0);
  });
});

describe("import (`bot.importAvatar`): what each source becomes", () => {
  const model3 = JSON.stringify({ Version: 3, FileReferences: { Moc: "m.moc3", Textures: ["t.png"] } });
  const kept = (home: string, file: string) => {
    const root = join(userAvatarsDir(home, "alpha"), file.slice("user:".length).split("/")[0]!);
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
        else out.push(`${prefix}${e.name}`);
      }
    };
    walk(root, "");
    return out.sort();
  };

  test("live2d, a folder: rooted at the shallowest .model3.json; JSON, .moc3 and png/webp/jpg/jpeg images come along, nothing else", () => {
    const home = temp(); const src = temp();
    const model = join(src, "pack", "Model");
    mkdirSync(join(model, "motions"), { recursive: true });
    mkdirSync(join(model, "deeper"), { recursive: true });
    for (const [name, data] of [
      ["x.model3.json", model3], ["m.moc3", "MOC3"], ["t.png", "P"], ["u.webp", "W"], ["v.jpg", "J"], ["w.jpeg", "J"],
      ["motions/idle.motion3.json", "{}"], ["deeper/y.model3.json", model3],
      // Left behind: sounds, art sources, scripts, other kinds.
      ["voice.wav", "W"], ["voice.mp3", "M"], ["art.psd", "P"], ["run.sh", "S"], ["x.gif", "G"], ["x.svg", "S"], ["x.avif", "A"],
    ] as const) writeFileSync(join(model, name), data);
    writeFileSync(join(src, "pack", "outside.png"), "P");
    const r = importAvatar(home, "alpha", join(src, "pack"));
    expect({ format: r.format, entry: r.file.split("/").slice(1).join("/") }).toEqual({ format: "live2d", entry: "x.model3.json" });
    expect(kept(home, r.file)).toEqual(["deeper/y.model3.json", "m.moc3", "motions/idle.motion3.json", "t.png", "u.webp", "v.jpg", "w.jpeg", "x.model3.json"]);
    expect(r.files).toBe(8);
  });

  test("vrm: a single .vrm or .glb file is kept as it is, under its own name", () => {
    for (const name of ["me.vrm", "me.glb", "ME.VRM"]) {
      const home = temp(); const src = temp();
      writeFileSync(join(src, name), "BYTES");
      const r = importAvatar(home, "alpha", join(src, name));
      expect([name, r.format, r.file.split("/").slice(1).join("/"), r.files, r.bytes]).toEqual([name, "vrm", name, 1, 5]);
    }
  });

  test("a folder or zip with only a .vrm in it isn't a model (a VRM is imported as its file)", () => {
    const home = temp(); const src = temp();
    writeFileSync(join(src, "me.vrm"), "VRM");
    // The words come from the installed formats now (what each takes).
    expect(() => importAvatar(home, "alpha", src)).toThrow("nothing in there is a model an installed renderer draws: an avatar is a folder or a zip holding a .model3.json, or a .vrm or .glb file");
  });

  test("the words of the other refusals", () => {
    const home = temp(); const src = temp();
    writeFileSync(join(src, "a.fbx"), "x");
    expect(() => importAvatar(home, "alpha", join(src, "a.fbx"))).toThrow("an avatar is a folder or a zip holding a .model3.json, or a .vrm or .glb file");
    expect(() => importAvatar(home, "alpha", join(src, "nope"))).toThrow(`nothing at ${join(src, "nope")}`);
  });

  test("the caps are one set for both formats: 512 files, 128 MiB a file, 192 MiB in all, a zip of 512 MiB", () => {
    expect(AVATAR_IMPORT_CAPS).toEqual({ files: 512, fileBytes: 128 * MiB, totalBytes: 192 * MiB, zipBytes: 512 * MiB });
  });

  test("the credit note is read for both formats' sources (a folder's top level)", () => {
    const home = temp(); const src = temp();
    mkdirSync(join(src, "pack"), { recursive: true });
    writeFileSync(join(src, "pack", "x.model3.json"), model3);
    writeFileSync(join(src, "pack", "m.moc3"), "M");
    writeFileSync(join(src, "pack", "t.png"), "P");
    writeFileSync(join(src, "pack", "license.txt"), "Free to use with credit.");
    expect(importAvatar(home, "alpha", join(src, "pack")).credit).toBe("Free to use with credit.");
    // A single file has no folder of its own: no note.
    writeFileSync(join(src, "me.vrm"), "VRM");
    expect(importAvatar(home, "alpha", join(src, "me.vrm")).credit).toBeUndefined();
  });
});

// ── Declared formats (lane 2): what changes on purpose, and what a third format gets ─────────────────────────────

const declOf = (folder: string) => {
  const m = JSON.parse(readFileSync(join(REPO, "plugins", "clover", "plugins", folder, "clover.json"), "utf8")) as { contributes: Record<string, unknown[]> };
  return AvatarFormatEntry.parse(m.contributes["avatar.formats"]![0]);
};
const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");

describe("the formats Clover ships are their renderers' declarations", () => {
  test("the SDK's fallback (an offline check's) is clover/vrm's and clover/live2d's avatar.formats entries", () => {
    const pick = (d: AvatarFormatDecl) => ({ format: d.format, name: d.name, entry: d.entry, files: d.files, import: d.import });
    expect(BUNDLED_AVATAR_FORMATS.map(pick)).toEqual([pick(declOf("vrm")), pick(declOf("live2d"))]);
  });

  // ON PURPOSE: each kind's own cap (its renderer's declaration, clamped) now holds at import too, under the one
  // 128 MiB a file: a .vrm, .glb or .moc3 keeps today's 128 MiB; a JSON over 8 MiB or an image over 32 MiB is refused.
  test("each kind's declared cap holds at import", () => {
    const kinds = (d: AvatarFormatDecl) => d.files.kinds.map((k) => [k.ext.join(" "), clampAvatarCap(k.type, k.maxBytes) / MiB]);
    expect(kinds(declOf("vrm"))).toEqual([[".vrm .glb", 128]]);
    expect(kinds(declOf("live2d"))).toEqual([[".json", 8], [".moc3", 128], [".png .webp .jpg .jpeg", 32]]);
  });
});

describe("import: a model of a format whose renderer is off is refused, naming the format", () => {
  const vrm = declOf("vrm");
  const live2d = declOf("live2d");
  const model3 = JSON.stringify({ Version: 3, FileReferences: { Moc: "m.moc3", Textures: ["t.png"] } });

  test("a .vrm with only Live2D on, a Live2D folder with only VRM on; nothing is written", () => {
    const home = temp(); const src = temp();
    writeFileSync(join(src, "me.vrm"), "VRM");
    expect(() => importAvatar(home, "alpha", join(src, "me.vrm"), { active: [live2d], known: [vrm, live2d] }))
      .toThrow("that is a VRM model (format `vrm`), and no installed renderer draws VRM models: install one, or turn it on in Plugins");
    mkdirSync(join(src, "pack"));
    for (const [n, d] of [["x.model3.json", model3], ["m.moc3", "M"], ["t.png", "P"]]) writeFileSync(join(src, "pack", n!), d!);
    expect(() => importAvatar(home, "alpha", join(src, "pack"), { active: [vrm], known: [vrm, live2d] }))
      .toThrow("that is a Live2D (Cubism) model (format `live2d`), and no installed renderer draws Live2D (Cubism) models: install one, or turn it on in Plugins");
    expect(existsSync(userAvatarsDir(home, "alpha"))).toBe(false);
  });

  test("a kind no installed format takes: the refusal says what the ones that are on take", () => {
    const home = temp(); const src = temp();
    writeFileSync(join(src, "a.fbx"), "x");
    expect(() => importAvatar(home, "alpha", join(src, "a.fbx"), { active: [live2d], known: [vrm, live2d] })).toThrow("an avatar is a folder or a zip holding a .model3.json");
    expect(() => importAvatar(home, "alpha", join(src, "a.fbx"), { active: [], known: [] })).toThrow("no installed renderer imports a model");
  });
});

describe("a third format, declared by its renderer, imports with no change to the core", () => {
  const sprite = AvatarFormatEntry.parse({
    id: "sprite", format: "sprite", name: "Sprite", entry: { extensions: [".sprite.json"] },
    files: { kinds: [{ ext: [".json"], type: "json", maxBytes: 65536 }, { ext: [".png"], type: "image", maxBytes: 8 }], maxFiles: 4 },
    import: { accepts: ["folder", "zip"] },
  });
  const formats = { active: [sprite], known: [sprite] };

  test("a folder: rooted at its entry file, only its declared kinds come along, the format is its id", () => {
    const home = temp(); const src = temp();
    for (const [n, d] of [["hero.sprite.json", "{}"], ["idle.png", "PNG"], ["talk.png", "PNG"], ["notes.psd", "PSD"], ["x.moc3", "M"]]) writeFileSync(join(src, n!), d!);
    const r = importAvatar(home, "alpha", src, formats);
    expect([r.format, r.file.split("/").slice(1).join("/"), r.files]).toEqual(["sprite", "hero.sprite.json", 3]);
  });

  test("its caps hold: a kind's declared cap, its file count", () => {
    const home = temp(); const src = temp();
    writeFileSync(join(src, "hero.sprite.json"), "{}");
    writeFileSync(join(src, "big.png"), "123456789");
    expect(() => importAvatar(home, "alpha", src, formats)).toThrow("big.png is over 8 bytes");
    const src2 = temp();
    writeFileSync(join(src2, "hero.sprite.json"), "{}");
    for (const n of ["a", "b", "c", "d"]) writeFileSync(join(src2, `${n}.png`), "P");
    expect(() => importAvatar(home, "alpha", src2, formats)).toThrow("that model has 5 files; the most is 4");
  });

  test("a bot's avatar of a format its own tree declares is checked by that declaration at install", async () => {
    const tree = (file: string) => folder({
      "clover.json": { manifest: 1, id: "hero", name: "Hero", version: "1.0.0", contributes: { bot: { name: "Hero", instructions: "bot/instructions.md", avatar: { file, format: "sprite" } }, "avatar.formats": [sprite] } },
      "bot/instructions.md": "Be brave.", [file]: "{}",
    });
    const errors = async (file: string) => (await validateTree(tree(file), { folderName: "hero" })).issues.filter((i) => i.severity === "error").map((i) => i.code);
    expect(await errors("assets/hero.sprite.json")).toEqual([]);
    expect(await errors("assets/hero.png")).toEqual(["file_format"]);
  });
});
