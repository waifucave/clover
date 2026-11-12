import { describe, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PushedSpeech } from "@waifucave/clover-plugin-vrm/lipsync";
import type { FigureBox, FigureCue, FigureNames } from "@waifucave/clover-plugin-vrm/control";
import { placeholderFiles } from "../src/placeholder/model";
import { Live2dAvatar, VIEW_OPTIONS, type AvatarFrames, type Live2dView, type ViewFactory } from "../src/ui/Live2dAvatar";
import { Live2dAvatarEntry } from "../src/ui/entry";
import manifest from "../clover.json" with { type: "json" };
import * as client from "../client/index";

const FILES = placeholderFiles();
const URL_BASE = "https://plugins.test/alpha/assets/live2d/";
const serve = async (url: string) => {
  const name = decodeURIComponent(url.slice(URL_BASE.length));
  return FILES[name] ? new Response(FILES[name] as Uint8Array<ArrayBuffer>) : new Response("", { status: 404 });
};

/** Mochi2D's view with no WebGL: what the avatar asks of it, recorded. */
function fakeView(hasLipSync = true) {
  const log: string[] = [];
  const params = new Map<string, number>();
  const effects = new Map<string, boolean>();
  type Mix = "add" | "replace" | "max" | ((live: number, current: number, id: string) => number);
  const live: { source: { next(dt: number): number } | null; mix?: Mix } = { source: null };
  let options: unknown;
  let loaded: string[] = [];
  const create: ViewFactory = (_canvas, o) => {
    options = o;
    const view: Live2dView = {
      load: async (input, opts) => {
        loaded = Object.keys(input.files);
        log.push(`load ${opts?.settings}`);
        return {
          setParameter: (id, v) => (params.set(id, v), true),
          setEffect: (name, on) => void effects.set(name, on),
          runtime: {
            setLiveLipSync: (source, mix) => {
              if (!hasLipSync) return false;
              live.source = source;
              live.mix = mix;
              return true;
            },
          },
        };
      },
      advance: (s) => void log.push(`advance ${s.toFixed(3)}`),
      figureRect: () => ({ left: 10, top: 20, right: 110, bottom: 220 }),
      resize: () => {},
      dispose: () => void log.push("dispose"),
    };
    return view;
  };
  /** What Mochi2D would write to a lip-sync parameter this frame, whatever a motion left in it. */
  const lipSync = (id: string, fromMotion = 0.9) => {
    const value = live.source?.next(1 / 60) ?? 0;
    return typeof live.mix === "function" ? live.mix(value, fromMotion, id) : value;
  };
  return { create, log, params, effects, live, lipSync, options: () => options, loaded: () => loaded };
}

function manualFrames() {
  let t = 0;
  let next: ((time: number) => void) | null = null;
  const frames: AvatarFrames = {
    now: () => t,
    requestFrame: (cb) => ((next = cb), 1),
    cancelFrame: () => void (next = null),
  };
  return {
    frames,
    step(ms: number) {
      t += ms;
      const cb = next;
      next = null;
      cb?.(t);
    },
    get waiting() {
      return next !== null;
    },
  };
}

const settle = () => act(async () => {});

describe("Live2dAvatar with the app's avatar control", () => {
  function control() {
    const listeners = new Set<(c: FigureCue) => void>();
    const names: (FigureNames | undefined)[] = [];
    const boxes: (FigureBox | undefined)[] = [];
    return {
      listeners, names, boxes,
      c: { onCue: (l: (c: FigureCue) => void) => { listeners.add(l); return () => listeners.delete(l); }, setCatalogue: (n: FigureNames | undefined) => void names.push(n), setBox: (b: FigureBox | undefined) => void boxes.push(b) },
    };
  }

  test("it publishes the model's names and the figure's box once shown, plays a cue, and takes both back when it goes", async () => {
    const v = fakeView();
    const k = control();
    const { unmount } = render(<Live2dAvatar src={`${URL_BASE}alpha.model3.json`} name="Alpha" fetcher={serve} createView={v.create} frames={manualFrames().frames} control={k.c} />);
    await settle();
    expect(k.names.at(-1)).toMatchObject({ expressions: expect.any(Array), motions: expect.any(Array), outfits: expect.any(Array) });
    expect(k.listeners.size).toBe(1);
    // The model's rectangle, in the figure's own pixels (the element sits at 0, 0 here), with portrait anchors from it.
    expect(k.boxes.at(-1)).toMatchObject({ figure: { x: 10, y: 20, width: 100, height: 200 }, anchors: { headTop: { x: 60, y: 20 }, face: { x: 60, y: 60 } } });
    k.listeners.forEach((l) => l({ type: "lookAt", point: { x: 0, y: 0 } }));
    unmount();
    expect(k.listeners.size).toBe(0);
    expect(k.names.at(-1)).toBeUndefined();
    expect(k.boxes.at(-1)).toBeUndefined();
  });

  test("it frames the figure by the stage's crop (its CSS variables) and by nothing when the stage asks for none", async () => {
    const asked: (unknown)[] = [];
    const v = fakeView();
    const create: ViewFactory = (c, o) => { const view = v.create(c, o); view.frame = (crop) => { asked.push(crop); return true; }; return view; };
    const sheet = document.createElement("style");
    sheet.textContent = ".clvl-avatar { --clover-avatar-crop: 0.56; --clover-avatar-headroom: 0.12; }";
    document.head.append(sheet);
    const { unmount } = render(<Live2dAvatar src={`${URL_BASE}alpha.model3.json`} name="Alpha" fetcher={serve} createView={create} frames={manualFrames().frames} />);
    await settle();
    expect(asked.at(-1)).toEqual({ show: 0.56, headroom: 0.12 });
    // A framing that moved is drawn again, once.
    expect(v.log.filter((l) => l === "advance 0.000").length).toBeGreaterThan(1);
    unmount();
    sheet.remove();
    asked.length = 0;
    render(<Live2dAvatar src={`${URL_BASE}alpha.model3.json`} name="Alpha" fetcher={serve} createView={create} frames={manualFrames().frames} />);
    await settle();
    expect(asked.at(-1)).toBeNull();
  });

  test("with no control it just lives: nothing is published", async () => {
    const v = fakeView();
    render(<Live2dAvatar src={`${URL_BASE}alpha.model3.json`} name="Alpha" fetcher={serve} createView={v.create} frames={manualFrames().frames} />);
    await settle();
    expect(v.log).toContain("advance 0.000");
  });
});

