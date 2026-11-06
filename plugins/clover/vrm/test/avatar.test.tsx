import { describe, expect, mock, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VrmAvatar, creditLine, fetchCapped, type AvatarFrames } from "../src/ui/VrmAvatar";
import { AvatarError } from "../src/vrm/scene";
import type { AvatarRenderer } from "../src/vrm/scene";
import type { VrmMeta } from "../src/vrm/validate";
import { PushedSpeech, speechFrames } from "../src/lipsync/sources";
import { vowel } from "../src/lipsync/synth";
import type { Mesh } from "three";

const file = readFileSync(join(import.meta.dir, "..", "..", "..", "alpha", "assets", "alpha.vrm"));
const bytes = () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;

/**
 * A renderer that counts, and reads how far the face has moved in each picture it is asked to draw: the sum of
 * a face mesh's morph weights (three-vrm combines each expression into one target when it loads).
 */
function fakeRenderer() {
  const calls = { render: 0, disposed: 0, mouth: [] as number[] };
  const create = (): AvatarRenderer => ({
    setPixelRatio: () => {},
    setSize: () => {},
    render: (scene) => {
      calls.render++;
      let moved = 0;
      scene.traverse((o) => {
        const influences = (o as Mesh).morphTargetInfluences;
        if (influences) moved = Math.max(moved, influences.reduce((s, v) => s + v, 0));
      });
      calls.mouth.push(moved);
    },
    dispose: () => void calls.disposed++,
  });
  return { calls, create };
}

function fakeFrames(step = 16) {
  let now = 0;
  let seq = 0;
  const frames = new Map<number, (t: number) => void>();
  const clock: AvatarFrames = {
    now: () => now,
    requestFrame: (fn) => {
      frames.set(++seq, fn);
      return seq;
    },
    cancelFrame: (id) => void frames.delete(id),
  };
  return {
    clock,
    get pending() {
      return frames.size;
    },
    run(ms: number) {
      const end = now + ms;
      while (now < end) {
        act(() => {
          now += step;
          for (const [id, fn] of [...frames]) {
            frames.delete(id);
            fn(now);
          }
        });
      }
    },
  };
}

