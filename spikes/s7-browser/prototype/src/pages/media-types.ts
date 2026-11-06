// Minimal declarations for the browser APIs the stream pages use that TypeScript's DOM library lacks.

export interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
export interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): TrackProcessor;
}
