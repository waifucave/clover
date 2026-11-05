// The avatar at rest: arms down from the T-pose every VRM is made in, a little bend at the elbows, and a slow
// breath through the chest with the head drifting a touch. Rotations on the normalised humanoid bones, as Euler
// angles in radians; a pure function of time, so a still frame is the same on every run. With reduced motion the
// pose holds still.

export type BoneName =
  | "hips"
  | "spine"
  | "chest"
  | "neck"
  | "head"
  | "leftShoulder"
  | "rightShoulder"
  | "leftUpperArm"
  | "rightUpperArm"
  | "leftLowerArm"
  | "rightLowerArm"
  | "leftHand"
  | "rightHand";

export type Euler = readonly [x: number, y: number, z: number];
export type Pose = Partial<Record<BoneName, Euler>>;

export const IDLE = {
  /** How far the arms come down from horizontal. */
  armDown: 1.32,
  armForward: 0.12,
  elbow: 0.32,
  breathHz: 0.24,
  breath: 0.018,
  swayHz: 0.09,
  sway: 0.012,
  headHz: 0.13,
  head: 0.028,
} as const;

export function idlePose(time: number, reducedMotion = false): Pose {
  const t = reducedMotion ? 0 : time;
  const breath = Math.sin(2 * Math.PI * IDLE.breathHz * t);
  const sway = Math.sin(2 * Math.PI * IDLE.swayHz * t + 0.6);
  const look = Math.sin(2 * Math.PI * IDLE.headHz * t + 1.3);
  const nod = Math.sin(2 * Math.PI * IDLE.headHz * 0.7 * t + 2.1);
  const lift = reducedMotion ? 0 : 0.02 * (breath + 1) * 0.5;
  return {
    // A model's left is +X: lowering its left arm turns it about Z the negative way, the right arm the positive.
    leftUpperArm: [0, -IDLE.armForward, -IDLE.armDown + lift],
    rightUpperArm: [0, IDLE.armForward, IDLE.armDown - lift],
    leftLowerArm: [0, -IDLE.elbow, 0],
    rightLowerArm: [0, IDLE.elbow, 0],
    leftHand: [0, 0, -0.12],
    rightHand: [0, 0, 0.12],
    leftShoulder: [0, 0, -lift * 0.5],
    rightShoulder: [0, 0, lift * 0.5],
    spine: [0, 0, IDLE.sway * sway],
    chest: [-IDLE.breath * breath, 0, 0],
    neck: [0, IDLE.head * 0.4 * look, 0],
    head: [IDLE.head * 0.5 * nod, IDLE.head * look, -IDLE.head * 0.4 * sway],
  };
}
