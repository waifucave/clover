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
export type ComposerActionId = "attach" | "model" | "level" | "voice" | "send" | "stop";

/** One of the computer's approval levels (spec §9.1). */
export interface ComposerLevelOption {
  id: string;
  label: string;
  detail?: string;
}

/** The approval level the bot works at on this computer, and the others to pick from. A change goes to
 *  the host, which makes it (spec §5.5: from any layer but `clover`'s it is a sealed card). */
export interface ComposerLevel {
  level: string;
  levels: ComposerLevelOption[];
  onChange: (level: string) => void;
}

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
  /** The approval-level pill. */
  level?: ComposerLevel;
  voice?: ComposerVoice;
  /** A sealed approval card waits in the conversation: menus close and the pills wait, so nothing of
   *  the composer's competes with the card (review item 1). */
  cardPending?: boolean;
  /** At most this many attachments ride one message. */
  maxAttachments?: number;
  placeholder?: string;
  autoFocus?: boolean;
  /** The `composer.action` spot: draw one button another way, or not at all (null). */
  renderAction?: (id: ComposerActionId, standard: ReactNode) => ReactNode;
  /** Open a menu at first (the gallery's still frame of it). */
  initialMenu?: "model" | "level";
}
