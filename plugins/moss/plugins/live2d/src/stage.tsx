// The gallery's stage and its synthetic speech, this plugin's own (F2b: no plugin imports another's folder): a stage the
// size of the frame with the theme's floor shadow, and what the SDK's mouth levels read at moments of a synthetic phrase.
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { FFT_SIZE, LipSync, type VisemeWeights } from "@waifucave/moss-plugin-sdk/ui";
import { phrase } from "./synth";

/** The placeholder bot's portrait, as the gallery serves it. */
export const ALPHA_PORTRAIT = "plugins/alpha/assets/portrait.svg";

const STAGE: CSSProperties = { position: "relative", background: "var(--moss-stage-background, linear-gradient(180deg, #FFFFFF 0%, #F4F2F8 100%))", overflow: "hidden" };

/** A stage the size of the frame, with the theme's floor shadow under the avatar. */
export function Stage({ width, height, children }: { width: number; height: number; children: ReactNode }): ReactElement {
  return (
    <div style={{ ...STAGE, width, height }}>
      <div style={{ position: "absolute", left: "50%", bottom: "6%", width: "56%", height: 26, marginLeft: "-28%", borderRadius: "50%", background: "radial-gradient(closest-side, var(--moss-stage-floor, #1C1B221F), #00000000)" }} />
      {children}
    </div>
  );
}

/** What the mouth levels read at moments of the synthetic phrase: the five weights, unsmoothed, as a still shows them. */
export function phraseFrames(times: readonly number[], sampleRate = 48000): { at: number; visemes: VisemeWeights }[] {
  const clip = phrase(sampleRate);
  return times.map((at) => {
    const start = Math.round(at * sampleRate);
    return { at, visemes: LipSync.analyse(clip.subarray(start, start + FFT_SIZE), sampleRate) };
  });
}
