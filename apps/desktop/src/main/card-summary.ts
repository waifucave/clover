/** What a tool card says in a line and a short preview, from the card's own sealed fields (spec §5.5). The app composes
 *  it here, on its own side, and only from what the core sealed into the card (`what`, `detail`, `command`, `paths`):
 *  never from anything a plugin or a page said. A preview may be shortened, and when it is it says so and the whole
 *  of what the card holds stays one press away (the card's own "show everything"), so what the user reads is never
 *  less than what they approve without a way to see the rest.
 *
 *  Pure: the tests drive all of it under Bun. */

import type { SealedValue } from "./sealed";

/** The most lines of a diff side, a command or a file's start one preview shows before it says the rest is hidden. */
export const PREVIEW_LINES = 6;
/** The most characters of one previewed line. */
export const PREVIEW_COLUMNS = 110;
/** The most rows of an unknown tool's input one preview lists. */
export const PREVIEW_ROWS = 6;

export type PreviewBlock =
  /** An edit: the lines going out and the lines coming in. */
  | { kind: "diff"; removed: readonly string[]; added: readonly string[]; hiddenRemoved: number; hiddenAdded: number; edits?: number }
  /** A command, or the start of what a file will hold. */
  | { kind: "lines"; label?: string; lines: readonly string[]; hidden: number; mono: boolean }
  /** The input of a tool this card doesn't know the shape of, as rows. */
  | { kind: "rows"; rows: readonly { label: string; value: string; cut: boolean }[]; hidden: number };

export interface CardSummary {
  /** "Alpha wants to edit story.md in Downloads", in its parts so the page can set the file and the place apart. */
  who: string;
  verb: string;
  target?: string;
  where?: string;
  /** A fact the line carries after the place ("replaces every match"). */
  note?: string;
  /** What the call does, short, as the core's title says it ("Change files"). */
  title?: string;
  preview?: PreviewBlock;
  /** Whether the preview leaves anything out. */
  shortened: boolean;
}

const textOf = (v: SealedValue | undefined): string | undefined => (v === undefined ? undefined : v.type === "text" ? v.text : v.type === "code" ? v.code : undefined);

