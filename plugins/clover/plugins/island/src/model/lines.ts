// The island's lines (the owner's ruling, 2026-11-14): other plugins put small items on the island, and the island draws
// them itself, in its own style and under its own rules. The endpoint is the island's own point, `island.line`: a plugin
// fills it with `{ id, handler }`, and the island calls the handler (no arguments, as the plugin) and takes what comes
// back as one line of plain text, an optional icon from a small named set and an optional progress from 0 to 1.
//
// Everything a sender could want to decide is decided here: how long a line is, which icons exist, how many lines a
// plugin may have and how many the island shows at once, their order, how long a handler may take, and what happens to one
// that fails. A line exists only while its handler returns one, so a plugin that is turned off, stopped or removed has no
// entry and no line, and a sender can change only what its own handler returns: it never reaches the island's look, size or
// another plugin's line, and it cannot open the island (a line is drawn only while the island is open on its Needs you tab).
//
// This file is pure: the clock, the timers and the calls are the caller's.

/** The named icons a line may carry; the island draws them (`Glyph`). A name outside this list draws no icon. */
export const LINE_ICONS = ["bolt", "check", "clock", "info", "sync", "link"] as const;
export type LineIcon = (typeof LINE_ICONS)[number];

/** A line's text at most, in characters; longer is cut with an ellipsis. */
export const LINE_TEXT_MAX = 80;
/** Entries the island calls at one poll, and lines one plugin may show, and lines shown at once (the rest are counted). */
export const LINE_ENTRIES_MAX = 24;
export const LINES_PER_PLUGIN = 2;
export const LINES_SHOWN = 4;
/** How long a handler may take before its line is skipped this time, and how long a handler that failed three polls in a row
 *  is left alone. */
export const LINE_CALL_MS = 1500;
export const LINE_BACKOFF_MS = 30_000;
export const LINE_FAILS_BEFORE_BACKOFF = 3;
/** How often the open Needs you tab asks again. */
export const LINE_POLL_MS = 2000;

/** A plugin's entry of the `island.line` point, as the plugin API gives it. */
export interface LineEntry {
  pluginId: string;
  entryId: string;
}

/** One line, as the island draws it. `key` is the sender's and its entry's, so two plugins' lines never share one. */
export interface Line {
  key: string;
  pluginId: string;
  text: string;
  icon?: LineIcon;
  progress?: number;
  bot?: string;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g;
const BOT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** What a handler returned, as one line, or undefined when there is nothing to draw. Plain text only: it is drawn as text,
 *  never as markup, and what could hide or reorder text (control, zero-width and bidirectional marks) becomes a space. */
export function cleanLine(entry: LineEntry, raw: unknown): Line | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.text !== "string") return undefined;
  const words = v.text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (words === "") return undefined;
  const chars = [...words];
  const text = chars.length > LINE_TEXT_MAX ? `${chars.slice(0, LINE_TEXT_MAX - 1).join("").trimEnd()}…` : words;
  const line: Line = { key: `${entry.pluginId}\u0000${entry.entryId}`, pluginId: entry.pluginId, text };
  if (typeof v.icon === "string" && (LINE_ICONS as readonly string[]).includes(v.icon)) line.icon = v.icon as LineIcon;
  if (typeof v.progress === "number" && Number.isFinite(v.progress)) line.progress = Math.min(1, Math.max(0, v.progress));
  if (typeof v.bot === "string" && BOT_ID.test(v.bot)) line.bot = v.bot;
  return line;
}

export interface LineDeps {
  /** The entries of `island.line`, in the registry's order. */
  entries(): Promise<LineEntry[]>;
  /** The entry's handler, called as the plugin with no arguments. */
  call(entry: LineEntry): Promise<unknown>;
  /** Milliseconds, monotonic. */
  now(): number;
  /** Rejects after `ms` unless the promise settles first. */
  within<T>(promise: Promise<T>, ms: number): Promise<T>;
}

export interface LinePoll {
  /** At most `LINES_SHOWN`, in order. */
  lines: Line[];
  /** Lines that did not fit. */
  more: number;
}

/** Polls the entries and keeps each one's failures, so a handler that keeps failing is left alone for a while. */
export class LineBoard {
  private readonly fails = new Map<string, { count: number; until: number }>();
  constructor(private readonly deps: LineDeps) {}

  async poll(): Promise<LinePoll> {
    const entries = (await this.deps.entries()).slice(0, LINE_ENTRIES_MAX);
    const now = this.deps.now();
    const live = new Set(entries.map((e) => `${e.pluginId}\u0000${e.entryId}`));
    for (const key of [...this.fails.keys()]) if (!live.has(key)) this.fails.delete(key);
    const answers = await Promise.all(entries.map(async (entry): Promise<Line | undefined> => {
      const key = `${entry.pluginId}\u0000${entry.entryId}`;
      const failed = this.fails.get(key);
      if (failed !== undefined && failed.until > now) return undefined;
      try {
        const line = cleanLine(entry, await this.deps.within(this.deps.call(entry), LINE_CALL_MS));
        this.fails.delete(key);
        return line;
      } catch {
        const count = (failed?.count ?? 0) + 1;
        this.fails.set(key, { count, until: count >= LINE_FAILS_BEFORE_BACKOFF ? this.deps.now() + LINE_BACKOFF_MS : 0 });
        return undefined;
      }
    }));
    return arrange(answers.filter((l): l is Line => l !== undefined));
  }
}

/** The order the island draws in: the registry's (the order the plugins were installed in), each plugin's lines together;
 *  a plugin keeps at most `LINES_PER_PLUGIN` of its lines, and the island shows at most `LINES_SHOWN`. */
export function arrange(lines: readonly Line[]): LinePoll {
  const first = new Map<string, number>();
  lines.forEach((l, i) => { if (!first.has(l.pluginId)) first.set(l.pluginId, i); });
  const taken = new Map<string, number>();
  const kept = lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => first.get(a.l.pluginId)! - first.get(b.l.pluginId)! || a.i - b.i)
    .map(({ l }) => l)
    .filter((l) => {
      const n = taken.get(l.pluginId) ?? 0;
      taken.set(l.pluginId, n + 1);
      return n < LINES_PER_PLUGIN;
    });
  return { lines: kept.slice(0, LINES_SHOWN), more: Math.max(0, kept.length - LINES_SHOWN) };
}

/** The words that say whose a line is: its plugin, and the bot when it names one (`botName` turns an id into the name the
 *  user knows; the id stands when it has none). The island writes this itself: a sender never sets it. */
export function lineSource(line: Line, botName?: (id: string) => string | undefined): string {
  if (line.bot === undefined) return line.pluginId;
  return `${line.pluginId} · ${botName?.(line.bot) ?? line.bot}`;
}
