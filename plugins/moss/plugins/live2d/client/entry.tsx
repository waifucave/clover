// The `avatar` spot's entry (`avatar` keyed `live2d`): the Live2D avatar as any plugin's part, on the public UI SDK alone
// (F2b). It installs the plugin's translator with the app's language (`useT`) before it draws, every render; its mouth
// follows the speech the stage plays (`useAvatarSpeech`) and its cues the stage's control (`useAvatarControl`). A stage
// that is another plugin's (F6) hands it the same through the same hooks.
import type { ReactElement } from "react";
import type { EntryProps } from "@waifucave/moss-plugin-sdk";
import { useAvatarControl, useAvatarSpeech, useT } from "@waifucave/moss-plugin-sdk/ui";
import { Live2dAvatarEntry } from "../src/ui/entry";
import { setTranslator } from "../src/strings";

export function Live2dAvatarSpot({ props, tokens }: EntryProps<{ speech?: unknown; speaking?: boolean }>): ReactElement | null {
  setTranslator(useT());
  const { feed, speaking } = useAvatarSpeech();
  const control = useAvatarControl();
  const p = props as { speech?: unknown; speaking?: boolean };
  return <Live2dAvatarEntry props={{ ...p, speech: p.speech ?? feed, speaking: p.speaking ?? speaking, control } as never} tokens={tokens} />;
}
