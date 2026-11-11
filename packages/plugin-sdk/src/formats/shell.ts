// A bot's shell style (a theme's optional `shell` block): the window's own chrome wears the bot's palette while that bot's
// tab is the one showing, and the stock look returns on any other tab. Bounded to a handful of colours and paints: no layout,
// no content, no CSS; the shell reads them as `--clover-shell-*` variables and falls back to its own colours for a group
// whose pairs miss their contrast floors. Pure: the theme lint, the main process and the tests all call these.

/** The names a `shell` block may set, by group. A group is applied whole or not at all. */
export const SHELL_GROUPS = {
  /** The title bar: a paint (a colour or a gradient, translucent over the tab's backdrop if it likes), its text and its rule. */
  bar: ["bar", "bar.text", "bar.rule"],
  /** The sidebar: a paint, its text, its quiet text, the selected row's fill and a hovered row's fill. */
  sidebar: ["sidebar", "sidebar.text", "sidebar.muted", "sidebar.selected", "sidebar.hover"],
  /** The accent the chrome's marks and focus take. Optional on its own. */
  accent: ["accent"],
} as const;
export type ShellGroup = keyof typeof SHELL_GROUPS;
export const SHELL_TOKEN_NAMES = Object.values(SHELL_GROUPS).flat() as readonly string[];
/** The names whose value may be a gradient: the two paints. */
export const SHELL_PAINTS: ReadonlySet<string> = new Set(["bar", "sidebar"]);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const GRADIENT = /^linear-gradient\((?:\s*(?:to (?:top|bottom|left|right)(?: (?:top|bottom|left|right))?|-?\d+(?:\.\d+)?deg)\s*,)?(?:\s*#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})(?:\s+\d+(?:\.\d+)?%)?\s*,?)+\)$/i;

/** A value a shell token may hold: a hex colour, or for a paint `transparent` or a gradient of hex colours. */
export function isShellValue(name: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (HEX.test(value)) return true;
  return SHELL_PAINTS.has(name) && (value === "transparent" || GRADIENT.test(value));
}

interface Rgba { r: number; g: number; b: number; a: number }
function hexToRgba(hex: string): Rgba {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}
const over = (top: Rgba, ground: Rgba): Rgba => ({ r: top.r * top.a + ground.r * (1 - top.a), g: top.g * top.a + ground.g * (1 - top.a), b: top.b * top.a + ground.b * (1 - top.a), a: 1 });
function luminance(c: Rgba): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
export function shellContrast(fg: Rgba, bg: Rgba): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The colours a paint shows, each laid over `ground` (a translucent or `transparent` paint shows its ground). */
export function paintColours(value: string, ground: string | readonly string[]): Rgba[] {
  const unders = (typeof ground === "string" ? [ground] : ground).map(hexToRgba);
  const stops = value === "transparent" ? [] : [...value.matchAll(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-f])/gi)].map((m) => hexToRgba(m[0]));
  return unders.flatMap((u) => (value === "transparent" ? [u] : stops.map((c) => over(c, u))));
}

/** The title bar floats over whatever the bot draws under it, so its pairs are checked worst case: the paint laid over
 *  pure black and over pure white, each gradient stop on its own. The bot's pixels never carry the bar's legibility. */
export const BAR_GROUNDS = ["#000000", "#FFFFFF"] as const;

