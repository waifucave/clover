// The git keys a sandboxed command must not set (spec item 1116): hooks and other code git would run later,
// outside the sandbox — `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `core.pager`, `core.editor`,
// `core.askPass`, `diff.external`, `filter.*.{clean,smudge,process}`, `!`-prefixed aliases, `credential.helper`,
// `gpg.program`, `gpg.*.program`, `include.path`, any `includeIf.*`, `uploadpack.packObjectsHook, and
// `remote.*.{receivepack,uploadpack}`. After a sandboxed command, watched keys that were added or changed are
// reverted to their pre-command values (other keys are left alone); a file that appeared with a watched key set
// is removed. `.git/config` stays writable otherwise: normal git use writes it.
//
// Parsing goes through git itself (`git config --file <copy> --list -z --no-includes`), with the built-in parser
// below as fallback where git is missing or rejects the file. The revert writes a temp file and renames it over,
// but only when the file hasn't changed since it was read.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export interface GitConfigKey {
  /** Dotted display form, lowercased except any subsection. */
  readonly dotted: string;
  /** The value, unquoted and uncontinued. */
  readonly value: string;
  /** The 0-based line that sets it. */
  readonly line: number;
}

interface WatchedPattern {
  readonly section: string;
  readonly sub: string | null;
  readonly names: readonly string[];
  /** Only a value starting with `!` counts (aliases). */
  readonly aliasBang?: boolean;
}

const WATCHED: readonly WatchedPattern[] = [
  { section: "core", sub: null, names: ["hookspath", "fsmonitor", "sshcommand", "pager", "editor", "askpass"] },
  { section: "diff", sub: null, names: ["external"] },
  { section: "filter", sub: "*", names: ["clean", "smudge", "process"] },
  { section: "alias", sub: null, names: ["*"], aliasBang: true },
  { section: "credential", sub: null, names: ["helper"] },
  { section: "gpg", sub: null, names: ["program"] },
  { section: "gpg", sub: "*", names: ["program"] },
  { section: "include", sub: null, names: ["path"] },
  { section: "includeif", sub: "*", names: ["*"] },
  { section: "uploadpack", sub: null, names: ["packobjectshook"] },
  { section: "remote", sub: "*", names: ["receivepack", "uploadpack"] },
];

/** Splits a dotted key for matching: lowercase section and name, case-sensitive subsection. */
function splitDotted(dotted: string): { section: string; sub: string | null; name: string } {
  const parts = dotted.split(".");
  const section = parts[0]!.toLowerCase();
  if (parts.length === 2) return { section, sub: null, name: parts[1]!.toLowerCase() };
  return { section, sub: parts.slice(1, -1).join("."), name: parts[parts.length - 1]!.toLowerCase() };
}

function watched(key: { section: string; sub: string | null; name: string }, value: string): boolean {
  return WATCHED.some((w) => {
    if (w.section !== key.section) return false;
    if (w.sub === null) {
      if (key.sub !== null) return false;
    } else {
      if (key.sub === null) return false;
      if (w.sub !== "*" && w.sub.toLowerCase() !== key.sub.toLowerCase()) return false;
    }
    if (!w.names.includes("*") && !w.names.includes(key.name)) return false;
    if (w.aliasBang === true && !value.trim().startsWith("!")) return false;
    return true;
  });
}

/** Parses a git config file into its watched keys, with line numbers. Sections compare case-insensitively,
 *  subsections case-sensitively, names case-insensitively; continuations joined, quotes stripped. Lines that
 *  don't parse are skipped (the whole-file comparison still notices a change); a malformed section header
 *  ends the previous section rather than attributing its keys to it. */
export function parseGitConfigWatched(text: string): GitConfigKey[] {
  const out: GitConfigKey[] = [];
  let section = "";
  let sub: string | null = null;
  const lines = text.replace(/\\\r?\n/g, "").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) return;
    const head = /^\[(.+)\]$/.exec(line);
    if (head !== null) {
      const inner = head[1]!.trim();
      const m = /^(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?$/.exec(inner);
      if (m === undefined || m === null) { section = ""; sub = null; }
      else { section = m[1]!.toLowerCase(); sub = m[2] === undefined ? null : m[2]; }
      return;
    }
    if (line.startsWith("[")) { section = ""; sub = null; return; }
    if (section === "") return;
    const kv = /^([A-Za-z0-9-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv === null) return;
    let value = kv[2]!;
    const q = /^"(.*)"$/.exec(value);
    if (q !== null) value = q[1]!.replace(/\\(.)/g, "$1");
    const dotted = sub === null ? `${section}.${kv[1]!}` : `${section}.${sub}.${kv[1]!}`;
    out.push({ dotted, value, line: i });
  });
  return out;
}

