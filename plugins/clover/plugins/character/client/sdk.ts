// The plugin SDK's UI API, from this part's own React (as every part's `client/sdk.ts`); in the `clover` layer the build
// swaps it for the app's runtime.
import * as React from "react";
import { uiFor } from "../../shell/runtime/ui";
export { AvatarControlHub, cleanAvatarCue } from "../../shell/runtime/ui";

export const { Spot, usePluginApi, useCore } = uiFor(React);

/** The hub a stage's renderers take cues from (a provider in the app; the stand-in hands its children through). */
export function AvatarControlProvider(props: { hub: unknown; children?: React.ReactNode }): React.ReactNode {
  return props.children ?? null;
}

type Feed = { subscribe(listener: (frames: readonly { t: number; rms: number; centroid: number }[]) => void): () => void; now(): number };
const SpeechContext = React.createContext<{ feed: Feed | undefined; speaking: boolean }>({ feed: undefined, speaking: false });

/** The speech a stage's renderers lip-sync to (a provider in the app; the stand-in's holds it for `useAvatarSpeech`, which a test's renderer reads). */
export function AvatarSpeechProvider(props: { feed: Feed | undefined; speaking: boolean; children?: React.ReactNode }): React.ReactNode {
  return React.createElement(SpeechContext.Provider, { value: { feed: props.feed, speaking: props.speaking } }, props.children);
}
export function useAvatarSpeech(): { feed: Feed | undefined; speaking: boolean } {
  return React.useContext(SpeechContext);
}
