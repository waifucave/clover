// Shortcuts (spec §5.2 "Commands", S9): a plugin command's `key` is a default shortcut, bound while a Clover window has
// the focus; the user can rebind it; a core shortcut or the user's own binding wins over it. The app's main process owns
// the app's shortcuts ahead of every layer (⌘Q, ⌘W, ⌘, on macOS; Ctrl elsewhere); the shell adds the palette's (⌘K /
// Ctrl+K). A key is written `Mod+Shift+T`: `Mod` is ⌘ on macOS and Ctrl elsewhere (Electron's `CmdOrCtrl` reads the
// same), then Ctrl, Alt (Option), Shift and Cmd (Meta), then one key. Pure, so it is unit-tested.

export interface Chord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

export type Platform = "mac" | "other";

export const currentPlatform = (): Platform => (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other");

const MODS: Record<string, keyof Omit<Chord, "key">> = {
  mod: "mod",
  cmdorctrl: "mod",
  commandorcontrol: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
};

/** Reads a key; undefined when it isn't one (no key, or an unknown modifier). */
export function parseChord(text: string): Chord | undefined {
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  if (text.endsWith("++")) parts.push("+");
  const key = parts.pop();
  if (!key) return undefined;
  const chord: Chord = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: named(key.toLowerCase()) };
  for (const p of parts) {
    const m = MODS[p.toLowerCase()];
    if (!m) return undefined;
    chord[m] = true;
  }
  return chord;
}

/** The chord as the OS's own keys: `mod` becomes ⌘ on macOS, Ctrl elsewhere. */
function resolved(c: Chord, platform: Platform): Omit<Chord, "mod"> {
  return { ctrl: c.ctrl || (c.mod && platform === "other"), meta: c.meta || (c.mod && platform === "mac"), alt: c.alt, shift: c.shift, key: c.key };
}

export function sameChord(a: Chord, b: Chord, platform: Platform): boolean {
  const x = resolved(a, platform);
  const y = resolved(b, platform);
  return x.ctrl === y.ctrl && x.meta === y.meta && x.alt === y.alt && x.shift === y.shift && x.key === y.key;
}

/** The same key by its other names: `event.key`'s (`ArrowUp`, `" "`, `Esc`) and the manifest's (`up`, `space`). */
const ALIASES: Record<string, string> = { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", " ": "space", spacebar: "space", esc: "escape", return: "enter", del: "delete" };
const named = (key: string) => ALIASES[key] ?? key;

/** The key a key press names, lower-case (`event.key`; a digit or letter as typed without Shift where the code says). */
function pressedKey(e: Pick<KeyboardEvent, "key" | "code">): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  return named(e.key.toLowerCase());
}

/** A key press as a chord (`mod` left false: it is resolved per platform when compared). */
export function chordOf(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): Chord {
  return { mod: false, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key: pressedKey(e) };
}

/** A chord written back, with `Mod` for the platform's primary modifier. */
export function writeChord(e: Chord, platform: Platform): string {
  const r = resolved(e, platform);
  const mod = platform === "mac" ? r.meta : r.ctrl;
  const parts = [mod ? "Mod" : "", r.ctrl && platform === "mac" ? "Ctrl" : "", r.alt ? "Alt" : "", r.shift ? "Shift" : "", r.meta && platform === "other" ? "Cmd" : ""].filter(Boolean);
  return [...parts, r.key.length === 1 ? r.key.toUpperCase() : r.key[0]!.toUpperCase() + r.key.slice(1)].join("+");
}

/** How a key shows: `⌘⇧T` on macOS, `Ctrl+Shift+T` elsewhere. */
export function showChord(text: string, platform: Platform): string {
  const c = parseChord(text);
  if (!c) return text;
  const r = resolved(c, platform);
  const key = r.key.length === 1 ? r.key.toUpperCase() : r.key[0]!.toUpperCase() + r.key.slice(1);
  if (platform === "mac") return `${r.ctrl ? "⌃" : ""}${r.alt ? "⌥" : ""}${r.shift ? "⇧" : ""}${r.meta ? "⌘" : ""}${key}`;
  return [r.ctrl ? "Ctrl" : "", r.alt ? "Alt" : "", r.shift ? "Shift" : "", r.meta ? "Win" : "", key].filter(Boolean).join("+");
}

