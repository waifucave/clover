// The Live2D renderer's entry in the avatar plugin's spot (`moss.character.renderer` keyed `live2d`), on the public UI SDK
// alone (F2b). It installs the plugin's translator with the app's language (`useT`) before it draws, every render; its
// mouth follows what MOSS Voice says (`moss.voice.speech`) and its cues come from the avatar plugin (`figure-link.ts`).
// A copy of the avatar plugin that is another plugin's hands it the same, the same way.
import type { ReactElement } from "react";
import type { EntryProps } from "@waifucave/moss-plugin-sdk";
import { useT } from "@waifucave/moss-plugin-sdk/ui";
import { Live2dAvatarEntry } from "../src/ui/entry";
import { setTranslator } from "../src/strings";
import { useFigureControl, useVoiceSpeech } from "./figure-link";

export function Live2dAvatarSpot({ props, tokens }: EntryProps<{ speech?: unknown; speaking?: boolean; mount?: string }>): ReactElement | null {
  setTranslator(useT());
  const { feed, speaking } = useVoiceSpeech();
  const p = props as { speech?: unknown; speaking?: boolean; mount?: string };
  const control = useFigureControl(p.mount);
  return <Live2dAvatarEntry props={{ ...p, speech: p.speech ?? feed, speaking: p.speaking ?? speaking, control } as never} tokens={tokens} />;
}
