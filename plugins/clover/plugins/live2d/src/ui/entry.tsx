// The `avatar` spot's entry (key `live2d`): lane B's `EntryProps` with the spot's props — the bot, its avatar file
// (a URL inside the bot's plugin), the format, whether it speaks, and the speech feed — to the avatar.

import type { ReactElement } from "react";
import type { SpeechFeed } from "@waifucave/clover-plugin-vrm/lipsync";
import { Live2dAvatar } from "./Live2dAvatar";

export interface AvatarSpotProps {
  bot: { id: string; name?: string } | string;
  file: string;
  format: string;
  speaking: boolean;
  speech?: SpeechFeed;
}

export interface Live2dEntryProps {
  props: AvatarSpotProps;
  tokens?: Readonly<Record<string, unknown>>;
  entry?: { pluginId: string; id: string; spot: string; key?: string };
}

export function Live2dAvatarEntry({ props }: Live2dEntryProps): ReactElement {
  const name = typeof props.bot === "string" ? props.bot : (props.bot.name ?? props.bot.id);
  return <Live2dAvatar src={props.file} name={name} speech={props.speech ?? null} />;
}
