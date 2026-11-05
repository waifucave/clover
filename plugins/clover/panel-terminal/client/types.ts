// The terminal panel's props: a terminal over a PTY feed. The feed's shape is a request to lane B (a
// `terminal` API beside `files`): the core runs the PTY on the session's computer and hands the view
// its output as text with styles, and takes the user's input. Until B pins it, the host passes the
// output it has (`chunks`) and gets the user's input (`onInput`).

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
  /** What the user typed, as the bytes a terminal sends (`\r` for Enter, `\x03` for Ctrl+C). */
  onInput?: (data: string) => void;
  onSelect?: (id: string) => void;
  onNew?: () => void;
  onClose?: (id: string) => void;
}