describe("Live2dAvatar", () => {
  test("checks the model, then shows only its checked files, with the caps' options: no pointer, no own loop, a texture budget", async () => {
    const v = fakeView();
    render(<Live2dAvatar src={`${URL_BASE}alpha.model3.json`} name="Alpha" fetcher={serve} createView={v.create} frames={manualFrames().frames} />);
    expect(screen.getByRole("status").textContent).toBe("Getting Alpha ready…");
    await settle();
    expect(v.log[0]).toBe("load alpha.model3.json");
    expect(v.loaded().sort()).toEqual(["alpha.moc3", "alpha.model3.json", "alpha.png"]);
    expect(v.options()).toEqual(VIEW_OPTIONS);
    expect(VIEW_OPTIONS).toMatchObject({ autoStart: false, look: "off", zoom: false, pan: false, textureBudget: 256, background: "transparent" });
    expect(v.effects.get("look")).toBe(true); // the view follows no pointer (look: "off"); she looks only where the stage aims her
    expect(v.effects.get("breath")).toBe(true);
    // The first picture, mouth shut, whatever a motion would open it to: the mouth goes through the live input.
    expect(v.live.source).not.toBeNull();
    expect(v.lipSync("ParamMouthOpenY", 0.9)).toBe(0);
    expect(v.params.has("ParamMouthOpenY")).toBe(false);
    expect(v.log).toContain("advance 0.000");
  });

  test("a refused model never reaches Mochi2D, and says why", async () => {
    const v = fakeView();
    const errors: string[] = [];
    const broken = async (url: string) => (url.endsWith(".png") ? new Response("not a png") : serve(url));
    render(<Live2dAvatar src={`${URL_BASE}alpha.model3.json`} name="Alpha" fetcher={broken} createView={v.create} onError={(m, d) => errors.push(`${m} | ${d}`)} />);
    await settle();
    expect(v.log).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("Alpha's avatar can't be shown");
    expect(errors).toEqual(["The avatar's textures can't be drawn here. | texture 0 is not a PNG"]);
  });

  test("the mouth follows the speech feed, at most 60 frames a second while it speaks and 30 at rest", async () => {
    const v = fakeView();
    const clock = { t: 0 };
    const feed = new PushedSpeech(() => clock.t);
    const f = manualFrames();
    render(<Live2dAvatar src={`${URL_BASE}alpha.model3.json`} name="Alpha" fetcher={serve} createView={v.create} frames={f.frames} speech={feed} />);
    await settle();
    const draws = () => v.log.filter((l) => l.startsWith("advance")).length;
    // Quiet: 20 a second while someone is about.
    const before = draws();
    for (let i = 0; i < 60; i++) f.step(1000 / 60);
    expect(draws() - before).toBeGreaterThanOrEqual(19);
    expect(draws() - before).toBeLessThanOrEqual(21);
    // A bright, loud vowel for the next second.
    clock.t = 10;
    feed.push(Array.from({ length: 200 }, (_, i) => ({ t: 10 + i * 0.005, rms: 0.3, centroid: 3000 })));
    const speaking = draws();
    for (let i = 0; i < 30; i++) {
      clock.t += 1 / 60;
      f.step(1000 / 60);
    }
    expect(draws() - speaking).toBeGreaterThanOrEqual(28);
    expect(v.lipSync("ParamMouthOpenY", 0)).toBeGreaterThan(0.5);
    // Bright: wide, less the rounding `ou` always carries.
    expect(v.params.get("ParamMouthForm")!).toBeGreaterThan(0.7);
  });

  test("a model Mochi2D gives no lip sync (no LipSync group) still moves its mouth, through setParameter", async () => {
    const v = fakeView(false);
    const clock = { t: 0 };
    const feed = new PushedSpeech(() => clock.t);
    const f = manualFrames();
    render(<Live2dAvatar src={`${URL_BASE}alpha.model3.json`} name="Alpha" fetcher={serve} createView={v.create} frames={f.frames} speech={feed} />);
    await settle();
    clock.t = 10;
    feed.push(Array.from({ length: 200 }, (_, i) => ({ t: 10 + i * 0.005, rms: 0.3, centroid: 3000 })));
    for (let i = 0; i < 30; i++) {
      clock.t += 1 / 60;
      f.step(1000 / 60);
    }
    expect(v.live.source).toBeNull();
    expect(v.params.get("ParamMouthOpenY")!).toBeGreaterThan(0.5);
    expect(v.params.get("ParamMouthForm")!).toBeGreaterThan(0.7);
  });

  test("paused, it draws nothing; a still sets its face and draws once", async () => {
    const v = fakeView();
    const f = manualFrames();
    const view = render(<Live2dAvatar src={`${URL_BASE}alpha.model3.json`} name="Alpha" fetcher={serve} createView={v.create} frames={f.frames} paused />);
    await settle();
    expect(f.waiting).toBe(false);
    view.rerender(<Live2dAvatar src={`${URL_BASE}alpha.model3.json`} name="Alpha" fetcher={serve} createView={v.create} frames={f.frames} still={{ visemes: { aa: 0.7 }, blink: 1 }} />);
    await settle();
    expect(v.params.get("ParamEyeLOpen")).toBe(0);
    expect(v.lipSync("ParamMouthOpenY")).toBeCloseTo(0.7);
    expect(v.effects.get("eyeBlink")).toBe(false);
    expect(v.effects.get("breath")).toBe(false);
    view.unmount();
    expect(v.log.at(-1)).toBe("dispose");
    expect(v.live.source).toBeNull();
  });

  test("with reduced motion it neither breathes nor idles", async () => {
    const v = fakeView();
    render(<Live2dAvatar src={`${URL_BASE}alpha.model3.json`} name="Alpha" fetcher={serve} createView={v.create} frames={manualFrames().frames} reducedMotion />);
    await settle();
    expect(v.effects.get("breath")).toBe(false);
    expect(v.effects.get("idle")).toBe(false);
    expect(v.effects.get("eyeBlink")).toBe(true);
  });
});

