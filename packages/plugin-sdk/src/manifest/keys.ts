// The keys the app keeps (lane E): its own shortcuts plus the Edit menu's, in the manifest's chord grammar
// (`mod+…`, KEY_CHORD_RE). Lane F's palette checks user bindings against this list, and the manifest validator
// refuses a command `key` that lands on one. The desktop imports the list from here instead of keeping its own.
export const APP_KEYS = ["mod+q", "mod+w", "mod+,", "mod+h", "mod+alt+h", "mod+m"] as const;

/** Electron's Edit-menu keys (the `editMenu` role's own accelerators, both platforms' redo, Paste and Match Style,
 *  and macOS's Emoji & Symbols): reserved with the app's own, so a layer or a plugin command never takes them
 *  silently. */
export const EDIT_MENU_KEYS = ["mod+z", "mod+shift+z", "mod+y", "mod+x", "mod+c", "mod+v", "mod+shift+v", "mod+alt+shift+v", "mod+a", "ctrl+mod+space"] as const;

/** Every key the app keeps: its own plus the Edit menu's. */
export const RESERVED_KEYS: readonly string[] = [...APP_KEYS, ...EDIT_MENU_KEYS];

/** A chord in canonical form: `mod` resolved for the platform, modifiers sorted, the key lower-cased. `mod+shift+K`
 *  on macOS and `shift+mod+z` anywhere spell the same chord. Throws on an empty chord, an unknown modifier or a
 *  missing key (the manifest schema polices the grammar first; this is the comparison form). */
export function normalizeChord(chord: string, platform: "darwin" | "win32" | "linux" | (string & {})): string {
  const bits = chord.split("+").map((b) => b.toLowerCase());
  const key = bits.at(-1);
  if (key === undefined || key === "") throw new Error(`a shortcut names a key (${chord})`);
  const mods = bits.slice(0, -1).map((m) => (m === "mod" ? (platform === "darwin" ? "meta" : "ctrl") : m));
  for (const m of mods) {
    if (m !== "ctrl" && m !== "meta" && m !== "alt" && m !== "shift") throw new Error(`a shortcut's modifier is ctrl, meta, alt, shift or mod (${chord})`);
  }
  return [...new Set(mods)].sort().concat(key).join("+");
}

/** The reserved list normalized per platform side, for the validator's comparison. */
const RESERVED_BY_PLATFORM: Record<"darwin" | "other", readonly { raw: string; norm: string }[]> = {
  darwin: RESERVED_KEYS.map((raw) => ({ raw, norm: normalizeChord(raw, "darwin") })),
  other: RESERVED_KEYS.map((raw) => ({ raw, norm: normalizeChord(raw, "win32") })),
};

/** A command `key` that lands on a reserved chord, in the reserved spelling, whatever its own spelling (`ctrl+c`
 *  and any modifier order count); undefined when free. Both platform sides count, so a key refused anywhere is
 *  refused everywhere. A chord that won't normalise is reserved too: refused, never silently taken. */
export function reservedCommandKey(key: string): string | undefined {
  let norm: { darwin: string; other: string };
  try {
    norm = { darwin: normalizeChord(key, "darwin"), other: normalizeChord(key, "win32") };
  } catch {
    return key;
  }
  for (const side of ["darwin", "other"] as const) {
    const hit = RESERVED_BY_PLATFORM[side].find((r) => r.norm === norm[side]);
    if (hit !== undefined) return hit.raw;
  }
  return undefined;
}