/** A bot's id as a name when nothing better is known: `alpha` -> `Alpha`. */
export function nameFromId(id: string): string {
  const spaced = id.replace(/^b_/, "").replace(/[-_]+/g, " ").trim();
  return spaced === "" ? id : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A path's file name and the name of the folder it lies in. */
export function placeOf(path: string): { name: string; folder?: string } {
  const parts = path.split(/[\\/]+/).filter((p) => p !== "");
  const name = parts[parts.length - 1] ?? path;
  const folder = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  return { name, ...(folder !== undefined ? { folder } : {}) };
}

function clipLine(line: string): { text: string; cut: boolean } {
  return line.length > PREVIEW_COLUMNS ? { text: `${line.slice(0, PREVIEW_COLUMNS - 1)}…`, cut: true } : { text: line, cut: false };
}

/** The first `PREVIEW_LINES` lines of `text`, each clipped; how many lines went unshown, and whether anything was cut. */
function head(text: string): { lines: string[]; hidden: number; cut: boolean } {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline is not a line.
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const lines: string[] = [];
  let cut = false;
  for (const l of all.slice(0, PREVIEW_LINES)) {
    const c = clipLine(l);
    lines.push(c.text);
    cut ||= c.cut;
  }
  return { lines, hidden: Math.max(0, all.length - PREVIEW_LINES), cut };
}

function asRecord(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    // The core clips a very long input: what is left isn't JSON, and the card shows it as it is.
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The card's one line and preview, or undefined for a card that isn't a tool call this knows how to say. */
export function summarize(card: { kind: string; fields: Readonly<Record<string, unknown>>; bot?: string }, botName?: string): CardSummary | undefined {
  if (card.kind !== "tool") return undefined;
  const f = card.fields as Record<string, SealedValue | undefined>;
  const what = textOf(f.what);
  if (what === undefined || what === "") return undefined;
  const who = botName ?? (card.bot !== undefined ? nameFromId(card.bot) : "A bot");
  const title = textOf(f.title);
  const input = asRecord(textOf(f.detail));
  const command = textOf(f.command);
  const firstPath = textOf(f.paths)?.split("\n")[0];
  const base = { who, ...(title !== undefined ? { title } : {}) };
  const place = (path: string | undefined) => (path === undefined || path === "" ? undefined : placeOf(path));

  switch (what) {
    case "Edit": {
      const p = place(str(input?.file_path) ?? firstPath);
      const oldS = str(input?.old_string);
      const newS = str(input?.new_string);
      const out: CardSummary = { ...base, verb: "edit", ...(p !== undefined ? { target: p.name, ...(p.folder !== undefined ? { where: p.folder } : {}) } : {}), shortened: false };
      if (oldS !== undefined && newS !== undefined) {
        const a = head(oldS);
        const b = head(newS);
        out.preview = { kind: "diff", removed: oldS === "" ? [] : a.lines, added: newS === "" ? [] : b.lines, hiddenRemoved: a.hidden, hiddenAdded: b.hidden };
        out.shortened = a.hidden > 0 || b.hidden > 0 || a.cut || b.cut;
      }
      if (input?.replace_all === true) out.note = "(replaces every match)";
      return out;
    }
    case "MultiEdit": {
      const p = place(str(input?.file_path) ?? firstPath);
      const edits = Array.isArray(input?.edits) ? (input!.edits as unknown[]) : [];
      const first = edits[0] !== null && typeof edits[0] === "object" ? (edits[0] as Record<string, unknown>) : undefined;
      const out: CardSummary = { ...base, verb: "edit", ...(p !== undefined ? { target: p.name, ...(p.folder !== undefined ? { where: p.folder } : {}) } : {}), shortened: edits.length > 1 };
      const oldS = str(first?.old_string);
      const newS = str(first?.new_string);
      if (oldS !== undefined && newS !== undefined) {
        const a = head(oldS);
        const b = head(newS);
        out.preview = { kind: "diff", removed: oldS === "" ? [] : a.lines, added: newS === "" ? [] : b.lines, hiddenRemoved: a.hidden, hiddenAdded: b.hidden, edits: edits.length };
        out.shortened ||= a.hidden > 0 || b.hidden > 0 || a.cut || b.cut;
      }
      return out;
    }
    case "NotebookEdit": {
      const p = place(str(input?.notebook_path) ?? firstPath);
      return { ...base, verb: "edit", ...(p !== undefined ? { target: p.name, ...(p.folder !== undefined ? { where: p.folder } : {}) } : {}), shortened: false };
    }
    case "Write": {
      const p = place(str(input?.file_path) ?? firstPath);
      const content = str(input?.content);
      const out: CardSummary = { ...base, verb: "write", ...(p !== undefined ? { target: p.name, ...(p.folder !== undefined ? { where: p.folder } : {}) } : {}), shortened: false };
      if (content !== undefined) {
        const h = head(content);
        const total = content.replace(/\r\n/g, "\n").split("\n").length - (content.endsWith("\n") ? 1 : 0);
        const bytes = new TextEncoder().encode(content).length;
        const size = bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        out.preview = { kind: "lines", label: `${total} ${total === 1 ? "line" : "lines"}, ${size}`, lines: h.lines, hidden: h.hidden, mono: true };
        out.shortened = h.hidden > 0 || h.cut;
      }
      return out;
    }
    case "Read": {
      const p = place(str(input?.file_path) ?? firstPath);
      return { ...base, verb: "read", ...(p !== undefined ? { target: p.name, ...(p.folder !== undefined ? { where: p.folder } : {}) } : {}), shortened: false };
    }
    case "Bash":
    case "PowerShell":
    case "Monitor": {
      const text = command ?? str(input?.command);
      const out: CardSummary = { ...base, verb: "run a command", shortened: false };
      if (text !== undefined) {
        const h = head(text);
        out.preview = { kind: "lines", lines: h.lines, hidden: h.hidden, mono: true };
        out.shortened = h.hidden > 0 || h.cut;
      }
      return out;
    }
    default:
  }

  // Any other tool: its name, and its input as a few rows. A built-in's name is the core's own text; another tool's is
  // a model's or a plugin's, which the core put in a code field.
  const out: CardSummary = { ...base, verb: `use ${what}`, shortened: false };
  if (input !== undefined) {
    const entries = Object.entries(input);
    const rows = entries.slice(0, PREVIEW_ROWS).map(([k, v]) => {
      const text = typeof v === "string" ? v : JSON.stringify(v) ?? "";
      const one = text.replace(/\s+/g, " ");
      const c = clipLine(one);
      return { label: k, value: c.text, cut: c.cut || one.length < text.length };
    });
    if (rows.length > 0) {
      out.preview = { kind: "rows", rows, hidden: Math.max(0, entries.length - PREVIEW_ROWS) };
      out.shortened = out.preview.hidden > 0 || rows.some((r) => r.cut);
    }
  }
  return out;
}
