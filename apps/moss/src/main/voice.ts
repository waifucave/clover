// MOSS's own microphone button and talk key (spec §6.6, §6.10, R8, item 113): they run the active voice plugin's talk
// command, `moss.push-to-talk`, held (down, then up or cancel), from MOSS's MAIN process through the engine
// (`command.run` with `held`, which only the app's own main process sends). The recording and the playback run in the
// voice plugin's background parts on the background host: MOSS opens no microphone, records nothing and plays nothing,
// and no plugin key binding applies in its window.
//
// The window's button says "down" and "up"; main takes a "down" only right after its own press record saw the person
// press in the window (a script can't hold the microphone open). The talk key is Ctrl+Shift+Space anywhere in the
// window, read in main's own `before-input-event` (its repeats are no new press).

/** The voice plugin's talk command (MOSS Voice's `moss.push-to-talk`, §6.6). */
export const TALK_COMMAND = "moss.push-to-talk";

export type Held = "down" | "up" | "cancel";

export interface KeyInput {
  type: string;
  code?: string;
  key?: string;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  isAutoRepeat?: boolean;
}

/** Whether a key event is the talk key: Ctrl+Shift+Space (no other modifier). */
export function isTalkKey(input: KeyInput): boolean {
  return input.code === "Space" && input.control === true && input.shift === true && input.alt !== true && input.meta !== true;
}

export class Talk {
  private held = false;

  constructor(private readonly run: (held: Held) => Promise<boolean>, private readonly log: (line: string) => void = () => {}) {}

  get holding(): boolean {
    return this.held;
  }

  down(how: "button" | "key"): void {
    if (this.held) return;
    this.held = true;
    this.log(`voice: talk held (${how})`);
    void this.run("down").then((ok) => {
      if (!ok) {
        this.held = false;
        this.log("voice: the talk command didn't run (no voice plugin, or the engine didn't take it)");
      }
    });
  }

  up(): void {
    if (!this.held) return;
    this.held = false;
    void this.run("up");
  }

  /** The window lost the focus or closed mid-hold: the recording is dropped, nothing is sent. */
  cancel(): void {
    if (!this.held) return;
    this.held = false;
    void this.run("cancel");
  }
}
