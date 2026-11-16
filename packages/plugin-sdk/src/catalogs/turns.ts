// Turns (spec §5.4 "Turns"): the one-at-a-time queues the platform runs, and their names. A turn's name is
// `<plugin id>/<name>`, the plugin's own (another plugin may take it only when the owner lists `<name>` in its
// manifest's `contributes.turns`), or a device turn from the catalog below (`device/…`), behind the capability it names.
// The queue itself is the daemon's (`packages/core/src/turns/`): first come, first served, one holder per name.

/** A device-wide turn: one queue for every plugin on this device, behind a capability. */
export interface DeviceTurnInfo {
  readonly name: `device/${string}`;
  /** The capability a plugin holds to take, read or watch it. */
  readonly capability?: string;
  readonly doc: string;
}

/** The device turns. More are added as features need them, as data. */
export const DEVICE_TURNS: readonly DeviceTurnInfo[] = [
  { name: "device/speech", capability: "audio",
    doc: "One voice at a time on this device: a plugin takes it before its sound starts and says done when the sound has ended." },
  { name: "device/microphone", capability: "microphone",
    doc: "One recording at a time on this device: a plugin takes it before it opens the microphone and says done when it has closed it." },
];

/** A turn's limit when the taker names none. */
export const TURN_LIMIT_DEFAULT_MS = 60_000;
/** The longest a turn may be held, extensions included. */
export const TURN_LIMIT_MAX_MS = 10 * 60_000;
/** The shortest limit a taker may name. */
export const TURN_LIMIT_MIN_MS = 100;
/** A take's note, at most (for the daemon's log and `state`). */
export const TURN_NOTE_MAX = 200;
/** The part of a turn's name after its owner (`contributes.turns`' `name`). */
export const TURN_LOCAL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A device turn by its name, or undefined. */
export function deviceTurn(name: string): DeviceTurnInfo | undefined {
  return DEVICE_TURNS.find((t) => t.name === name);
}

/** What a turn's name says: a device turn, or `<owner>/<local>` (the owner is everything before the last `/`, so a
 *  child plugin's id works as an owner), or undefined when it is neither. */
export function parseTurnName(name: string): { device: DeviceTurnInfo } | { owner: string; local: string } | undefined {
  if (typeof name !== "string" || name.length === 0 || name.length > 256) return undefined;
  if (name.startsWith("device/")) {
    const device = deviceTurn(name);
    return device === undefined ? undefined : { device };
  }
  const at = name.lastIndexOf("/");
  if (at <= 0) return undefined;
  const local = name.slice(at + 1);
  if (!TURN_LOCAL_NAME.test(local)) return undefined;
  return { owner: name.slice(0, at), local };
}
