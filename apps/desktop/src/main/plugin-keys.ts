// A plugin command's default key (`commands[].key`, §5.4) pressed in the app: a table kept ready from the daemon's
// `command.list` (the core's `keyState` says which chords are bound: the app's own and clashing ones are not), read
// synchronously on each press because `before-input-event` must be answered in the same turn. Pure but for the one
// request that fills it, so the matching is unit-tested.
//
// A held binding (`commands[].hold`) asks for the key's release too (`hold`, below): per window, the chord's down (never a
// repeat) starts it, and the first up of its key or of one of its modifiers ends it, once; another key's up is not it.
// Its down and repeats are NOT handled in `before-input-event`: Chromium drops every key-up after a key-down the browser
// handled (until the next key-down), so a binding consumed there could never hear its release. They go on to the focused
// frame, where the app's preload keeps them from the page (`swallows`: a synchronous ask from its capture-phase keydown).
import { canonicalChord, chordOfPress, type HoldPhase, type KeyPress, type KeyPlatform } from "@waifucave/moss-plugin-sdk";
import { liveCommands } from "./ui/composer-calls";

/** Whether a press may run a plugin's command at all: not while a sealed frame (an approval or OK card, whose buttons and
 *  fields are the user's alone) has the focus, and not while the app's own key dialog (a secret field) is open. The key
 *  goes where the focus is and no command runs. */
export function keysMayRun(focus: { frameUrl: string | null | undefined; secureOpen: boolean }): boolean {
  if (focus.secureOpen) return false;
  return !(typeof focus.frameUrl === "string" && focus.frameUrl.startsWith("moss-sealed://"));
}

/** A bound key: its command, the command's plugin, and whether it asks for the release too. */
export interface BoundKey {
  name: string;
  pluginId: string;
  hold: boolean;
  /** Canonical (`ctrl+shift+space`). */
  chord: string;
}

/** What a held binding's key event comes to: deliver `phase` to its command (none: nothing to deliver; `up` is the user's
 *  release, `cancel` a hold that ended with none), and whether main consumes the event (only its key's up: a down or repeat
 *  goes on, for the preload to keep from the page). `passOn`: the event is still an ordinary press after that (a stale
 *  hold's end). */
export interface HoldStep {
  binding: BoundKey;
  phase?: HoldPhase;
  consume: boolean;
  passOn?: boolean;
}

/** The modifier keys a key event names (`input.key`), as a chord writes them. */
const MODIFIER_KEYS: Record<string, string> = { Control: "ctrl", Shift: "shift", Alt: "alt", Meta: "meta" };

/** The key of a press without its modifiers (`space`, `k`), or undefined for a lone modifier. */
const keyPart = (p: KeyPress): string | undefined => chordOfPress({ key: p.key, ...(p.code !== undefined ? { code: p.code } : {}), control: false, meta: false, alt: false, shift: false });

/** One window's held binding: its key and modifiers; `ended` once a modifier's up ended it while its key is still down
 *  (that key's repeats and up are still the binding's, so the chord never types). */
interface Held {
  binding: BoundKey;
  key: string;
  mods: Set<string>;
  ended: boolean;
}

export class PluginKeys {
  #table = new Map<string, BoundKey>();
  #held = new Map<number, Held>();
  constructor(private readonly platform: KeyPlatform) {}

