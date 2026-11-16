// The `avatar` spot's entry (`avatar` keyed `vrm`): the VRM avatar as any plugin's part, on the public UI SDK alone (F2b).
// It installs the plugin's translator with the app's language (`useT`) before it draws, every render, so a language
// change reaches the next one; its mouth follows the speech the stage plays (`useAvatarSpeech`); its cues come from the
// stage's control (`useAvatarControl`). A stage that is another plugin's (F6) hands it the same through the same hooks.
import type { ReactElement } from "react";
import type { EntryProps } from "@waifucave/clover-plugin-sdk";
import { useAvatarControl, useAvatarSpeech, useT } from "@waifucave/clover-plugin-sdk/ui";
import { VrmAvatar, type VrmAvatarProps } from "../src/ui/VrmAvatar";
import { setTranslator } from "../src/strings";

export function VrmAvatarEntry({ props }: EntryProps<VrmAvatarProps>): ReactElement | null {
  setTranslator(useT());
  const { feed } = useAvatarSpeech();
  const control = useAvatarControl();
  const p = props as VrmAvatarProps;
  return <VrmAvatar {...p} speech={p.speech ?? feed ?? null} control={control} />;
}
