// The VRM avatar in every state, for the lane's gallery (rendered to PNGs in CI with software WebGL, never on a
// desk). Every frame is a still: the idle motion at a moment, the mouth at given weights or at what lip-sync
// reads from a synthetic phrase at that moment, so a picture is the same on every run.

import type { CSSProperties, ReactElement, ReactNode } from "react";
import { FFT_SIZE } from "./lipsync/features";
import { LipSync } from "./lipsync/sources";
import { phrase } from "./lipsync/synth";
import type { VisemeWeights } from "./lipsync/visemes";
import { VrmAvatar, type AvatarStill } from "./ui/VrmAvatar";
import type { Framing } from "./vrm/scene";

export interface Story {
  id: string;
  title: string;
  width: number;
  height: number;
  render: () => ReactNode;
  ready?: () => Promise<void>;
  /** The theme stack the gallery draws the frame in. */
  theme?: string;
}

/** Where the gallery serves Alpha's assets (the same path they have in the repo). */
export const ALPHA_VRM = "plugins/alpha/assets/alpha.vrm";
export const ALPHA_PORTRAIT = "plugins/alpha/assets/portrait.svg";

/** Resolves once every avatar in the frame has drawn (or failed), and one more frame has passed. */
export async function avatarsSettled(timeoutMs = 25_000): Promise<void> {
  const started = performance.now();
  for (;;) {
    const figures = [...document.querySelectorAll(".clvr-avatar")];
    if (figures.length > 0 && figures.every((f) => f.getAttribute("data-state") !== "loading")) break;
    if (performance.now() - started > timeoutMs) throw new Error("an avatar never finished loading");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

const STAGE: CSSProperties = { position: "relative", background: "var(--stage-background, linear-gradient(180deg, #FFFFFF 0%, #F4F2F8 100%))", overflow: "hidden" };

/** A stage the size of the frame, with the theme's floor shadow under the avatar. */
export function Stage({ width, height, children }: { width: number; height: number; children: ReactNode }): ReactElement {
  return (
    <div style={{ ...STAGE, width, height }}>
      <div style={{ position: "absolute", left: "50%", bottom: "6%", width: "56%", height: 26, marginLeft: "-28%", borderRadius: "50%", background: "radial-gradient(closest-side, var(--stage-floor, #1C1B221F), #00000000)" }} />
      {children}
    </div>
  );
}

function Avatar({ still, framing = "bust", credit = "auto" }: { still: AvatarStill; framing?: Framing; credit?: "auto" | "never" }): ReactElement {
  return <VrmAvatar src={ALPHA_VRM} name="Alpha" portrait={ALPHA_PORTRAIT} framing={framing} still={still} credit={credit} />;
}

/** A labelled grid of small stages. */
function Sheet({ cells, columns, cell, label }: { cells: { label: string; still: AvatarStill }[]; columns: number; cell: { width: number; height: number }; label?: (i: number) => string }): ReactElement {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, ${cell.width}px)`, gap: 6, background: "var(--color-canvas, #F6F6F8)" }}>
      {cells.map((c, i) => (
        <div key={i} style={{ position: "relative" }}>
          <Stage width={cell.width} height={cell.height}>
            {/* The credit shows on the single stories; in a sheet of small stages it would cover the figure. */}
            <Avatar still={c.still} credit="never" />
          </Stage>
          <span style={{ position: "absolute", left: 8, top: 6, font: "600 11px system-ui, sans-serif", color: "var(--color-text, #1C1B22)", background: "#FFFFFFB3", borderRadius: 6, padding: "1px 6px" }}>{label?.(i) ?? c.label}</span>
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

/** What lip-sync reads at moments of the synthetic phrase: its five weights, unsmoothed, as a still shows them. */
export function phraseFrames(times: readonly number[], sampleRate = 48000): { at: number; visemes: VisemeWeights }[] {
  const clip = phrase(sampleRate);
  return times.map((at) => {
    const start = Math.round(at * sampleRate);
    return { at, visemes: LipSync.analyse(clip.subarray(start, start + FFT_SIZE), sampleRate) };
  });
}

const SPOKEN = [0.08, 0.27, 0.5, 0.62, 0.86, 1.02, 1.2, 1.4];

export const VRM_STORIES: Story[] = [
  {
    id: "vrm/alpha-idle",
    title: "Alpha's placeholder avatar at rest on the base stage, with its placeholder credit",
    width: 400,
    height: 520,
    theme: "base-light",
    render: () => (
      <Stage width={400} height={520}>
        <Avatar still={{ at: 1.2 }} />
      </Stage>
    ),
    ready: avatarsSettled,
  },
  {
    id: "vrm/alpha-idle-dark",
    title: "The same on the base stage in the dark, lit by the dark theme's avatar lights",
    width: 400,
    height: 520,
    theme: "base-dark",
    render: () => (
      <Stage width={400} height={520}>
        <Avatar still={{ at: 1.2 }} />
      </Stage>
    ),
    ready: avatarsSettled,
  },
  {
    id: "vrm/mouth-shapes",
    theme: "base-light",
    title: "The five mouth shapes lip-sync mixes, each at full weight",
    width: 3 * 220 + 2 * 6,
    height: 2 * 250 + 6,
    render: () => <Sheet columns={3} cell={{ width: 220, height: 250 }} cells={SHAPES.map((s) => ({ label: s.label, still: { at: 0.6, visemes: s.visemes } }))} />,
    ready: avatarsSettled,
  },
  {
    id: "vrm/faces",
    theme: "base-light",
    title: "Blink, happy and surprised",
    width: 3 * 220 + 2 * 6,
    height: 250,
    render: () => (
      <Sheet
        columns={3}
        cell={{ width: 220, height: 250 }}
        cells={[
          { label: "blink", still: { at: 0.6, blink: 1 } },
          { label: "happy", still: { at: 0.6, happy: 1 } },
          { label: "surprised", still: { at: 0.6, surprised: 1, visemes: { oh: 0.3 } } },
        ]}
      />
    ),
    ready: avatarsSettled,
  },
  {
    id: "vrm/speaking",
    theme: "base-light",
    title: "Speaking: the mouth at moments of a synthetic phrase, as lip-sync reads the sound",
    width: 4 * 200 + 3 * 6,
    height: 2 * 230 + 6,
    render: () => {
      const frames = phraseFrames(SPOKEN);
      return <Sheet columns={4} cell={{ width: 200, height: 230 }} cells={frames.map((f) => ({ label: `${f.at.toFixed(2)} s`, still: { at: 0.6 + f.at, visemes: f.visemes } }))} />;
    },
    ready: avatarsSettled,
  },
  {
    id: "vrm/full-figure",
    theme: "base-light",
    title: "The whole placeholder figure, arms down from its T-pose",
    width: 360,
    height: 640,
    render: () => (
      <Stage width={360} height={640}>
        <Avatar still={{ at: 2.4 }} framing="full" />
      </Stage>
    ),
    ready: avatarsSettled,
  },
  {
    id: "vrm/loading",
    theme: "base-light",
    title: "Loading: the portrait holds the place",
    width: 320,
    height: 360,
    render: () => (
      <Stage width={320} height={360}>
        <VrmAvatar src="never.vrm" name="Alpha" portrait={ALPHA_PORTRAIT} fetchBytes={() => new Promise(() => {})} />
      </Stage>
    ),
  },
  {
    id: "vrm/error",
    theme: "base-light",
    title: "A file that is not a model: what went wrong, the portrait in its place",
    width: 320,
    height: 360,
    render: () => (
      <Stage width={320} height={360}>
        <VrmAvatar src={new TextEncoder().encode("not a model").buffer as ArrayBuffer} name="Alpha" portrait={ALPHA_PORTRAIT} />
      </Stage>
    ),
    ready: avatarsSettled,
  },
];
