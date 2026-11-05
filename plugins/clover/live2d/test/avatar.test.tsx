import { describe, expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PushedSpeech } from "@waifucave/clover-plugin-vrm/lipsync";
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
function fakeView() {
  const log: string[] = [];
  const params = new Map<string, number>();
  const effects = new Map<string, boolean>();
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
        };
      },
      advance: (s) => void log.push(`advance ${s.toFixed(3)}`),
      resize: () => {},
      dispose: () => void log.push("dispose"),
    };
    return view;
  };
  return { create, log, params, effects, options: () => options, loaded: () => loaded };
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
    expect(v.effects.get("look")).toBe(false);
    expect(v.effects.get("breath")).toBe(true);
    // The first picture, mouth shut.
    expect(v.params.get("ParamMouthOpenY")).toBe(0);
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
    // Quiet: 30 a second.
    const before = draws();
    for (let i = 0; i < 60; i++) f.step(1000 / 60);
    expect(draws() - before).toBeGreaterThanOrEqual(29);
    expect(draws() - before).toBeLessThanOrEqual(31);
    // A bright, loud vowel for the next second.
    clock.t = 10;
    feed.push(Array.from({ length: 200 }, (_, i) => ({ t: 10 + i * 0.005, rms: 0.3, centroid: 3000 })));
    const speaking = draws();
    for (let i = 0; i < 30; i++) {
      clock.t += 1 / 60;
      f.step(1000 / 60);
    }
    expect(draws() - speaking).toBeGreaterThanOrEqual(28);
    expect(v.params.get("ParamMouthOpenY")!).toBeGreaterThan(0.5);
    // Bright: wide, less the rounding `ou` always carries.
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
    expect(v.params.get("ParamMouthOpenY")).toBeCloseTo(0.7);
    expect(v.effects.get("eyeBlink")).toBe(false);
    expect(v.effects.get("breath")).toBe(false);
    view.unmount();
    expect(v.log.at(-1)).toBe("dispose");
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
    for (const call of ["startLiveLipSync", "startMotionSync", "setMotionSyncInput", ".speak(", "getUserMedia", "AudioContext"]) expect(sources).not.toContain(call);
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
