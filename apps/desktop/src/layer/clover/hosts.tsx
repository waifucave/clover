// The avatars' hosts, from the app's runtime: they have no host context and hear nothing of the app; their words come from each
// child's own fixed table. (The island and the pill read their hosts from the SDK's hooks inside their own plugins.)
import type { ReactElement } from "react";
import { useAvatarControl, useAvatarSpeech, useT } from "@waifucave/clover-plugin-sdk/ui";
import { VrmAvatar, setTranslator as setVrmTranslator } from "@clover-child/vrm";
import { Live2dAvatarEntry, setTranslator as setLive2dTranslator } from "@clover-child/live2d";

/* The avatars -------------------------------------------------------------------------------------------------------
 * They have no host context and hear nothing of the app; their words come from each child's own fixed table. The
 * wrapper's single job: install the child's translator with the app's `useT()` before the avatar draws, every render,
 * so a language change reaches the next one (G-M3's `setTranslator`, the same hook lane F's parts get). */

export function VrmAvatarHosted({ props }: { props: unknown; tokens?: Readonly<Record<string, unknown>> }): ReactElement | null {
  const t = useT();
  setVrmTranslator(t);
  // The speech the stage plays (the character stage's provider): the mouth follows it.
  const { feed } = useAvatarSpeech();
  const control = useAvatarControl();
  const p = props as import("@clover-child/vrm").VrmAvatarProps;
  return <VrmAvatar {...p} speech={p.speech ?? feed ?? null} control={control} />;
}

export function Live2dAvatarHosted({ props, tokens }: { props: unknown; tokens?: Readonly<Record<string, unknown>> }): ReactElement | null {
  const t = useT();
  setLive2dTranslator(t);
  const { feed, speaking } = useAvatarSpeech();
  const control = useAvatarControl();
  const p = props as { speech?: unknown; speaking?: boolean };
  return <Live2dAvatarEntry props={{ ...p, speech: p.speech ?? feed, speaking: p.speaking ?? speaking, control } as never} tokens={tokens} />;
}

