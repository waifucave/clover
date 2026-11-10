// The call cards: this computer's built-in card for each call another computer's signed answer may lift
// (`CALL_CARD_METHODS`; R1 "approvals follow the files", R15 for a move or copy between two computers). The holder
// renders its card when it refuses a call that needs the user's answer (`needsAnswer`), the calling computer shows the
// user that same card, and the holder rebuilds it to check the signed answer (`verifySignedAnswer`): a card that
// reads one thing can never bind another call.
//
// Every card is built only from the call (computer, method, params) and the strings here, so two computers on the same
// tables build the same card. Each binds exactly its call (`binds`: the computer that runs it, the method, and SHA-256
// over the call's canonical JSON; for `tree.transfer` both computers). Names and paths lose characters that hide or
// reorder text (`plainOf`); a command, a file's text or a call's input shows each one as a visible escape.
// Every code field (a command, a file's text, a link's target, a tool's input, Mirror's setup) also shows every character
// that isn't ASCII as an escape (a Cyrillic `а` can't pass for a Latin `a`; a file may be a script that runs later), and
// a long run of spaces or of blank lines as a marker saying how long it is, so nothing hides off to the side or below
// (#368's review). A backslash shows doubled, and the markers use brackets that can't come from the text (they aren't
// ASCII, and every character that isn't is escaped), so each display means exactly one text. What is too long for a sealed field isn't cut: the card says how long it is and that it isn't
// shown; a long path goes whole into code, and a long name shows its beginning and its end with its length.
import {
  TREE_TRANSFER, callBindingInput, canonicalJson,
  type CallBinding, type CardContent, type CardOption, type Level, type SealedValue, type TreeTransferParams,
} from "@waifucave/clover-protocol";
import { plainOf } from "../approvals/strings";
import type { CallCardRenderer } from "../contracts/approval-broker";

/** The longest code a card shows in one field (the sealed limit is 64,000; the rest is room for escapes). */
export const CALL_CARD_CODE_MAX = 48_000;
/** The longest single line (a path, a name) a list item holds. */
const LINE_MAX = 4000;

/** What a level is called on a card. */
export const LEVEL_NAMES: Record<Level, string> = {
  "read-only": "Read only",
  ask: "Ask for everything",
  "ask-risky": "Ask for risky actions",
  "accept-edits": "Accept edits",
  automatic: "Automatic",
};

