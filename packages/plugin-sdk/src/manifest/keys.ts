// A command's default key chord (`commands[].key`, §5.4): what it means on a press, and who gets it. Pure, so the
// daemon (`command.list`'s `keyState`), the app's main process (the press that runs the command) and the tests
// all read one resolver.
//
// * A chord is canonical as modifiers in the order ctrl, alt, shift, meta, then the key: `mod` becomes meta on macOS and
//   ctrl elsewhere, so `mod+k` and `meta+k` are one chord on a Mac.
// * The app's own chords win (`APP_CHORDS`, the shortcuts and menu accelerators the window already answers); a plugin
//   chord that equals one is not bound.
// * A chord with no ctrl, alt, meta or `mod` (a bare letter, `shift+a`, `enter`) would take typing from the composer: not
//   bound. A function key stands alone. On macOS `alt+<letter>` (and `alt+shift+<letter>`) types a character, so alt alone
//   does not count there: the chord needs ctrl or meta (or is a function key).
// * Two commands on one chord: neither is bound, and each says who it clashes with.

export type KeyPlatform = "darwin" | "win32" | "linux" | NodeJS.Platform;

/** The chords the app answers before any page, as written in a manifest (`mod` = ⌘ on macOS, Ctrl elsewhere). */
export const APP_CHORDS: readonly { chord: string; what: string; mac?: true }[] = [
  { chord: "mod+q", what: "Quit" },
  { chord: "mod+w", what: "Close window" },
  { chord: "mod+,", what: "Settings" },
  { chord: "mod+x", what: "Cut" },
  { chord: "mod+c", what: "Copy" },
  { chord: "mod+v", what: "Paste" },
  { chord: "mod+a", what: "Select all" },
  { chord: "mod+z", what: "Undo" },
  { chord: "mod+shift+z", what: "Redo" },
  { chord: "mod+m", what: "Minimise", mac: true },
  { chord: "mod+h", what: "Hide", mac: true },
  { chord: "mod+alt+h", what: "Hide others", mac: true },
  // What a window of this app answers by itself on Windows and Linux (Chromium's own), reserved on every platform so a
  // plugin's key never shadows them there.
  { chord: "f5", what: "Reload" },
  { chord: "mod+r", what: "Reload" },
  { chord: "mod+shift+r", what: "Reload, skipping the cache" },
  { chord: "f12", what: "Developer tools" },
  { chord: "ctrl+shift+i", what: "Developer tools" },
  { chord: "mod+alt+i", what: "Developer tools" },
  { chord: "f11", what: "Full screen" },
  { chord: "mod+0", what: "Reset zoom" },
  { chord: "mod+=", what: "Zoom in" },
  { chord: "mod+-", what: "Zoom out" },
];

const ORDER = ["ctrl", "alt", "shift", "meta"] as const;

/** A manifest chord as its canonical form on `platform`, or undefined when it isn't one. */
export function canonicalChord(chord: string, platform: KeyPlatform): string | undefined {
  const parts = chord.split("+");
  // `+` itself is never a key here (KEY_CHORD_RE has no `+`), so splitting is safe; an empty key is not a chord.
  const key = parts.pop();
  if (key === undefined || key === "") return undefined;
  const mods = new Set<string>();
  for (const p of parts) {
    if (p === "mod") mods.add(platform === "darwin" ? "meta" : "ctrl");
    else if ((ORDER as readonly string[]).includes(p)) mods.add(p);
    else return undefined;
  }
  return [...ORDER.filter((m) => mods.has(m)), key].join("+");
}

const CODE_KEYS: Record<string, string> = {
  Enter: "enter", NumpadEnter: "enter", Escape: "escape", Space: "space", Tab: "tab", Backspace: "backspace", Delete: "delete",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backquote: "`", Minus: "-", Equal: "=",
};

export interface KeyPress {
  key: string;
  /** The physical key (`KeyA`, `Digit1`, `Comma`): what is matched when it is there, since a shift or alt changes `key`. */
  code?: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/** The canonical chord a press makes, or undefined for a press that is no chord's key (a lone modifier, a dead key). */
export function chordOfPress(p: KeyPress): string | undefined {
  let key: string | undefined;
  const code = p.code ?? "";
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code.toLowerCase();
  else if (code in CODE_KEYS) key = CODE_KEYS[code];
  else {
    const k = p.key.length === 1 ? p.key.toLowerCase() : p.key;
    if (/^[a-z0-9]$/.test(k)) key = k;
    else if (/^F([1-9]|1[0-2])$/.test(k)) key = k.toLowerCase();
    else key = Object.values(CODE_KEYS).includes(k.toLowerCase()) ? k.toLowerCase() : k === " " ? "space" : k.startsWith("Arrow") ? k.slice(5).toLowerCase() : undefined;
  }
  if (key === undefined) return undefined;
  const mods = new Set<string>();
  if (p.control) mods.add("ctrl");
  if (p.alt) mods.add("alt");
  if (p.shift) mods.add("shift");
  if (p.meta) mods.add("meta");
  return [...ORDER.filter((m) => mods.has(m)), key].join("+");
}

/** Whether a canonical chord has a modifier that keeps it from typing, or is a function key. On macOS alt types characters
 *  (`alt+e`, `alt+shift+k`), so there only ctrl or meta count. */
function hasRealModifier(canonical: string, platform: KeyPlatform): boolean {
  const parts = canonical.split("+");
  const key = parts[parts.length - 1]!;
  const typing = platform === "darwin" ? ["ctrl", "meta"] : ["ctrl", "alt", "meta"];
  return parts.some((m) => typing.includes(m)) || /^f([1-9]|1[0-2])$/.test(key);
}

/** The app's chords on `platform`, canonical, with what each does. */
export function appChords(platform: KeyPlatform): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of APP_CHORDS) {
    if (a.mac === true && platform !== "darwin") continue;
    const c = canonicalChord(a.chord, platform);
    if (c !== undefined) out.set(c, a.what);
  }
  return out;
}

/** What becomes of one command's key. */
export type KeyState =
  | { state: "bound"; chord: string }
  | { state: "app"; what: string }
  | { state: "bare" }
  | { state: "clash"; with: string[] };

/** The state of each command that names a `key`, by command name; commands without a key are left out. */
export function resolveKeys(commands: readonly { name: string; key?: string }[], platform: KeyPlatform): Map<string, KeyState> {
  const app = appChords(platform);
  const out = new Map<string, KeyState>();
  const byChord = new Map<string, string[]>();
  for (const c of commands) {
    if (c.key === undefined) continue;
    const canon = canonicalChord(c.key, platform);
    if (canon === undefined) continue;
    const what = app.get(canon);
    if (what !== undefined) out.set(c.name, { state: "app", what });
    else if (!hasRealModifier(canon, platform)) out.set(c.name, { state: "bare" });
    else byChord.set(canon, [...(byChord.get(canon) ?? []), c.name]);
  }
  for (const [chord, names] of byChord) {
    for (const n of names) {
      out.set(n, names.length === 1 ? { state: "bound", chord } : { state: "clash", with: names.filter((x) => x !== n) });
    }
  }
  return out;
}
