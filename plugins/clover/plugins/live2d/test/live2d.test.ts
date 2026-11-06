import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { join } from "node:path";
import { MemoryFileSource, ModelRuntime, readMoc, type MotionSyncSetting } from "@waifucave/mochi2d/headless";
import { placeholderFiles, placeholderMocData, PLACEHOLDER_PARAMETERS } from "../src/placeholder/model";
import { PLACEHOLDER_DIR } from "../scripts/make-placeholder";
import { insideFolder, LIVE2D_BUDGETS, Live2dRefusal, pngSize, validateLive2d } from "../src/validate";
import { memorySource, readCapped, urlSource, zipDeclared, zipSource } from "../src/sources";
import { inflateCapped, openZip, settingsIn } from "../src/zip";
import { archiveBombCheck, bombCheckProblems } from "../src/bomb";
import { motionSyncValues, mouthPlan, openAndForm } from "../src/mouth";
import { SHUT } from "@waifucave/clover-plugin-vrm/lipsync";

const enc = (s: string) => new TextEncoder().encode(s);
const FILES = placeholderFiles();

interface ZipOptions {
  /** Deflate the entries (method 8) instead of storing them. */
  deflate?: boolean;
  /** One entry's directory claims another inflated size (or CRC, or flags) than the truth. */
  lie?: { name: string; size?: number; crc?: number; flags?: number };
  /** Names as these raw bytes, flagged UTF-8 or not. */
  rawNames?: Record<string, { bytes: Uint8Array; utf8: boolean }>;
}

