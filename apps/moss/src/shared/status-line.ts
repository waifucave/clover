// The one line a running bot turn shows at the end of its conversation (the owner's words: "just one line ... like
// 'searching the web', 'running commands', 'thinking', 'reading file.txt'; it changes across what's running"). Pure: the
// activity state, the tool's wire name and a SAFE detail go in, a phrase comes out. Only a file's base name or a site's
// host may ever appear, never a path, a command, a query or any other argument: the line is glanceable and may be
// seen by someone beside the person. `safeDetail` is the only place a detail is made, from the tool call's own input.
import type { ActivityState } from "@waifucave/moss-protocol";

/** The phrases, every one through here (the app's strings): `{}` is the detail or the title. */
export const STATUS_WORDS = {
  thinking: "Thinking",
  working: "Working",
  search: "Searching the web",
  fetch: "Reading {}",
  fetchBare: "Reading a page",
  shell: "Running commands",
  read: "Reading {}",
  readBare: "Reading a file",
  write: "Writing {}",
  writeBare: "Writing a file",
  edit: "Editing {}",
  editBare: "Editing a file",
  browser: "Using the browser",
  computer: "Using the computer",
  bot: "Making a bot",
  routine: "Making a routine",
  memory: "Saving to memory",
  plugin: "Using {}",
} as const;

const fill = (words: string, detail: string | undefined, bare: string): string => (detail === undefined ? bare : words.replace("{}", detail));

/** One line of plain text, at most `max` UTF-16 units: control, bidirectional and zero-width characters dropped. */
export function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A tool's last name segment (`mcp__moss_browser__Open` → `Open`), lower case, with `_` and `-` taken out. */
function leaf(wire: string): string {
  const parts = wire.split("__");
  return (parts[parts.length - 1] ?? wire).replace(/[_\-\s]/g, "").toLowerCase();
}

/** The tool's server segment (`mcp__moss_browser__Open` → `mossbrowser`), or "" for a built-in tool. */
function server(wire: string): string {
  const parts = wire.split("__");
  return parts[0] === "mcp" && parts.length >= 3 ? (parts[1] ?? "").replace(/[_\-\s]/g, "").toLowerCase() : "";
}

export interface StatusInput {
  state: ActivityState;
  /** The tool's wire name while `working`. */
  tool?: string;
  /** A file's base name or a site's host (from `safeDetail`), nothing else. */
  detail?: string;
  /** A plugin tool's own display title. */
  title?: string;
}

/** What the bot is doing, in a phrase, or undefined when no turn is running (idle, listening, asking, stuck, done, asleep). */
export function statusPhrase(i: StatusInput): string | undefined {
  if (i.state === "thinking") return STATUS_WORDS.thinking;
  if (i.state !== "working") return undefined;
  const wire = i.tool;
  if (wire === undefined || wire === "") return STATUS_WORDS.working;
  const t = leaf(wire);
  const s = server(wire);
  const d = i.detail;
  if (["websearch", "search", "searchweb", "websearchtool"].includes(t)) return STATUS_WORDS.search;
  if (["webfetch", "fetch", "readpage", "fetchpage", "fetchurl"].includes(t)) return fill(STATUS_WORDS.fetch, d, STATUS_WORDS.fetchBare);
  if (["bash", "shell", "run", "runcommand", "exec", "powershell", "terminal"].includes(t)) return STATUS_WORDS.shell;
  if (s === "" || s === "moss" || s === "builtin") {
    if (["read", "readfile", "view", "cat", "notebookread"].includes(t)) return fill(STATUS_WORDS.read, d, STATUS_WORDS.readBare);
    if (["write", "writefile", "create", "createfile"].includes(t)) return fill(STATUS_WORDS.write, d, STATUS_WORDS.writeBare);
    if (["edit", "multiedit", "notebookedit", "applypatch", "patch", "strreplace"].includes(t)) return fill(STATUS_WORDS.edit, d, STATUS_WORDS.editBare);
  }
  if (/createbot|makebot|newbot|spawnbot/.test(t)) return STATUS_WORDS.bot;
  if (/routine/.test(t)) return STATUS_WORDS.routine;
  if (/memory/.test(t)) return STATUS_WORDS.memory;
  if (/browser/.test(s) || (s === "moss" && t === "browser")) return STATUS_WORDS.browser;
  if (/opensky|computeruse|computer/.test(s) || t === "computer" || t === "computerv2") return STATUS_WORDS.computer;
  if (s !== "" && s !== "moss") {
    const own = i.title !== undefined && oneLine(i.title, 40) !== "" ? oneLine(i.title, 40) : oneLine((wire.split("__").at(-1) ?? "").replace(/[_\-]+/g, " "), 40);
    return own === "" ? STATUS_WORDS.working : STATUS_WORDS.plugin.replace("{}", own);
  }
  return STATUS_WORDS.working;
}

/** The only detail a tool call may give: a file's base name (read, write, edit) or a site's host (fetch), from the call's
 *  own JSON input. Everything else, and anything that doesn't parse, gives nothing. */
export function safeDetail(wire: string, argsJson: string): string | undefined {
  if (argsJson.length > 200_000) return undefined;
  const t = leaf(wire);
  const file = ["read", "readfile", "view", "cat", "notebookread", "write", "writefile", "create", "createfile", "edit", "multiedit", "notebookedit", "strreplace"].includes(t);
  const web = ["webfetch", "fetch", "readpage", "fetchpage", "fetchurl"].includes(t);
  if (!file && !web) return undefined;
  let args: unknown;
  try { args = JSON.parse(argsJson); } catch { return undefined; }
  if (typeof args !== "object" || args === null) return undefined;
  const a = args as Record<string, unknown>;
  if (file) {
    const p = [a.file_path, a.path, a.filePath, a.notebook_path, a.filename].find((v) => typeof v === "string" && v !== "");
    if (typeof p !== "string") return undefined;
    const base = oneLine(p.split(/[\\/]/).filter((x) => x !== "").at(-1) ?? "", 60);
    return base === "" ? undefined : base;
  }
  const u = a.url;
  if (typeof u !== "string") return undefined;
  try {
    const host = new URL(u).hostname.replace(/^www\./, "");
    return /^[A-Za-z0-9.\-]+$/.test(host) && host !== "" ? host.slice(0, 60) : undefined;
  } catch { return undefined; }
}