/** The app's own shortcuts: lane E's main process takes them ahead of every layer (`apps/desktop/src/main/shortcuts.ts`'s
 *  `appShortcut`: ⌘Q, ⌘W and ⌘, with or without Shift), checked against it in the tests until E exports the list (asked in the PR). */
export const APP_KEYS = ["Mod+Q", "Mod+W", "Mod+,", "Mod+Shift+,"] as const;

/** The keys of E's Edit menu (Electron's `editMenu` role: undo, redo, cut, copy, paste, paste and match style, select
 *  all) and find: what typing and text fields need, in the composer and everywhere else (review N3). */
export const EDIT_KEYS = ["Mod+Z", "Mod+Shift+Z", "Mod+Y", "Mod+X", "Mod+C", "Mod+V", "Mod+Shift+V", "Mod+Alt+Shift+V", "Mod+A", "Mod+F"] as const;

/** Moving the focus and acting on it (WCAG 2.1.1): Tab and Shift+Tab, Enter, Space, Escape, the arrows, Home, End,
 *  Page Up and Down, Backspace, Delete, and F6 between the window's parts. Unmodified, no command takes them. */
export const FOCUS_KEYS = ["Tab", "Shift+Tab", "Enter", "Shift+Enter", "Space", "Shift+Space", "Escape", "Up", "Down", "Left", "Right", "Shift+Up", "Shift+Down", "Shift+Left", "Shift+Right", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete", "F6", "Shift+F6"] as const;

/** The keys no command takes, not a plugin's default and not the user's binding either: the app's, the palette's, the
 *  Edit menu's and the focus keys. */
export const CORE_KEYS: readonly string[] = [...APP_KEYS, "Mod+K", ...EDIT_KEYS, ...FOCUS_KEYS];
export const PALETTE_KEY = "Mod+K";

/** A key press is a modifier alone (Shift, ⌘…): nothing to bind yet. */
export const isModifierOnly = (e: Pick<KeyboardEvent, "key">) => ["Shift", "Control", "Alt", "Meta", "OS"].includes(e.key);

/** Whether a key is one no command may take (`CORE_KEYS`). */
export function reserved(key: Chord, platform: Platform): boolean {
  return CORE_KEYS.some((k) => sameChord(parseChord(k)!, key, platform));
}

/** Each command's shortcut: the user's own binding (null: none), else its default key, unless a core key (`CORE_KEYS`)
 *  or a binding the user made has that key. A key two defaults share goes to neither, so neither runs by surprise. */
export function bindings(commands: readonly { name: string; key?: string }[], user: Readonly<Record<string, string | null>>, platform: Platform): Map<string, string> {
  const out = new Map<string, string>();
  const taken: Chord[] = CORE_KEYS.map((k) => parseChord(k)!);
  for (const [name, key] of Object.entries(user)) {
    const c = key ? parseChord(key) : undefined;
    if (!c || taken.some((t) => sameChord(t, c, platform))) continue;
    out.set(name, key!);
    taken.push(c);
  }
  const defaults = commands.filter((c) => !(c.name in user) && c.key && parseChord(c.key) && !taken.some((t) => sameChord(t, parseChord(c.key!)!, platform)));
  for (const c of defaults) {
    const chord = parseChord(c.key!)!;
    if (defaults.filter((d) => sameChord(parseChord(d.key!)!, chord, platform)).length > 1) continue;
    out.set(c.name, c.key!);
  }
  return out;
}

/** The command a key press runs, if any. */
export function commandFor(e: Chord, bound: ReadonlyMap<string, string>, platform: Platform): string | undefined {
  for (const [name, key] of bound) {
    const c = parseChord(key);
    if (c && sameChord(c, e, platform)) return name;
  }
  return undefined;
}
