// MOSS's own microphone button and talk key (spec §6.6, §6.10, R8, item 113): they run the active voice plugin's talk
// command, held (down, then up or cancel), from MOSS's MAIN process through the engine (`command.run` with `held`,
// which only the app's own main process sends). The recording and the playback run in the voice plugin's background
// parts on the background host: MOSS opens no microphone, records nothing and plays nothing, and no plugin key binding
// applies in its window.
//
// Which command that is comes from the plugins' own declarations, never a name in MOSS (`talkCommandOf`): the active
// filler of the voice point (the platform's one-at-a-time `Voice` picker, `point.active.list`), and that filler's
// plugin's held command (`command.list`, `hold: true`); where the active filler declares none (a mode that only speaks
// and hears another way), the held command of the plugin that declares the voice point. With neither, the microphone
// says why and does nothing.
//
// The window's button says "down" and "up"; main takes a "down" only right after its own press record saw the person
// press in the window (a script can't hold the microphone open). The talk key is Ctrl+Shift+Space anywhere in the
// window, read in main's own `before-input-event` (its repeats are no new press).

/** The voice point (§6.6): the one-at-a-time point whose active filler is the voice bots speak and listen with. Its name
 *  is the platform's (MOSS Voice declares it); MOSS reads which plugin fills it, never which command to run. */
export const VOICE_POINT = "moss.voice.modes";

export type Held = "down" | "up" | "cancel";

/** The talk command, or why there is none, in words the window shows. */
export type TalkCommand = { command: string; pluginId: string } | { why: string };

interface PointRow { point: string; declaredBy: "core" | string; active?: { pluginId: string } }
interface CommandRow { name: string; pluginId: string; hold?: true }

/** The talk command from the plugins' declarations (above). */
export function talkCommandOf(points: readonly PointRow[] | undefined, commands: readonly CommandRow[] | undefined): TalkCommand {
  if (points === undefined || commands === undefined) return { why: "Talking waits for the engine's voice plugin list." };
  const voice = points.find((p) => p.point === VOICE_POINT);
  if (voice === undefined) return { why: "No voice plugin is on, so there's nothing to talk to. Turn one on in Plugins." };
  const held = (pluginId: string | undefined) => pluginId === undefined ? undefined : commands.find((c) => c.pluginId === pluginId && c.hold === true);
  const found = held(voice.active?.pluginId) ?? held(voice.declaredBy === "core" ? undefined : voice.declaredBy);
  if (found === undefined) return { why: "The voice plugin on now has no talk command." };
  return { command: found.name, pluginId: found.pluginId };
}

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
        this.log("voice: the talk command didn't run (no voice plugin's talk command, or the engine didn't take it)");
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