  /** Replaces the table from `command.list` rows already narrowed to running plugins' commands. */
  set(rows: readonly { name: string; pluginId?: unknown; key?: unknown; keyState?: unknown; hold?: unknown }[]): void {
    const next = new Map<string, BoundKey>();
    for (const r of rows) {
      const st = r.keyState as { state?: unknown; chord?: unknown } | undefined;
      if (st?.state !== "bound" || typeof r.key !== "string") continue;
      const canon = canonicalChord(r.key, this.platform);
      if (canon !== undefined) next.set(canon, { name: r.name, pluginId: typeof r.pluginId === "string" ? r.pluginId : "", hold: r.hold === true, chord: canon });
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
    return this.binding(press)?.name;
  }

  /** The binding a fresh key-down (not a repeat) makes, or undefined. */
  binding(press: KeyPress & { type: string; isAutoRepeat?: boolean }): BoundKey | undefined {
    if ((press.type !== "keyDown" && press.type !== "rawKeyDown") || press.isAutoRepeat === true || this.#table.size === 0) return undefined;
    const chord = chordOfPress(press);
    return chord === undefined ? undefined : this.#table.get(chord);
  }

  /** A key event in window `windowId`, for the held bindings, before anything else reads it: undefined when it is none of
   *  theirs (the press goes on as any other). `mayRun` is `keysMayRun` for the focus now: a hold starts only where a
   *  command's key may run, and once started its release is always heard.
   *  * The chord's down (not a repeat) starts the hold: `down` (not consumed here: the preload keeps it from the page).
   *  * While held, the chord's key going down again (a repeat) is nothing new: nothing delivered (the preload keeps it too).
   *  * The up of its key ends it (`up`, consumed); so does the up of one of its modifiers, or any up whose modifier state has
   *    lost one of them (`up`, not consumed, so the page sees the modifier let go); its key's later repeats and up are still
   *    kept from the page. Another key's up, its modifiers still down, is not it.
   *  * A stale hold (its up never came: the Mac slept, no blur): the chord's key going down afresh (not a repeat) without all
   *    of its modifiers ends it as a `cancel` (no release), is not kept from the page, and goes on as an ordinary press. */
  hold(windowId: number, input: KeyPress & { type: string; isAutoRepeat?: boolean }, mayRun: boolean): HoldStep | undefined {
    const h = this.#held.get(windowId);
    const down = input.type === "keyDown" || input.type === "rawKeyDown";
    if (down) {
      if (h !== undefined && keyPart(input) === h.key) {
        if (input.isAutoRepeat === true) return { binding: h.binding, consume: false };
        if (!h.ended) {
          const isDown: Record<string, boolean> = { ctrl: input.control, shift: input.shift, alt: input.alt, meta: input.meta };
          // The chord again while held (an up that never came, the chord pressed anew): no new press.
          if ([...h.mods].every((m) => isDown[m] === true)) return { binding: h.binding, consume: false };
          this.#held.delete(windowId);
          return { binding: h.binding, phase: "cancel", consume: false, passOn: true };
        }
      }
      // Any other press: what was left of an ended hold goes (the press goes on as any other).
      if (h?.ended === true) this.#held.delete(windowId);
      if (h !== undefined && !h.ended) return undefined;
      const b = mayRun ? this.binding(input) : undefined;
      if (b === undefined || !b.hold) return undefined;
      const parts = b.chord.split("+");
      this.#held.set(windowId, { binding: b, key: parts.pop()!, mods: new Set(parts), ended: false });
      return { binding: b, phase: "down", consume: false };
    }
    if (input.type !== "keyUp" || h === undefined) return undefined;
    if (keyPart(input) === h.key) {
      this.#held.delete(windowId);
      return h.ended ? { binding: h.binding, consume: true } : { binding: h.binding, phase: "up", consume: true };
    }
    // One of its modifiers let go: that key's up, or an up whose modifier state no longer has one of them (a synthesized
    // modifier's up may name no key Chromium knows, but its state says which modifiers are still down).
    const mod = MODIFIER_KEYS[input.key];
    const still: Record<string, boolean> = { ctrl: input.control, shift: input.shift, alt: input.alt, meta: input.meta };
    if (!h.ended && ((mod !== undefined && h.mods.has(mod)) || [...h.mods].some((m) => still[m] !== true))) {
      h.ended = true;
      return { binding: h.binding, phase: "up", consume: false };
    }
    return undefined;
  }

  /** Whether the preload keeps a key-down from the page: one of the held binding's key (its down, a repeat, or a repeat
   *  after a modifier ended it) in that window. Asked after main's `before-input-event` ran for the same event. */
  swallows(windowId: number, down: { key: string; code?: string }): boolean {
    const h = this.#held.get(windowId);
    return h !== undefined && keyPart({ key: down.key, ...(down.code !== undefined ? { code: down.code } : {}), control: false, meta: false, alt: false, shift: false }) === h.key;
  }

  /** The held binding of a window, if one is held now. */
  holding(windowId: number): string | undefined {
    const h = this.#held.get(windowId);
    return h === undefined || h.ended ? undefined : h.binding.name;
  }

  /** The window lost the focus or closed: a hold still on ends with no release of the user's (a `cancel`, which counts for
   *  nothing). */
  cancel(windowId: number): HoldStep | undefined {
    const h = this.#held.get(windowId);
    this.#held.delete(windowId);
    return h === undefined || h.ended ? undefined : { binding: h.binding, phase: "cancel", consume: false };
  }

  /** Fills the table from the daemon: only commands of plugins that are on, OK'd and running count. */
  async refresh(asApp: (method: string, params: unknown) => Promise<unknown>): Promise<void> {
    this.set((await liveCommands(asApp)).map((l) => l.cmd as { name: string; pluginId?: unknown; key?: unknown; keyState?: unknown; hold?: unknown }));
  }
}
