// Mouth levels from speech (exported from `@waifucave/moss-plugin-sdk/ui`, the one SDK module a layer serves): for any avatar renderer, the five vowel shapes'
// weights (aa, ih, ou, ee, oh) from the speech the stage plays, read at the moment it sounds. The feed is the `avatar`
// spot's `speech` (`useAvatarSpeech().feed`): two numbers a frame, loudness and brightness, never samples, so a
// renderer needs no `audio` capability. A renderer maps the weights onto its own mouth (morphs, parameters, sprites).
export { LipSync, SpeechRing, frameSource, ringSource, analyserSource, bufferSource, speechFrames, PushedSpeech, MAX_FRAME_SECONDS, type LipSyncSource, type SpeechFeatureSource, type SpeechFeatures, type AnalyserLike, type SpeechFeed, type SpeechFrame } from "./sources";
export { visemeWeights, MouthSmoother, VISEMES, SHUT, SILENCE_RMS, FULL_RMS, DARK_HZ, BRIGHT_HZ, clamp01, type VisemeWeights } from "./visemes";
export { rmsOf, spectralCentroidOf, FFT_SIZE } from "./features";
