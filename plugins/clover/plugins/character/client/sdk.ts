// The plugin SDK's UI API, from this part's own React (as every part's `client/sdk.ts`); in the `clover` layer the build
// swaps it for the app's runtime. The voice hooks below are the stand-ins' (a gallery and the tests have no player: a quiet
// bot with no voice controls); the app's `sdk.ts` has the real ones.
import * as React from "react";
import { uiFor } from "../../shell/runtime/ui";

export const { Spot, usePluginApi } = uiFor(React);

type Feed = { subscribe(listener: (frames: readonly { t: number; rms: number; centroid: number }[]) => void): () => void; now(): number };

/** The speech a stage's renderers lip-sync to (a provider in the app; the stand-in hands its children through). */
export function AvatarSpeechProvider(props: { feed: Feed | undefined; speaking: boolean; children?: React.ReactNode }): React.ReactNode {
  return props.children ?? null;
}
export function useBotSpeech(_bot: string): { feed: Feed | undefined; speaking: boolean } {
  return { feed: undefined, speaking: false };
}
export interface VoiceControls { speaking: boolean; speakReplies: boolean; stop(): void; toggle(): void }
export function useVoiceControls(_bot: string): VoiceControls {
  return { speaking: false, speakReplies: true, stop: () => undefined, toggle: () => undefined };
}
