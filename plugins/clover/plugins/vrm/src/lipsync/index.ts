// The lip-sync on its own, for another avatar format (the Live2D renderer): the speech feed's frames, the five mouth
// weights and their easing, with nothing of three.js.

export { LipSync, SpeechRing, frameSource, ringSource, analyserSource, bufferSource, speechFrames, PushedSpeech, type LipSyncSource, type SpeechFeatureSource, type SpeechFeatures, type SpeechFrame, type SpeechFeed, type AnalyserLike } from "./sources";
export { visemeWeights, MouthSmoother, VISEMES, SHUT, SILENCE_RMS, FULL_RMS, clamp01, type VisemeWeights } from "./visemes";
export { rmsOf, spectralCentroidOf, FFT_SIZE } from "./features";
