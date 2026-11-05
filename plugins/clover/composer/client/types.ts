import type { ReactNode } from "react";

// The composer's props contract: plain data and callbacks the host routes back (spec §5.5). The
// draft is the host's (controlled), so it survives a remount and waits while the bot is asleep.

export interface ComposerAttachment {
  id: string;
  kind: "image" | "file";
  name: string;
  /** Folder-tree path (`home/Studio/…`, spec §9.1), shown on hover. */
  path?: string;
  /** An asset URL the host resolved for an image's thumbnail. */
  previewUrl?: string;
}

export interface ComposerMessage {
  text: string;
  attachments: ComposerAttachment[];
}

export interface ComposerModel {
  id: string;
  label: string;
  /** Where it runs: the provider, or "your subscription". */
  detail?: string;
}

/** The bot's model and effort, changeable at any time; the next turn uses them (spec §6.3). */
export interface ComposerModelChoice {
  model: string;
  effort?: string;
  models: ComposerModel[];
  efforts?: string[];
  onChange: (choice: { model: string; effort?: string }) => void;
}

/** Push-to-talk (spec §6.6): the app records while the button is held and hands the audio to the
 *  bot's voice plugin. The composer only says when the hold starts and ends. */
export interface ComposerVoice {
  listening: boolean;
  onPressStart: () => void;
  onPressEnd: () => void;
}

/** The composer's buttons, keyed like the `composer.action` spot (spec §5.5). */
export type ComposerActionId = "attach" | "model" | "voice" | "send" | "stop";

export interface ComposerProps {
  botName: string;
  value: string;
  onChange: (value: string) => void;
  /** Called inside the key press or click that sent, so the app can count the send as the user's
   *  (spec §5.5: one hardware key press or click covers one send). */
  onSend: (message: ComposerMessage) => void;
  attachments?: ComposerAttachment[];
  onAttach?: () => void;
  onRemoveAttachment?: (id: string) => void;
  /** Files pasted or dropped into the composer. */
  onAddFiles?: (files: File[]) => void;
  /** The bot's main conversation has a turn running: a message sent now interrupts it (spec §6.4). */
  running?: boolean;
  onStop?: () => void;
  /** Set while no computer running the bot can be reached: the draft stays, sending waits (spec
   *  §6.4: sending needs a live connection). */
  asleep?: { reason: string };
  model?: ComposerModelChoice;
  voice?: ComposerVoice;
  /** At most this many attachments ride one message. */
  maxAttachments?: number;
  placeholder?: string;
  autoFocus?: boolean;
  /** The `composer.action` spot: draw one button another way, or not at all (null). */
  renderAction?: (id: ComposerActionId, standard: ReactNode) => ReactNode;
  /** Open the model menu at first (the gallery's still frame of it). */
  initialMenuOpen?: boolean;
}
