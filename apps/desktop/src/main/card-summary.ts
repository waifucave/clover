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
  /** "Alpha wants to edit ~/Downloads/story.md", in its parts so the page can set the file apart. The file is the path the
   *  CORE resolved and sealed into the card (`paths`), never the string the model gave in its input: a link or a `..`
   *  in that string would otherwise let a harmless-looking name stand for another file. */
  who: string;
  verb: string;
  /** The resolved path, under the home as `~/...`, middle-shortened only where it must be (the first folders after `~`
   *  and the file name always stay). With several paths, the first. */
  target?: string;
  /** How many paths the call names, when more than one. */
  count?: number;
  /** The path as the model wrote it, when that is not the resolved one ("asked as ~/Downloads/photos/config"). */
  asked?: string;
  /** A fact the line carries after the place ("replaces every match"). */
  note?: string;
  /** What "Always allow" would save, in Clover's words, from the rule the core sealed with the card. */
  always?: string;
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

/** `/Users/me/Downloads/a.md` as `~/Downloads/a.md` when it lies under `home`. */
export function underHome(path: string, home: string | undefined): string {
  if (home === undefined || home === "") return path;
  const h = home.replace(/[\\/]+$/, "");
  if (path === h) return "~";
  return path.startsWith(`${h}/`) || path.startsWith(`${h}\\`) ? `~${path.slice(h.length)}` : path;
}

/** The longest a path is drawn before its middle goes: the first two folders and the last folder and the file name stay. */
export const PATH_COLUMNS = 64;

/** A component that says what a path is: a dot name (`.ssh`, `.git`), a `*.git` or `*.app` folder, `Library`. Never cut. */
const protectedPart = (part: string): boolean => part.startsWith(".") || part.endsWith(".git") || part.endsWith(".app") || part === "Library";

/** A path cut in the middle only where it is long: the first folders after `~` (or the root) and the last two names stay,
 *  and so does every component that matters (see `protectedPart`); only runs of ordinary folder names go, each run
 *  saying how many it holds. */
export function shortenPath(path: string): string {
  if (path.length <= PATH_COLUMNS) return path;
  const parts = path.split("/");
  if (parts.length <= 5) return path;
  const head = parts.slice(0, 3);
  const tail = parts.slice(-2);
  const out = [...head];
  let run = 0;
  const flush = () => { if (run > 0) out.push(`…(${run} ${run === 1 ? "folder" : "folders"})`); run = 0; };
  for (const part of parts.slice(3, -2)) {
    if (protectedPart(part)) { flush(); out.push(part); } else run++;
  }
  flush();
  return [...out, ...tail].join("/");
}

/** The start of a Browser acting card's `what`, from the core (`browserKnown`). */
const BROWSER_WHAT = "Browser: ";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The rule an "always" on a card would store, as the broker wrote it into the card's `rule` rows from the record it saves
 *  (broker.ts `ruleFieldOf`): what kind of thing it allows, the thing, the bot it holds for (empty: no bot named) and the
 *  computers it holds on. */
export interface StoredRule { kind: string; target: string; bot: string; computers: readonly string[] }

export function ruleOf(card: { fields: Readonly<Record<string, unknown>> }): StoredRule | undefined {
  const v = card.fields.rule as SealedValue | undefined;
  if (v === undefined || v.type !== "rows") return undefined;
  const get = (label: string): string | undefined => v.rows.find((r) => r.label === label)?.value;
  const kind = get("kind"), target = get("target"), bot = get("bot"), computers = get("computers");
  if (kind === undefined || target === undefined || bot === undefined || computers === undefined) return undefined;
  return { kind, target, bot, computers: computers.split("\n").filter((c) => c !== "") };
}

/** The ONE sentence for a stored rule: it names every dimension the rule leaves open. The thing (the exact command wherever
 *  it runs; the one file; every call of a tool whatever it touches), the bot (only the bot it was saved for, or requests
 *  naming no bot), and the computers (only those it was saved on). Nothing narrower is claimed and nothing wider. */
