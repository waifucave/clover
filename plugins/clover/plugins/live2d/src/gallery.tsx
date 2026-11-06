// The 2D model avatar (the Live2D Cubism format) in every state, for lane G's gallery (rendered to PNGs in CI with software WebGL, never on a desk):
// Alpha's code-made placeholder drawn by Mochi2D at rest, with each mouth shape, blinking and speaking a synthetic
// phrase as the speech feed reads it, then loading and refused. Every frame is a still, the same on every run.

import type { ReactElement, ReactNode } from "react";
import { ALPHA_PORTRAIT, Stage, phraseFrames } from "@waifucave/clover-plugin-vrm/gallery";
import type { VisemeWeights } from "@waifucave/clover-plugin-vrm/lipsync";
import { Live2dAvatar, type AvatarStill } from "./ui/Live2dAvatar";
import { archiveBombCheck, bombCheckProblems } from "./bomb";

export interface Live2dStory {
  id: string;
  title: string;
  width: number;
  height: number;
  theme?: string;
  render: () => ReactNode;
  ready?: () => Promise<void>;
}

/** Where the gallery serves Alpha's Live2D placeholder (the same path it has in the repo). */
export const ALPHA_LIVE2D = "plugins/alpha/assets/live2d/alpha.model3.json";

/** Resolves once every 2D model avatar in the frame has drawn (or failed), and one more frame has passed. */
export async function live2dSettled(timeoutMs = 25_000): Promise<void> {
  const started = performance.now();
  for (;;) {
    const figures = [...document.querySelectorAll(".clvl-avatar")];
    if (figures.length > 0 && figures.every((f) => f.getAttribute("data-state") !== "loading")) break;
    if (performance.now() - started > timeoutMs) throw new Error("a 2D model avatar never finished loading");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/** Fails the story when an avatar could not be shown where one should have been. */
async function drawn(): Promise<void> {
  await live2dSettled();
  const failed = [...document.querySelectorAll('.clvl-avatar[data-state="error"]')];
  if (failed.length > 0) throw new Error(`a 2D model avatar was refused: ${failed[0]!.textContent ?? ""}`);
}

function Avatar({ still }: { still: AvatarStill }): ReactElement {
  return <Live2dAvatar src={ALPHA_LIVE2D} name="Alpha" portrait={ALPHA_PORTRAIT} still={still} />;
}

function Sheet({ cells, columns, cell }: { cells: { label: string; still: AvatarStill }[]; columns: number; cell: { width: number; height: number } }): ReactElement {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, ${cell.width}px)`, gap: 6, background: "var(--clover-color-canvas, #F6F6F8)" }}>
      {cells.map((c, i) => (
        <div key={i} style={{ position: "relative" }}>
          <Stage width={cell.width} height={cell.height}>
            <Avatar still={c.still} />
          </Stage>
          <span style={{ position: "absolute", left: 8, top: 6, font: "600 11px system-ui, sans-serif", color: "var(--clover-color-text, #1C1B22)", background: "#FFFFFFB3", borderRadius: 6, padding: "1px 6px" }}>{c.label}</span>
        </div>
      ))}
    </div>
  );
}

const SHAPES: { label: string; visemes: Partial<VisemeWeights> }[] = [
  { label: "at rest", visemes: {} },
  { label: "aa", visemes: { aa: 1 } },
  { label: "ih", visemes: { ih: 1 } },
  { label: "ou", visemes: { ou: 1 } },
  { label: "ee", visemes: { ee: 1 } },
  { label: "oh", visemes: { oh: 1 } },
];

const SPOKEN = [0.08, 0.27, 0.5, 0.62, 0.86, 1.02, 1.2, 1.4];

/** A texture header claiming 8192 px a side: refused before anything decodes it. */
async function oversizedTexture(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!url.endsWith(".png")) return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  new DataView(bytes.buffer).setUint32(16, 8192);
  return new Response(bytes);
}

/** The archive-bomb check in the gallery's own Chromium (the engine the app's layers run): the numbers on the page, and
 *  the story fails when the cap tripped too late. */
async function bombInChromium(): Promise<void> {
  const check = await archiveBombCheck();
  const el = document.querySelector("[data-bomb]");
  const kib = (n: number) => `${(n / 1024).toFixed(0)} KiB`;
  if (el) {
    el.textContent = [
      `A deflate stream of ${kib(check.compressed)} that inflates to ${kib(check.inflatesTo)}, against a ${kib(check.cap)} cap:`,
      check.refused ? `refused after ${kib(check.writtenBeforeRefusal)} of it was pushed, in ${check.ms} ms` : `not refused (${check.detail})`,
      `largest push: ${check.largestWrite} bytes; engine: ${navigator.userAgent.match(/(HeadlessChrome|Chrome)\/[\d.]+/)?.[0] ?? navigator.userAgent}`,
    ].join("\n");
  }
  const problems = bombCheckProblems(check);
  if (problems.length > 0) throw new Error(`the archive cap tripped too late in this engine: ${problems.join("; ")}`);
}

export const LIVE2D_STORIES: Live2dStory[] = [
  {
    id: "live2d/alpha-placeholder",
    title: "Alpha as a 2D model (decision 87): the code-made placeholder, drawn by Mochi2D on the base stage",
    width: 400,
    height: 480,
    theme: "base-light",
    render: () => (
      <Stage width={400} height={480}>
        <Avatar still={{}} />
      </Stage>
    ),
    ready: drawn,
  },
  {
    id: "live2d/alpha-placeholder-dark",
    title: "The same in the dark",
    width: 400,
    height: 480,
    theme: "base-dark",
    render: () => (
      <Stage width={400} height={480}>
        <Avatar still={{ breath: 1 }} />
      </Stage>
    ),
    ready: drawn,
  },
  {
    id: "live2d/mouth-shapes",
    title: "The five weights the speech feed gives, as the placeholder's mouth opens, widens and rounds",
    width: 3 * 220 + 2 * 6,
    height: 2 * 250 + 6,
    theme: "base-light",
    render: () => <Sheet columns={3} cell={{ width: 220, height: 250 }} cells={SHAPES.map((s) => ({ label: s.label, still: { visemes: s.visemes } }))} />,
    ready: drawn,
  },
  {
    id: "live2d/speaking",
    title: "Speaking: the mouth at moments of a synthetic phrase, as the speech feed reads it (no microphone)",
    width: 4 * 200 + 3 * 6,
    height: 2 * 230 + 6,
    theme: "base-light",
    render: () => <Sheet columns={4} cell={{ width: 200, height: 230 }} cells={phraseFrames(SPOKEN).map((f) => ({ label: `${f.at.toFixed(2)} s`, still: { visemes: f.visemes } }))} />,
    ready: drawn,
  },
  {
    id: "live2d/blink",
    title: "Blinking: open, half, shut",
    width: 3 * 220 + 2 * 6,
    height: 250,
    theme: "base-light",
    render: () => (
      <Sheet
        columns={3}
        cell={{ width: 220, height: 250 }}
        cells={[
          { label: "open", still: { blink: 0 } },
          { label: "half", still: { blink: 0.5 } },
          { label: "shut", still: { blink: 1 } },
        ]}
      />
    ),
    ready: drawn,
  },
  {
    id: "live2d/loading",
    title: "Loading: the portrait holds the place",
    width: 320,
    height: 360,
    theme: "base-light",
    render: () => (
      <Stage width={320} height={360}>
        <Live2dAvatar src="never.model3.json" name="Alpha" portrait={ALPHA_PORTRAIT} fetcher={() => new Promise(() => {})} />
      </Stage>
    ),
  },
  {
    id: "live2d/archive-bomb",
    title: "An archive bomb in Chromium: the 2D model's archive is inflated 1 KiB at a time and cut off at its cap (R5)",
    width: 560,
    height: 120,
    theme: "base-light",
    render: () => (
      <pre data-bomb="" style={{ margin: 0, boxSizing: "border-box", width: "100%", height: "100%", padding: 16, whiteSpace: "pre-wrap", font: "12px ui-monospace, Menlo, monospace", color: "var(--clover-color-text, #1F1F1F)", background: "var(--clover-color-surface, #FFFFFF)" }}>
        Checking…
      </pre>
    ),
    ready: bombInChromium,
  },
  {
    id: "live2d/refused",
    title: "Refused before it decodes: a texture over 4096 px a side",
    width: 320,
    height: 360,
    theme: "base-light",
    render: () => (
      <Stage width={320} height={360}>
        <Live2dAvatar src={ALPHA_LIVE2D} name="Alpha" portrait={ALPHA_PORTRAIT} fetcher={oversizedTexture} />
      </Stage>
    ),
    ready: live2dSettled,
  },
];