/** A zip of `files`, stored or deflated, for the archive tests. */
function zip(files: Record<string, Uint8Array>, options: ZipOptions | { name: string; size: number } = {}): Uint8Array {
  const o: ZipOptions = "name" in options ? { lie: options } : options;
  const lie = o.lie;
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const [name, plain] of Object.entries(files)) {
    const n = o.rawNames?.[name]?.bytes ?? enc(name);
    const data = o.deflate ? new Uint8Array(deflateRawSync(plain)) : plain;
    const method = o.deflate ? 8 : 0;
    const flags = (o.rawNames?.[name]?.utf8 ?? true ? 0x800 : 0) | (lie?.name === name ? (lie.flags ?? 0) : 0);
    const local = new Uint8Array(30 + n.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc(plain), true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, plain.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(data, 30 + n.length);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, lie?.name === name && lie.crc !== undefined ? lie.crc : crc(plain), true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, lie?.name === name && lie.size !== undefined ? lie.size : plain.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    central.set(n, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const p of [...locals, ...centrals, end]) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function refusal(promise: Promise<unknown>): Promise<Live2dRefusal> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Live2dRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** The placeholder with some files replaced. */
function withFiles(changes: Record<string, Uint8Array | string | object>): Record<string, Uint8Array> {
  const out = { ...FILES };
  for (const [k, v] of Object.entries(changes)) out[k] = v instanceof Uint8Array ? v : enc(typeof v === "string" ? v : JSON.stringify(v));
  return out;
}

const settings = () => JSON.parse(new TextDecoder().decode(FILES["alpha.model3.json"])) as { FileReferences: Record<string, unknown>; Groups: unknown[] };

describe("Alpha's placeholder (decision 87: a code-made model until open question 26)", () => {
  test("the committed files are what the code makes", () => {
    for (const [name, bytes] of Object.entries(FILES)) expect(Buffer.from(readFileSync(join(PLACEHOLDER_DIR, name))).equals(Buffer.from(bytes))).toBe(true);
  });

  test("passes the avatar check, well inside every budget", async () => {
    const model = await validateLive2d(memorySource(FILES), "alpha.model3.json");
    expect(model.stats).toMatchObject({ files: 3, mocVersion: 3, drawables: 11, parameters: 5, parts: 1, deformers: 0, textures: 1, texturePixels: 64 * 64, motions: 0 });
    expect(model.parameterIds).toEqual(PLACEHOLDER_PARAMETERS.map((p) => p.id));
    expect(readMoc(FILES["alpha.moc3"]!).data.artMeshes.ids).toEqual(placeholderMocData().artMeshes.ids);
  });

  test("Mochi2D runs it: the mouth opens, widens and rounds, the eyes shut, the shoulders breathe", async () => {
    const rt = await ModelRuntime.load(MemoryFileSource.fromFiles(FILES));
    rt.setEffect("eyeBlink", false);
    rt.setEffect("breath", false);
    const ids = rt.model.meshes.ids;
    const bounds = (id: string) => {
      const v = rt.instance.drawableVertices[ids.indexOf(id)]!;
      let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
      for (let i = 0; i < v.length; i += 2) {
        x0 = Math.min(x0, v[i]!);
        x1 = Math.max(x1, v[i]!);
        y0 = Math.min(y0, v[i + 1]!);
        y1 = Math.max(y1, v[i + 1]!);
      }
      return { width: x1 - x0, height: y1 - y0, bottom: y0, top: y1 };
    };
    const at = (values: Record<string, number>) => {
      for (const [id, v] of Object.entries(values)) rt.setParameter(id, v);
      rt.update(0);
    };
    at({ ParamMouthOpenY: 0, ParamMouthForm: 0 });
    // Upright, in model units (y up): the fringe over the eyes, over the mouth, over the shoulders.
    expect(bounds("ArtMeshFringe").bottom).toBeGreaterThan(bounds("ArtMeshEyeL").bottom);
    expect(bounds("ArtMeshEyeL").bottom).toBeGreaterThan(bounds("ArtMeshMouth").top);
    expect(bounds("ArtMeshMouth").bottom).toBeGreaterThan(bounds("ArtMeshBody").top);
    const shut = bounds("ArtMeshMouth");
    at({ ParamMouthOpenY: 1, ParamMouthForm: 0 });
    const open = bounds("ArtMeshMouth");
    expect(open.height).toBeGreaterThan(shut.height * 4);
    at({ ParamMouthOpenY: 1, ParamMouthForm: 1 });
    const wide = bounds("ArtMeshMouth");
    at({ ParamMouthOpenY: 1, ParamMouthForm: -1 });
    const round = bounds("ArtMeshMouth");
    expect(wide.width).toBeGreaterThan(round.width * 1.5);
    expect(round.height).toBeGreaterThan(wide.height);
    at({ ParamEyeLOpen: 1 });
    const eyeOpen = bounds("ArtMeshEyeL").height;
    at({ ParamEyeLOpen: 0 });
    expect(bounds("ArtMeshEyeL").height).toBeLessThan(eyeOpen / 5);
    at({ ParamBreath: 0 });
    const still = bounds("ArtMeshBody").top;
    at({ ParamBreath: 1 });
    expect(bounds("ArtMeshBody").top).toBeGreaterThan(still);
  });
});

describe("the avatar check (the VRM renderer's caps, for Live2D)", () => {
  test("references stay inside the model's folder", () => {
    expect(insideFolder("model/alpha.model3.json", "alpha.moc3")).toBe("model/alpha.moc3");
    expect(insideFolder("model/alpha.model3.json", "textures/../alpha.png")).toBe("model/alpha.png");
    expect(insideFolder("model/alpha.model3.json", "../secret.png")).toBe("secret.png");
    expect(insideFolder("alpha.model3.json", "../secret.png")).toBeNull();
    expect(insideFolder("alpha.model3.json", "/etc/passwd")).toBeNull();
    expect(insideFolder("alpha.model3.json", "https://example.com/a.png")).toBeNull();
    expect(insideFolder("alpha.model3.json", "C:\\a.png")).toBeNull();
    expect(insideFolder("alpha.model3.json", "a\0.png")).toBeNull();
  });

  test("refuses a reference out of the folder, a missing file, a damaged .moc3, a texture that isn't a PNG", async () => {
    const out = settings();
    out.FileReferences.Moc = "../alpha.moc3";
    expect((await refusal(validateLive2d(memorySource(withFiles({ "alpha.model3.json": out })), "alpha.model3.json"))).code).toBe("outside-folder");
    const missing = { ...FILES };
    delete missing["alpha.png"];
    expect((await refusal(validateLive2d(memorySource(missing), "alpha.model3.json"))).code).toBe("missing");
    expect((await refusal(validateLive2d(memorySource(withFiles({ "alpha.moc3": new Uint8Array(256) })), "alpha.model3.json"))).code).toBe("moc");
    expect((await refusal(validateLive2d(memorySource(withFiles({ "alpha.png": enc("not a png") })), "alpha.model3.json"))).code).toBe("texture");
    expect((await refusal(validateLive2d(memorySource(withFiles({ "alpha.model3.json": "{" })), "alpha.model3.json"))).code).toBe("settings");
  });

  test("a texture's size is read from its header, and one over 4096 a side is refused before it decodes", async () => {
    expect(pngSize(FILES["alpha.png"]!)).toEqual({ width: 64, height: 64 });
    const huge = new Uint8Array(FILES["alpha.png"]!);
    new DataView(huge.buffer).setUint32(16, 8192);
    const r = await refusal(validateLive2d(memorySource(withFiles({ "alpha.png": huge })), "alpha.model3.json"));
    expect(r.code).toBe("texture");
    expect(r.detail).toContain("8192×64");
  });

  test("holds the model to its budgets: bytes, drawables, motions and physics", async () => {
    expect((await refusal(validateLive2d(memorySource(FILES), "alpha.model3.json", { ...LIVE2D_BUDGETS, totalBytes: 4000 }))).code).toBe("too-large");
    expect((await refusal(validateLive2d(memorySource(FILES), "alpha.model3.json", { ...LIVE2D_BUDGETS, drawables: 10 }))).detail).toBe("11 drawables, over 10");
    const s = settings();
    s.FileReferences.Physics = "alpha.physics3.json";
    const physics = { Version: 3, Meta: { PhysicsSettingCount: 1, VertexCount: 9000 }, PhysicsSettings: [{ Vertices: [] }] };
    const r = await refusal(validateLive2d(memorySource(withFiles({ "alpha.model3.json": s, "alpha.physics3.json": physics })), "alpha.model3.json"));
    expect(r.detail).toBe("9000 physics particles, over 4096");
    const m = settings();
    m.FileReferences.Motions = { Idle: [{ File: "idle.motion3.json" }] };
    const motion = { Version: 3, Meta: { Duration: 1, CurveCount: 5000, TotalPointCount: 10 }, Curves: [] };
    expect((await refusal(validateLive2d(memorySource(withFiles({ "alpha.model3.json": m, "idle.motion3.json": motion })), "alpha.model3.json"))).detail).toBe("5000 motion curves, over 4000");
  });

  test("a motion's own Meta never wins: the larger of the points it declares and the values it holds", async () => {
    const s = settings();
    s.FileReferences.Motions = { Idle: [{ File: "liar.motion3.json" }, { File: "liar.motion3.json" }] };
    const liar = { Version: 3, Meta: { Duration: 1, CurveCount: 1, TotalPointCount: 1 }, Curves: [{ Target: "Parameter", Id: "ParamMouthOpenY", Segments: new Array(40).fill(0) }] };
    const r = await refusal(validateLive2d(memorySource(withFiles({ "alpha.model3.json": s, "liar.motion3.json": liar })), "alpha.model3.json", { ...LIVE2D_BUDGETS, motionPoints: 50 }));
    expect(r.detail).toBe("80 motion points, over 50");
  });

  test("a motion's sound is dropped and never read: the avatar plays no audio of its own", async () => {
    const s = settings();
    s.FileReferences.Motions = { Idle: [{ File: "idle.motion3.json", Sound: "hello.wav" }] };
    const motion = { Version: 3, Meta: { Duration: 1, Fps: 30, Loop: true, CurveCount: 0, TotalSegmentCount: 0, TotalPointCount: 0 }, Curves: [] };
    const reads: string[] = [];
    const inner = memorySource(withFiles({ "alpha.model3.json": s, "idle.motion3.json": motion, "hello.wav": new Uint8Array(10) }));
    const model = await validateLive2d({ read: (p, cap) => (reads.push(p), inner.read(p, cap)) }, "alpha.model3.json");
    expect(reads).not.toContain("hello.wav");
    expect(model.files.has("hello.wav")).toBe(false);
    expect(new TextDecoder().decode(model.files.get("alpha.model3.json"))).not.toContain("hello.wav");
    expect(model.settings.motions[0]!.entries[0]!.sound).toBeUndefined();
  });

  test("an archive: read through Mochi2D, refused before inflating when its directory declares too much", async () => {
    const archive = zip(Object.fromEntries(Object.entries(FILES).map(([k, v]) => [`alpha/${k}`, v])));
    expect(zipDeclared(archive)).toEqual({ entries: 3, inflated: Object.values(FILES).reduce((s, f) => s + f.length, 0), largest: FILES["alpha.moc3"]!.length });
    const { source, settingsPath } = zipSource(archive);
    expect(settingsPath).toBe("alpha/alpha.model3.json");
    expect((await validateLive2d(source, settingsPath)).stats.drawables).toBe(11);
    const bomb = zip(FILES, { name: "alpha.moc3", size: 0x7fffffff });
    expect(() => zipSource(bomb)).toThrow(Live2dRefusal);
    expect(() => zipSource(enc("not a zip"))).toThrow(Live2dRefusal);
  });

  test("Clover extracts the archive itself (R5): a deflated model loads, and a cap counts the real inflated bytes", async () => {
    const archive = zip(FILES, { deflate: true });
    const { source, settingsPath } = zipSource(archive);
    expect(settingsPath).toBe("alpha.model3.json");
    expect((await validateLive2d(source, settingsPath)).stats.drawables).toBe(11);
    // An entry that says it is small but inflates to 4 MiB: cut off at the cap, whatever it declared.
    const big = new Uint8Array(4 * 1024 * 1024);
    const liar = openZip(zip({ "big.bin": big }, { deflate: true, lie: { name: "big.bin", size: 100 } }));
    expect(liar.declared).toEqual([100]);
    const r = await refusal(liar.read("big.bin", 64 * 1024));
    expect(r.code).toBe("too-large");
    expect(r.detail).toBe("big.bin inflates past 65536 bytes");
    // Under the cap, all of it; a capped stream never holds more than the cap.
    expect((await liar.read("big.bin", big.length)).length).toBe(big.length);
    expect((await refusal(inflateCapped(new Uint8Array(deflateRawSync(big)), 1000, "x"))).code).toBe("too-large");
  });

  test("an archive bomb is cut off a slice or two in: the compressed data goes in 1 KiB at a time (the review's blocker)", async () => {
    const check = await archiveBombCheck();
    expect(bombCheckProblems(check)).toEqual([]);
    expect(check.compressed).toBeGreaterThan(16 * 1024);
    expect(check.writtenBeforeRefusal).toBeLessThanOrEqual(8 * 1024);
  });

  test("an archive entry that fails its checksum, is encrypted, or uses another compression is refused", async () => {
    expect((await refusal(openZip(zip(FILES, { lie: { name: "alpha.png", crc: 1 } })).read("alpha.png", 1e6))).code).toBe("archive");
    expect((await refusal(openZip(zip(FILES, { lie: { name: "alpha.png", flags: 1 } })).read("alpha.png", 1e6))).detail).toBe("alpha.png is encrypted");
    expect((await refusal(openZip(zip(FILES)).read("nothing.png", 1e6))).code).toBe("missing");
    expect((await refusal(inflateCapped(enc("not deflate data at all"), 1000, "x"))).code).toBe("archive");
  });

  test("names as the archive's tool wrote them: UTF-8, or a local code page such as Shift_JIS", () => {
    // 「アルファ」 in Shift_JIS, unflagged, as Japanese tools often write it.
    const sjis = new Uint8Array([0x83, 0x41, 0x83, 0x8b, 0x83, 0x74, 0x83, 0x40]);
    const names = openZip(zip({ a: FILES["alpha.png"]!, b: FILES["alpha.png"]! }, { rawNames: { a: { bytes: new Uint8Array([...sjis, ...enc("/alpha.png")]), utf8: false }, b: { bytes: enc("b.png"), utf8: false } } })).names;
    expect(names).toEqual(["アルファ/alpha.png", "b.png"]);
    expect(settingsIn(["deep/x/a.model3.json", "top.model3.json", "b.moc3"])).toBe("top.model3.json");
    expect(settingsIn(["a.moc3"])).toBeNull();
  });

  test("over the network: a Content-Length over the cap is refused unread; a body that runs past it is cut off", async () => {
    const declared = new Response(new Uint8Array(10), { headers: { "content-length": "999999" } });
    expect((await refusal(readCapped(declared, 1000, "x"))).code).toBe("too-large");
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(600));
      },
    });
    expect((await refusal(readCapped(new Response(stream), 1000, "x"))).code).toBe("too-large");
    expect((await refusal(readCapped(new Response("", { status: 404 }), 1000, "x"))).code).toBe("missing");
    const asked: string[] = [];
    const { source, settingsPath } = urlSource("https://plugins.test/alpha/assets/live2d/alpha.model3.json", async (url) => {
      asked.push(url);
      const name = decodeURIComponent(url.split("/").pop()!);
      return FILES[name] ? new Response(FILES[name] as Uint8Array<ArrayBuffer>) : new Response("", { status: 404 });
    });
    const model = await validateLive2d(source, settingsPath);
    expect(model.stats.files).toBe(3);
    expect(asked).toEqual(["https://plugins.test/alpha/assets/live2d/alpha.model3.json", "https://plugins.test/alpha/assets/live2d/alpha.moc3", "https://plugins.test/alpha/assets/live2d/alpha.png"]);
  });
});

