import { describe, expect, mock, test } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VrmAvatar, creditLine, type AvatarFrames } from "../src/ui/VrmAvatar";
import type { AvatarRenderer } from "../src/vrm/scene";
import type { VrmMeta } from "../src/vrm/validate";
import { bufferSource } from "../src/lipsync/sources";
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

function fakeFrames() {
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
          now += 16;
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
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(container.querySelector("figure")!.getAttribute("data-state")).toBe("ready");
    expect(screen.getByText(/Alpha \(placeholder model\) · by Clover contributors · Apache-2.0/)).toBeTruthy();
    // Alive: a frame loop, drawing.
    expect(frames.pending).toBe(1);
    frames.run(100);
    expect(fake.calls.render).toBeGreaterThan(3);
  });

  test("says what went wrong, with the portrait in its place", async () => {
    const onError = mock((_: string) => {});
    render(<VrmAvatar src={new TextEncoder().encode("not a model").buffer as ArrayBuffer} name="Alpha" portrait="p.svg" createRenderer={fakeRenderer().create} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert").textContent).toContain("Alpha's avatar can't be shown");
    expect(screen.getByRole("alert").textContent).toContain("Not a binary glTF");
  });

  test("a file that can't be fetched is an error too", async () => {
    const onError = mock((_: string) => {});
    render(<VrmAvatar src="missing.vrm" name="Alpha" createRenderer={fakeRenderer().create} fetchBytes={() => Promise.reject(new Error("The avatar file could not be read (404)."))} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("The avatar file could not be read (404)."));
  });

  test("without WebGL it says so", async () => {
    const onError = mock((_: string) => {});
    render(<VrmAvatar src={bytes()} name="Alpha" createRenderer={() => { throw new Error("no gl"); }} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("This computer can't draw the 3D avatar here."));
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

  test("its mouth follows the speech", async () => {
    let at = 0.05;
    const speech = bufferSource(vowel("a", 0.5), 48000, () => at);
    const fake = fakeRenderer();
    const frames = fakeFrames();
    const onReady = mock((_: VrmMeta) => {});
    const view = render(<VrmAvatar src={bytes()} name="Alpha" createRenderer={fake.create} frames={frames.clock} speech={speech} onReady={onReady} />);
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    frames.run(200);
    expect(Math.max(...fake.calls.mouth)).toBeGreaterThan(0.15);
    // The clip ends: the mouth closes.
    at = 3;
    frames.run(400);
    expect(fake.calls.mouth.at(-1)!).toBeLessThan(0.02);
    view.unmount();
    expect(fake.calls.disposed).toBe(1);
  });

  test("credit: a licence that asks for it gets it, a model that doesn't, doesn't", () => {
    const meta: VrmMeta = { title: "Mika", author: "Ana", version: "1.0", modelVersion: null, licenceName: "VRM Public License 1.0", licenceUrl: "https://vrm.dev/licenses/1.0/", otherLicenceUrl: null, commercialUse: "allowed", creditRequired: true, redistribution: "allowed", placeholder: false };
    expect(creditLine(meta)).toBe("Mika · by Ana · VRM Public License 1.0");
    expect(creditLine({ ...meta, creditRequired: false })).toBeNull();
    expect(creditLine({ ...meta, creditRequired: false }, "always")).toBe("Mika · by Ana · VRM Public License 1.0");
    expect(creditLine(meta, "never")).toBeNull();
  });
});
