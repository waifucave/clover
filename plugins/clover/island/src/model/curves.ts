// Springs and eases, as functions of time (SwiftUI's response and damping fraction), so every frame of an
// island animation is a pure function of the seconds since it began: the views draw a frame, the tests
// sample frames, and the gallery draws filmstrips without a clock.

/** A spring's travel from 0 to 1, `t` seconds after it starts. */
export function spring(t: number, response: number, damping: number): number {
  if (t <= 0) return 0;
  const w0 = (2 * Math.PI) / response;
  if (damping >= 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const wd = w0 * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * w0 * t) * (Math.cos(wd * t) + ((damping * w0) / wd) * Math.sin(wd * t));
}

/** A critically damped spring: monotonic, never past 1. */
export function criticalSpring(t: number, response: number): number {
  if (t <= 0) return 0;
  const w = (2 * Math.PI) / response;
  return Math.min(1, 1 - Math.exp(-w * t) * (1 + w * t));
}

export const phase = (t: number, a: number, b: number): number => Math.min(Math.max((t - a) / (b - a), 0), 1);
export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
export const easeOut = (x: number): number => 1 - (1 - x) ** 3;
export const easeIn = (x: number): number => x * x;
export const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/**
 * The spring as a CSS `linear()` easing over its settling time: a hover grow or a dot's slide rides the
 * same curve the Swift surfaces do, with no frame loop. `samples` points, plus the end.
 */
export function springEasing(response: number, damping: number, samples = 40): { easing: string; durationMs: number } {
  // Settled once the envelope is within 0.1 % of rest.
  const w0 = (2 * Math.PI) / response;
  const zeta = Math.min(damping, 1);
  const settle = Math.min(2.5, Math.max(response, Math.log(1000) / (zeta * w0)));
  const points: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (settle * i) / samples;
    points.push((i === samples ? 1 : spring(t, response, damping)).toFixed(4));
  }
  return { easing: `linear(${points.join(", ")})`, durationMs: Math.round(settle * 1000) };
}

/** The surfaces' spring (Winter's `HoverGrowth.animation`, the Dispatch pill's). */
export const SURFACE_SPRING = { response: 0.3, damping: 0.7 } as const;
