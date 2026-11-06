// The terminal panel's props: a terminal over a PTY feed. The feed's shape is a request to lane B (a
// `terminal` capability beside `files`, with an OK that says it runs commands on a computer, and input
// that counts only from real key presses, like a send): the core runs the PTY on the chosen computer
// (lane J) and hands the view its output as text with styles. Until B pins it, the host passes the
// output it has (`chunks`) and gets the user's keys (`onInput`) and pastes (`onPaste`) apart. The terminal
// is a code session's only: a bot's tab never shows it.
import type { Run } from "./ansi";
import type { Platform } from "./keys";

/** A run of output in one style. ANSI colours arrive already parsed into these. */
export interface TerminalChunk {
  text: string;
  style?: "error" | "warning" | "success" | "prompt" | "dim" | "bold" | "link";
}

export interface TerminalTab {
  id: string;
  title: string;
  /** The process ended; its output stays. */
  exited?: { code: number };
}

export interface TerminalPanelProps {
  tabs: TerminalTab[];
  active: string;
  /** The active terminal's output so far. */
  chunks: TerminalChunk[];
  /** The PTY's output as a terminal shows it (`ansi.ts`): lines of runs with their look. Given, it replaces `chunks`. */
  lines?: Run[][];
  /** What the user typed, key by key, as the bytes a terminal sends (`\r` for Enter, `\x03` for Ctrl+C). */
  onInput?: (data: string) => void;
  /** What the user pasted, whole: the host brackets it for the shell, and asks before a paste of several
   *  lines runs. Without it, a paste does nothing. */
  onPaste?: (text: string) => void;
  /** The trusted input event itself, a key press the terminal sends or a paste (lane B's `TerminalApi.input`): the
   *  app's runtime derives the bytes from it, so nothing the component makes up reaches the shell. When this is
   *  given, `onInput` and `onPaste` aren't called. */
  onEvent?: (event: KeyboardEvent | ClipboardEvent) => void;
  /** Which keys paste: ⌘V on macOS, Ctrl+V and Ctrl+Shift+V elsewhere. The platform it runs on when absent. */
  platform?: Platform;
}

/** The tabs, in the panel's header. */
export interface TerminalTabsProps {
  tabs: TerminalTab[];
  active: string;
  onSelect?: (id: string) => void;
  onNew?: () => void;
  onClose?: (id: string) => void;
}