export function ruleSentence(rule: StoredRule, botName?: string, home?: string): string {
  // The Browser tool's kept rule, without the tool's internal name: "Always allow Alpha to click and type on <site>, on this computer (Delta) only."
  const site = rule.kind === "plugin-tool" ? /^mcp__browser__Browser\((.+)\)$/.exec(rule.target)?.[1] : undefined;
  if (site !== undefined) {
    const who = rule.bot === "" ? "your coding sessions" : botName ?? nameFromId(rule.bot);
    const where = rule.computers.length === 0 ? "no computer" : `this computer (${rule.computers.join(", ")})`;
    return `Always allow ${who} to click and type on ${site}, on ${where} only.`;
  }
  // A cut text says how much is hidden, so a cut command never reads as whole.
  const clip = (t: string) => (t.length > 70 ? `${t.slice(0, 70)}… (${t.length - 70} more characters)` : t);
  const what = rule.kind === "command" ? `this exact command (${clip(rule.target.replace(/\s+/g, " "))}), in any folder`
    : rule.kind === "file" ? `edits to ${shortenPath(underHome(rule.target, home))}`
    : rule.kind === "tool" ? `every ${rule.target} call, whatever it touches`
    : rule.kind === "plugin-tool" ? `every call to ${rule.target}, whatever it is given`
    : `this exact request (${clip(rule.target.replace(/\s+/g, " "))})`;
  const who = rule.bot === "" ? "requests that name no bot" : botName ?? nameFromId(rule.bot);
  const where = rule.computers.length === 0 ? "no computer" : rule.computers.join(", ");
  return `Always allow: ${what}, for ${who}, on ${where} only.`;
}

/** The sentence for the "always" a card offers; none where the card offers none or carries no stored rule. */
export function alwaysSentence(card: { fields: Readonly<Record<string, unknown>>; bot?: string; options?: readonly { remember?: string }[] }, botName?: string, home?: string): string | undefined {
  if (card.options?.some((o) => o.remember === "always") !== true) return undefined;
  const rule = ruleOf(card);
  return rule === undefined ? undefined : ruleSentence(rule, card.bot === rule.bot ? botName : undefined, home);
}

/** The card's one line and preview, or undefined for a card that isn't a tool call this knows how to say. */
export function summarize(card: { kind: string; fields: Readonly<Record<string, unknown>>; bot?: string; options?: readonly { remember?: string }[] }, botName?: string, home?: string): CardSummary | undefined {
  if (card.kind !== "tool") return undefined;
  const f = card.fields as Record<string, SealedValue | undefined>;
  const what = textOf(f.what);
  if (what === undefined || what === "") return undefined;
  const browserCard = what.startsWith(BROWSER_WHAT);
  const who = botName ?? (card.bot !== undefined ? nameFromId(card.bot) : browserCard ? "This coding session" : "A bot");
  const title = textOf(f.title);
  const input = asRecord(textOf(f.detail));
  const command = textOf(f.command);
  const resolved = (textOf(f.paths) ?? "").split("\n").filter((x) => x !== "");
  const always = alwaysSentence(card, botName, home);
  const base = { who, ...(title !== undefined ? { title } : {}), ...(always !== undefined ? { always } : {}) };
  // The place the card names is the core's resolved path alone. What the model wrote is shown only beside it, and only
  // when it differs.
  const place = (raw: unknown): { target?: string; count?: number; asked?: string } => {
    if (resolved.length === 0) return {};
    const target = shortenPath(underHome(resolved[0]!, home));
    const written = typeof raw === "string" && raw !== "" ? raw : undefined;
    const askedAs = written !== undefined ? underHome(written, home) : undefined;
    const differs = askedAs !== undefined && askedAs !== underHome(resolved[0]!, home);
    return { target, ...(resolved.length > 1 ? { count: resolved.length } : {}), ...(differs ? { asked: askedAs!.length > 80 ? `${askedAs!.slice(0, 79)}…` : askedAs! } : {}) };
  };

  // A Browser acting card ("Browser: click and type on <site>"): one sentence, and the act in words on a line of its own
  // (the core's `command` line, from the element the session's read listed; the raw call stays under "show everything").
  if (browserCard) {
    const out: CardSummary = { ...base, verb: what.slice(BROWSER_WHAT.length), shortened: false };
    if (command !== undefined && command !== "") out.preview = { kind: "lines", lines: [clipLine(command.replace(/\s+/g, " ")).text], hidden: 0, mono: false };
    return out;
  }
  switch (what) {
    case "Edit": {
      const p = place(input?.file_path);
      const oldS = str(input?.old_string);
      const newS = str(input?.new_string);
      const out: CardSummary = { ...base, verb: "edit", ...p, shortened: false };
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
      const p = place(input?.file_path);
      const edits = Array.isArray(input?.edits) ? (input!.edits as unknown[]) : [];
      const first = edits[0] !== null && typeof edits[0] === "object" ? (edits[0] as Record<string, unknown>) : undefined;
      const out: CardSummary = { ...base, verb: "edit", ...p, shortened: edits.length > 1 };
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
      return { ...base, verb: "edit", ...place(input?.notebook_path), shortened: false };
    }
    case "Write": {
      const p = place(input?.file_path);
      const content = str(input?.content);
      const out: CardSummary = { ...base, verb: "write", ...p, shortened: false };
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
      return { ...base, verb: "read", ...place(input?.file_path), shortened: false };
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