const ALLOW: CardOption[] = [{ id: "approve", kind: "approve", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" }];

const text = (t: string): SealedValue => ({ type: "text", text: t });
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Paths as a list, or whole as code when one is longer than a list item holds (never cut). */
function pathsField(paths: readonly (string | undefined)[]): SealedValue {
  const shown = paths.map((p) => (p === undefined ? "(no path)" : plainOf(p) === "" ? "(no path)" : plainOf(p)));
  return shown.every((p) => p.length <= LINE_MAX) ? { type: "list", items: shown } : { type: "code", code: shown.join("\n") };
}

/** A run of spaces or tabs this long or longer shows as a marker with its length. */
const WHITESPACE_RUN = 8;
/** This many blank lines in a row or more show as a marker with their count. */
const BLANK_LINES = 3;

/** Code as its card shows it, one-to-one: a backslash doubled, every character that isn't ASCII printable (or a tab or
 *  newline) as `\u{…}` (so hiding characters and homoglyphs alike), and long runs of spaces or blank lines as
 *  `⟦…⟧` markers, which no text can produce itself. */
export function shownCommand(command: string): string {
  const hex = (c: string) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`;
  let out = command.replace(/\\/g, "\\\\").replace(/[^\x20-\x7E\t\n]/gu, hex);
  out = out.replace(new RegExp(`[ \\t]{${WHITESPACE_RUN},}`, "g"), (run) => ` ⟦${run.length} spaces⟧ `);
  out = out.replace(new RegExp(`\\n(?:[ \\t]*\\n){${BLANK_LINES},}`, "g"), (run) => `\n⟦${run.split("\n").length - 2} blank lines⟧\n`);
  return out;
}

/** Code, shown one-to-one (`shownCommand`), or a note saying how long it is when it is too long to show whole. */
function codeOr(code: string, what: string): { command?: SealedValue; detail?: SealedValue } {
  const shown = shownCommand(code);
  if (shown.length <= CALL_CARD_CODE_MAX) return { command: { type: "code", code: shown } };
  return { detail: { type: "rows", rows: [{ label: what, value: `${code.length} characters, too long to show on this card` }] } };
}

/** A name as a card shows it: plain; one longer than a line shows its beginning and its end, with its length. */
function named(s: string | undefined, fallback: string): string {
  const p = s === undefined ? "" : plainOf(s);
  return p.length === 0 ? fallback : p.length <= LINE_MAX ? p : `${p.slice(0, 200)} … ${p.slice(-200)} (${p.length} characters)`;
}

function bindingOf(computer: string, method: string, params: unknown, sha256: (text: string) => string): CallBinding {
  if (method === TREE_TRANSFER) {
    const p = params as TreeTransferParams;
    return { computer: p.destination, source: p.source, method, params: sha256(callBindingInput(method, params)) };
  }
  return { computer, method, params: sha256(callBindingInput(method, params)) };
}

type Fields = CardContent["fields"];

/** Each call's own fields, from its params. Undefined for a call with no card here. */
function fieldsFor(computer: string, method: string, params: unknown): { kind: CardContent["kind"]; change?: CardContent["change"]; fields: Fields } | undefined {
  const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  const on = text(plainOf(computer));
  switch (method) {
    case "tree.write": {
      const data = (typeof p.data === "object" && p.data !== null ? p.data : {}) as { encoding?: unknown; text?: unknown; base64?: unknown };
      const body = data.encoding === "utf8" && typeof data.text === "string"
        ? codeOr(data.text, "Content")
        : { detail: { type: "rows" as const, rows: [{ label: "Content", value: `binary, ${typeof data.base64 === "string" ? Math.floor((data.base64.length * 3) / 4) : 0} bytes` }] } };
      return { kind: "tool", fields: { title: text("Write a file from another computer"), what: text("Write this file?"), computer: on, paths: pathsField([str(p.path)]), ...body } };
    }
    case "tree.remove":
      return { kind: "tool", fields: {
        title: text("Delete from another computer"), what: text(p.recursive === true ? "Delete this, and everything in it?" : "Delete this?"),
        computer: on, paths: pathsField([str(p.path)]),
      } };
    case "tree.move":
      return { kind: "tool", fields: {
        title: text("Move from another computer"), what: text("Move this?"), computer: on,
        paths: pathsField([str(p.from), str(p.to)]),
      } };
    case "tree.mkdir":
      return { kind: "tool", fields: { title: text("Make a folder from another computer"), what: text("Make this folder?"), computer: on, paths: pathsField([str(p.path)]) } };
    case "tree.symlink":
      return { kind: "tool", fields: {
        title: text("Make a link from another computer"), what: text("Make this link?"), computer: on,
        paths: pathsField([str(p.path)]), ...codeOr(str(p.target) ?? "", "Points to"),
      } };
    case TREE_TRANSFER: {
      const move = p.operation === "move";
      return { kind: "tool", fields: {
        title: text(move ? "Move between computers" : "Copy between computers"),
        what: text(move ? "Move these files from one computer to the other?" : "Copy these files from one computer to the other?"),
        computer: text(`${named(str(p.source), "?")} → ${named(str(p.destination), "?")}`),
        paths: pathsField([str(p.from), str(p.to)]),
      } };
    }
    case "terminal.open":
      return { kind: "tool", fields: {
        title: text("Open a terminal from another computer"), what: text("Open a terminal here? Whatever is typed in it runs as you."),
        computer: on, paths: pathsField([str(p.cwd) ?? "(the home folder)"]),
      } };
    case "mcp.mirror":
      return { kind: "tool", fields: {
        title: text("Install a tool server from another computer"), what: text("Install and run this MCP server here?"),
        computer: on, source: text(named(str(p.server), "(no name)")), ...codeOr(canonicalJson(p.config ?? null), "Its setup"),
      } };
    case "computer.setLevel": {
      const level = str(p.level) as Level | undefined;
      const label = level !== undefined && level in LEVEL_NAMES ? LEVEL_NAMES[level] : named(level, "(no level)");
      return { kind: "change", change: "computer-level", fields: {
        title: text("Change a computer's level"), what: text(`Set this computer to "${label}"?`),
        computer: text(named(str(p.name), plainOf(computer))),
      } };
    }
    case "tool.run": {
      const tool = named(str(p.tool), "(no tool)");
      const input = (typeof p.input === "object" && p.input !== null ? p.input : {}) as { command?: unknown; cwd?: unknown };
      if (p.tool === "Bash" && typeof input.command === "string") {
        return { kind: "tool", fields: {
          title: text("Run a command from another computer"), what: text("Run this command?"), computer: on,
          ...codeOr(input.command, "Command"), ...(typeof input.cwd === "string" ? { paths: pathsField([input.cwd]) } : {}),
        } };
      }
      return { kind: "tool", fields: {
        title: text("Use a tool from another computer"), what: text(`Use ${tool}?`), computer: on, source: text(tool),
        ...codeOr(canonicalJson(p.input ?? null), "Input"),
      } };
    }
    default:
      return undefined;
  }
}

/** This computer's card tables for calls from another computer. */
export function callCardRenderer(sha256: (text: string) => string): CallCardRenderer {
  return ({ computer, method, params }) => {
    const f = fieldsFor(computer, method, params);
    if (f === undefined) return undefined;
    return {
      kind: f.kind, ...(f.change === undefined ? {} : { change: f.change }),
      fields: f.fields, options: ALLOW.map((o) => ({ ...o })), binds: bindingOf(computer, method, params, sha256),
    };
  };
}
