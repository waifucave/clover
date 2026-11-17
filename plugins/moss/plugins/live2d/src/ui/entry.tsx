// The avatar plugin's renderer spot entry (key `live2d`): the spot's props (the figure's name, its model file as a URL,
// the format) with whether it speaks and the speech feed, to the drawing.

import type { ReactElement } from "react";
import type { SpeechFeed } from "@waifucave/moss-plugin-sdk/ui";
import type { FigureControl } from "./figure-cues";
import { Live2dAvatar } from "./Live2dAvatar";

export interface AvatarSpotProps {
  /** Who the figure is, for its label. */
  name?: string;
  file: string;
  format: string;
  speaking: boolean;
  speech?: SpeechFeed;
  /** The avatar plugin's link (the entry adds it): cues in, the model's names and the figure's box out. */
  control?: FigureControl;
}

export interface Live2dEntryProps {
  props: AvatarSpotProps;
  tokens?: Readonly<Record<string, unknown>>;
  entry?: { pluginId: string; id: string; spot: string; key?: string };
}

export function Live2dAvatarEntry({ props }: Live2dEntryProps): ReactElement {
  const name = props.name ?? "";
  return <Live2dAvatar src={props.file} name={name} speech={props.speech ?? null} {...(props.control ? { control: props.control } : {})} />;
}
