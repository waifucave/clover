// The pill's shape spring (the Swift reference's `morphStep` and `DispatchPillController.springTick`): width and height
// each pulled toward the target by a damped spring, stepped once a frame by the real time since the last
// one. A value, never a render loop, so a test or a gallery frame can step it to any moment. Pure.

import type { Size } from "./metrics";

export const SPRING = {
  stiffness: 140,
  damping: 22,
  /** A step's time is held between these: a stalled frame never throws the shape, a fast one still moves it. */
  minStep: 1 / 240,
  maxStep: 1 / 20,
  /** Settled once both sides are this close to the target… */
  settleDistance: 0.5,
  /** …and moving slower than this, in pixels a second. */
  settleSpeed: 4,
} as const;

export interface Axis {
  value: number;
  velocity: number;
}

/** One semi-implicit Euler step of a damped spring toward `target`. */
export function springStep(axis: Axis, target: number, rawDt: number, stiffness: number = SPRING.stiffness, damping: number = SPRING.damping): Axis {
  const dt = Math.max(SPRING.minStep, Math.min(rawDt, SPRING.maxStep));
  const accel = stiffness * (target - axis.value) - damping * axis.velocity;
  const velocity = axis.velocity + accel * dt;
  return { value: axis.value + velocity * dt, velocity };
}

export interface SizeSpring {
  size: Size;
  velocity: Size;
  target: Size;
}

export function restingSpring(size: Size): SizeSpring {
  return { size, velocity: { width: 0, height: 0 }, target: size };
}

export function retarget(spring: SizeSpring, target: Size): SizeSpring {
  return { ...spring, target };
}

export function settled(spring: SizeSpring): boolean {
  const { size, velocity, target } = spring;
  return (
    Math.abs(target.width - size.width) < SPRING.settleDistance &&
    Math.abs(velocity.width) < SPRING.settleSpeed &&
    Math.abs(target.height - size.height) < SPRING.settleDistance &&
    Math.abs(velocity.height) < SPRING.settleSpeed
  );
}

/** The spring after `dt` seconds: snapped onto its target once settled, never thinner than a pixel. */
export function stepSpring(spring: SizeSpring, dt: number): SizeSpring {
  const w = springStep({ value: spring.size.width, velocity: spring.velocity.width }, spring.target.width, dt);
  const h = springStep({ value: spring.size.height, velocity: spring.velocity.height }, spring.target.height, dt);
  const next: SizeSpring = {
    size: { width: Math.max(1, w.value), height: Math.max(1, h.value) },
    velocity: { width: w.velocity, height: h.velocity },
    target: spring.target,
  };
  return settled(next) ? restingSpring(spring.target) : next;
}

/** Where a spring released from `from` toward `to` is after `seconds`, stepped at 60 frames a second. */
export function springAt(from: Size, to: Size, seconds: number, fps = 60): SizeSpring {
  let spring = retarget(restingSpring(from), to);
  const steps = Math.round(seconds * fps);
  for (let i = 0; i < steps; i++) spring = stepSpring(spring, 1 / fps);
  return spring;
}

/** How long a spring from `from` to `to` takes to settle, in seconds (to the frame). */
export function settleSeconds(from: Size, to: Size, fps = 60, limit = 5): number {
  let spring = retarget(restingSpring(from), to);
  for (let i = 1; i <= limit * fps; i++) {
    spring = stepSpring(spring, 1 / fps);
    if (spring.velocity.width === 0 && spring.velocity.height === 0 && spring.size.width === to.width && spring.size.height === to.height) return i / fps;
  }
  return limit;
}
