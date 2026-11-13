// A plugin command's default key (`commands[].key`, §5.4) pressed in the app: a table kept ready from the daemon's
// `command.list` (the core's `keyState` says which chords are bound: the app's own and clashing ones are not), read
// synchronously on each press because `before-input-event` must be answered in the same turn. Pure but for the one
// request that fills it, so the matching is unit-tested.
import { canonicalChord, chordOfPress, type KeyPress, type KeyPlatform } from "@waifucave/clover-plugin-sdk";
import { liveCommands } from "./ui/composer-calls";

export class PluginKeys {
  #table = new Map<string, string>();
  constructor(private readonly platform: KeyPlatform) {}

  /** Replaces the table from `command.list` rows already narrowed to running plugins' commands. */
  set(rows: readonly { name: string; key?: unknown; keyState?: unknown }[]): void {
    const next = new Map<string, string>();
    for (const r of rows) {
      const st = r.keyState as { state?: unknown; chord?: unknown } | undefined;
      if (st?.state !== "bound" || typeof r.key !== "string") continue;
      const canon = canonicalChord(r.key, this.platform);
      if (canon !== undefined) next.set(canon, r.name);
    }
    this.#table = next;
    this.onSet?.(next.size);
  }

  /** Told the table's size each time it is filled (the app's log). */
  onSet?: (size: number) => void;

  get size(): number {
    return this.#table.size;
  }

  /** The command a press runs, or undefined: a key-down that isn't a repeat, whose chord a running plugin's command is bound to. */
  /** The chord a press makes (for the log of a press nothing was bound to, in a test build). */
  chordOf(press: KeyPress): string | undefined {
    return chordOfPress(press);
  }

  match(press: KeyPress & { type: string; isAutoRepeat?: boolean }): string | undefined {
    if ((press.type !== "keyDown" && press.type !== "rawKeyDown") || press.isAutoRepeat === true || this.#table.size === 0) return undefined;
    const chord = chordOfPress(press);
    return chord === undefined ? undefined : this.#table.get(chord);
  }

  /** Fills the table from the daemon: only commands of plugins that are on, OK'd and running count. */
  async refresh(asApp: (method: string, params: unknown) => Promise<unknown>): Promise<void> {
    this.set((await liveCommands(asApp)).map((l) => l.cmd as { name: string; key?: unknown; keyState?: unknown }));
  }
}
