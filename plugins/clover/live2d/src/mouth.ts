// The Live2D mouth from the speech the app plays (decision 87: lip sync from the speech feed only; Mochi2D's own
// microphone lip sync and its motion sync from audio stay off, so the avatar never asks for a microphone and hears
// nothing itself). The VRM renderer's lip-sync turns each frame's loudness and brightness into five eased vowel
// weights; here they become parameter values:
//
// - a model with motion-sync settings (`.motionsync3.json`): its own shapes, blended by the weights — Silence takes
//   what the vowels leave, A, I, U, E and O take `aa`, `ih`, `ou`, `ee` and `oh` — which is motion sync driven from the
//   feed instead of from the audio;
// - any other: the lip-sync parameters (`ParamMouthOpenY`, or the settings' `LipSync` group) open by the weights' sum,
//   and `ParamMouthForm` widens for the bright vowels and rounds for the dark ones, where the model has it.

import type { MotionSyncSetting } from "@waifucave/mochi2d/headless";
import type { VisemeWeights } from "@waifucave/clover-plugin-vrm/lipsync";

export const MOUTH_FORM = "ParamMouthForm";
export const MOUTH_OPEN = "ParamMouthOpenY";

/** What each motion-sync element takes from the five weights. */
const ELEMENT_WEIGHT: Readonly<Record<string, (w: VisemeWeights) => number>> = {
  A: (w) => w.aa,
  I: (w) => w.ih,
  U: (w) => w.ou,
  E: (w) => w.ee,
  O: (w) => w.oh,
};

function clamp(x: number, lo: number, hi: number): number {
  return x > lo ? (x < hi ? x : hi) : lo;
}

/** How open the mouth is (0 to 1) and its form (−1 round to 1 wide), from the weights. */
export function openAndForm(w: VisemeWeights): { open: number; form: number } {
  const total = w.aa + w.ih + w.ou + w.ee + w.oh;
  if (!(total > 0)) return { open: 0, form: 0 };
  return { open: clamp(total, 0, 1), form: clamp((w.ee + w.ih - (w.oh + w.ou)) / total, -1, 1) };
}

/** A motion-sync setting's parameter values for the weights: each element's shape, blended. Silence is the rest. */
export function motionSyncValues(setting: MotionSyncSetting, w: VisemeWeights): Map<string, number> {
  const vowels = w.aa + w.ih + w.ou + w.ee + w.oh;
  const weightOf = (id: string) => (id === "Silence" ? clamp(1 - vowels, 0, 1) : (ELEMENT_WEIGHT[id]?.(w) ?? 0));
  const values = new Map<string, number>();
  setting.parameters.forEach((p, k) => {
    let v = 0;
    let weight = 0;
    setting.elements.forEach((e, i) => {
      if (!e.enabled) return;
      const we = weightOf(e.id);
      v += we * (setting.shapes[i]?.[k] ?? 0);
      weight += we;
    });
    values.set(p.id, clamp(weight > 0 ? v / weight : 0, p.min, p.max));
  });
  return values;
}

/** Where the weights go on one model: worked out once when it loads. */
export interface MouthPlan {
  /** The parameters the speech writes each frame, and the value for the weights. */
  values(w: VisemeWeights): Map<string, number>;
  /** Every parameter it may write: set back to their defaults when the speech stops. */
  readonly parameters: readonly string[];
  /** Those the model's lip sync drives (its `LipSync` group, else `ParamMouthOpenY`): written through the live input. */
  readonly lipSync: ReadonlySet<string>;
}

export function mouthPlan(parameterIds: readonly string[], lipSyncIds: readonly string[], setting: MotionSyncSetting | null): MouthPlan {
  const has = new Set(parameterIds);
  const open = (lipSyncIds.length > 0 ? lipSyncIds : [MOUTH_OPEN]).filter((id) => has.has(id));
  const lipSync = new Set(open);
  if (setting && setting.parameters.every((p) => has.has(p.id))) {
    return { parameters: setting.parameters.map((p) => p.id), lipSync, values: (w) => motionSyncValues(setting, w) };
  }
  const form = has.has(MOUTH_FORM) ? MOUTH_FORM : null;
  return {
    parameters: form ? [...open, form] : open,
    lipSync,
    values: (w) => {
      const { open: o, form: f } = openAndForm(w);
      const values = new Map<string, number>(open.map((id) => [id, o]));
      if (form) values.set(form, f);
      return values;
    },
  };
}
