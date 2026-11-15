import { describe, expect, test } from "bun:test";
import { SPEECH_FRAMES_MAX, boxOrDefault, cleanAvatarBox, cleanAvatarCue, cleanAvatarReport, cleanSpeechCue, defaultAvatarBox, judgeCue, judgeSpeech, type AvatarReport } from "../src/index";

describe("the avatar cues", () => {
  test("a cue crosses only in one of its shapes, with names checked and a point kept inside the stage", () => {
    expect(cleanAvatarCue({ type: "expression", name: "happy" })).toEqual({ type: "expression", name: "happy" });
    expect(cleanAvatarCue({ type: "outfit", part: "hat", on: true, extra: 1 })).toEqual({ type: "outfit", part: "hat", on: true });
    expect(cleanAvatarCue({ type: "pace", calm: false })).toEqual({ type: "pace", calm: false });
    expect(cleanAvatarCue({ type: "lookAt", point: { x: 5, y: -9 } })).toEqual({ type: "lookAt", point: { x: 1, y: -1 } });
    expect(cleanAvatarCue({ type: "lookAt", point: null })).toEqual({ type: "lookAt", point: null });
    for (const bad of [null, "x", {}, { type: "dance" }, { type: "expression" }, { type: "expression", name: "" }, { type: "expression", name: "a\nb" }, { type: "expression", name: "x".repeat(65) }, { type: "outfit", part: "hat" }, { type: "pace", calm: "yes" }, { type: "lookAt", point: { x: Number.NaN, y: 0 } }, { type: "lookAt" }]) {
      expect(cleanAvatarCue(bad)).toBeUndefined();
    }
  });

  test("a renderer's report keeps only the catalog's capabilities and clean names", () => {
    const r = cleanAvatarReport({ format: "live2d", renderer: "clover/live2d", capabilities: ["expressions", "juggling", "expressions"], names: { expressions: ["a", "a", "", "b"], motions: [], outfits: [{ name: "hat", on: false }, { name: "hat", on: true }, { name: 3 }] } });
    expect(r).toEqual({ format: "live2d", renderer: "clover/live2d", capabilities: ["expressions"], names: { expressions: ["a", "b"], motions: [], outfits: [{ name: "hat", on: false }] } });
    expect(cleanAvatarReport({ format: "", renderer: "x" })).toBeUndefined();
    expect(cleanAvatarReport(null)).toBeUndefined();
  });

  test("a box is whole pixels; one that says only the canvas reads as the default, anchors the renderer gave kept", () => {
    expect(cleanAvatarBox({ canvas: { width: 300.4, height: 500 }, figure: { x: 1.5, y: 2, width: 100, height: 200 }, anchors: { face: { x: 10.2, y: 20 }, tail: { x: 1, y: 1 } } }))
      .toEqual({ canvas: { width: 300, height: 500 }, figure: { x: 2, y: 2, width: 100, height: 200 }, anchors: { face: { x: 10, y: 20 } } });
    expect(cleanAvatarBox({ canvas: { width: 0, height: 5 } })).toBeUndefined();
    expect(cleanAvatarBox({ canvas: { width: Number.NaN, height: 5 } })).toBeUndefined();
    const d = boxOrDefault({ canvas: { width: 400, height: 600 }, anchors: { mouth: { x: 7, y: 8 } } })!;
    expect(d.estimated).toBe(true);
    expect(d.anchors?.mouth).toEqual({ x: 7, y: 8 });
    expect(d.anchors?.headTop).toBeDefined();
    expect(d.figure!.y).toBeLessThan(d.canvas.height / 2);
    expect(boxOrDefault({ canvas: { width: 1, height: 1 }, figure: { x: 0, y: 0, width: 1, height: 1 } })!.estimated).toBeUndefined();
    expect(defaultAvatarBox({ width: 100, height: 100 }).anchors!.face!.x).toBe(50);
  });

  test("a cue a renderer can't play is answered plainly, never dropped", () => {
    const report: AvatarReport = { format: "png", renderer: "luna/pngtuber", capabilities: ["expressions"], names: { expressions: ["happy", "sad"], motions: [], outfits: [] } };
    expect(judgeCue(undefined, { type: "expression", name: "happy" })).toMatchObject({ ok: false, reason: "no-renderer" });
    expect(judgeCue(report, { type: "expression", name: "happy" })).toBeUndefined();
    const outfit = judgeCue(report, { type: "outfit", part: "hat", on: true });
    expect(outfit).toMatchObject({ ok: false, reason: "unsupported" });
    expect((outfit as { message: string }).message).toContain("doesn't do outfits");
    const unknown = judgeCue(report, { type: "expression", name: "angry" });
    expect(unknown).toMatchObject({ ok: false, reason: "unknown-name" });
    expect((unknown as { message: string }).message).toContain("happy, sad");
    expect(judgeCue({ ...report, capabilities: ["lookat"] }, { type: "lookAt", point: null })).toBeUndefined();
  });
});

describe("the speech cue", () => {
  test("it is not a cue a renderer is handed: cleanAvatarCue never reads it", () => {
    expect(cleanAvatarCue({ type: "speech", frames: [{ t: 1, rms: 0.5 }] })).toBeUndefined();
  });

  test("levels cross as whole-millisecond stamps strictly rising, loudness 0 to 1, brightness 0 to 24 kHz and optional; cut only as true", () => {
    expect(cleanSpeechCue({ type: "speech", frames: [{ t: 1000.6, rms: 2, centroid: 99_999, extra: 1 }, { t: 1020, rms: -1 }], x: 1 })).toEqual({ cue: { type: "speech", frames: [{ t: 1001, rms: 1, centroid: 24_000 }, { t: 1020, rms: 0 }] } });
    expect(cleanSpeechCue({ type: "speech", frames: [], cut: true })).toEqual({ cue: { type: "speech", frames: [], cut: true } });
    expect(cleanSpeechCue({ type: "speech", frames: Array.from({ length: SPEECH_FRAMES_MAX }, (_, i) => ({ t: 1 + i, rms: 0 })) })).toHaveProperty("cue");
    for (const bad of [null, "x", {}, { type: "speech" }, { type: "speech", frames: [] }, { type: "speech", frames: [{ t: 5, rms: 0 }, { t: 5, rms: 0 }] }, { type: "speech", frames: [{ t: -1, rms: 0 }] },
      { type: "speech", frames: [{ t: 1, rms: "0" }] }, { type: "speech", frames: [{ t: 1, rms: 0, centroid: Number.NaN }] }, { type: "speech", frames: [null] },
      { type: "speech", frames: [{ t: 1, rms: 0 }], cut: false }, { type: "speech", frames: Array.from({ length: SPEECH_FRAMES_MAX + 1 }, (_, i) => ({ t: 1 + i, rms: 0 })) }]) {
      expect(cleanSpeechCue(bad)).toHaveProperty("why");
    }
  });

  test("a renderer must declare lipsync; with none drawing, the answer says so", () => {
    expect(judgeSpeech(undefined)).toMatchObject({ ok: false, reason: "no-renderer" });
    expect(judgeSpeech({ renderer: "luna/pngtuber", capabilities: ["expressions"] })).toMatchObject({ ok: false, reason: "unsupported" });
    expect(judgeSpeech({ renderer: "luna/pngtuber", capabilities: ["lipsync"] })).toBeUndefined();
  });
});