describe("the VRM avatar", () => {
  test("waits with the portrait, then shows the model with its placeholder credit", async () => {
    const fake = fakeRenderer();
    const onReady = mock((_: VrmMeta) => {});
    const frames = fakeFrames();
    const { container } = render(<VrmAvatar src={bytes()} name="Alpha" portrait="portrait.svg" createRenderer={fake.create} frames={frames.clock} onReady={onReady} />);
    expect(screen.getByRole("status").textContent).toContain("Getting Alpha ready");
    expect(container.querySelector(".clvr-portrait")!.getAttribute("src")).toBe("portrait.svg");
    await waitFor(() => { expect(onReady).toHaveBeenCalledTimes(1); expect(frames.pending).toBe(1); }); // ready, and the frame loop running (React commits after onReady)
    expect(container.querySelector("figure")!.getAttribute("data-state")).toBe("ready");
    expect(screen.getByText(/Alpha \(placeholder model\) · by Clover contributors · VRM Public License 1.0/)).toBeTruthy();
    // Alive: a frame loop, drawing.
    expect(frames.pending).toBe(1);
    frames.run(100);
    expect(fake.calls.render).toBeGreaterThan(3);
  });

  test("says what went wrong in words for a person, with the portrait in its place; the detail goes to the log", async () => {
    const onError = mock((_: string, __?: string) => {});
    render(<VrmAvatar src={new TextEncoder().encode("not a model").buffer as ArrayBuffer} name="Alpha" portrait="p.svg" createRenderer={fakeRenderer().create} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert").textContent).toContain("Alpha's avatar can't be shown");
    expect(screen.getByRole("alert").textContent).toContain("The avatar file is not a VRM model.");
    expect(onError.mock.calls[0]![1]).toContain("Not a binary glTF");
  });

  test("a file that can't be fetched is an error too", async () => {
    const onError = mock((_: string, __?: string) => {});
    render(<VrmAvatar src="missing.vrm" name="Alpha" createRenderer={fakeRenderer().create} fetchBytes={() => Promise.reject(new Error("404"))} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("The avatar file could not be read.", "404"));
  });

  test("without WebGL it says so", async () => {
    const onError = mock((_: string, __?: string) => {});
    render(<VrmAvatar src={bytes()} name="Alpha" createRenderer={() => { throw new Error("no gl"); }} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("This computer can't draw the 3D avatar here.", "no gl"));
  });

  test("animates only while seen: off screen or with the window hidden, no frame runs", async () => {
    const observers: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    const real = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    let hidden = false;
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    try {
      const fake = fakeRenderer();
      const frames = fakeFrames();
      const onReady = mock((_: VrmMeta) => {});
      const { container } = render(<VrmAvatar src={bytes()} name="Alpha" createRenderer={fake.create} frames={frames.clock} onReady={onReady} />);
      await waitFor(() => { expect(onReady).toHaveBeenCalled(); expect(frames.pending).toBe(1); }); // ready, and the frame loop running (React commits after onReady)
      const figure = container.querySelector("figure")!;
      expect(frames.pending).toBe(1);
      // Scrolled away.
      act(() => observers.at(-1)!([{ isIntersecting: false }]));
      expect(frames.pending).toBe(0);
      expect(figure.getAttribute("data-running")).toBeNull();
      act(() => observers.at(-1)!([{ isIntersecting: true }]));
      expect(frames.pending).toBe(1);
      // The window hidden, then shown.
      hidden = true;
      act(() => void document.dispatchEvent(new Event("visibilitychange")));
      expect(frames.pending).toBe(0);
      const drawn = fake.calls.render;
      frames.run(200);
      expect(fake.calls.render).toBe(drawn);
      hidden = false;
      act(() => void document.dispatchEvent(new Event("visibilitychange")));
      expect(frames.pending).toBe(1);
      expect(figure.getAttribute("data-running")).toBe("true");
    } finally {
      globalThis.IntersectionObserver = real;
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (visibility) Object.defineProperty(Document.prototype, "visibilityState", visibility);
    }
  });

  test("a still draws once and runs no frames; paused, nothing runs", async () => {
    const fake = fakeRenderer();
    const frames = fakeFrames();
    const onReady = mock((_: VrmMeta) => {});
    const { rerender } = render(<VrmAvatar src={bytes()} name="Alpha" createRenderer={fake.create} frames={frames.clock} still={{ at: 1, visemes: { aa: 0.8 } }} onReady={onReady} />);
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    await waitFor(() => expect(fake.calls.render).toBe(1));
    expect(frames.pending).toBe(0);
    // The still's own mouth, held.
    expect(fake.calls.mouth[0]).toBeCloseTo(0.8, 6);
    rerender(<VrmAvatar src={bytes()} name="Alpha" createRenderer={fake.create} frames={frames.clock} paused onReady={onReady} />);
    expect(frames.pending).toBe(0);
  });

  test("its mouth follows the speech the app pushes, on the audio clock, and closes when it stops", async () => {
    let audio = 10;
    const speech = new PushedSpeech(() => audio);
    const fake = fakeRenderer();
    const frames = fakeFrames();
    const onReady = mock((_: VrmMeta) => {});
    const view = render(<VrmAvatar src={bytes()} name="Alpha" createRenderer={fake.create} frames={frames.clock} speech={speech} onReady={onReady} />);
    await waitFor(() => { expect(onReady).toHaveBeenCalled(); expect(frames.pending).toBe(1); }); // ready, and the frame loop running (React commits after onReady)
    // Frames stamped for when they will be heard: half a second of "a" from 10.2 s on.
    act(() => speech.push(speechFrames(vowel("a", 0.5), 48000, 10.2)));
    frames.run(100);
    // Not yet heard: the mouth stays shut.
    expect(Math.max(...fake.calls.mouth)).toBeLessThan(0.02);
    audio = 10.3;
    frames.run(200);
    expect(Math.max(...fake.calls.mouth)).toBeGreaterThan(0.15);
    // The clip ends: the mouth closes.
    audio = 11;
    frames.run(400);
    expect(fake.calls.mouth.at(-1)!).toBeLessThan(0.02);
    view.unmount();
    expect(fake.calls.disposed).toBe(1);
  });

  test("draws at most 30 frames a second while quiet, and 60 while speech sounds", async () => {
    let audio = 0;
    const speech = new PushedSpeech(() => audio);
    const fake = fakeRenderer();
    const frames = fakeFrames(8);
    const onReady = mock((_: VrmMeta) => {});
    render(<VrmAvatar src={bytes()} name="Alpha" createRenderer={fake.create} frames={frames.clock} speech={speech} onReady={onReady} />);
    await waitFor(() => { expect(onReady).toHaveBeenCalled(); expect(frames.pending).toBe(1); }); // ready, and the frame loop running (React commits after onReady)
    let before = fake.calls.render;
    frames.run(1000);
    expect(fake.calls.render - before).toBeLessThanOrEqual(31);
    expect(fake.calls.render - before).toBeGreaterThanOrEqual(28);
    act(() => speech.push(speechFrames(vowel("a", 2), 48000, 0)));
    audio = 0.5;
    before = fake.calls.render;
    frames.run(1000);
    expect(fake.calls.render - before).toBeGreaterThanOrEqual(55);
    expect(fake.calls.render - before).toBeLessThanOrEqual(63);
  });

  test("credit: a licence that asks for it gets it, a model that doesn't, doesn't", () => {
    const meta: VrmMeta = { title: "Mika", author: "Ana", version: "1.0", modelVersion: null, licenceName: "VRM Public License 1.0", licenceUrl: "https://vrm.dev/licenses/1.0/", otherLicenceUrl: null, commercialUse: "allowed", creditRequired: true, redistribution: "allowed", placeholder: false };
    expect(creditLine(meta)).toBe("Mika · by Ana · VRM Public License 1.0");
    expect(creditLine({ ...meta, creditRequired: false })).toBeNull();
    expect(creditLine({ ...meta, creditRequired: false }, "always")).toBe("Mika · by Ana · VRM Public License 1.0");
    expect(creditLine(meta, "never")).toBeNull();
  });
});

describe("reading the avatar file", () => {
  const stream = (chunks: number[], pulled: { count: number }) =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulled.count++];
        if (next === undefined) controller.close();
        else controller.enqueue(new Uint8Array(next));
      },
    });

  test("refuses a Content-Length over the cap before reading a byte", async () => {
    const pulled = { count: 0 };
    const response = new Response(stream([10, 10], pulled), { headers: { "content-length": "4000" } });
    const error = await fetchCapped("a.vrm", 1000, async () => response).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AvatarError);
    expect((error as AvatarError).reason).toBe("too-large");
    expect(pulled.count).toBeLessThanOrEqual(1);
  });

  test("stops a body that runs past the cap, whatever its headers said", async () => {
    const pulled = { count: 0 };
    const response = new Response(stream([400, 400, 400, 400, 400, 400], pulled), { headers: { "content-length": "100" } });
    const error = await fetchCapped("a.vrm", 1000, async () => response).catch((e: unknown) => e);
    expect((error as AvatarError).reason).toBe("too-large");
    expect(pulled.count).toBeLessThan(6);
  });

  test("reads a file within the cap, and calls a failed answer unreadable", async () => {
    const pulled = { count: 0 };
    const bytes = await fetchCapped("a.vrm", 1000, async () => new Response(stream([300, 300], pulled)));
    expect(bytes.byteLength).toBe(600);
    const error = await fetchCapped("a.vrm", 1000, async () => new Response("no", { status: 404 })).catch((e: unknown) => e);
    expect((error as AvatarError).reason).toBe("unreadable");
  });
});
