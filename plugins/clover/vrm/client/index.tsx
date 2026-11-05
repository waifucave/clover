// The VRM renderer's client entry (spec §10): what the manifest's `avatar` entry names, and the pieces a host
// or another avatar format can reuse (the lip-sync above all).

export { VrmAvatar, creditLine, themeLights, BROWSER_FRAMES, type VrmAvatarProps, type AvatarStill, type AvatarFrames } from "../src/ui/VrmAvatar";
export { ensureAvatarStyles, AVATAR_CSS } from "../src/ui/styles";
export { AvatarScene, clampStep, webGLRenderer, DEFAULT_LIGHTS, SPRING_MAX_STEP, type AvatarRenderer, type RendererFactory, type StageLights, type Framing, type FaceState, type LoadedAvatar } from "../src/vrm/scene";
export { validateVrm, MAX_VRM_BYTES, VRM_BUDGETS, type VrmMeta, type VrmValidation, type VrmStats, type AssetRejection } from "../src/vrm/validate";
export { LipSync, SpeechRing, ringSource, analyserSource, bufferSource, type LipSyncSource, type AnalyserLike } from "../src/lipsync/sources";
export { visemeWeights, MouthSmoother, VISEMES, SHUT, SILENCE_RMS, FULL_RMS, type VisemeWeights } from "../src/lipsync/visemes";
export { rmsOf, spectralCentroidOf, FFT_SIZE } from "../src/lipsync/features";
export { Blinker, blinkCurve, BLINK } from "../src/motion/blink";
export { idlePose, IDLE, type Pose, type BoneName } from "../src/motion/idle";
