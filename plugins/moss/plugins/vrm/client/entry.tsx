// The VRM renderer's entry in the avatar plugin's spot (`moss.character.renderer` keyed `vrm`), on the public UI SDK alone
// (F2b). It installs the plugin's translator with the app's language (`useT`) before it draws, every render, so a language
// change reaches the next one; its mouth follows what MOSS Voice says (`moss.voice.speech`) and its cues come from the
// avatar plugin (`figure-link.ts`). A copy of the avatar plugin that is another plugin's hands it the same, the same way.
import type { ReactElement } from "react";
import type { EntryProps } from "@waifucave/moss-plugin-sdk";
import { useT } from "@waifucave/moss-plugin-sdk/ui";
import { VrmAvatar, type VrmAvatarProps } from "../src/ui/VrmAvatar";
import { setTranslator } from "../src/strings";
import { useFigureControl, useVoiceSpeech } from "./figure-link";

export function VrmAvatarEntry({ props }: EntryProps<VrmAvatarProps & { mount?: string }>): ReactElement | null {
  setTranslator(useT());
  const { feed } = useVoiceSpeech();
  const p = props as VrmAvatarProps & { mount?: string };
  const control = useFigureControl(p.mount);
  return <VrmAvatar {...p} speech={p.speech ?? feed} control={control as never} />;
}