describe("the mouth, from the speech feed's weights", () => {
  test("open by the weights' sum; wide for the bright vowels, round for the dark", () => {
    expect(openAndForm(SHUT)).toEqual({ open: 0, form: 0 });
    expect(openAndForm({ ...SHUT, aa: 0.6 })).toEqual({ open: 0.6, form: 0 });
    expect(openAndForm({ ...SHUT, ee: 0.3, ih: 0.2 })).toEqual({ open: 0.5, form: 1 });
    expect(openAndForm({ ...SHUT, oh: 0.3, ou: 0.1 }).form).toBe(-1);
  });

  test("a model with motion-sync settings: its own shapes, blended; silence takes what the vowels leave", () => {
    const setting = {
      parameters: [
        { id: "ParamA", name: "A", min: 0, max: 1, damper: 0, smooth: 0 },
        { id: "ParamWide", name: "W", min: -1, max: 1, damper: 0, smooth: 0 },
      ],
      elements: ["Silence", "A", "I", "U", "E", "O"].map((id) => ({ id, name: id, min: 0, max: 1, scale: 1, enabled: true, known: true })),
      shapes: [
        [0, 0],
        [1, 0],
        [0.3, 1],
        [0.2, -1],
        [0.5, 0.8],
        [0.6, -0.6],
      ],
    } as unknown as MotionSyncSetting;
    expect([...motionSyncValues(setting, SHUT)]).toEqual([
      ["ParamA", 0],
      ["ParamWide", 0],
    ]);
    const half = motionSyncValues(setting, { ...SHUT, aa: 0.5 });
    expect(half.get("ParamA")).toBeCloseTo(0.5);
    const e = motionSyncValues(setting, { ...SHUT, ee: 1 });
    expect(e.get("ParamWide")).toBeCloseTo(0.8);
    const plan = mouthPlan(["ParamA", "ParamWide", "ParamMouthOpenY"], [], setting);
    expect(plan.parameters).toEqual(["ParamA", "ParamWide"]);
  });

  test("without them: the settings' LipSync parameters, else ParamMouthOpenY, and ParamMouthForm where it exists", () => {
    const placeholder = mouthPlan(PLACEHOLDER_PARAMETERS.map((p) => p.id), ["ParamMouthOpenY"], null);
    expect(placeholder.parameters).toEqual(["ParamMouthOpenY", "ParamMouthForm"]);
    expect([...placeholder.values({ ...SHUT, ee: 0.4 })]).toEqual([
      ["ParamMouthOpenY", 0.4],
      ["ParamMouthForm", 1],
    ]);
    expect(mouthPlan(["ParamMouthOpenY"], [], null).parameters).toEqual(["ParamMouthOpenY"]);
    expect(mouthPlan(["ParamJaw", "ParamMouthOpenY"], ["ParamJaw"], null).parameters).toEqual(["ParamJaw"]);
    // A motion-sync setting naming a parameter the model lacks is not used.
    const broken = { parameters: [{ id: "ParamGone", min: 0, max: 1 }], elements: [], shapes: [] } as unknown as MotionSyncSetting;
    expect(mouthPlan(["ParamMouthOpenY"], [], broken).parameters).toEqual(["ParamMouthOpenY"]);
  });
});