/** A watched key whose values changed between the snapshots, with both sides' values (in order). */
export interface WatchedGitChange {
  readonly dotted: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** Parses a config file the way git reads it: through `git config --file <copy> --list -z --no-includes`
 *  (no includes, so a planted `include.path` can't smuggle keys into the parse). Null where git is missing or
 *  rejects the file — the caller falls back to the built-in parser. */
export function parseGitConfigWithGit(text: string): Map<string, string[]> | null {
  let dir = "";
  try {
    dir = mkdtempSync(join(tmpdir(), "clover-gitcfg-"));
    const f = join(dir, "config");
    writeFileSync(f, text, { mode: 0o600 });
    const r = spawnSync("git", ["config", "--file", f, "--list", "-z", "--no-includes"], { encoding: "buffer", timeout: 10_000 });
    if (r.status !== 0 || r.error) return null;
    const m = new Map<string, string[]>();
    for (const rec of (r.stdout as Buffer).toString("utf8").split("\0")) {
      if (rec === "") continue;
      const nl = rec.indexOf("\n");
      if (nl < 0) return null; // not git's shape: fall back
      const key = rec.slice(0, nl);
      const value = rec.slice(nl + 1);
      const s = splitDotted(key);
      if (!watched(s, value)) continue;
      const dotted = s.sub === null ? `${s.section}.${s.name}` : `${s.section}.${s.sub}.${s.name}`;
      const arr = m.get(dotted) ?? [];
      arr.push(value);
      m.set(dotted, arr);
    }
    return m;
  } catch { return null; }
  finally { if (dir !== "") { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } }
}

/** Which watched keys were added, changed or removed. A removed plain alias doesn't count (removing it only
 *  disarms it); everything else does. Parsed through git, with the built-in parser as fallback. */
export function watchedGitChanges(before: string | null, after: string | null): WatchedGitChange[] {
  if (before === after) return [];
  const at = (text: string | null): Map<string, string[]> => {
    if (text === null) return new Map();
    const viaGit = parseGitConfigWithGit(text);
    if (viaGit !== null) return viaGit;
    const m = new Map<string, string[]>();
    for (const k of parseGitConfigWatched(text)) {
      const s = splitDotted(k.dotted);
      if (!watched(s, k.value)) continue;
      const dotted = s.sub === null ? `${s.section}.${s.name}` : `${s.section}.${s.sub}.${s.name}`;
      const arr = m.get(dotted) ?? [];
      arr.push(k.value);
      m.set(dotted, arr);
    }
    return m;
  };
  const a = at(before), b = at(after);
  const out: WatchedGitChange[] = [];
  for (const [dotted, bv] of b) {
    const av = a.get(dotted) ?? [];
    if (av.length !== bv.length || av.some((v, i) => v !== bv[i])) out.push({ dotted, before: av, after: bv });
  }
  for (const [dotted, av] of a) {
    if (b.has(dotted) || dotted.split(".")[0] === "alias") continue;
    out.push({ dotted, before: av, after: [] });
  }
  return out.sort((x, y) => (x.dotted < y.dotted ? -1 : 1));
}

/** Reverts watched changes in `text`: drops every line that sets a changed watched key, then re-appends each
 *  key's before-values under its section (a missing section is added at the end). Unwatched lines are untouched. */
export function revertWatchedGitChanges(text: string, changes: readonly WatchedGitChange[]): string {
  if (changes.length === 0) return text;
  const changed = new Set(changes.map((c) => c.dotted.toLowerCase()));
  const lines = text.replace(/\\\r?\n/g, "").split("\n");
  // Map each line to the dotted key it sets, where the parser would see one.
  const dottedOf = (line: string, section: string, sub: string | null): string | null => {
    const t = line.trim();
    if (t === "" || t.startsWith("#") || t.startsWith(";")) return null;
    const head = /^\[(.+)\]$/.exec(t);
    if (head !== null) return null;
    if (t.startsWith("[")) return null;
    if (section === "") return null;
    const kv = /^([A-Za-z0-9-]+)\s*=\s*(.*?)\s*$/.exec(t);
    if (kv === null) return null;
    const name = kv[1]!;
    return sub === null ? `${section}.${name}` : `${section}.${sub}.${name}`;
  };
  let section = "";
  let sub: string | null = null;
  const kept: string[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    const head = /^\[(.+)\]$/.exec(t);
    if (head !== null) {
      const inner = head[1]!.trim();
      const m = /^(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?$/.exec(inner);
      if (m === undefined || m === null) { section = ""; sub = null; }
      else { section = m[1]!.toLowerCase(); sub = m[2] === undefined ? null : m[2]; }
      kept.push(raw);
      continue;
    }
    if (t.startsWith("[")) { section = ""; sub = null; kept.push(raw); continue; }
    const d = dottedOf(raw, section, sub);
    if (d !== null && changed.has(d.toLowerCase())) continue; // drop: re-appended below from the snapshot
    kept.push(raw);
  }
  // Re-append each changed key's before-values (nothing to append for a key that was added).
  const bySection = new Map<string, { header: string; names: { name: string; value: string }[] }>();
  for (const c of changes) {
    if (c.before.length === 0) continue;
    const parts = c.dotted.split(".");
    const key = parts.length === 2
      ? { section: parts[0]!, sub: null as string | null, name: parts[1]! }
      : { section: parts[0]!, sub: parts.slice(1, -1).join("."), name: parts[parts.length - 1]! };
    const hk = `${key.section}\0${key.sub ?? ""}`;
    let g = bySection.get(hk);
    if (g === undefined) { g = { header: key.sub === null ? `[${key.section}]` : `[${key.section} "${key.sub}"]`, names: [] }; bySection.set(hk, g); }
    for (const value of c.before) g.names.push({ name: key.name, value });
  }
  // Drop a trailing blank the join would leave doubled.
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  for (const g of bySection.values()) {
    kept.push(g.header);
    for (const n of g.names) kept.push(`${n.name} = ${n.value}`);
  }
  return kept.join("\n") + (kept.length === 0 ? "" : "\n");
}