/** Every pair a group paints, with the floor it must reach: text on its paint (4.5), the rule and a selected row's text. */
export function shellProblems(group: ShellGroup, values: Readonly<Record<string, string>>, ground: string): string[] {
  const out: string[] = [];
  const need = (fgName: string, bgName: string, floor: number, bgColours?: Rgba[]) => {
    const fg = values[fgName];
    const bg = bgColours ?? paintColours(values[bgName]!, ground);
    if (fg === undefined || !HEX.test(fg)) return;
    for (const b of bg) {
      const got = shellContrast(over(hexToRgba(fg), b), b);
      if (got < floor) { out.push(`${fgName} on ${bgName} is ${got.toFixed(2)}:1; it needs ${floor}:1`); return; }
    }
  };
  if (group === "bar") {
    const worst = paintColours(values["bar"]!, BAR_GROUNDS);
    need("bar.text", "bar", 4.5, worst);
    need("bar.rule", "bar", 1.15, worst);
  } else if (group === "sidebar") {
    need("sidebar.text", "sidebar", 4.5);
    need("sidebar.muted", "sidebar", 4.5);
    // The selected and hovered rows carry the text over their own fill, laid on the paint.
    for (const row of ["sidebar.selected", "sidebar.hover"] as const) {
      const fill = values[row];
      if (fill === undefined || !HEX.test(fill)) continue;
      const rows = paintColours(values["sidebar"]!, ground).map((p) => over(hexToRgba(fill), p));
      need("sidebar.text", row, 4.5, rows);
    }
  } else {
    need("accent", "accent", 0, [hexToRgba("#FFFFFF")]);
  }
  return out;
}

/** The accent must read at 3:1 on every ground it is drawn on: the bar (worst case), the sidebar paint, the selected and
 *  hovered rows laid on it, or the shell's own surface when the skin has no sidebar group. `values` holds the groups that
 *  already passed. */
function accentProblems(accent: string, values: Readonly<Record<string, string>>, ground: string): string[] {
  const a = hexToRgba(accent);
  const grounds: [string, Rgba[]][] = [];
  if (values["bar"] !== undefined) grounds.push(["the bar", paintColours(values["bar"], BAR_GROUNDS)]);
  if (values["sidebar"] !== undefined) {
    const paint = paintColours(values["sidebar"], ground);
    grounds.push(["the sidebar", paint]);
    for (const row of ["sidebar.selected", "sidebar.hover"]) {
      const fill = values[row];
      if (fill !== undefined) grounds.push([`the ${row.slice(8)} row`, paint.map((p) => over(hexToRgba(fill), p))]);
    }
  } else grounds.push(["the surface", [hexToRgba(ground)]]);
  for (const [where, colours] of grounds) {
    for (const c of colours) {
      const got = shellContrast(over(a, c), c);
      if (got < 3) return [`accent on ${where} is ${got.toFixed(2)}:1; it needs 3:1`];
    }
  }
  return [];
}

/** A theme's shell values for one appearance, checked: only the groups that are whole and legible survive (a group that
 *  misses a pair is dropped, so that part of the chrome stays the shell's own). `ground` is the colour a translucent paint
 *  lies over (the theme's own surface); the accent must read at 3:1 on it. */
export function resolveShell(
  shell: { tokens: Readonly<Record<string, unknown>>; dark?: { tokens: Readonly<Record<string, unknown>> } } | undefined,
  appearance: "light" | "dark",
  ground: string,
  themeAppearance: "light" | "dark" | "both" = "both",
): { values: Record<string, string>; dropped: { group: ShellGroup; why: string }[] } {
  const values: Record<string, string> = {};
  const dropped: { group: ShellGroup; why: string }[] = [];
  if (shell === undefined || (themeAppearance !== "both" && themeAppearance !== appearance)) return { values, dropped };
  const merged: Record<string, unknown> = { ...shell.tokens, ...(appearance === "dark" ? shell.dark?.tokens ?? {} : {}) };
  for (const group of Object.keys(SHELL_GROUPS) as ShellGroup[]) {
    const names = SHELL_GROUPS[group];
    const got: Record<string, string> = {};
    let any = false;
    let whole = true;
    for (const n of names) {
      const v = merged[n];
      if (v === undefined) { whole = false; continue; }
      any = true;
      if (isShellValue(n, v)) got[n] = v;
      else whole = false;
    }
    if (!any) continue;
    if (!whole) { dropped.push({ group, why: "a name is missing or its value is not allowed" }); continue; }
    const problems = group === "accent" ? accentProblems(got["accent"]!, values, ground) : shellProblems(group, got, ground);
    if (problems.length > 0) { dropped.push({ group, why: problems.join("; ") }); continue; }
    Object.assign(values, got);
  }
  return { values, dropped };
}