describe("no microphone, no sound of its own", () => {
  test("nothing in the renderer starts Mochi2D's live lip sync, its motion sync from audio, or speech playback", () => {
    const dir = join(import.meta.dir, "..", "src");
    const sources = readdirSync(dir, { recursive: true })
      .filter((f) => /\.(ts|tsx)$/.test(String(f)))
      .map((f) => readFileSync(join(dir, String(f)), "utf8"))
      .join("\n");
    for (const call of ["startLiveLipSync", "startMotionSync", "setMotionSyncInput", "recordAudio", "playMotionSound", ".speak(", "getUserMedia", "AudioContext"]) expect(sources).not.toContain(call);
  });

  test("Mochi2D never opens an archive: Clover extracts it with its own caps (R5)", () => {
    const dir = join(import.meta.dir, "..", "src");
    const sources = readdirSync(dir, { recursive: true })
      .filter((f) => /\.(ts|tsx)$/.test(String(f)))
      .map((f) => readFileSync(join(dir, String(f)), "utf8"))
      .join("\n");
    for (const name of ["sourceFromZip", "ZipFileSource"]) expect(sources).not.toContain(name);
  });
});

describe("the entry the manifest names", () => {
  test("is an export of the client entry, keyed live2d in the avatar spot", async () => {
    expect(manifest.contributes.ui).toEqual([{ spot: "avatar", id: "live2d", key: "live2d", component: "Live2dAvatarEntry" }]);
    expect(typeof (client as Record<string, unknown>).Live2dAvatarEntry).toBe("function");
  });

  test("takes the spot's props: the bot's name and its file", () => {
    render(<Live2dAvatarEntry props={{ bot: { id: "alpha", name: "Alpha" }, file: "https://plugins.test/none.model3.json", format: "live2d", speaking: false }} />);
    expect(screen.getByRole("status").textContent).toBe("Getting Alpha ready…");
  });
});

describe("Live2dAvatar pace", () => {
  test("the rest rates: 20 a second about, 6 once no one has touched the document for a while", async () => {
    const { AVATAR_FPS, CALM_AFTER_MS } = await import("../src/ui/Live2dAvatar");
    expect(AVATAR_FPS.quiet).toBeLessThanOrEqual(20);
    expect(AVATAR_FPS.calm).toBeLessThanOrEqual(2);
    expect(CALM_AFTER_MS).toBeGreaterThanOrEqual(5000);
  });
});
