// The Live2D renderer's client entry (decision 87): what the manifest's `avatar` entry names, and the pieces a host or
// the core can reuse — the check above all, which runs without a browser.

export { Live2dAvatarEntry, type AvatarSpotProps, type Live2dEntryProps } from "../src/ui/entry";
export { Live2dAvatar, loadLive2d, VIEW_OPTIONS, AVATAR_FPS, BROWSER_FRAMES, type Live2dAvatarProps, type Live2dView, type Live2dShownModel, type ViewFactory, type AvatarStill, type AvatarFrames } from "../src/ui/Live2dAvatar";
export { ensureLive2dStyles, LIVE2D_CSS } from "../src/ui/styles";
export { validateLive2d, insideFolder, pngSize, mocCounts, LIVE2D_BUDGETS, Live2dRefusal, type Live2dModel, type Live2dSource, type Live2dStats, type Live2dProblemCode, type Live2dBudgets } from "../src/validate";
export { urlSource, zipSource, zipDeclared, memorySource, readCapped } from "../src/sources";
export { mouthPlan, openAndForm, motionSyncValues, MOUTH_OPEN, MOUTH_FORM, type MouthPlan } from "../src/mouth";
